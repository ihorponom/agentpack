import { mkdirSync, writeFileSync } from "node:fs";
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
import type { AgentpackConfig, GitInfo } from "./types.js";

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
