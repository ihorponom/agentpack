import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPassport, readTaskActiveIntervals } from "./tasks.js";
import {
  buildLinkedTaskUsageReport,
  formatTaskUsageReport,
  linkTaskUsage,
  readLinkedSourceFiles,
  unlinkTaskUsage,
  type TaskUsageReport,
  type UsageSourceLink
} from "./usage-manifest.js";
import { readCodexSessionMeta, readUsageTimeline } from "./usage.js";

export interface UsageCandidate {
  number: number;
  /** Stable session id (file name without .jsonl); prefer it over number when picking later. */
  id: string;
  client: "codex" | "claude";
  file: string;
  subagent: boolean;
  started: string | null;
  requests: number;
  /** Requests counted for the task: those made while it was current, or the whole subagent session if it started then. */
  taskRequests: number;
  /** The session's own Agentpack output started, switched to or loaded this task; traced sessions (and their subagents) are counted without linking. */
  traced: boolean;
  linked: boolean;
}

export interface UsageCandidates {
  kind: "task-usage-candidates";
  taskId: string;
  linked: boolean;
  intervals: Array<{ from: string; to: string | null }>;
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

export type TaskUsageView = TaskUsageReport | UsageCandidates;

export type UsageLinkResult = UsageCandidates
  | { kind: "task-usage-unlink"; taskId: string; removed: string; remaining: number }
  | { kind: "task-usage-link"; taskId: string; linked: string[]; report: TaskUsageReport };

/** key identifies a main session; parent names the main session a subagent belongs to. */
interface SourceFile { file: string; subagent: boolean; key: string; parent?: string }

const MAX_FILES_PER_CLIENT = 200;
const MAX_CODEX_DAYS = 120;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
// File mtimes can lag the wall clock (coarse filesystem timestamps); the mtime
// check only skips clearly older files, request times decide attribution.
const MTIME_SLACK_MS = 60 * 1000;

/**
 * Suggest Claude Code/Codex sessions recorded in the task worktree that have
 * requests while the task was current. Suggestions only; linking stays explicit.
 */
export function findUsageCandidates(root: string, taskId: string, env: NodeJS.ProcessEnv = process.env): UsageCandidates {
  const passport = readPassport(root, taskId);
  const intervals = readTaskActiveIntervals(root, taskId);
  const periods = intervals.map(interval => [Date.parse(interval.from), interval.to === null ? null : Date.parse(interval.to)] as const);
  const linked = new Set(readLinkedSourceFiles(root, taskId));
  const warnings: string[] = [];
  if (!periods.length) {
    warnings.push("This task has never been the current Task Passport here, so no usage can be attributed to it; switch to it first.");
    return { kind: "task-usage-candidates", taskId, linked: linked.size > 0, intervals, searched: [], warnings, candidates: [] };
  }
  const from = periods[0]![0];
  const to = periods[periods.length - 1]![1];
  const worktree = path.resolve(passport.worktree);
  const home = os.homedir();
  // Claude Code names project directories after the session cwd with every
  // non-alphanumeric character replaced by "-".
  const claudeDir = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects", worktree.replace(/[^A-Za-z0-9]/gu, "-"));
  const codexDir = path.join(env.CODEX_HOME || path.join(home, ".codex"), "sessions");
  const found: Array<Omit<UsageCandidate, "number">> = [];
  const parents = new Map<Omit<UsageCandidate, "number">, string | undefined>();
  const tracedKeys = new Set<string>();
  const sources = [
    ["claude", claudeFiles(claudeDir, from, warnings)],
    ["codex", codexFiles(codexDir, real(worktree), from, to, warnings)]
  ] as const;
  for (const [client, files] of sources) {
    for (const source of files) {
      const inspected = inspect(client, source, periods, warnings, taskId);
      if (!inspected) continue;
      const candidate = { ...inspected, linked: linked.has(inspected.file) };
      found.push(candidate);
      parents.set(candidate, source.parent);
      if (candidate.traced) tracedKeys.add(source.key);
    }
  }
  for (const candidate of found) {
    const parent = parents.get(candidate);
    if (candidate.subagent && parent !== undefined && tracedKeys.has(parent)) candidate.traced = true;
  }
  found.sort((a, b) => (a.started || "￿").localeCompare(b.started || "￿") || a.file.localeCompare(b.file));
  return {
    kind: "task-usage-candidates", taskId, linked: linked.size > 0,
    intervals,
    searched: [claudeDir, codexDir], warnings,
    candidates: found.map((candidate, index) => ({ number: index + 1, ...candidate }))
  };
}

/**
 * Task usage for CLI, MCP and TUI: the report of linked plus traced sessions,
 * or the candidate list when neither exists. Reading never writes.
 */
export function buildTaskUsage(root: string, taskId: string, byTurn = false, env: NodeJS.ProcessEnv = process.env): TaskUsageView {
  const found = findUsageCandidates(root, taskId, env);
  const traced = tracedLinks(found);
  if (!readLinkedSourceFiles(root, taskId).length && !traced.length) return found;
  const report = buildLinkedTaskUsageReport(root, taskId, byTurn, traced);
  const others = found.candidates.filter(candidate => !candidate.traced && !candidate.linked).length;
  if (others) report.warnings.push(`${others} other candidate session(s) of this worktree are not included; review them with agentpack usage link --task ${taskId}.`);
  return report;
}

export function formatTaskUsage(view: TaskUsageView): string {
  return view.kind === "task-usage-report" ? formatTaskUsageReport(view) : formatUsageCandidates(view);
}

function tracedLinks(found: UsageCandidates): UsageSourceLink[] {
  return found.candidates.filter(candidate => candidate.traced).map(candidate => ({ client: candidate.client, file: candidate.file, phase: "traced" }));
}

/** Shared CLI/MCP link semantics: list, pick, explicit file, coverage or remove. */
export function runUsageLink(root: string, taskId: string, request: UsageLinkRequest, cwd: string, env: NodeJS.ProcessEnv = process.env): UsageLinkResult {
  const has = (key: keyof UsageLinkRequest) => request[key] !== undefined;
  const found = findUsageCandidates(root, taskId, env);
  const traced = tracedLinks(found);
  if (has("remove")) {
    if ((Object.keys(request) as Array<keyof UsageLinkRequest>).some(key => key !== "remove" && has(key))) throw new Error("remove cannot be combined with link options");
    const remaining = unlinkTaskUsage(root, taskId, request.remove!, cwd, traced);
    return { kind: "task-usage-unlink", taskId, removed: request.remove!, remaining };
  }
  if (has("coverage") && request.coverage !== "partial" && request.coverage !== "declared-complete") throw new Error("coverage requires partial or declared-complete");
  if (has("coverage") !== has("note")) throw new Error("coverage and note must be supplied together");
  const coverage = request.coverage !== undefined ? { status: request.coverage as "partial" | "declared-complete", note: request.note! } : undefined;
  const phase = request.phase ?? "main";
  let links: UsageSourceLink[];
  if (has("pick")) {
    if (has("client") || has("file") || has("turns")) throw new Error("pick links the suggested selection; use client, file and turns for a custom one");
    links = pickUsageCandidates(found, request.pick!, phase);
  } else if (has("client") || has("file")) {
    if (request.client !== "codex" && request.client !== "claude") throw new Error("Linking a file requires client codex or claude");
    if (!has("file")) throw new Error("Linking requires a file with client");
    links = [{ client: request.client, file: request.file!, phase, ...(has("turns") ? { turns: request.turns! } : {}) }];
  } else {
    if (has("turns") || has("phase")) throw new Error("turns and phase require pick or file");
    if (!coverage) return found;
    if (!readLinkedSourceFiles(root, taskId).length && !traced.length) throw new Error(`No usage sources linked or traced for ${taskId}; link sources before declaring coverage`);
    links = [];
  }
  const report = linkTaskUsage(root, taskId, links, cwd, coverage, traced);
  return { kind: "task-usage-link", taskId, linked: links.map(link => path.basename(link.file)), report };
}

export function formatUsageLinkResult(result: UsageLinkResult): string {
  if (result.kind === "task-usage-candidates") return formatUsageCandidates(result);
  if (result.kind === "task-usage-unlink") return `Unlinked usage source from ${result.taskId}; ${result.remaining} linked source(s) remain.`;
  const linked = result.linked.length ? `Linked to ${result.taskId}: ${result.linked.join(", ")}` : `Updated coverage for ${result.taskId}`;
  return `${linked} (${result.report.slices.length} source(s) in the task report).\n\n${formatTaskUsageReport(result.report)}`;
}

/** Resolve picks (candidate numbers or stable session ids) against a fresh discovery. */
function pickUsageCandidates(found: UsageCandidates, picks: Array<number | string>, phase: string): UsageSourceLink[] {
  const { candidates, taskId } = found;
  return picks.map(pick => {
    const matches = candidates.filter(item => typeof pick === "number" ? item.number === pick : item.id === pick);
    if (matches.length > 1) throw new Error(`Usage candidate ${pick} is ambiguous; link it with an explicit file`);
    const candidate = matches[0];
    if (!candidate) throw new Error(`No usage candidate ${pick} for ${taskId}; list candidates first`);
    return { client: candidate.client, file: candidate.file, phase };
  });
}

export function formatUsageCandidates(result: UsageCandidates): string {
  const lines = [
    `Task usage: ${result.taskId}`,
    result.linked ? "Linked sources exist; candidates marked [linked] are already included." : "No usage sources linked yet.",
    `Task was current: ${result.intervals.map(interval => `${interval.from} to ${interval.to || "now"}`).join("; ") || "never"}`,
    ...(result.searched.length ? [`Searched: ${result.searched.map(display).join(", ")}`] : []),
    ...result.warnings.map(warning => `Warning: ${warning}`),
    ""
  ];
  if (!result.candidates.length) {
    lines.push("No Claude Code or Codex sessions of this worktree have requests while the task was current.",
      `Link a source explicitly: agentpack usage link --task ${result.taskId} --client claude|codex --file <jsonl> [--turns N|N:|N:M]`);
    return lines.join("\n");
  }
  lines.push("Candidate sessions. [traced] ones ran Agentpack for this task and are counted automatically; others count only after linking. Counts cover requests made while the task was current (subagents: whole session if started then):");
  for (const c of result.candidates) {
    lines.push(`${c.number}. ${c.id} (${c.client}${c.subagent ? " subagent" : ""})${c.traced ? " [traced]" : ""}${c.linked ? " [linked]" : ""}`,
      `   started ${c.started || "unknown"}; ${c.taskRequests}/${c.requests} requests counted for the task`,
      `   ${display(c.file)}`);
  }
  lines.push("", `Link: agentpack usage link --task ${result.taskId} --pick <number or session id>[,...]`,
    `Then: agentpack usage report --task ${result.taskId}`);
  return lines.join("\n");
}

function inspect(client: "codex" | "claude", source: SourceFile, periods: ReadonlyArray<readonly [number, number | null]>, warnings: string[], taskId: string): Omit<UsageCandidate, "number" | "linked"> | null {
  let timeline;
  try { timeline = readUsageTimeline(client, source.file, path.dirname(source.file)); }
  catch (error) {
    // Files without usage records are ordinary (metadata-only sessions); real read or parse failures are disclosed.
    if (!(error instanceof Error && error.message.startsWith("No supported usage records"))) {
      warnings.push(`Skipped unreadable ${client} session ${path.basename(source.file, ".jsonl")}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
  const inPeriods = (at: number) => periods.some(([start, end]) => at >= start && (end === null || at < end));
  const times = timeline.requests.flatMap(request => request.at === null ? [] : [request.at]);
  const { report } = timeline;
  const taskRequests = source.subagent
    ? (times.length && inPeriods(times.reduce((min, at) => Math.min(min, at))) ? report.requests : 0)
    : times.filter(inPeriods).length;
  if (!taskRequests) return null;
  const file = report.sources[0]?.path || source.file;
  return {
    id: path.basename(file, ".jsonl"), client, file, subagent: source.subagent,
    started: report.turns?.find(turn => turn.start !== null)?.start || null,
    requests: report.requests, taskRequests, traced: !source.subagent && hasAgentpackTrace(source.file, taskId)
  };
}

/** Agentpack lifecycle output naming the task: start, switch, or a resume/load_context showing it as current. */
function hasAgentpackTrace(file: string, taskId: string): boolean {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return false; }
  const id = taskId.replace(/[.]/gu, "\\.");
  return new RegExp(`(?:Started task|Switched to task) ${id}(?![A-Za-z0-9_-])|Current Task Passport(?:\\\\n|\\n)- ID: ${id}(?![A-Za-z0-9_-])`, "u").test(text);
}

function claudeFiles(dir: string, from: number, warnings: string[]): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of entries(dir)) {
    const file = path.join(dir, entry);
    if (entry.endsWith(".jsonl")) files.push({ file, subagent: false, key: file });
    else for (const child of entries(path.join(file, "subagents"))) {
      if (child.endsWith(".jsonl")) files.push({ file: path.join(file, "subagents", child), subagent: true, key: path.join(file, "subagents", child), parent: `${file}.jsonl` });
    }
  }
  return recent(files, from, warnings, "Claude Code");
}

function codexFiles(dir: string, worktree: string, from: number, to: number | null, warnings: string[]): SourceFile[] {
  const files: string[] = [];
  const end = to ?? Date.now();
  const start = Math.max(from - DAY_MS, end - MAX_CODEX_DAYS * DAY_MS);
  if (start > from - DAY_MS) warnings.push(`Codex sessions were searched only for the last ${MAX_CODEX_DAYS} days of the task; link earlier sessions explicitly.`);
  // Rollout directories use local calendar dates; step by date (DST-safe) with one extra day on each side.
  const last = new Date(end + DAY_MS);
  for (let date = new Date(start); date <= last; date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)) {
    const dayDir = path.join(dir, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
    for (const entry of entries(dayDir)) if (entry.endsWith(".jsonl")) files.push(path.join(dayDir, entry));
  }
  const matched: SourceFile[] = [];
  for (const file of new Set(files)) {
    const meta = readCodexSessionMeta(file);
    if (typeof meta?.cwd !== "string" || real(meta.cwd) !== worktree) continue;
    const parent = typeof meta.parent_thread_id === "string" ? `codex:${meta.parent_thread_id}` : undefined;
    matched.push({ file, subagent: meta.thread_source === "subagent", key: `codex:${String(meta.id)}`, ...(parent ? { parent } : {}) });
  }
  return recent(matched, from, warnings, "Codex");
}

function recent(files: SourceFile[], from: number, warnings: string[], label: string): SourceFile[] {
  const stats: Array<SourceFile & { mtime: number }> = [];
  for (const source of files) {
    try {
      const stat = statSync(source.file);
      if (!stat.isFile() || stat.mtimeMs < from - MTIME_SLACK_MS) continue;
      if (stat.size > MAX_FILE_BYTES) warnings.push(`Skipped ${label} session ${path.basename(source.file, ".jsonl")}: larger than 64 MiB.`);
      else stats.push({ ...source, mtime: stat.mtimeMs });
    } catch { /* unreadable transcripts are not candidates */ }
  }
  if (stats.length > MAX_FILES_PER_CLIENT) warnings.push(`Only the ${MAX_FILES_PER_CLIENT} most recently updated ${label} sessions were inspected; link others explicitly.`);
  return stats.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES_PER_CLIENT).map(({ mtime: _mtime, ...source }) => source);
}

function entries(dir: string): string[] {
  try { return readdirSync(dir).sort(); }
  catch { return []; }
}

function real(file: string): string {
  try { return realpathSync(file); } catch { return path.resolve(file); }
}

function display(file: string): string {
  const home = os.homedir();
  return file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}
