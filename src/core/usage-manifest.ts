import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./hash.js";
import { formatUsageReport, readUsageReport, type UsageReport } from "./usage.js";

export interface TaskUsageReport {
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

/** Explicit local mapping only; no discovery, ledger writes or completeness inference. */
export function buildTaskUsageReport(file: string, cwd: string, byTurn = false): TaskUsageReport {
  let resolved: string;
  let bytes: Buffer;
  try {
    resolved = realpathSync(path.resolve(cwd, file));
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid manifest file");
    bytes = readFileSync(resolved);
    if (bytes.length > 1024 * 1024) throw new Error("Manifest grew beyond limit");
  } catch { throw new Error("Cannot read usage manifest; provide a regular local JSON file of at most 1 MiB"); }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Usage manifest must contain valid JSON"); }
  const manifest = record(parsed, ["version", "taskId", "coverage", "sources"]);
  if (manifest.version !== 1) throw new Error("Unsupported usage manifest version");
  const taskId = text(manifest.taskId, 240);
  if (!/^task_[A-Za-z0-9_-]+$/u.test(taskId)) throw new Error("Usage manifest requires a Task Passport id");
  const coverage = record(manifest.coverage, ["status", "note"]);
  if (coverage.status !== "partial" && coverage.status !== "declared-complete") throw new Error("Invalid usage coverage status");
  const note = text(coverage.note, 2000);
  if (!Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.length > 32) {
    throw new Error("Usage manifest requires 1 to 32 source selections");
  }
  const seen = new Set<string>();
  const totals: UsageReport["totals"] = { input: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const slices: TaskUsageReport["slices"] = [];
  let requests = 0;
  for (const value of manifest.sources) {
    const source = record(value, ["client", "file", "turns", "phase"]);
    if (source.client !== "codex" && source.client !== "claude") throw new Error("Supported usage clients: codex and claude");
    const sourceFile = text(source.file, 4096);
    const phase = text(source.phase, 120);
    const turns = source.turns === undefined ? undefined : text(source.turns, 40);
    const { report, requestIds } = readUsageReport({ client: source.client, files: [sourceFile], byTurn,
      ...(turns !== undefined ? { turns } : {}) }, path.dirname(resolved));
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
  return { version: 1, taskId, manifest: { path: resolved, sha256: sha256(bytes) },
    coverage: { status: coverage.status, note }, requests, totals, slices, billedUsd: null,
    warnings: [...new Set(["Coverage is declared by the manifest author; it is not independently verified.",
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
