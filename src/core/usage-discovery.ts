import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPassport } from "./tasks.js";
import {
  formatTaskUsageReport,
  hasLinkedTaskUsage,
  linkTaskUsage,
  readLinkedSourceFiles,
  unlinkTaskUsage,
  type TaskUsageReport,
  type UsageSourceLink
} from "./usage-manifest.js";
import { readUsageTimeline } from "./usage.js";

export interface UsageCandidate {
  number: number;
  /** Stable session id (file name without .jsonl); prefer it over number when picking later. */
  id: string;
  client: "codex" | "claude";
  file: string;
  subagent: boolean;
  started: string | null;
  requests: number;
  windowRequests: number;
  /** False when no turn boundary covers the in-window requests; link with explicit file/turns. */
  selectable: boolean;
  /** Suggested turns; null selects the whole source. */
  turns: string | null;
  linked: boolean;
}

export interface UsageCandidates {
  kind: "task-usage-candidates";
  taskId: string;
  linked: boolean;
  window: { from: string; to: string | null };
  searched: string[];
  warnings: string[];
  candidates: UsageCandidate[];
}

export interface UsageLinkRequest {
  pick?: Array<number | string>;
  client?: string;
  file?: string;
  turns?: string;
  phase?: string;
  coverage?: string;
  note?: string;
  remove?: string;
}

export type UsageLinkResult = UsageCandidates
  | { kind: "task-usage-unlink"; taskId: string; removed: string; remaining: number }
  | { kind: "task-usage-link"; taskId: string; linked: string[]; report: TaskUsageReport };

interface SourceFile { file: string; subagent: boolean }

const MAX_FILES_PER_CLIENT = 200;
const MAX_CODEX_DAYS = 120;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_META_BYTES = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Suggest Claude Code/Codex sessions recorded in the task worktree that have
 * requests inside the Passport window. Suggestions only; linking stays explicit.
 */
export function findUsageCandidates(root: string, taskId: string, env: NodeJS.ProcessEnv = process.env): UsageCandidates {
  const passport = readPassport(root, taskId);
  const from = Date.parse(passport.createdAt);
  const to = passport.closedAt ? Date.parse(passport.closedAt) : null;
  const worktree = path.resolve(passport.worktree);
  const home = os.homedir();
  // Claude Code names project directories after the session cwd with every
  // non-alphanumeric character replaced by "-".
  const claudeDir = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects", worktree.replace(/[^A-Za-z0-9]/gu, "-"));
  const codexDir = path.join(env.CODEX_HOME || path.join(home, ".codex"), "sessions");
  const linked = new Set(readLinkedSourceFiles(root, taskId));
  const warnings: string[] = [];
  const found: Array<Omit<UsageCandidate, "number">> = [];
  const sources = [
    ["claude", claudeFiles(claudeDir, from, warnings)],
    ["codex", codexFiles(codexDir, real(worktree), from, to, warnings)]
  ] as const;
  for (const [client, files] of sources) {
    for (const source of files) {
      const candidate = inspect(client, source, from, to);
      if (candidate) found.push({ ...candidate, linked: linked.has(candidate.file) });
    }
  }
  found.sort((a, b) => (a.started || "￿").localeCompare(b.started || "￿") || a.file.localeCompare(b.file));
  return {
    kind: "task-usage-candidates", taskId, linked: linked.size > 0,
    window: { from: passport.createdAt, to: passport.closedAt || null },
    searched: [claudeDir, codexDir], warnings,
    candidates: found.map((candidate, index) => ({ number: index + 1, ...candidate }))
  };
}

/** Shared CLI/MCP link semantics: list, pick, explicit file, coverage or remove. */
export function runUsageLink(root: string, taskId: string, request: UsageLinkRequest, cwd: string, env: NodeJS.ProcessEnv = process.env): UsageLinkResult {
  const has = (key: keyof UsageLinkRequest) => request[key] !== undefined;
  if (has("remove")) {
    if ((Object.keys(request) as Array<keyof UsageLinkRequest>).some(key => key !== "remove" && has(key))) throw new Error("remove cannot be combined with link options");
    const remaining = unlinkTaskUsage(root, taskId, request.remove!, cwd);
    return { kind: "task-usage-unlink", taskId, removed: request.remove!, remaining };
  }
  if (has("coverage") && request.coverage !== "partial" && request.coverage !== "declared-complete") throw new Error("coverage requires partial or declared-complete");
  if (has("coverage") !== has("note")) throw new Error("coverage and note must be supplied together");
  const coverage = request.coverage !== undefined ? { status: request.coverage as "partial" | "declared-complete", note: request.note! } : undefined;
  const phase = request.phase ?? "main";
  let links: UsageSourceLink[];
  if (has("pick")) {
    if (has("client") || has("file") || has("turns")) throw new Error("pick links the suggested selection; use client, file and turns for a custom one");
    links = pickUsageCandidates(root, taskId, request.pick!, phase, env);
  } else if (has("client") || has("file")) {
    if (request.client !== "codex" && request.client !== "claude") throw new Error("Linking a file requires client codex or claude");
    if (!has("file")) throw new Error("Linking requires a file with client");
    links = [{ client: request.client, file: request.file!, phase, ...(has("turns") ? { turns: request.turns! } : {}) }];
  } else {
    if (has("turns") || has("phase")) throw new Error("turns and phase require pick or file");
    if (!coverage) return findUsageCandidates(root, taskId, env);
    if (!hasLinkedTaskUsage(root, taskId)) throw new Error(`No usage sources linked to ${taskId}; link sources before declaring coverage`);
    links = [];
  }
  const report = linkTaskUsage(root, taskId, links, cwd, coverage);
  return { kind: "task-usage-link", taskId, linked: links.map(link => path.basename(link.file)), report };
}

export function formatUsageLinkResult(result: UsageLinkResult): string {
  if (result.kind === "task-usage-candidates") return formatUsageCandidates(result);
  if (result.kind === "task-usage-unlink") return `Unlinked usage source from ${result.taskId}; ${result.remaining} linked source(s) remain.`;
  const linked = result.linked.length ? `Linked to ${result.taskId}: ${result.linked.join(", ")}` : `Updated coverage for ${result.taskId}`;
  return `${linked} (${result.report.slices.length} linked source(s) in total).\n\n${formatTaskUsageReport(result.report)}`;
}

/** Resolve picks (candidate numbers or stable session ids) against a fresh discovery. */
export function pickUsageCandidates(root: string, taskId: string, picks: Array<number | string>, phase: string, env: NodeJS.ProcessEnv = process.env): UsageSourceLink[] {
  const { candidates } = findUsageCandidates(root, taskId, env);
  return picks.map(pick => {
    const matches = candidates.filter(item => typeof pick === "number" ? item.number === pick : item.id === pick);
    if (matches.length > 1) throw new Error(`Usage candidate ${pick} is ambiguous; link it with an explicit file`);
    const candidate = matches[0];
    if (!candidate) throw new Error(`No usage candidate ${pick} for ${taskId}; list candidates first`);
    if (!candidate.selectable) throw new Error(`Usage candidate ${pick} has no turn boundary inside the task window; link it with an explicit file and turns`);
    return { client: candidate.client, file: candidate.file, phase, ...(candidate.turns === null ? {} : { turns: candidate.turns }) };
  });
}

export function formatUsageCandidates(result: UsageCandidates): string {
  const lines = [
    `Task usage: ${result.taskId}`,
    result.linked ? "Linked sources exist; candidates marked [linked] are already included." : "No usage sources linked yet.",
    `Task window: ${result.window.from} to ${result.window.to || "now (task open)"}`,
    `Searched: ${result.searched.map(display).join(", ")}`,
    ...result.warnings.map(warning => `Warning: ${warning}`),
    ""
  ];
  if (!result.candidates.length) {
    lines.push("No Claude Code or Codex sessions of this worktree have requests in the task window.",
      `Link a source explicitly: agentpack usage link --task ${result.taskId} --client claude|codex --file <jsonl> [--turns N|N:|N:M]`);
    return lines.join("\n");
  }
  lines.push("Candidate sessions (suggestions only; nothing is counted until linked):");
  for (const c of result.candidates) {
    const selection = !c.selectable ? "no turn boundary fits the window; link with explicit --file/--turns"
      : c.turns === null ? "whole session" : `turns ${c.turns}`;
    lines.push(`${c.number}. ${c.id} (${c.client}${c.subagent ? " subagent" : ""})${c.linked ? " [linked]" : ""}`,
      `   started ${c.started || "unknown"}; ${c.windowRequests}/${c.requests} requests in task window; suggested: ${selection}`,
      `   ${display(c.file)}`);
  }
  lines.push("", `Link: agentpack usage link --task ${result.taskId} --pick <number or session id>[,...]`,
    `Then: agentpack usage report --task ${result.taskId}`);
  return lines.join("\n");
}

function inspect(client: "codex" | "claude", source: SourceFile, from: number, to: number | null): Omit<UsageCandidate, "number" | "linked"> | null {
  let timeline;
  try { timeline = readUsageTimeline(client, source.file, path.dirname(source.file)); }
  catch { return null; }
  const inWindow = timeline.requests.filter(request => request.at !== null && request.at >= from && (to === null || request.at < to));
  if (!inWindow.length) return null;
  const { report } = timeline;
  let turns: string | null = null;
  let selectable = true;
  if (inWindow.length !== report.requests) {
    // Turns with at least one request inside the window, using source-local numbering.
    const selected = inWindow.flatMap(request => request.turn === null ? [] : [request.turn]);
    const final = (report.turns || []).reduce((max, turn) => Math.max(max, turn.turn), 0);
    if (!selected.length) selectable = false;
    else {
      const first = selected.reduce((min, turn) => Math.min(min, turn));
      const last = selected.reduce((max, turn) => Math.max(max, turn));
      turns = to === null && last === final ? `${first}:` : first === last ? `${first}` : `${first}:${last}`;
    }
  }
  const file = report.sources[0]?.path || source.file;
  return {
    id: path.basename(file, ".jsonl"), client, file, subagent: source.subagent,
    started: report.turns?.find(turn => turn.start !== null)?.start || null,
    requests: report.requests, windowRequests: inWindow.length, selectable, turns
  };
}

function claudeFiles(dir: string, from: number, warnings: string[]): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of entries(dir)) {
    const file = path.join(dir, entry);
    if (entry.endsWith(".jsonl")) files.push({ file, subagent: false });
    else for (const child of entries(path.join(file, "subagents"))) {
      if (child.endsWith(".jsonl")) files.push({ file: path.join(file, "subagents", child), subagent: true });
    }
  }
  return recent(files, from, warnings, "Claude Code");
}

function codexFiles(dir: string, worktree: string, from: number, to: number | null, warnings: string[]): SourceFile[] {
  const files: SourceFile[] = [];
  const end = to ?? Date.now();
  const start = Math.max(from - DAY_MS, end - MAX_CODEX_DAYS * DAY_MS);
  if (start > from - DAY_MS) warnings.push(`Codex sessions were searched only for the last ${MAX_CODEX_DAYS} days of the task window; link earlier sessions explicitly.`);
  // Rollout directories use local dates; one extra day on each side covers time zones.
  for (let day = start; day <= end + DAY_MS; day += DAY_MS) {
    const date = new Date(day);
    const dayDir = path.join(dir, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
    for (const entry of entries(dayDir)) if (entry.endsWith(".jsonl")) files.push({ file: path.join(dayDir, entry), subagent: false });
  }
  const matched: SourceFile[] = [];
  for (const { file } of recent(files, from, warnings, "Codex")) {
    const meta = codexMeta(file);
    if (typeof meta?.cwd === "string" && real(meta.cwd) === worktree) matched.push({ file, subagent: meta.thread_source === "subagent" });
  }
  return matched;
}

function recent(files: SourceFile[], from: number, warnings: string[], label: string): SourceFile[] {
  const stats: Array<SourceFile & { mtime: number }> = [];
  for (const source of files) {
    try {
      const stat = statSync(source.file);
      if (stat.isFile() && stat.size <= MAX_FILE_BYTES && stat.mtimeMs >= from) stats.push({ ...source, mtime: stat.mtimeMs });
    } catch { /* unreadable transcripts are not candidates */ }
  }
  if (stats.length > MAX_FILES_PER_CLIENT) warnings.push(`Only the ${MAX_FILES_PER_CLIENT} most recently updated ${label} sessions were inspected; link others explicitly.`);
  return stats.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES_PER_CLIENT).map(({ file, subagent }) => ({ file, subagent }));
}

function entries(dir: string): string[] {
  try { return readdirSync(dir).sort(); }
  catch { return []; }
}

function codexMeta(file: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    let newline = -1;
    while (newline < 0 && total < MAX_META_BYTES) {
      const chunk = Buffer.alloc(64 * 1024);
      const bytes = readSync(fd, chunk, 0, chunk.length, total);
      if (!bytes) break;
      newline = chunk.subarray(0, bytes).indexOf(10);
      chunks.push(chunk.subarray(0, newline < 0 ? bytes : newline));
      total += bytes;
    }
    const row = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    return row.type === "session_meta" && row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function real(file: string): string {
  try { return realpathSync(file); } catch { return path.resolve(file); }
}

function display(file: string): string {
  const home = os.homedir();
  return file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}
