import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./hash.js";

export interface UsageOptions {
  client: "codex" | "claude";
  files: string[];
  task?: string;
  from?: string;
  to?: string;
  byTurn?: boolean;
  turns?: string;
  /** Task reports: keep only requests inside these periods (end exclusive; null = open). */
  intervals?: Array<{ from: string; to: string | null }>;
  /** Task reports: request identities already counted from another source (resumed or forked sessions). */
  exclude?: ReadonlySet<string>;
}

interface Tokens {
  input: number;
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number | null;
}

interface RequestUsage {
  model: string;
  tokens: Tokens;
  turnKey: string | null;
  at: number | null;
}

interface UsageTurn {
  source: number;
  turn: number;
  start: string | null;
  durationMs: number | null;
  complete: boolean | null;
  boundary: "client turn" | "user message";
  requests: number;
  tokens: Tokens;
}

interface UsageSource {
  path: string;
  sha256: string;
  malformedLines: number;
  invalidUsage: number;
  missingTimestamps: number;
  usageRecords: number;
  cumulativeCheck: "matched" | "mismatch" | "unavailable" | "time-filtered" | "turn-filtered";
  cost: { usd: number | null; basis: "client-session estimate"; reason: string };
}

export interface UsageReport {
  version: 1;
  client: UsageOptions["client"];
  task: string | null;
  boundary: { from: string | null; to: string | null; selection: string; intervals?: Array<{ from: string; to: string | null }> };
  requests: number;
  duplicateRecords: number;
  duplicateFiles: number;
  totals: Tokens;
  models: Array<{ model: string; requests: number; tokens: Tokens }>;
  sources: UsageSource[];
  warnings: string[];
  billedUsd: null;
  turnSelection: string | null;
  turns?: UsageTurn[];
  unassignedRequests: number;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const identifier = /^[A-Za-z0-9._<>:/-]{1,160}$/u;
const fields = ["input", "uncachedInput", "cacheRead", "cacheWrite", "output"] as const;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Invalid token count");
  }
  return value as number;
}

function optionalCount(value: unknown): number {
  return value === undefined ? 0 : count(value);
}

function label(value: unknown): string {
  return typeof value === "string" && identifier.test(value) ? value : "unknown";
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(value)) {
    return null;
  }
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function boundary(value: string | undefined, name: string): number | null {
  if (value === undefined) return null;
  const result = timestamp(value);
  if (result === null) throw new Error(`${name} requires an ISO timestamp with timezone`);
  return result;
}

function normalize(client: UsageOptions["client"], value: unknown): Tokens {
  const u = object(value);
  const output = count(u.output_tokens);
  const reasoningValue = client === "codex" ? u.reasoning_output_tokens : object(u.output_tokens_details).thinking_tokens;
  const reasoning = reasoningValue === undefined ? null : count(reasoningValue);
  if (reasoning !== null && reasoning > output) throw new Error("Invalid reasoning subset");
  const rawInput = count(u.input_tokens);
  const cacheRead = client === "codex" ? count(u.cached_input_tokens) : count(u.cache_read_input_tokens);
  const cacheWrite = optionalCount(client === "codex" ? u.cache_write_input_tokens : u.cache_creation_input_tokens);
  const input = client === "codex" ? rawInput : rawInput + cacheRead + cacheWrite;
  const uncachedInput = client === "codex" ? input - cacheRead - cacheWrite : rawInput;
  if (!Number.isSafeInteger(input) || uncachedInput < 0) throw new Error("Invalid cache subset");
  if (client === "codex" && u.total_tokens !== undefined && count(u.total_tokens) !== input + output) {
    throw new Error("Inconsistent total tokens");
  }
  return { input, uncachedInput, cacheRead, cacheWrite, output, reasoning };
}

function emptyTokens(): Tokens {
  return { input: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}

function addTokens(total: Tokens, tokens: Tokens): void {
  for (const field of fields) {
    const a = total[field];
    const b = tokens[field];
    const sum = a + b;
    if (!Number.isSafeInteger(sum)) throw new Error("Token aggregate exceeds safe integer range");
    total[field] = sum;
  }
  total.reasoning = total.reasoning === null || tokens.reasoning === null ? null : total.reasoning + tokens.reasoning;
}

function clientCost(row: Record<string, unknown>, bounded: boolean): UsageSource["cost"] {
  const unavailable = (reason: string): UsageSource["cost"] => ({ usd: null, basis: "client-session estimate", reason });
  if (bounded) return unavailable("Session cost cannot be attributed to selected turns or a time range");
  if (row.hasUnknownModelCost !== false) return unavailable("Client cost has unknown or unspecified model pricing");
  if (typeof row.totalCostUSD !== "number" || !Number.isFinite(row.totalCostUSD) || row.totalCostUSD < 0) {
    return unavailable("Invalid client cost snapshot");
  }
  return { usd: row.totalCostUSD, basis: "client-session estimate", reason: "Cumulative client snapshot; may cover more than visible records. Not verified charges; do not sum across overlapping sessions." };
}

/** Read explicit local sources only. Never write ledger state or infer billing rates. */
export function buildUsageReport(options: UsageOptions, cwd: string): UsageReport {
  return parseUsageReport(options, cwd).report;
}

/** First-line Codex session_meta payload (bounded read), or null. */
export function readCodexSessionMeta(file: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    let newline = -1;
    while (newline < 0 && total < 1024 * 1024) {
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

/** Claude subagent transcripts live under <session>/subagents/; Codex marks them in session_meta. */
export function isSubagentTranscript(client: UsageOptions["client"], file: string): boolean {
  return client === "claude" ? file.split(path.sep).includes("subagents") : isCodexChildThread(readCodexSessionMeta(file));
}

/** Codex child threads (subagents, guardian reviews) name a parent thread or a subagent source. */
export function isCodexChildThread(meta: Record<string, unknown> | null): boolean {
  if (!meta) return false;
  const source = meta.source && typeof meta.source === "object" ? meta.source as Record<string, unknown> : {};
  return meta.thread_source === "subagent" || typeof meta.parent_thread_id === "string" || source.subagent !== undefined;
}

/** Request times and source-local turns for one source, without request identities or content. */
export function readUsageTimeline(client: UsageOptions["client"], file: string, cwd: string): { report: UsageReport; requests: Array<{ at: number | null; turn: number | null }> } {
  const { report, requests, turnGroups } = parseUsageReport({ client, files: [file], byTurn: true }, cwd);
  return { report, requests: [...requests.values()].map(request => ({ at: request.at,
    turn: request.turnKey ? turnGroups.get(request.turnKey)?.turn ?? null : null })) };
}

/** Internal request identities allow manifest aggregation to reject overlap. */
export function readUsageReport(options: UsageOptions, cwd: string): { report: UsageReport; requestIds: string[]; excludedRequests: number } {
  const { report, requests, excludedRequests } = parseUsageReport(options, cwd);
  return { report, requestIds: [...requests.keys()].map(key => `${options.client}:${key}`), excludedRequests };
}

function parseUsageReport(options: UsageOptions, cwd: string): { report: UsageReport; requests: Map<string, RequestUsage>; turnGroups: Map<string, UsageTurn>; excludedRequests: number } {
  if (options.client !== "codex" && options.client !== "claude") throw new Error("Usage supports codex or claude JSONL sources");
  if (!options.files.length) throw new Error("Usage requires at least one --file");
  const from = boundary(options.from, "--from");
  const to = boundary(options.to, "--to");
  if (from !== null && to !== null && from >= to) throw new Error("--from must be earlier than --to");
  if (options.intervals && (from !== null || to !== null)) throw new Error("Task intervals cannot be combined with --from or --to");
  const intervals = options.intervals?.map(interval => [boundary(interval.from, "interval start")!, boundary(interval.to ?? undefined, "interval end")] as const);
  const bounded = from !== null || to !== null || intervals !== undefined;
  let turnRange: [number, number] | null = null;
  if (options.turns !== undefined) {
    const match = /^([1-9]\d*)(:([1-9]\d*)?)?$/u.exec(options.turns);
    if (!match || options.files.length !== 1) throw new Error("--turns requires N, N: or N:M and exactly one source file");
    const first = Number(match[1]);
    const last = match[2] && !match[3] ? Number.POSITIVE_INFINITY : Number(match[3] || match[1]);
    if (!Number.isSafeInteger(first) || (last !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(last)) || first > last) throw new Error("Invalid turn range");
    turnRange = [first, last];
  }
  const turnGroups = new Map<string, UsageTurn>();
  const requests = new Map<string, RequestUsage>();
  const sources: UsageSource[] = [];
  const paths = new Set<string>();
  let duplicateFiles = 0;
  let duplicateRecords = 0;
  let excludedRequests = 0;
  for (const file of options.files) {
    // Resolve explicit symlinks so the same source cannot be counted twice.
    let resolved: string;
    let text: string;
    let bytes: Buffer;
    try {
      resolved = realpathSync(path.resolve(cwd, file));
      if (paths.has(resolved)) { duplicateFiles += 1; continue; }
      const stat = statSync(resolved);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Invalid input file");
      bytes = readFileSync(resolved);
      if (bytes.length > MAX_FILE_BYTES) throw new Error("Input grew beyond limit");
      text = bytes.toString("utf8");
    } catch {
      throw new Error("Cannot read usage source; provide a regular local file of at most 64 MiB");
    }
    paths.add(resolved);
    const source: UsageSource = {
      path: resolved, sha256: sha256(bytes), malformedLines: 0, invalidUsage: 0, missingTimestamps: 0, usageRecords: 0,
      cumulativeCheck: bounded ? "time-filtered" : "unavailable",
      cost: { usd: null, basis: "client-session estimate", reason: "No client monetary snapshot in source" }
    };
    sources.push(source);
    let model = "unknown";
    const turnModels = new Map<string, string>();
    const sourceRequests = new Map<string, Tokens>();
    let cumulative: unknown;
    let turnNumber = 0;
    let activeTurn: string | null = null;
    const clientTurns = new Map<string, string>();
    const beginTurn = (id: string, at: unknown, boundaryKind: UsageTurn["boundary"]) => {
      if (clientTurns.has(id)) { activeTurn = clientTurns.get(id)!; return; }
      turnNumber += 1;
      const key = `${sources.length}:${turnNumber}`;
      clientTurns.set(id, key);
      activeTurn = key;
      turnGroups.set(key, { source: sources.length, turn: turnNumber,
        start: timestamp(at) === null ? null : String(at), durationMs: null,
        complete: boundaryKind === "client turn" ? false : null, boundary: boundaryKind, requests: 0, tokens: emptyTokens() });
    };
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try { row = object(JSON.parse(line) as unknown); }
      catch { source.malformedLines += 1; continue; }
      const payload = object(row.payload);
      if (options.client === "codex" && row.type === "event_msg") {
        if (payload.type === "task_started" && typeof payload.turn_id === "string") beginTurn(payload.turn_id, row.timestamp, "client turn");
        if (payload.type === "task_complete" && typeof payload.turn_id === "string") {
          const key = clientTurns.get(payload.turn_id);
          const group = key ? turnGroups.get(key) : undefined;
          if (group) {
            group.complete = true;
            group.durationMs = !bounded && typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms) && payload.duration_ms >= 0
              ? payload.duration_ms : null;
          }
          if (activeTurn === key) activeTurn = null;
        }
      }
      if (options.client === "claude" && row.type === "user" && row.isMeta !== true && typeof row.promptId === "string") {
        const content = object(row.message).content;
        const humanText = typeof content === "string" || (Array.isArray(content) && content.some(block => object(block).type === "text"));
        const toolResult = Array.isArray(content) && content.some(block => object(block).type === "tool_result");
        if (humanText && !toolResult) beginTurn(row.promptId, row.timestamp, "user message");
      }
      if (row.type === "turn_context") {
        model = label(payload.model);
        if (typeof payload.turn_id === "string") turnModels.set(payload.turn_id, model);
      }
      if (options.client === "claude" && row.type === "cost-state") {
        source.cost = clientCost(row, bounded || turnRange !== null);
        continue;
      }
      const message = object(row.message);
      const isUsage = options.client === "codex" ? row.type === "token_usage_record"
        : row.type === "assistant" && message.usage !== undefined && message.model !== "<synthetic>";
      if (!isUsage) continue;
      const turnKey = options.client === "codex" ? clientTurns.get(String(payload.turn_id)) || null : activeTurn;
      const selectedTurn = turnKey ? turnGroups.get(turnKey) : undefined;
      if (turnRange && (!selectedTurn || selectedTurn.turn < turnRange[0] || selectedTurn.turn > turnRange[1])) continue;
      const time = timestamp(row.timestamp);
      if (bounded && time === null) { source.missingTimestamps += 1; continue; }
      if (time !== null && ((from !== null && time < from) || (to !== null && time >= to))) continue;
      if (intervals && !intervals.some(([start, end]) => time! >= start && (end === null || time! < end))) continue;
      const id = options.client === "codex" ? payload.response_id : message.id;
      if (typeof id !== "string" || !identifier.test(id)) { source.invalidUsage += 1; continue; }
      let tokens: Tokens;
      try { tokens = normalize(options.client, options.client === "codex" ? payload.usage : message.usage); }
      catch { source.invalidUsage += 1; continue; }
      const requestModel = options.client === "codex" ? turnModels.get(String(payload.turn_id)) || model : label(message.model);
      // Claude message ids are API response ids, unique across sessions; resumed
      // or forked transcripts copy them under a new sessionId.
      const key = id;
      if (options.exclude?.has(`${options.client}:${key}`)) { excludedRequests += 1; continue; }
      source.usageRecords += 1;
      sourceRequests.set(key, tokens);
      if (options.client === "codex") cumulative = payload.thread_token_usage;
      const existing = requests.get(key);
      if (existing) {
        duplicateRecords += 1;
        const inputConflict = existing.model !== requestModel || ["input", "uncachedInput", "cacheRead", "cacheWrite"].some(field =>
          existing.tokens[field as keyof Tokens] !== tokens[field as keyof Tokens]);
        const outputConflict = options.client === "codex" && JSON.stringify(existing.tokens) !== JSON.stringify(tokens);
        if (inputConflict || outputConflict) throw new Error("Conflicting usage for a duplicate request; no report generated");
        if (existing.turnKey === null && turnKey !== null) existing.turnKey = turnKey;
        // Claude can repeat one message id for several content blocks. Keep
        // final output counters, not a sum of snapshots or content blocks.
        existing.tokens.output = Math.max(existing.tokens.output, tokens.output);
        existing.tokens.reasoning = existing.tokens.reasoning === null || tokens.reasoning === null
          ? null : Math.max(existing.tokens.reasoning, tokens.reasoning);
      } else {
        requests.set(key, { model: requestModel, tokens, turnKey, at: time });
      }
    }
    if (turnRange) source.cumulativeCheck = "turn-filtered";
    if (options.client === "codex" && !bounded && !turnRange && cumulative !== undefined) {
      const sum = emptyTokens();
      for (const tokens of sourceRequests.values()) addTokens(sum, tokens);
      try {
        const expected = normalize("codex", cumulative);
        const countsMatch = fields.every(field => sum[field] === expected[field]);
        source.cumulativeCheck = !countsMatch ? "mismatch"
          : sum.reasoning === null || expected.reasoning === null ? "unavailable"
          : sum.reasoning === expected.reasoning ? "matched" : "mismatch";
      } catch { source.cumulativeCheck = "mismatch"; }
    }
  }
  if (!requests.size && !excludedRequests) throw new Error("No supported usage records in selected sources/range; check client, schema and boundaries");
  const models = new Map<string, { model: string; requests: number; tokens: Tokens }>();
  const totals = emptyTokens();
  let unassignedRequests = 0;
  for (const request of requests.values()) {
    let group = models.get(request.model);
    if (!group) { group = { model: request.model, requests: 0, tokens: emptyTokens() }; models.set(request.model, group); }
    group.requests += 1;
    addTokens(group.tokens, request.tokens);
    addTokens(totals, request.tokens);
    const turn = request.turnKey ? turnGroups.get(request.turnKey) : undefined;
    if (turn) { turn.requests += 1; addTokens(turn.tokens, request.tokens); }
    else unassignedRequests += 1;
  }
  const warnings = [
    "Only supplied sources are measured. Child sessions, missing requests and other clients are not discovered automatically.",
    "Supplied sources do not establish whole-task coverage, completion or quality.",
    "Cache read/write are included in input; reasoning, when reported, is included in output. Do not add subsets again.",
    "No verified charges or model rates are available from this importer. Monetary estimates are reported separately per source."
  ];
  if (sources.some(s => s.malformedLines || s.invalidUsage || s.missingTimestamps)) warnings.push("Partial data: malformed/invalid records or untimestamped usage were omitted; see source counters.");
  if (sources.some(s => s.usageRecords === 0)) warnings.push("Some supplied sources contain no selected supported usage records.");
  if (sources.some(s => s.cumulativeCheck === "mismatch")) warnings.push("Codex source requests do not reconcile with the last cumulative counter; source may be partial or counters may have reset.");
  if (models.has("unknown")) warnings.push("Some requests lack a recognized model label.");
  if ((options.byTurn || turnRange) && unassignedRequests) warnings.push("Some requests lack usable turn boundaries and are not included in turn rows.");
  if (options.byTurn || turnRange) warnings.push("Turn duration includes tools/waits; Claude user-message boundaries do not establish completion or duration. Time-filtered durations are unavailable.");
  const report: UsageReport = {
    version: 1, client: options.client, task: options.task || null,
    boundary: options.intervals
      ? { from: null, to: null, selection: "Usage record timestamps inside the task's active intervals (end exclusive)", intervals: options.intervals }
      : { from: options.from || null, to: options.to || null, selection: "Usage record timestamps: inclusive from, exclusive to; whole supplied sources when unbounded" },
    requests: requests.size, duplicateRecords, duplicateFiles, totals,
    models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model)), sources, warnings, billedUsd: null,
    turnSelection: options.turns || null, unassignedRequests,
    ...(options.byTurn ? { turns: [...turnGroups.values()].filter(turn => turn.requests > 0) } : {})
  };
  return { report, requests, turnGroups, excludedRequests };
}

function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}

export function formatUsageReport(report: UsageReport): string {
  const lines = ["Agentpack usage report (read-only)", `Client: ${report.client}`, `Task label: ${printable(report.task || "(not supplied)")}`,
    report.boundary.intervals
      ? `Boundary: task active ${report.boundary.intervals.map(interval => `${interval.from} to ${interval.to || "now"}`).join("; ")} (end exclusive)`
      : `Boundary: ${report.boundary.from || "start of sources"} to ${report.boundary.to || "end of sources"} (end exclusive)`,
    `Requests: ${report.requests}; duplicate records: ${report.duplicateRecords}; duplicate files: ${report.duplicateFiles}`, ""];
  for (const group of [...report.models, { model: "TOTAL", requests: report.requests, tokens: report.totals }]) {
    const t = group.tokens;
    lines.push(`${group.model}: ${group.requests} requests; input ${t.input} (uncached ${t.uncachedInput}, cache read ${t.cacheRead}, cache write ${t.cacheWrite}); output ${t.output} (reasoning ${t.reasoning ?? "unknown"})`);
  }
  if (report.turnSelection) lines.push(`Selected turns: ${report.turnSelection}`);
  if (report.turns) {
    lines.push("", "Source/Turn | Started | Requests | Uncached input | Cache read | Cache write | Output | Duration (seconds) | Complete");
    for (const turn of report.turns) lines.push(`${turn.source}/${turn.turn} | ${turn.start || "unknown"} | ${turn.requests} | ${turn.tokens.uncachedInput} | ${turn.tokens.cacheRead} | ${turn.tokens.cacheWrite} | ${turn.tokens.output} | ${turn.durationMs === null ? "unknown" : (turn.durationMs / 1000).toFixed(1)} | ${turn.complete === null ? "unknown" : turn.complete}`);
    lines.push(`Requests without turn boundaries: ${report.unassignedRequests}`);
  }
  lines.push("", "Client monetary estimates (not verified charges):");
  for (const source of report.sources) {
    lines.push(`- ${printable(source.path)} [sha256 ${source.sha256}]: ${source.cost.usd === null ? "unavailable" : `$${source.cost.usd.toFixed(6)}`} — ${source.cost.reason}`,
      `  Omitted: ${source.malformedLines} malformed lines, ${source.invalidUsage} invalid usage records, ${source.missingTimestamps} untimestamped usage records. Cumulative check: ${source.cumulativeCheck}.`);
  }
  lines.push("", ...report.warnings.map(w => `Warning: ${w}`));
  return lines.join("\n");
}
