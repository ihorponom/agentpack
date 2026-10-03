import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { resolveRegularFileWithin, sha256 } from "./hash.js";
import { getPackPath, PACK_DIR_MODE, withPackWriteLock, writeJson } from "./store.js";
import { getCurrentPassport, readPassport, readTaskActiveIntervals } from "./tasks.js";
import { formatUsageReport, readUsageReport, type UsageReport } from "./usage.js";

export interface TaskUsageReport {
  kind: "task-usage-report";
  version: 1;
  taskId: string;
  manifest: { path: string; sha256: string };
  coverage: { status: "partial" | "declared-complete"; note: string };
  requests: number;
  totals: UsageReport["totals"];
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
const DEFAULT_COVERAGE: UsageCoverage = { status: "partial", note: "Linked sources only; other sessions or clients may be missing." };

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

/** Report the sources explicitly linked to a Task Passport; never sums unlinked sessions. */
export function buildLinkedTaskUsageReport(root: string, taskId: string, byTurn = false): TaskUsageReport {
  const intervals = readTaskActiveIntervals(root, taskId);
  if (!hasLinkedTaskUsage(root, taskId)) throw new Error(`No usage sources linked to ${taskId}`);
  const file = resolveRegularFileWithin(getPackPath(root), path.join("usage", `${taskId}.json`), "usage manifest");
  if (statSync(file).size > MAX_MANIFEST_BYTES) throw new Error("Linked usage manifest exceeds 1 MiB");
  const report = reportFromBytes(readFileSync(file), file, byTurn, intervals);
  if (report.taskId !== taskId) throw new Error(`Linked usage manifest belongs to ${report.taskId}, not ${taskId}`);
  return report;
}

export function readLinkedSourceFiles(root: string, taskId: string): string[] {
  return hasLinkedTaskUsage(root, taskId) ? readLinkedManifest(root, taskId).sources.map(source => source.file) : [];
}

/** Add or replace (by resolved file) explicit task sources after validating the combined report. */
export function linkTaskUsage(root: string, taskId: string, links: UsageSourceLink[], cwd: string, coverage?: UsageCoverage): TaskUsageReport {
  const intervals = readTaskActiveIntervals(root, taskId);
  return withPackWriteLock(root, () => {
    const manifest = hasLinkedTaskUsage(root, taskId)
      ? readLinkedManifest(root, taskId)
      : { version: 1 as const, taskId, coverage: DEFAULT_COVERAGE, sources: [] };
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
    return writeLinkedManifest(root, manifest, intervals);
  });
}

/** Remove one linked source by path or session id; returns the remaining source count. */
export function unlinkTaskUsage(root: string, taskId: string, file: string, cwd: string): number {
  const intervals = readTaskActiveIntervals(root, taskId);
  return withPackWriteLock(root, () => {
    if (!hasLinkedTaskUsage(root, taskId)) throw new Error(`No usage sources linked to ${taskId}`);
    const manifest = readLinkedManifest(root, taskId);
    const absolute = path.resolve(cwd, file);
    let resolved = absolute;
    try { resolved = realpathSync(absolute); } catch { /* a deleted transcript can still be unlinked by its recorded path */ }
    const remaining = manifest.sources.filter(source => source.file !== resolved && source.file !== absolute
      && path.basename(source.file, ".jsonl") !== file);
    if (remaining.length === manifest.sources.length) throw new Error(`Usage source is not linked to ${taskId}: ${file}`);
    if (!remaining.length) {
      rmSync(taskUsageManifestPath(root, taskId));
      return 0;
    }
    writeLinkedManifest(root, { ...manifest, sources: remaining }, intervals);
    return remaining.length;
  });
}

function readLinkedManifest(root: string, taskId: string): UsageManifest {
  const file = resolveRegularFileWithin(getPackPath(root), path.join("usage", `${taskId}.json`), "usage manifest");
  if (statSync(file).size > MAX_MANIFEST_BYTES) throw new Error("Linked usage manifest exceeds 1 MiB");
  let manifest: UsageManifest;
  try { manifest = parseManifest(JSON.parse(readFileSync(file, "utf8")) as unknown); }
  catch (error) { throw new Error(`Invalid linked usage manifest for ${taskId}: ${error instanceof Error ? error.message : String(error)}`); }
  if (manifest.taskId !== taskId) throw new Error(`Linked usage manifest belongs to ${manifest.taskId}, not ${taskId}`);
  return manifest;
}

type Intervals = Array<{ from: string; to: string | null }>;

function writeLinkedManifest(root: string, manifest: UsageManifest, intervals: Intervals): TaskUsageReport {
  const file = taskUsageManifestPath(root, manifest.taskId);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const report = reportFromBytes(Buffer.from(text), file, false, intervals);
  mkdirSync(path.dirname(file), { recursive: true, mode: PACK_DIR_MODE });
  writeJson(file, manifest);
  return report;
}

function parseManifest(parsed: unknown): UsageManifest {
  const manifest = record(parsed, ["version", "taskId", "coverage", "sources"]);
  if (manifest.version !== 1) throw new Error("Unsupported usage manifest version");
  const taskId = text(manifest.taskId, 240);
  if (!/^task_[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskId)) throw new Error("Usage manifest requires a Task Passport id");
  const coverage = record(manifest.coverage, ["status", "note"]);
  if (coverage.status !== "partial" && coverage.status !== "declared-complete") throw new Error("Invalid usage coverage status");
  const note = text(coverage.note, 2000);
  if (!Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.length > 32) {
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
function reportFromBytes(bytes: Buffer, resolved: string, byTurn: boolean, intervals: Intervals | null = null): TaskUsageReport {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Usage manifest must contain valid JSON"); }
  const { taskId, coverage, sources } = parseManifest(parsed);
  const seen = new Set<string>();
  const totals: UsageReport["totals"] = { input: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const slices: TaskUsageReport["slices"] = [];
  let requests = 0;
  for (const { client, file: sourceFile, phase, turns } of sources) {
    const { report, requestIds } = readUsageReport({ client, files: [sourceFile], byTurn,
      ...(turns !== undefined ? { turns } : {}), ...(intervals ? { intervals } : {}) }, path.dirname(resolved));
    for (const id of requestIds) {
      if (seen.has(id)) throw new Error("Overlapping usage selections; a request appears in more than one manifest source");
      seen.add(id);
    }
    requests += report.requests;
    for (const key of ["input", "uncachedInput", "cacheRead", "cacheWrite", "output"] as const) {
      totals[key] += report.totals[key];
      if (!Number.isSafeInteger(totals[key])) throw new Error("Usage manifest totals exceed safe integer range");
    }
    totals.reasoning = totals.reasoning === null || report.totals.reasoning === null ? null : totals.reasoning + report.totals.reasoning;
    if (totals.reasoning !== null && !Number.isSafeInteger(totals.reasoning)) throw new Error("Usage manifest totals exceed safe integer range");
    slices.push({ phase, report });
  }
  return { kind: "task-usage-report", version: 1, taskId, manifest: { path: resolved, sha256: sha256(bytes) },
    coverage, requests, totals, slices, billedUsd: null,
    warnings: [...new Set(["Coverage is declared by the manifest author; it is not independently verified.",
      ...(intervals ? ["Only requests made while the task was the current Passport are counted; sessions shared with other tasks are split by those periods."] : []),
      "Session monetary estimates are not combined into task monetary cost.",
      ...slices.flatMap(slice => slice.report.warnings)])] };
}

export function formatTaskUsageReport(report: TaskUsageReport): string {
  return [`Task usage: ${report.taskId}`, `Coverage: ${report.coverage.status} — ${report.coverage.note}`,
    `Requests: ${report.requests}`, `Input: ${report.totals.input} (cache read ${report.totals.cacheRead}, cache write ${report.totals.cacheWrite}, uncached ${report.totals.uncachedInput})`,
    `Output: ${report.totals.output} (reasoning ${report.totals.reasoning ?? "unknown"})`,
    "Task monetary cost: unavailable", ...report.warnings.map(warning => `Warning: ${warning}`),
    ...report.slices.map(slice => `\nPhase: ${slice.phase}\n${formatUsageReport({ ...slice.report, warnings: [] })}`)].join("\n");
}
