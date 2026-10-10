import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildResume } from "./resume.js";
import { getGitInfo } from "./git.js";
import {
  appendEvent,
  getPackPath,
  listCheckpoints,
  PACK_DIR_MODE,
  PACK_FILE_MODE,
  readJson,
  readState,
  withPackWriteLock,
  writeJson,
  writeState
} from "./store.js";
import { redactForRoot } from "./redaction.js";
import { getCurrentPassport } from "./tasks.js";
import { resolveRegularFileWithin } from "./hash.js";
import type { AgentpackConfig, GitInfo, TaskCheckpoint } from "./types.js";

export const MAX_TASK_CHECKPOINT_BYTES = 2 * 1024;
const MAX_CHECKPOINT_MANIFEST_BYTES = 64 * 1024;

export interface TaskCheckpointContext {
  checkpoint?: TaskCheckpoint;
  imported?: boolean;
  warnings: string[];
}

export function readLocalTaskCheckpoint(root: string, taskId: string): TaskCheckpointContext {
  const warnings: string[] = [];
  const directory = getPackPath(root, "checkpoints");
  if (!existsSync(directory)) return { warnings };
  let ids: string[];
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe directory");
    ids = listCheckpoints(root).reverse();
  } catch {
    return { warnings: ["Cannot read task checkpoints: unreadable or unsafe checkpoint directory."] };
  }
  for (const id of ids) {
    try {
      const file = resolveRegularFileWithin(root, getPackPath(root, "checkpoints", id, "checkpoint.json"), "checkpoint manifest");
      if (lstatSync(file).size > MAX_CHECKPOINT_MANIFEST_BYTES) throw new Error("oversized manifest");
      const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isRecord(manifest)) throw new Error("invalid manifest");
      if (manifest.taskId !== taskId) continue;
      const checkpoint = {
        id: manifest.id,
        taskId: manifest.taskId,
        createdAt: manifest.createdAt,
        summary: manifest.summary,
        git: manifest.git
      };
      if (manifest.id !== id || !checkpointShape(checkpoint)) throw new Error("invalid linked manifest");
      return { checkpoint: boundTaskCheckpoint(root, checkpoint), warnings };
    } catch {
      if (!warnings.length) warnings.push("Skipped unreadable, unsafe or invalid checkpoint metadata.");
    }
  }
  return { warnings };
}

export function isTaskCheckpoint(value: unknown): value is TaskCheckpoint {
  return checkpointShape(value)
    && Object.keys(value).every((key) => ["id", "taskId", "createdAt", "summary", "git", "truncated"].includes(key))
    && Object.keys(value.git).every((key) => key === "branch" || key === "head")
    && (value.truncated === undefined || typeof value.truncated === "boolean")
    && Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_TASK_CHECKPOINT_BYTES;
}

function checkpointShape(value: unknown): value is TaskCheckpoint {
  if (!isRecord(value) || !isRecord(value.git)) return false;
  return typeof value.id === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(value.id)
    && typeof value.taskId === "string"
    && /^task_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.taskId)
    && value.taskId.length <= 256
    && typeof value.createdAt === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt)
    && Number.isFinite(Date.parse(value.createdAt))
    && new Date(value.createdAt).toISOString() === value.createdAt
    && typeof value.summary === "string"
    && [value.git.branch, value.git.head].every((ref) => ref === null || (typeof ref === "string" && Buffer.byteLength(ref, "utf8") <= 256));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function boundTaskCheckpoint(root: string, checkpoint: TaskCheckpoint): TaskCheckpoint {
  const canonicalRoot = realpathSync(root);
  const portable = (text: string) => redactForRoot(canonicalRoot, text)
    .split(canonicalRoot).join("[REDACTED:WORKTREE]")
    .split(root).join("[REDACTED:WORKTREE]");
  const result: TaskCheckpoint = {
    id: checkpoint.id,
    taskId: checkpoint.taskId,
    createdAt: checkpoint.createdAt,
    summary: portable(checkpoint.summary),
    git: {
      branch: checkpoint.git.branch === null ? null : portable(checkpoint.git.branch),
      head: checkpoint.git.head === null ? null : portable(checkpoint.git.head)
    },
    ...(checkpoint.truncated ? { truncated: true } : {})
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_TASK_CHECKPOINT_BYTES) {
    if (!isTaskCheckpoint(result)) throw new Error("Invalid portable checkpoint metadata.");
    return result;
  }
  const characters = Array.from(result.summary);
  const marker = "\n[Checkpoint summary truncated]";
  result.truncated = true;
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    result.summary = characters.slice(0, middle).join("") + marker;
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_TASK_CHECKPOINT_BYTES) low = middle;
    else high = middle - 1;
  }
  result.summary = characters.slice(0, low).join("") + marker;
  if (!isTaskCheckpoint(result)) throw new Error("Checkpoint metadata exceeds portable limits.");
  return result;
}

export function formatTaskCheckpoint(context: TaskCheckpointContext): string[] {
  const checkpoint = context.checkpoint;
  return [
    ...(checkpoint ? [
      `Latest task checkpoint${context.imported ? " (imported origin)" : ""}:`,
      `- ID: ${checkpoint.id}; Created: ${checkpoint.createdAt}`,
      `- Origin task: ${checkpoint.taskId}; Git: ${checkpoint.git.branch || "(unknown)"} @ ${checkpoint.git.head || "(unknown)"}`,
      checkpoint.summary,
      ...(checkpoint.truncated && !checkpoint.summary.endsWith("[Checkpoint summary truncated]") ? ["[Checkpoint summary truncated]"] : [])
    ] : []),
    ...context.warnings.map((warning) => `[warn] ${warning}`)
  ];
}

interface CheckpointOptions {
  summary?: string;
  status?: string;
  nextActions?: string[];
}

interface CheckpointManifest {
  schemaVersion?: number;
  id?: string;
  summary?: string;
  status?: string;
  taskId?: string;
  git?: Partial<GitInfo>;
}

export function createCheckpoint(root: string, options: CheckpointOptions = {}) {
  return withPackWriteLock(root, () => {
    const state = readState(root);
    const config = readJson<Partial<AgentpackConfig>>(getPackPath(root, "config.json"), {});
    const git = getGitInfo(root, { includeDiff: config.includeGitDiff !== false });
    const id = checkpointId();
    const checkpointPath = getPackPath(root, "checkpoints", id);
    const summary = redactForRoot(root, options.summary || "Checkpoint created.");
    // Link only checkpoints taken while a task is current (active, blocked or
    // verifying, matching usage attribution); others stay global. A broken
    // current pointer must not stop saving progress.
    let taskId: string | undefined;
    try {
      const task = getCurrentPassport(root);
      if (task && (task.status === "active" || task.status === "blocked" || task.status === "verifying")) taskId = task.id;
    } catch { /* fall back to a global checkpoint */ }

    mkdirSync(checkpointPath, { recursive: true, mode: PACK_DIR_MODE });

    if (options.status) {
      state.currentStatus = redactForRoot(root, options.status);
    }

    if (options.nextActions && options.nextActions.length > 0) {
      state.nextActions = options.nextActions.map((item) => redactForRoot(root, item));
    }

    state.currentCheckpoint = id;
    writeState(root, state);

    const manifest = {
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      summary,
      status: state.currentStatus,
      nextActions: state.nextActions || [],
      ...(taskId ? { taskId } : {}),
      git: {
        available: git.available,
        branch: git.branch,
        head: git.head
      }
    };

    writeJson(path.join(checkpointPath, "checkpoint.json"), manifest);
    writeFileSync(path.join(checkpointPath, "git-status.txt"), redactForRoot(root, git.status || ""), { encoding: "utf8", mode: PACK_FILE_MODE });

    if (config.includeGitDiff !== false) {
      writeFileSync(path.join(checkpointPath, "diff.patch"), redactForRoot(root, git.diff || ""), { encoding: "utf8", mode: PACK_FILE_MODE });
    }

    const resume = buildResume(root, { budget: config.defaultBudget || 4000 });
    writeFileSync(path.join(checkpointPath, "resume.md"), resume.markdown, { encoding: "utf8", mode: PACK_FILE_MODE });

    appendEvent(root, "checkpoint", {
      checkpointId: id,
      summary,
      status: state.currentStatus,
      ...(taskId ? { taskId } : {})
    });

    return { id, path: checkpointPath, manifest };
  });
}

export function diffCheckpoints(root: string, fromId?: string, toId?: string): string {
  const checkpoints = listCheckpoints(root);
  if (checkpoints.length === 0) {
    return "No checkpoints yet.";
  }

  const latest = checkpoints[checkpoints.length - 1];
  if (!latest) {
    return "No checkpoints yet.";
  }

  const to = toId || latest;
  const from = fromId || checkpoints[checkpoints.length - 2] || latest;
  const fromManifest = readJson<CheckpointManifest>(getPackPath(root, "checkpoints", from, "checkpoint.json"), {});
  const toManifest = readJson<CheckpointManifest>(getPackPath(root, "checkpoints", to, "checkpoint.json"), {});

  return [
    "# Agentpack Checkpoint Diff",
    "",
    `From: ${from}`,
    `To: ${to}`,
    "",
    "## Summary",
    `- From: ${fromManifest.summary || "No summary"}`,
    `- To: ${toManifest.summary || "No summary"}`,
    "",
    "## Status",
    `- From: ${fromManifest.status || "No status"}`,
    `- To: ${toManifest.status || "No status"}`,
    "",
    "## Task",
    `- From: ${fromManifest.taskId || "none (global checkpoint)"}`,
    `- To: ${toManifest.taskId || "none (global checkpoint)"}`,
    "",
    "## Git",
    `- From: ${formatGitRef(fromManifest.git)}`,
    `- To: ${formatGitRef(toManifest.git)}`
  ].join("\n");
}

function checkpointId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatGitRef(git: Partial<GitInfo> = {}): string {
  if (!git.available) {
    return "not available";
  }
  return `${git.branch || "unknown"} @ ${git.head || "unknown"}`;
}
