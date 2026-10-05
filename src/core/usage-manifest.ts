import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { resolveRegularFileWithin, sha256 } from "./hash.js";
import { getPackPath, PACK_DIR_MODE, withPackWriteLock, writeJson } from "./store.js";
import { getCurrentPassport, listTasks, readPassport, readTaskActiveIntervals } from "./tasks.js";
import { addAgentpackOverhead, beforeActivationLine, emptyAgentpackOverhead, formatUsageReport, isSubagentTranscript, readUsageReport, readUsageTimeline, type AgentpackOverhead, type UsageReport } from "./usage.js";

export interface TaskUsageReport {
  kind: "task-usage-report";
  version: 1;
  taskId: string;
  manifest: { path: string; sha256: string };
  coverage: { status: "partial" | "declared-complete"; note: string };
  requests: number;
  totals: UsageReport["totals"];
  agentpackOverhead: AgentpackOverhead;
  agentpackOverheadBeforeActivation: AgentpackOverhead;
  slices: Array<{ phase: string; report: UsageReport }>;
  billedUsd: null;
  warnings: string[];
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid usage manifest fields");
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error("Invalid usage manifest text");
  return value;
}

export interface UsageSourceLink { client: "codex" | "claude"; file: string; turns?: string; phase: string }
export interface UsageCoverage { status: "partial" | "declared-complete"; note: string }
interface UsageManifest { version: 1; taskId: string; coverage: UsageCoverage; sources: UsageSourceLink[] }

const MAX_MANIFEST_BYTES = 1024 * 1024;
const DEFAULT_COVERAGE: UsageCoverage = { status: "partial", note: "Linked and traced sources only; other sessions or clients may be missing." };

/** Explicit local mapping only; no discovery, ledger writes or completeness inference. */
export function buildTaskUsageReport(file: string, cwd: string, byTurn = false): TaskUsageReport {
  let resolved: string;
  let bytes: Buffer;
  try {
    resolved = realpathSync(path.resolve(cwd, file));
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error("Invalid manifest file");
    bytes = readFileSync(resolved);
    if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("Manifest grew beyond limit");
  } catch { throw new Error("Cannot read usage manifest; provide a regular local JSON file of at most 1 MiB"); }
  return reportFromBytes(bytes, resolved, byTurn);
}

export function usageTaskId(root: string, taskId?: string): string {
  if (taskId !== undefined) {
    try { return readPassport(root, taskId).id; }
    catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}. Task usage needs a Task Passport id; for a descriptive label use --client/--file (MCP: client/files).`);
    }
  }
  const current = getCurrentPassport(root);
  if (!current) throw new Error("No current Task Passport; specify a task id");
  return current.id;
}

export function taskUsageManifestPath(root: string, taskId: string): string {
  return getPackPath(root, "usage", `${taskId}.json`);
}

export function hasLinkedTaskUsage(root: string, taskId: string): boolean {
  return existsSync(taskUsageManifestPath(root, taskId));
}

/**
 * Report the sources linked to a Task Passport plus sessions traced to it by
 * Agentpack lifecycle output (passed in by discovery); never other sessions.
 * The report's manifest describes this effective selection.
 */
export function buildLinkedTaskUsageReport(root: string, taskId: string, byTurn = false, traced: UsageSourceLink[] = []): TaskUsageReport {
  const intervals = attributableIntervals(root, taskId);
  const manifest = hasLinkedTaskUsage(root, taskId) ? readLinkedManifest(root, taskId) : emptyManifest(taskId);
  const effective = withTraced(manifest, traced);
  if (!effective.sources.length) throw new Error(`No usage sources linked or traced for ${taskId}`);
  return reportFromBytes(Buffer.from(`${JSON.stringify(effective, null, 2)}\n`), taskUsageManifestPath(root, taskId), byTurn, intervals, preActivationWindows(root, intervals));
}

/**
 * Gaps with no current task that end where this task became current. Null when
 * any task's periods cannot be read: calls are then never guessed into a window.
 */
function preActivationWindows(root: string, intervals: Intervals): PreActivation | null {
  try {
    const listed = listTasks(root);
    if (listed.warnings.length) return null;
    const others = listed.tasks.flatMap(task => readTaskActiveIntervals(root, task.id));
    return intervals.flatMap(({ from }) => {
      const start = Date.parse(from);
      if (others.some(other => Date.parse(other.from) < start && (other.to === null || Date.parse(other.to) > start))) return [];
      const ends = others.flatMap(other => other.to !== null && Date.parse(other.to) <= start ? [other.to] : []);
      return [{ from: ends.length ? ends.reduce((a, b) => Date.parse(b) > Date.parse(a) ? b : a) : null, to: from }];
    });
  } catch { return null; }
}

function emptyManifest(taskId: string): UsageManifest {
  return { version: 1, taskId, coverage: DEFAULT_COVERAGE, sources: [] };
}

function withTraced(manifest: UsageManifest, traced: UsageSourceLink[]): UsageManifest {
  const linked = new Set(manifest.sources.map(source => source.file));
  return { ...manifest, sources: [...manifest.sources, ...traced.filter(source => !linked.has(source.file))] };
}

function attributableIntervals(root: string, taskId: string): Intervals {
  const intervals = readTaskActiveIntervals(root, taskId);
  if (!intervals.length) throw new Error(`${taskId} has never been the current Task Passport here, so no usage can be attributed to it; switch to it first`);
  return intervals;
}

export function readLinkedSourceFiles(root: string, taskId: string): string[] {
  return hasLinkedTaskUsage(root, taskId) ? readLinkedManifest(root, taskId).sources.map(source => source.file) : [];
}

/** Add or replace (by resolved file) explicit task sources after validating the combined report. */
export function linkTaskUsage(root: string, taskId: string, links: UsageSourceLink[], cwd: string, coverage?: UsageCoverage, traced: UsageSourceLink[] = []): TaskUsageReport {
  const intervals = attributableIntervals(root, taskId);
  return withPackWriteLock(root, () => {
    const manifest = hasLinkedTaskUsage(root, taskId) ? readLinkedManifest(root, taskId) : emptyManifest(taskId);
    for (const link of links) {
      let file: string;
      try { file = realpathSync(path.resolve(cwd, link.file)); }
      catch { throw new Error(`Cannot read usage source: ${link.file}`); }
      const source: UsageSourceLink = { client: link.client, file, phase: link.phase, ...(link.turns !== undefined ? { turns: link.turns } : {}) };
      const index = manifest.sources.findIndex(existing => existing.file === file);
      if (index >= 0) manifest.sources[index] = source;
      else manifest.sources.push(source);
    }
    if (coverage) manifest.coverage = coverage;
    return writeLinkedManifest(root, manifest, intervals, traced);
  });
}

/** Remove one linked source by path or session id; returns the remaining source count. */
export function unlinkTaskUsage(root: string, taskId: string, file: string, cwd: string, traced: UsageSourceLink[] = []): number {
  readPassport(root, taskId);
  const absolute = path.resolve(cwd, file);
  let resolved = absolute;
  try { resolved = realpathSync(absolute); } catch { /* a deleted transcript can still be unlinked by its recorded path */ }
  const matches = (source: UsageSourceLink) => source.file === resolved || source.file === absolute;
  const matchesId = (source: UsageSourceLink) => path.basename(source.file, ".jsonl") === file;
  return withPackWriteLock(root, () => {
    const manifest = hasLinkedTaskUsage(root, taskId) ? readLinkedManifest(root, taskId) : emptyManifest(taskId);
    const byPath = manifest.sources.filter(matches);
    const byId = manifest.sources.filter(matchesId);
    if (!byPath.length && byId.length > 1) throw new Error(`Session id ${file} matches ${byId.length} linked sources; unlink by path`);
    const removed = new Set(byPath.length ? byPath : byId);
    const remaining = manifest.sources.filter(source => !removed.has(source));
    if (remaining.length === manifest.sources.length) {
      if (traced.some(source => matches(source) || matchesId(source))) {
        throw new Error(`${file} is traced to ${taskId} by its own Agentpack lifecycle output and is always included; only explicitly linked sources can be unlinked`);
      }
      throw new Error(`Usage source is not linked to ${taskId}: ${file}`);
    }
    // An emptied manifest is kept only to preserve a declared-complete coverage for traced sessions.
    if (!remaining.length && !(manifest.coverage.status === "declared-complete" && traced.length)) {
      rmSync(taskUsageManifestPath(root, taskId));
      return 0;
    }
    // Removing sources cannot create overlap, so the remaining selection needs no revalidation.
    writeJson(taskUsageManifestPath(root, taskId), { ...manifest, sources: remaining });
    return remaining.length;
  });
}

function readLinkedManifest(root: string, taskId: string): UsageManifest {
  const file = resolveRegularFileWithin(getPackPath(root), path.join("usage", `${taskId}.json`), "usage manifest");
  if (statSync(file).size > MAX_MANIFEST_BYTES) throw new Error("Linked usage manifest exceeds 1 MiB");
  let manifest: UsageManifest;
  try { manifest = parseManifest(JSON.parse(readFileSync(file, "utf8")) as unknown, true); }
  catch (error) { throw new Error(`Invalid linked usage manifest for ${taskId}: ${error instanceof Error ? error.message : String(error)}`); }
  if (manifest.taskId !== taskId) throw new Error(`Linked usage manifest belongs to ${manifest.taskId}, not ${taskId}`);
  return manifest;
}

type Intervals = Array<{ from: string; to: string | null }>;
type PreActivation = Array<{ from: string | null; to: string }>;

function writeLinkedManifest(root: string, manifest: UsageManifest, intervals: Intervals, traced: UsageSourceLink[]): TaskUsageReport {
  const file = taskUsageManifestPath(root, manifest.taskId);
  const effective = withTraced(manifest, traced);
  if (!effective.sources.length) throw new Error(`No usage sources linked or traced for ${manifest.taskId}; link sources first`);
  const report = reportFromBytes(Buffer.from(`${JSON.stringify(effective, null, 2)}\n`), file, false, intervals, preActivationWindows(root, intervals));
  mkdirSync(path.dirname(file), { recursive: true, mode: PACK_DIR_MODE });
  writeJson(file, manifest);
  return report;
}

/** Linked manifests may hold only coverage (zero sources) when traced sessions supply the sources. */
function parseManifest(parsed: unknown, allowEmpty = false): UsageManifest {
  const manifest = record(parsed, ["version", "taskId", "coverage", "sources"]);
  if (manifest.version !== 1) throw new Error("Unsupported usage manifest version");
  const taskId = text(manifest.taskId, 240);
  if (!/^task_[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskId)) throw new Error("Usage manifest requires a Task Passport id");
  const coverage = record(manifest.coverage, ["status", "note"]);
  if (coverage.status !== "partial" && coverage.status !== "declared-complete") throw new Error("Invalid usage coverage status");
  const note = text(coverage.note, 2000);
  if (!Array.isArray(manifest.sources) || (!allowEmpty && !manifest.sources.length) || manifest.sources.length > 32) {
    throw new Error("Usage manifest requires 1 to 32 source selections");
  }
  const sources = manifest.sources.map((value): UsageSourceLink => {
    const source = record(value, ["client", "file", "turns", "phase"]);
    if (source.client !== "codex" && source.client !== "claude") throw new Error("Supported usage clients: codex and claude");
    return { client: source.client, file: text(source.file, 4096), phase: text(source.phase, 120),
      ...(source.turns === undefined ? {} : { turns: text(source.turns, 40) }) };
  });
  return { version: 1, taskId, coverage: { status: coverage.status, note }, sources };
}

/**
 * Linked task reports pass the task's active intervals so a session shared by
 * several tasks is split by when each task was current, never counted twice.
 */
function reportFromBytes(bytes: Buffer, resolved: string, byTurn: boolean, intervals: Intervals | null = null, windows: PreActivation | null = null): TaskUsageReport {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Usage manifest must contain valid JSON"); }
  // Task reports (with intervals) may combine an empty linked manifest with traced sessions.
  const { taskId, coverage, sources } = parseManifest(parsed, intervals !== null);
  const seen = new Set<string>();
  const seenBefore = new Set<string>();
  const skippedSubagents: string[] = [];
  const emptySources: string[] = [];
  let repeatedRequests = 0;
  const totals: UsageReport["totals"] = { input: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const agentpackOverhead = emptyAgentpackOverhead();
  const agentpackOverheadBeforeActivation = emptyAgentpackOverhead();
  const slices: TaskUsageReport["slices"] = [];
  let requests = 0;
  for (const { client, file: sourceFile, phase, turns } of sources) {
    // A subagent works for the task that was current when it started, even if
    // the main session switches tasks while it runs: count it whole or not at all.
    let sourceIntervals = intervals;
    let sourceWindows = windows;
    if (intervals && isSubagentTranscript(client, sourceFile)) {
      const start = readUsageTimeline(client, sourceFile, path.dirname(resolved)).requests
        .reduce<number | null>((min, request) => request.at === null ? min : min === null ? request.at : Math.min(min, request.at), null);
      if (start === null) {
        emptySources.push(path.basename(sourceFile, ".jsonl"));
        continue;
      }
      if (!intervals.some(interval => start >= Date.parse(interval.from) && (interval.to === null || start < Date.parse(interval.to)))) {
        skippedSubagents.push(path.basename(sourceFile, ".jsonl"));
        continue;
      }
      sourceIntervals = null;
      sourceWindows = null;
    }
    // Task reports count a request once even when resumed or forked transcripts repeat it;
    // explicit --manifest files keep rejecting overlap below.
    // Sources with no usage at all still fail (wrong client, outside the task's
    // periods, not a transcript); only sources emptied by repeats are skipped.
    const read = readUsageReport({ client, files: [sourceFile], byTurn, ...(turns !== undefined ? { turns } : {}),
      ...(sourceIntervals ? { intervals: sourceIntervals } : {}), ...(intervals ? { exclude: seen } : {}),
      ...(sourceWindows ? { preActivation: sourceWindows, excludeBeforeActivation: seenBefore } : {}) }, path.dirname(resolved));
    const { report, requestIds } = read;
    repeatedRequests += read.excludedRequests;
    if (!report.requests) {
      emptySources.push(path.basename(sourceFile, ".jsonl"));
      continue;
    }
    for (const id of requestIds) {
      if (seen.has(id)) throw new Error("Overlapping usage selections; a request appears in more than one manifest source");
      seen.add(id);
    }
    for (const id of read.beforeActivationRequestIds) seenBefore.add(id);
    requests += report.requests;
    addAgentpackOverhead(agentpackOverhead, report.agentpackOverhead);
    if (report.agentpackOverheadBeforeActivation) addAgentpackOverhead(agentpackOverheadBeforeActivation, report.agentpackOverheadBeforeActivation);
    for (const key of ["input", "uncachedInput", "cacheRead", "cacheWrite", "output"] as const) {
      totals[key] += report.totals[key];
      if (!Number.isSafeInteger(totals[key])) throw new Error("Usage manifest totals exceed safe integer range");
    }
    totals.reasoning = totals.reasoning === null || report.totals.reasoning === null ? null : totals.reasoning + report.totals.reasoning;
    if (totals.reasoning !== null && !Number.isSafeInteger(totals.reasoning)) throw new Error("Usage manifest totals exceed safe integer range");
    slices.push({ phase, report });
  }
  return { kind: "task-usage-report", version: 1, taskId, manifest: { path: resolved, sha256: sha256(bytes) },
    coverage, requests, totals, agentpackOverhead, agentpackOverheadBeforeActivation, slices, billedUsd: null,
    warnings: [...new Set(["Coverage is declared by the manifest author; it is not independently verified.",
      ...(intervals ? ["Only requests made while the task was the current Passport are counted; sessions shared with other tasks are split by those periods. Subagent sessions count whole for the task that was current when they started."] : []),
      ...(intervals && !windows ? ["Agentpack overhead before activation is unavailable: another task's active periods could not be read."] : []),
      ...(skippedSubagents.length ? [`Subagent sessions started while another task was current are not counted: ${skippedSubagents.join(", ")}.`] : []),
      ...(emptySources.length ? [`Sources without new requests while the task was current: ${emptySources.join(", ")}.`] : []),
      ...(repeatedRequests ? [`${repeatedRequests} request(s) repeated across sources (resumed or forked sessions) were counted once.`] : []),
      "Session monetary estimates are not combined into task monetary cost.",
      ...slices.flatMap(slice => slice.report.warnings)])] };
}

export function formatTaskUsageReport(report: TaskUsageReport): string {
  return [`Task usage: ${report.taskId}`, `Coverage: ${report.coverage.status} — ${report.coverage.note}`,
    `Requests: ${report.requests}`, `Input: ${report.totals.input} (cache read ${report.totals.cacheRead}, cache write ${report.totals.cacheWrite}, uncached ${report.totals.uncachedInput})`,
    `Output: ${report.totals.output} (reasoning ${report.totals.reasoning ?? "unknown"})`,
    `Agentpack: ${report.agentpackOverhead.calls} calls; response ~${report.agentpackOverhead.responseTokens} tokens; later-context <=${report.agentpackOverhead.rereadTokensUpperBound}; invoking-output <=${report.agentpackOverhead.outputTokensUpperBound}`,
    ...(report.agentpackOverheadBeforeActivation.calls || report.agentpackOverheadBeforeActivation.rereadTokensUpperBound ? [beforeActivationLine(report.agentpackOverheadBeforeActivation)] : []),
    "Task monetary cost: unavailable", ...report.warnings.map(warning => `Warning: ${warning}`),
    ...report.slices.map(slice => `\nPhase: ${slice.phase}\n${formatUsageReport({ ...slice.report, warnings: [] })}`)].join("\n");
}
