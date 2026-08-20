import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getGitInfo, listDirtyFiles } from "./git.js";
import { normalizePath } from "./hash.js";
import { createId } from "./ids.js";
import {
  getPackPath,
  listCheckpoints,
  PACK_DIR_MODE,
  PACK_FILE_MODE,
  readJson,
  SCHEMA_VERSION,
  withPackWriteLock,
  writeJson
} from "./store.js";
import type {
  AgentpackEvent,
  TaskPassport,
  TaskRisk,
  TaskStatus,
  TaskVerification
} from "./types.js";

const TASK_STATUSES = new Set<TaskStatus>(["active", "parked", "blocked", "verifying", "completed", "abandoned"]);

export interface TaskStartOptions {
  title: string;
  objective?: string;
  constraints?: string[];
  writeScope?: string[];
  nextActions?: string[];
  tags?: string[];
  risk?: TaskRisk;
}

export interface TaskListItem {
  id: string;
  title: string;
  status: TaskStatus;
  branch: string | null;
  current: boolean;
  updatedAt: string;
  writeScope: string[];
}

export interface TaskVerificationUpdateOptions {
  status?: TaskVerification["status"] | string;
  evidence?: string[];
  summary?: string;
}

export interface TaskFinalizeOptions extends TaskVerificationUpdateOptions {
  force?: boolean;
}

export interface TaskVerificationUpdateResult {
  passport: TaskPassport;
  changed: boolean;
}

export interface TaskUpdateOptions {
  objective?: string;
  constraints?: string[];
  writeScope?: string[];
  nextActions?: string[];
  clearNextActions?: boolean;
  tags?: string[];
  risk?: TaskRisk;
}

export interface TaskAuditSourceStatus {
  path: string;
  status: "unchanged" | "changed" | "missing";
}

export interface TaskAuditIssue {
  level: "ok" | "warn";
  message: string;
  category?: "task" | "metadata";
}

export interface TaskAuditReport {
  passport: TaskPassport | null;
  issues: TaskAuditIssue[];
}

const CLOSED_STATUSES = new Set<TaskStatus>(["completed", "abandoned"]);
const VERIFICATION_STATUSES = new Set<TaskVerification["status"]>(["unknown", "pending", "passed", "failed", "accepted"]);
const FINAL_VERIFICATION_STATUSES = new Set<TaskVerification["status"]>(["passed", "failed", "accepted"]);

export function formatVerificationUpdateMessage(passport: TaskPassport, changed: boolean): string {
  const prefix = changed ? "Updated verification" : "Verification unchanged";
  const status = passport.verification.status;
  if (FINAL_VERIFICATION_STATUSES.has(status)) {
    return `${prefix} for task ${passport.id} (${status}). Bound HEAD ${passport.currentHead || "(unknown)"}; the final verdict freezes code changes until finalization or an explicit return to pending.`;
  }
  const consequence = status === "pending"
    ? "Verification remains pending: the task stays active for fixes and intermediate checks."
    : "Verification is unknown: the task stays active until a verification result is recorded.";
  return `${prefix} for task ${passport.id} (${status}). ${consequence}`;
}

export function formatTaskFinalizationMessage(passport: TaskPassport): string {
  return `Finalized task ${passport.id} (${passport.verification.status}). Bound HEAD ${passport.currentHead || "(unknown)"}; the final verdict is frozen and the task is completed.`;
}

export function startTask(root: string, options: TaskStartOptions): TaskPassport {
  if (!options.title.trim()) {
    throw new Error("task start requires a title");
  }

  return withPackWriteLock(root, () => {
    ensureTasksDir(root);
    const currentTask = getCurrentPassport(root);
    if (currentTask && !CLOSED_STATUSES.has(currentTask.status) && currentTask.status !== "parked") {
      throw new Error(
        `Current task ${currentTask.id} is ${currentTask.status}; park or close it before starting a new task.`
      );
    }

    const now = new Date().toISOString();
    const git = getGitInfo(root);
    const id = createTaskId(options.title);
    const passport: TaskPassport = {
      schemaVersion: SCHEMA_VERSION,
      id,
      title: options.title.trim(),
      status: "active",
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      objective: options.objective?.trim() || options.title.trim(),
      constraints: uniqueStrings(options.constraints || []),
      branch: git.branch,
      baseHead: git.head,
      currentHead: git.head,
      worktree: root,
      writeScope: normalizeWriteScope(root, options.writeScope || []),
      risk: options.risk || "unknown",
      verification: {
        status: "unknown",
        evidence: [],
        summary: ""
      },
      nextActions: uniqueStrings(options.nextActions || []),
      tags: uniqueStrings(options.tags || [])
    };

    writePassport(root, passport);
    writeCurrentTaskId(root, passport.id);
    appendTaskEvent(root, passport.id, "task-start", {
      title: passport.title,
      status: passport.status,
      writeScope: passport.writeScope
    });
    return passport;
  });
}

export interface TaskListResult {
  tasks: TaskListItem[];
  warnings: string[];
}

export function listTasks(root: string): TaskListResult {
  const current = readCurrentTaskId(root);
  const warnings: string[] = [];
  const passports: TaskPassport[] = [];

  for (const id of listTaskIds(root)) {
    try {
      passports.push(readPassport(root, id));
    } catch (error) {
      warnings.push(`Unreadable task passport ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const tasks = passports
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((passport) => ({
      id: passport.id,
      title: passport.title,
      status: passport.status,
      branch: passport.branch,
      current: passport.id === current,
      updatedAt: passport.updatedAt,
      writeScope: passport.writeScope
    }));

  return { tasks, warnings };
}

export function formatTaskList(tasks: TaskListItem[]): string {
  return tasks.map((task) => [
    task.current ? "*" : "-",
    task.id,
    `[${task.status}]`,
    task.title,
    task.branch ? `(branch: ${task.branch})` : "",
    task.writeScope.length > 0 ? `(scope: ${formatWriteScope(task.writeScope)})` : ""
  ].filter(Boolean).join(" ")).join("\n");
}

function formatWriteScope(writeScope: string[]): string {
  const shown = writeScope.slice(0, 3);
  const rest = writeScope.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}

export function scopeOverlaps(writeScope: string[], filters: string[]): boolean {
  return writeScope.some((entry) => filters.some((filter) => {
    const scope = normalizeScopePath(entry);
    const target = normalizeScopePath(filter);
    return scope === "." || target === "." || scope === target
      || target.startsWith(`${scope}/`) || scope.startsWith(`${target}/`);
  }));
}

export function normalizeScopePath(path: string): string {
  let result = path.trim();
  while (result.startsWith("./")) {
    result = result.slice(2);
  }
  return result.replace(/\/+$/, "") || ".";
}

export function isInWriteScope(file: string, writeScope: string[]): boolean {
  return writeScope.some((rawEntry) => {
    const entry = normalizeScopePath(rawEntry);
    return entry === "." || file === entry || file.startsWith(`${entry}/`);
  });
}

export function getCurrentPassport(root: string): TaskPassport | null {
  const current = readCurrentTaskId(root);
  return current ? readPassport(root, current) : null;
}

export function readPassport(root: string, taskId: string): TaskPassport {
  if (!/^task_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) {
    throw new Error(`Invalid task id: ${taskId || "(empty)"}`);
  }
  const value = readJson<unknown>(passportPath(root, taskId), null);
  if (!value) {
    throw new Error(`Task passport not found: ${taskId}`);
  }
  return validateTaskPassport(value, taskId);
}

export function switchTask(root: string, taskId: string): TaskPassport {
  return withPackWriteLock(root, () => {
    const existing = readPassport(root, taskId);
    if (CLOSED_STATUSES.has(existing.status)) {
      throw new Error(`Cannot switch to closed task ${taskId}`);
    }

    const currentTaskId = readCurrentTaskId(root);
    if (currentTaskId && currentTaskId !== taskId) {
      const currentPassport = readPassport(root, currentTaskId);
      if (!CLOSED_STATUSES.has(currentPassport.status) && currentPassport.status !== "parked") {
        throw new Error(`Cannot switch tasks while current task ${currentTaskId} is ${currentPassport.status}; park or finalize it first.`);
      }
    }

    const previousStatus = existing.status;
    const passport: TaskPassport = previousStatus === "parked"
      ? {
          ...existing,
          // A parked task can be waiting for an external outcome after a final
          // verdict. Keep that verdict frozen when it becomes current again;
          // callers must explicitly return verification to pending before
          // making further edits. Ordinary parked work resumes as active.
          status: FINAL_VERIFICATION_STATUSES.has(existing.verification.status) ? "verifying" : "active",
          // The final verdict is bound to the HEAD that was reviewed. Resuming
          // a parked task must not silently rewrite that historical binding.
          ...(FINAL_VERIFICATION_STATUSES.has(existing.verification.status) ? {} : { currentHead: getGitInfo(root).head }),
          updatedAt: new Date().toISOString()
        }
      : existing;

    if (passport !== existing) {
      writePassport(root, passport);
    }
    writeCurrentTaskId(root, passport.id);
    appendTaskEvent(root, passport.id, "task-switch", {
      previousStatus,
      status: passport.status
    });
    return passport;
  });
}

export function parkCurrentTask(root: string): TaskPassport {
  return updateCurrentTask(root, "parked", "task-park");
}

export function blockCurrentTask(root: string, reason = ""): TaskPassport {
  return updateCurrentTask(root, "blocked", "task-block", {
    blockedReason: reason
  });
}

export function updateCurrentTaskPassport(root: string, options: TaskUpdateOptions = {}): TaskPassport {
  return patchCurrentTask(root, "task-update", (existing) => {
    const objective = options.objective?.trim() || "";
    const constraints = uniqueStrings(options.constraints || []);
    const writeScope = normalizeWriteScope(root, options.writeScope || []);
    const nextActions = uniqueStrings(options.nextActions || []);
    const tags = uniqueStrings(options.tags || []);

    if (!options.clearNextActions && !hasTaskUpdate({ objective, constraints, writeScope, nextActions, tags }, options.risk)) {
      throw new Error("task update requires at least one non-empty field");
    }

    const patch: Partial<TaskPassport> = {};
    if (objective) {
      patch.objective = objective;
    }
    if (constraints.length > 0) {
      patch.constraints = mergeStringLists(existing.constraints, constraints);
    }
    if (writeScope.length > 0) {
      patch.writeScope = mergeStringLists(existing.writeScope, writeScope);
    }
    if (options.clearNextActions) {
      patch.nextActions = nextActions;
    } else if (nextActions.length > 0) {
      patch.nextActions = mergeStringLists(existing.nextActions, nextActions);
    }
    if (tags.length > 0) {
      patch.tags = mergeStringLists(existing.tags, tags);
    }
    if (options.risk) {
      patch.risk = options.risk;
    }

    if (!changesTaskPassport(existing, patch)) {
      throw new Error("task update did not change the current task");
    }

    return patch;
  });
}

export function updateCurrentTaskVerification(root: string, options: TaskVerificationUpdateOptions = {}): TaskVerificationUpdateResult {
  return withPackWriteLock(root, () => {
    const current = readCurrentTaskId(root);
    if (!current) {
      throw new Error("No current task. Run `agentpack task start <title>` first.");
    }

    const existing = readPassport(root, current);
    if (CLOSED_STATUSES.has(existing.status)) {
      throw new Error(`Cannot update closed task ${current}`);
    }
    if (existing.status === "parked") {
      throw new Error(
        `Current task is parked; resume it first with \`agentpack task switch ${current}\` before updating verification.`
      );
    }

    const verification: TaskVerification = {
      status: parseVerificationStatus(options.status),
      evidence: uniqueStrings([
        ...(existing.verification?.evidence || []),
        ...(options.evidence || [])
      ]),
      summary: options.summary === undefined
        ? existing.verification?.summary || ""
        : options.summary.trim()
    };

    // A final verdict (passed/failed/accepted) means implementation is done and
    // awaiting review, matching the documented "verifying" status. A non-final
    // verdict (pending/unknown) means verification found more work, so the
    // lifecycle returns to "active" rather than getting stuck in "verifying"
    // while the gate keeps warning about legitimate continued edits.
    const nextStatus: TaskStatus = FINAL_VERIFICATION_STATUSES.has(verification.status) ? "verifying" : "active";

    if (existing.status === nextStatus && sameVerification(existing.verification, verification)) {
      return { passport: existing, changed: false };
    }

    const now = new Date().toISOString();
    const git = getGitInfo(root);
    const passport: TaskPassport = {
      ...existing,
      status: nextStatus,
      verification,
      currentHead: git.head,
      updatedAt: now
    };
    // A verify-driven unblock (blocked -> active/verifying) resolves the block,
    // so the stale reason must not linger in the passport or leak into events.
    if (existing.status === "blocked") {
      delete passport.blockedReason;
    }

    writePassport(root, passport);
    appendTaskEvent(root, passport.id, "task-verify", {
      status: passport.status,
      objective: passport.objective,
      writeScope: passport.writeScope,
      nextActions: passport.nextActions,
      risk: passport.risk,
      reason: passport.blockedReason || "",
      verificationStatus: passport.verification.status,
      evidence: passport.verification.evidence
    });
    return { passport, changed: true };
  });
}

export function closeCurrentTask(root: string): TaskPassport {
  return updateCurrentTask(root, "completed", "task-close", {
    closedAt: new Date().toISOString()
  });
}

export function finalizeCurrentTask(root: string, options: TaskFinalizeOptions = {}): TaskPassport {
  return updateCurrentTask(root, "completed", "task-finalize", (existing) => {
    const explicitStatus = options.status !== undefined && String(options.status).trim() !== "";
    const verificationStatus = !explicitStatus
      ? existing.verification.status
      : parseVerificationStatus(options.status);

    if (!FINAL_VERIFICATION_STATUSES.has(verificationStatus)) {
      throw new Error("task finalize requires verification status passed, failed, or accepted; run `agentpack task verify --status passed|failed|accepted` first or pass `--status`.");
    }
    if (verificationStatus === "accepted" && existing.nextActions.length > 0 && !options.force) {
      throw new Error("task finalize --status accepted refuses to close a task that still has next actions. Use `agentpack task park` for deferred work, clear or complete the next actions, or pass `--force` if this task is genuinely accepted as-is.");
    }

    return {
      closedAt: new Date().toISOString(),
      verification: {
        status: verificationStatus,
        evidence: uniqueStrings([
          ...(existing.verification?.evidence || []),
          ...(options.evidence || [])
        ]),
        summary: options.summary === undefined
          ? existing.verification?.summary || ""
          : options.summary.trim()
      }
    };
  });
}

// Advisory by design: finalize is a ritual, not a gate. These never block and
// have no config knob; they only surface hygiene gaps at the moment of closure.
export function finalizeAdvisories(root: string, passport: TaskPassport): string[] {
  const advisories: string[] = [];

  if (passport.writeScope.length > 0) {
    const dirtyInScope = listDirtyFiles(root)
      .map((file) => normalizePath(file))
      .filter((file) => isInWriteScope(file, passport.writeScope));
    if (dirtyInScope.length > 0) {
      const shown = dirtyInScope.slice(0, 5).join(", ");
      const more = dirtyInScope.length > 5 ? ` (+${dirtyInScope.length - 5} more)` : "";
      advisories.push(`Uncommitted changes remain inside the task write scope: ${shown}${more}. Commit them first, or park the task until they are committed.`);
    }
  }

  if (passport.nextActions.length > 0) {
    advisories.push(`Closed with ${passport.nextActions.length} remaining next action(s); they will read as historical. Update them with \`task update --clear-next-actions\` first when they are stale.`);
  }

  const checkpoints = listCheckpoints(root);
  const latestCheckpoint = checkpoints[checkpoints.length - 1] || "";
  const createdMarker = passport.createdAt.replace(/[:.]/g, "-");
  if (latestCheckpoint < createdMarker) {
    advisories.push("No repo checkpoint since this task started. Record durable findings with `checkpoint` before moving on.");
  }

  return advisories;
}

export function auditCurrentTask(root: string, sourceStatuses: TaskAuditSourceStatus[] = []): TaskAuditReport {
  const issues: TaskAuditIssue[] = [];
  let passport: TaskPassport | null;

  try {
    passport = getCurrentPassport(root);
  } catch (error) {
    return {
      passport: null,
      issues: [
        { level: "warn", message: `Cannot read current task passport: ${error instanceof Error ? error.message : String(error)}` }
      ]
    };
  }

  if (!passport) {
    return {
      passport,
      issues: [
        { level: "warn", message: "No current task passport. Run `agentpack task start <title>` before relying on task-scoped handoff." }
      ]
    };
  }

  const git = getGitInfo(root);
  const staleSources = sourceStatuses.filter((source) => source.status !== "unchanged");

  issues.push({ level: "ok", message: `Current task: ${passport.id} [${passport.status}] ${passport.title}` });

  if (CLOSED_STATUSES.has(passport.status)) {
    issues.push({ level: "warn", message: "Current task is closed. Start or switch to an open task before continuing work." });
  }

  if (!passport.nextActions.length) {
    issues.push({ level: "warn", message: "Task has no next actions." });
  }

  if (passport.verification.status === "unknown" || passport.verification.status === "pending") {
    issues.push({ level: "warn", message: `Verification is ${passport.verification.status}. Attach evidence or close the loop before handoff.` });
  }

  if (!passport.writeScope.length) {
    issues.push({ level: "warn", message: "Task has no write scope; future agents may not know the intended blast radius." });
  }

  if (git.available) {
    if (passport.branch && git.branch && passport.branch !== git.branch) {
      issues.push({ level: "warn", message: `Branch drift: passport branch is ${passport.branch}, current branch is ${git.branch}.` });
    }
    if (passport.currentHead && git.head && passport.currentHead !== git.head) {
      issues.push({ level: "warn", message: `HEAD drift: passport head is ${passport.currentHead}, current head is ${git.head}.` });
    }
  } else {
    issues.push({ level: "warn", message: "Git repository not detected; branch/head drift cannot be checked." });
  }

  if (!samePath(root, passport.worktree)) {
    issues.push({ level: "warn", message: "Worktree path differs from the current pack root; verify this passport belongs to this workspace." });
  }

  if (staleSources.length > 0) {
    issues.push({
      level: "warn",
      category: "metadata",
      message: `Source cache metadata has ${staleSources.length} changed or missing record(s): ${staleSources.map((source) => source.path).join(", ")}. Refresh only records whose durable conclusions changed.`
    });
  } else {
    issues.push({ level: "ok", category: "metadata", message: "No changed or missing recorded source conclusions." });
  }

  if (issues.filter((issue) => issue.category !== "metadata").every((issue) => issue.level === "ok")) {
    issues.push({ level: "ok", message: "No action-required task warnings." });
  }

  return { passport, issues };
}

export function formatTaskAuditReport(report: TaskAuditReport): string {
  const taskIssues = report.issues.filter((issue) => issue.category !== "metadata");
  const metadataIssues = report.issues.filter((issue) => issue.category === "metadata");
  return [
    "Task audit",
    ...taskIssues.map((issue) => `[${issue.level}] ${issue.message}`),
    ...(metadataIssues.length
      ? [
          "",
          "Metadata",
          ...metadataIssues.map((issue) => `[${issue.level}] ${issue.message}`)
        ]
      : [])
  ].join("\n");
}

export function formatCurrentTaskStatus(root: string): string {
  let passport: TaskPassport | null;

  try {
    passport = getCurrentPassport(root);
  } catch (error) {
    return [
      "Task status",
      `[warn] Cannot read current task passport: ${error instanceof Error ? error.message : String(error)}`
    ].join("\n");
  }

  if (!passport) {
    return [
      "Task status",
      "[warn] No current task passport. Run `agentpack task start <title>` before relying on task-scoped handoff."
    ].join("\n");
  }

  const git = getGitInfo(root);
  const drift = formatTaskDrift(passport, git);
  const nextAction = passport.nextActions[0] || "(none)";
  const writeScope = passport.writeScope.length > 0 ? passport.writeScope.join(", ") : "(none)";
  const verification = passport.verification?.status || "unknown";

  return [
    "Task status",
    `${passport.title} [${passport.status}]`,
    `ID: ${passport.id}`,
    `Branch: ${passport.branch || "(unknown)"}`,
    `Risk: ${passport.risk || "unknown"}`,
    `Verification: ${verification}`,
    `Next: ${nextAction}`,
    `Write scope: ${writeScope}`,
    `Drift: ${drift}`
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatCurrentTaskHandoff(root: string, sourceStatuses: TaskAuditSourceStatus[] = []): string {
  let passport: TaskPassport | null;

  try {
    passport = getCurrentPassport(root);
  } catch (error) {
    return [
      "Task handoff",
      `[warn] Cannot read current task passport: ${error instanceof Error ? error.message : String(error)}`
    ].join("\n");
  }

  if (!passport) {
    return [
      "Task handoff",
      "[warn] No current task passport. Run `agentpack task start <title>` before relying on task-scoped handoff."
    ].join("\n");
  }

  return formatTaskPassportHandoff(root, passport, sourceStatuses);
}

export function formatTaskPassportHandoff(root: string, passport: TaskPassport, sourceStatuses: TaskAuditSourceStatus[] = []): string {
  const git = getGitInfo(root);
  const warnings = taskHandoffWarnings(root, passport, git, sourceStatuses);
  const verification = passport.verification;

  return [
    "Task handoff",
    `${passport.title} [${passport.status}]`,
    `ID: ${passport.id}`,
    `Objective: ${passport.objective || "(none)"}`,
    `Branch: ${passport.branch || "(unknown)"}`,
    `HEAD: ${git.head || passport.currentHead || "(unknown)"}`,
    `Risk: ${passport.risk || "unknown"}`,
    `Verification: ${verification.status}${verification.summary ? ` - ${verification.summary}` : ""}`,
    `Evidence: ${verification.evidence.length > 0 ? verification.evidence.join(", ") : "(none)"}`,
    "Constraints:",
    ...formatList(passport.constraints),
    "Write scope:",
    ...formatList(passport.writeScope),
    "Next actions:",
    ...formatList(passport.nextActions),
    `Drift: ${formatTaskDrift(passport, git)}`,
    `Audit: ${warnings.task.length > 0 ? warnings.task.join(" | ") : "No action-required task warnings."}`,
    `Metadata: ${warnings.metadata.length > 0 ? warnings.metadata.join(" | ") : "No source-cache metadata warnings."}`
  ].join("\n");
}

function taskHandoffWarnings(
  root: string,
  passport: TaskPassport,
  git: ReturnType<typeof getGitInfo>,
  sourceStatuses: TaskAuditSourceStatus[]
): { task: string[]; metadata: string[] } {
  const task: string[] = [];
  const metadata: string[] = [];
  const staleSources = sourceStatuses.filter((source) => source.status !== "unchanged");

  if (CLOSED_STATUSES.has(passport.status)) {
    task.push("Task is closed. Start or switch to an open task before continuing work.");
  }
  if (!passport.nextActions.length) {
    task.push("Task has no next actions.");
  }
  if (passport.verification.status === "unknown" || passport.verification.status === "pending") {
    task.push(`Verification is ${passport.verification.status}. Attach evidence or close the loop before handoff.`);
  }
  if (!passport.writeScope.length) {
    task.push("Task has no write scope; future agents may not know the intended blast radius.");
  }
  if (git.available) {
    if (passport.branch && git.branch && passport.branch !== git.branch) {
      task.push(`Branch drift: passport branch is ${passport.branch}, current branch is ${git.branch}.`);
    }
    if (passport.currentHead && git.head && passport.currentHead !== git.head) {
      task.push(`HEAD drift: passport head is ${passport.currentHead}, current head is ${git.head}.`);
    }
  } else {
    task.push("Git repository not detected; branch/head drift cannot be checked.");
  }
  if (!samePath(root, passport.worktree)) {
    task.push("Worktree path differs from the current pack root; verify this passport belongs to this workspace.");
  }
  if (staleSources.length > 0) {
    metadata.push(`Source cache metadata has ${staleSources.length} changed or missing record(s): ${staleSources.map((source) => source.path).join(", ")}. Refresh only records whose durable conclusions changed.`);
  }

  return { task, metadata };
}

function formatList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- (none)"];
}

function formatTaskDrift(passport: TaskPassport, git: ReturnType<typeof getGitInfo>): string {
  if (!git.available) {
    return "git unavailable";
  }
  const issues: string[] = [];
  if (passport.branch && git.branch && passport.branch !== git.branch) {
    issues.push(`branch ${passport.branch} -> ${git.branch}`);
  }
  if (passport.currentHead && git.head && passport.currentHead !== git.head) {
    issues.push(`HEAD ${passport.currentHead} -> ${git.head}`);
  }
  return issues.length > 0 ? issues.join("; ") : "none";
}

function updateCurrentTask(
  root: string,
  status: TaskStatus,
  eventType: string,
  patch: Partial<TaskPassport> | ((existing: TaskPassport) => Partial<TaskPassport>) = {}
): TaskPassport {
  return patchCurrentTask(root, eventType, (existing) => ({
    ...(typeof patch === "function" ? patch(existing) : patch),
    status
  }));
}

function patchCurrentTask(
  root: string,
  eventType: string,
  patch: Partial<TaskPassport> | ((existing: TaskPassport) => Partial<TaskPassport>) = {}
): TaskPassport {
  return withPackWriteLock(root, () => {
    const current = readCurrentTaskId(root);
    if (!current) {
      throw new Error("No current task. Run `agentpack task start <title>` first.");
    }

    const existing = readPassport(root, current);
    if (CLOSED_STATUSES.has(existing.status)) {
      throw new Error(`Cannot update closed task ${current}`);
    }

    const now = new Date().toISOString();
    const git = getGitInfo(root);
    const resolvedPatch = typeof patch === "function" ? patch(existing) : patch;
    const passport: TaskPassport = {
      ...existing,
      ...resolvedPatch,
      // A final verdict binds the reviewed code state. Routine metadata
      // updates, parking, switching, and finalization must preserve it; an
      // explicit verification update below is the deliberate rebinding path.
      currentHead: FINAL_VERIFICATION_STATUSES.has(existing.verification.status)
        ? existing.currentHead
        : git.head,
      updatedAt: now
    };

    if (passport.status === "completed" || passport.status === "abandoned") {
      passport.closedAt = passport.closedAt || now;
    }

    writePassport(root, passport);
    appendTaskEvent(root, passport.id, eventType, {
      status: passport.status,
      objective: passport.objective,
      writeScope: passport.writeScope,
      nextActions: passport.nextActions,
      risk: passport.risk,
      reason: passport.blockedReason || "",
      verificationStatus: passport.verification.status,
      evidence: passport.verification.evidence
    });
    return passport;
  });
}

function hasTaskUpdate(options: Omit<TaskUpdateOptions, "risk">, risk: TaskRisk | undefined): boolean {
  return Boolean(
    options.objective ||
    risk !== undefined ||
    (options.constraints && options.constraints.length > 0) ||
    (options.writeScope && options.writeScope.length > 0) ||
    (options.nextActions && options.nextActions.length > 0) ||
    (options.tags && options.tags.length > 0)
  );
}

function mergeStringLists(existing: string[], incoming: string[] | undefined): string[] {
  return uniqueStrings([...existing, ...(incoming || [])]);
}

function changesTaskPassport(existing: TaskPassport, patch: Partial<TaskPassport>): boolean {
  return Boolean(
    (patch.objective !== undefined && patch.objective !== existing.objective) ||
    (patch.risk !== undefined && patch.risk !== existing.risk) ||
    (patch.constraints !== undefined && !sameStringList(patch.constraints, existing.constraints)) ||
    (patch.writeScope !== undefined && !sameStringList(patch.writeScope, existing.writeScope)) ||
    (patch.nextActions !== undefined && !sameStringList(patch.nextActions, existing.nextActions)) ||
    (patch.tags !== undefined && !sameStringList(patch.tags, existing.tags))
  );
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function parseVerificationStatus(value: TaskVerificationUpdateOptions["status"]): TaskVerification["status"] {
  const status = String(value || "pending");
  if (VERIFICATION_STATUSES.has(status as TaskVerification["status"])) {
    return status as TaskVerification["status"];
  }
  throw new Error(`Unknown verification status: ${status}`);
}

function createTaskId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
  return `${createId("task")}_${slug}`;
}

function ensureTasksDir(root: string): void {
  mkdirSync(getPackPath(root, "tasks"), { recursive: true, mode: PACK_DIR_MODE });
}

export function listTaskIds(root: string): string[] {
  const tasksPath = getPackPath(root, "tasks");
  if (!existsSync(tasksPath)) {
    return [];
  }

  return readdirSync(tasksPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(passportPath(root, entry.name)))
    .map((entry) => entry.name);
}

function validateTaskPassport(value: unknown, taskId: string): TaskPassport {
  if (!isRecord(value)) {
    throw new Error(`Task passport is invalid: ${taskId}`);
  }
  const status = value.status;
  const risk = value.risk;
  const verification = value.verification;
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    value.id !== taskId ||
    typeof value.title !== "string" ||
    !TASK_STATUSES.has(status as TaskStatus) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !(value.closedAt === null || typeof value.closedAt === "string") ||
    typeof value.objective !== "string" ||
    !stringArrayValue(value.constraints) ||
    !(value.branch === null || typeof value.branch === "string") ||
    !(value.baseHead === null || typeof value.baseHead === "string") ||
    !(value.currentHead === null || typeof value.currentHead === "string") ||
    typeof value.worktree !== "string" ||
    !stringArrayValue(value.writeScope) ||
    !(risk === "low" || risk === "medium" || risk === "high" || risk === "unknown") ||
    !isRecord(verification) ||
    !VERIFICATION_STATUSES.has(verification.status as TaskVerification["status"]) ||
    !stringArrayValue(verification.evidence) ||
    typeof verification.summary !== "string" ||
    !stringArrayValue(value.nextActions) ||
    !stringArrayValue(value.tags) ||
    !(value.blockedReason === undefined || typeof value.blockedReason === "string")
  ) {
    throw new Error(`Task passport is invalid: ${taskId}`);
  }
  // A legacy `roles` field is ignored rather than migrated: strip it here so it
  // never propagates into a later write of this passport.
  const { roles: _legacyRoles, ...rest } = value;
  return rest as unknown as TaskPassport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArrayValue(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function passportPath(root: string, taskId: string): string {
  return getPackPath(root, "tasks", taskId, "passport.json");
}

function taskEventsPath(root: string, taskId: string): string {
  return getPackPath(root, "tasks", taskId, "events.jsonl");
}

function currentTaskPath(root: string): string {
  return getPackPath(root, "tasks", "current");
}

function readCurrentTaskId(root: string): string | null {
  const filePath = currentTaskPath(root);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, "utf8").trim() || null;
}

function writeCurrentTaskId(root: string, taskId: string): void {
  ensureTasksDir(root);
  writeFileSync(currentTaskPath(root), `${taskId}\n`, { encoding: "utf8", mode: PACK_FILE_MODE });
}

function writePassport(root: string, passport: TaskPassport): void {
  const taskPath = getPackPath(root, "tasks", passport.id);
  mkdirSync(path.join(taskPath, "checkpoints"), { recursive: true, mode: PACK_DIR_MODE });
  mkdirSync(path.join(taskPath, "evidence"), { recursive: true, mode: PACK_DIR_MODE });
  mkdirSync(path.join(taskPath, "exports"), { recursive: true, mode: PACK_DIR_MODE });
  if (!existsSync(taskEventsPath(root, passport.id))) {
    writeFileSync(taskEventsPath(root, passport.id), "", { encoding: "utf8", mode: PACK_FILE_MODE });
  }
  writeJson(passportPath(root, passport.id), passport);
}

function appendTaskEvent(root: string, taskId: string, type: string, payload: Record<string, unknown>): AgentpackEvent {
  const event: AgentpackEvent = {
    id: createId("evt"),
    ts: new Date().toISOString(),
    type,
    ...payload
  };
  writeFileSync(taskEventsPath(root, taskId), `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    flag: "a",
    mode: PACK_FILE_MODE
  });
  return event;
}

function normalizeWriteScope(root: string, writeScope: string[]): string[] {
  return uniqueStrings(writeScope.map((item) => {
    const absolutePath = path.resolve(root, item);
    const relativePath = path.relative(root, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Refusing write scope outside project root: ${item}`);
    }
    return normalizePath(relativePath || ".");
  }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sameVerification(left: TaskVerification, right: TaskVerification): boolean {
  return left.status === right.status &&
    left.summary === right.summary &&
    left.evidence.length === right.evidence.length &&
    left.evidence.every((item, index) => item === right.evidence[index]);
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}
