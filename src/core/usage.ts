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
  /** Task reports: requests outside `intervals` but inside these windows (end exclusive; null from = open) feed `agentpackOverheadBeforeActivation` only. */
  preActivation?: Array<{ from: string | null; to: string }>;
  /** Task reports: pre-activation request identities already counted from another source. */
  excludeBeforeActivation?: ReadonlySet<string>;
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

export interface AgentpackOverhead {
  method: "direct calls, completed nested MCP events, or distinct observed code-mode results; visible chars / 4; later selected requests are an upper bound";
  calls: number;
  responseTokens: number;
  rereadTokensUpperBound: number;
  outputTokensUpperBound: number;
  unattributedResponses: number;
  byTool: Array<{ tool: string; calls: number; responseTokens: number; rereadTokensUpperBound: number; outputTokensUpperBound: number }>;
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
  agentpackOverhead: AgentpackOverhead;
  agentpackOverheadBeforeActivation?: AgentpackOverhead;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;
// Short results such as an empty JSON list also occur in unrelated shell output.
const MIN_NESTED_MATCH_CHARS = 16;
// Installed servers are `agentpack` or `agentpack-<slug>`; Codex rewrites `-` to `_` in tool namespaces.
const AGENTPACK_SERVER = /^agentpack(?:-[a-z0-9_-]+)?$/u;
const AGENTPACK_TOOL = /^mcp__agentpack(?:[-_][a-z0-9_-]*)?__([a-z]+(?:_[a-z]+)*)$/u;
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

export function emptyAgentpackOverhead(): AgentpackOverhead {
  return { method: "direct calls, completed nested MCP events, or distinct observed code-mode results; visible chars / 4; later selected requests are an upper bound", calls: 0,
    responseTokens: 0, rereadTokensUpperBound: 0, outputTokensUpperBound: 0,
    unattributedResponses: 0, byTool: [] };
}

export function addAgentpackOverhead(total: AgentpackOverhead, part: AgentpackOverhead): void {
  for (const key of ["calls", "responseTokens", "rereadTokensUpperBound", "outputTokensUpperBound", "unattributedResponses"] as const) total[key] += part[key];
  for (const row of part.byTool) {
    let group = total.byTool.find(item => item.tool === row.tool);
    if (!group) { group = { tool: row.tool, calls: 0, responseTokens: 0, rereadTokensUpperBound: 0, outputTokensUpperBound: 0 }; total.byTool.push(group); }
    for (const key of ["calls", "responseTokens", "rereadTokensUpperBound", "outputTokensUpperBound"] as const) group[key] += row[key];
  }
  total.byTool.sort((a, b) => a.tool.localeCompare(b.tool));
}

/** Match nested result text transiently to visible output; never include transcript content in reports. */
function estimateAgentpackOverhead(client: UsageOptions["client"], lines: string[], selected: Map<string, { line: number; tokens: Tokens }>, allCodexRequests: Array<{ id: string; line: number }>, seenCalls: Set<string>, later: Map<string, { line: number; tokens: Tokens }> = selected): AgentpackOverhead {
  const overhead = emptyAgentpackOverhead();
  const calls = new Map<string, { tools: string[]; direct: boolean; otherMcp: boolean; line: number; requestId: string | null }>();
  const nestedByWrapper = new Map<string, Array<{ id: string; tool: string; resultTexts: string[] }>>();
  const completedNested: Array<{ id: string; tool: string; resultTexts: string[]; line: number; wrapper: [string, number] | null }> = [];
  const unassignedNested: Array<{ id: string; line: number }> = [];
  const functionCallIds = new Set<string>();
  const openCodexExec = new Map<string, number>();
  const outputRequests = new Set<string>();
  const toolOutputRequests = new Map<string, Set<string>>();
  const selectedInOrder = [...later.entries()].sort((a, b) => a[1].line - b[1].line);
  const firstAtOrAfter = (line: number): string | null => {
    let low = 0; let high = allCodexRequests.length;
    while (low < high) { const mid = (low + high) >>> 1; if (allCodexRequests[mid]!.line < line) low = mid + 1; else high = mid; }
    return allCodexRequests[low]?.id ?? null;
  };
  const laterCount = (line: number): number => {
    let low = 0; let high = selectedInOrder.length;
    while (low < high) { const mid = (low + high) >>> 1; if (selectedInOrder[mid]![1].line <= line) low = mid + 1; else high = mid; }
    return selectedInOrder.length - low;
  };
  const rowAt = (line: string): Record<string, unknown> => {
    try { return object(JSON.parse(line) as unknown); } catch { return {}; }
  };
  const toolGroup = (name: string) => {
    let group = overhead.byTool.find(item => item.tool === name);
    if (!group) { group = { tool: name, calls: 0, responseTokens: 0, rereadTokensUpperBound: 0, outputTokensUpperBound: 0 }; overhead.byTool.push(group); }
    return group;
  };
  const resultLength = (value: unknown): number => {
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + resultLength(object(item).text ?? object(item).content), 0);
    return 0;
  };
  const resultTool = (value: string): string | null => {
    const first = value.trimStart();
    if (/^Task task_[A-Za-z0-9][A-Za-z0-9._-]*\. State:/u.test(first)) return "task_status";
    const listBody = first.replace(/^(?:\[warn\] [^\n]*\n)+/u, "");
    if (/^[*-] task_[A-Za-z0-9][A-Za-z0-9._-]* \[(?:active|parked|blocked|verifying|completed|abandoned)\] /u.test(listBody)
      || listBody === "No task passports yet. Call `task_start` first."
      || listBody === "No task passports match the filters."
      || listBody === "No open task passports. Pass `all: true` for history.") return "task_list";
    if (listBody.startsWith("[") && listBody.endsWith("]")) {
      try {
        const tasks: unknown = JSON.parse(listBody);
        if (Array.isArray(tasks) && tasks.length > 0 && tasks.every(item => {
          const task = object(item);
          return typeof task.id === "string" && /^task_[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(task.id)
            && typeof task.title === "string" && typeof task.status === "string"
            && /^(?:active|parked|blocked|verifying|completed|abandoned)$/u.test(task.status)
            && (task.branch === null || typeof task.branch === "string")
            && typeof task.current === "boolean" && typeof task.updatedAt === "string"
            && Array.isArray(task.writeScope) && task.writeScope.every(scope => typeof scope === "string");
        })) return "task_list";
      } catch { /* Unrecognized printed text is not an Agentpack result. */ }
    }
    for (const [tool, prefix] of [["load_context", "# Agentpack Resume"], ["task_status", "Task inspection"],
      ["task_status", "Task status"],
      ["attach_evidence", "Attached evidence"], ["checkpoint", "Created checkpoint"],
      ["task_start", "Started task"], ["task_switch", "Switched to task"],
      ["task_park", "Parked task"], ["task_update", "Updated task"],
      ["task_update_verification", "Updated verification for task"],
      ["task_update_verification", "Verification unchanged for task"],
      ["task_finalize", "Finalized task"]] as const) {
      if (first.startsWith(prefix)) return tool;
    }
    return null;
  };
  const codexResultBlocks = (value: unknown, soleTool: string | null): Array<{ chars: number; tool: string | null; digest: string }> => {
    if (!Array.isArray(value)) return [];
    return value.flatMap(block => {
      const visible = object(block).text;
      if (typeof visible !== "string") return [];
      try {
        const parsed = object(JSON.parse(visible) as unknown);
        const result = Array.isArray(parsed.content) ? parsed : object(parsed.result);
        if (Array.isArray(result.content) && result.content.every(item => object(item).type === "text")) {
          const first = object(result.content[0]).text;
          return [{ chars: visible.length, tool: (typeof first === "string" ? resultTool(first) : null) || soleTool, digest: sha256(visible) }];
        }
      } catch { /* A direct text(r.content[0]) result is not JSON. */ }
      const tool = resultTool(visible) || (visible.startsWith("Warning: truncated output") && visible.includes("# Agentpack Resume") ? "load_context" : null);
      return tool ? [{ chars: visible.length, tool, digest: sha256(visible) }] : [];
    });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const row = rowAt(lines[i]!);
    const payload = object(row.payload);
    const message = object(row.message);
    if (client === "codex" && row.type === "response_item" && payload.type === "custom_tool_call"
      && payload.name === "exec" && typeof payload.call_id === "string") openCodexExec.set(payload.call_id, i);
    if (client === "codex" && row.type === "event_msg" && payload.type === "item_completed") {
      const item = object(payload.item);
      if (item.type === "McpToolCall" && typeof item.server === "string" && AGENTPACK_SERVER.test(item.server) && item.status === "completed"
        && typeof item.id === "string" && typeof item.tool === "string" && /^[a-z_]+$/u.test(item.tool)) {
        const result = object(item.result);
        const resultTexts = Array.isArray(result.content) ? result.content.flatMap(block => {
          const visible = object(block).text;
          return typeof visible === "string" ? [visible] : [];
        }) : [];
        completedNested.push({ id: item.id, tool: item.tool, resultTexts, line: i,
          wrapper: openCodexExec.size === 1 ? openCodexExec.entries().next().value! : null });
      }
    }
    if (client === "codex" && row.type === "response_item" && payload.type === "function_call"
      && typeof payload.call_id === "string") functionCallIds.add(payload.call_id);
    if (client === "codex" && row.type === "response_item" && payload.type === "custom_tool_call_output"
      && typeof payload.call_id === "string") openCodexExec.delete(payload.call_id);
    if (client === "claude" && row.type === "assistant") {
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const item = object(block);
        const tool = item.type === "tool_use" && typeof item.name === "string" ? AGENTPACK_TOOL.exec(item.name)?.[1] : undefined;
        if (typeof item.id !== "string" || !tool) continue;
        calls.set(item.id, { tools: [tool], direct: true, otherMcp: false, line: i,
          requestId: typeof message.id === "string" ? message.id : null });
      }
    }
    if (client === "codex" && row.type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
      if (typeof payload.call_id !== "string") continue;
      const name = typeof payload.name === "string" ? `${typeof payload.namespace === "string" ? payload.namespace : ""}${payload.name}` : "";
      const directTool = AGENTPACK_TOOL.exec(name)?.[1];
      const input = String(payload.arguments ?? payload.input ?? "");
      const invoked = [...input.matchAll(/tools\.(mcp__[A-Za-z0-9_]+)\s*\(/gu)].map(match => AGENTPACK_TOOL.exec(match[1]!)?.[1] ?? null);
      const wrapped = invoked.filter((tool): tool is string => tool !== null);
      const tools = directTool ? [directTool] : wrapped;
      if (tools.length) calls.set(payload.call_id, { tools: [...new Set(tools)], direct: Boolean(directTool),
        otherMcp: invoked.includes(null), line: i, requestId: null });
    }
  }
  // Direct MCP calls also emit item_completed with the function call id; only the remaining events are nested.
  for (const event of completedNested) {
    if (functionCallIds.has(event.id)) continue;
    if (!event.wrapper) { unassignedNested.push(event); continue; }
    const [wrapperId, line] = event.wrapper;
    if (!nestedByWrapper.has(wrapperId)) nestedByWrapper.set(wrapperId, []);
    nestedByWrapper.get(wrapperId)!.push(event);
    if (!calls.has(wrapperId)) calls.set(wrapperId, { tools: [], direct: false, otherMcp: false, line, requestId: null });
  }
  for (const [id, call] of calls) {
    if (client === "codex") call.requestId = firstAtOrAfter(call.line);
    if (!call.requestId || !selected.has(call.requestId)) continue;
    if (client === "codex" && !call.direct) continue;
    if (seenCalls.has(`${client}:${id}`)) { calls.delete(id); continue; }
    seenCalls.add(`${client}:${id}`);
    overhead.calls += call.tools.length;
    for (const tool of call.tools) toolGroup(tool).calls += 1;
    outputRequests.add(call.requestId);
    if (call.tools.length === 1) {
      const tool = call.tools[0]!;
      if (!toolOutputRequests.has(tool)) toolOutputRequests.set(tool, new Set());
      toolOutputRequests.get(tool)!.add(call.requestId);
    }
  }
  const countedNested = new Map<string, Array<{ id: string; tool: string; resultTexts: string[] }>>();
  if (client === "codex") for (const [wrapperId, items] of nestedByWrapper) {
    const requestId = calls.get(wrapperId)?.requestId;
    if (!requestId || !selected.has(requestId)) continue;
    for (const item of items) {
      const identity = `codex:nested:${item.id}`;
      if (seenCalls.has(identity)) continue;
      seenCalls.add(identity);
      overhead.calls += 1;
      toolGroup(item.tool).calls += 1;
      outputRequests.add(requestId);
      if (!toolOutputRequests.has(item.tool)) toolOutputRequests.set(item.tool, new Set());
      toolOutputRequests.get(item.tool)!.add(requestId);
      if (!countedNested.has(wrapperId)) countedNested.set(wrapperId, []);
      countedNested.get(wrapperId)!.push(item);
    }
  }
  if (client === "codex") for (const item of unassignedNested) {
    const identity = `codex:nested:${item.id}`;
    const requestId = firstAtOrAfter(item.line);
    if (!requestId || !selected.has(requestId) || seenCalls.has(identity) || seenCalls.has(`codex:unassigned:${item.id}`)) continue;
    seenCalls.add(`codex:unassigned:${item.id}`);
    overhead.unattributedResponses += 1;
  }
  let nestedMatchBudget = MAX_FILE_BYTES;
  for (let i = 0; i < lines.length; i += 1) {
    const row = rowAt(lines[i]!);
    const payload = object(row.payload);
    const message = object(row.message);
    const outputs: Array<{ id: string; content: unknown }> = [];
    if (client === "codex" && row.type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") && typeof payload.call_id === "string") {
      outputs.push({ id: payload.call_id, content: payload.output });
    }
    if (client === "claude" && row.type === "user" && Array.isArray(message.content)) {
      for (const block of message.content) {
        const item = object(block);
        if (item.type === "tool_result" && typeof item.tool_use_id === "string") outputs.push({ id: item.tool_use_id, content: item.content });
      }
    }
    for (const output of outputs) {
      const call = calls.get(output.id);
      if (!call || !call.requestId || !selected.has(call.requestId) || selected.get(call.requestId)!.line > i) continue;
      const laterRequests = laterCount(i);
      if (client === "codex" && nestedByWrapper.has(output.id)) {
        const nested = countedNested.get(output.id) ?? [];
        const blocks = Array.isArray(output.content) ? output.content : [output.content];
        let matched = false;
        let matchLimited = false;
        for (const block of blocks) {
          const visible = typeof block === "string" ? block : object(block).text;
          if (typeof visible !== "string") continue;
          const recognized = codexResultBlocks([block], null).filter(result => nested.some(item => item.tool === result.tool));
          if (recognized.length) {
            for (const result of recognized) {
              const size = Math.ceil(result.chars / 4);
              const group = toolGroup(result.tool!);
              group.responseTokens += size;
              group.rereadTokensUpperBound += size * laterRequests;
              overhead.responseTokens += size;
              overhead.rereadTokensUpperBound += size * laterRequests;
              matched = true;
            }
            continue;
          }
          const candidates = new Map<string, string>();
          for (const item of nested) for (const resultText of item.resultTexts) {
            if (resultText.length >= MIN_NESTED_MATCH_CHARS && !candidates.has(resultText)) candidates.set(resultText, item.tool);
          }
          // Longest first, removing matches so a result contained in another is not counted twice.
          let remaining = visible;
          for (const [resultText, tool] of [...candidates].sort((a, b) => b[0].length - a[0].length)) {
            if (remaining.length > nestedMatchBudget) { matchLimited = true; continue; }
            nestedMatchBudget -= remaining.length;
            const parts = remaining.split(resultText);
            const copies = parts.length - 1;
            if (!copies) continue;
            remaining = parts.join("\0");
            const size = Math.ceil(resultText.length / 4) * copies;
            const group = toolGroup(tool);
            group.responseTokens += size;
            group.rereadTokensUpperBound += size * laterRequests;
            overhead.responseTokens += size;
            overhead.rereadTokensUpperBound += size * laterRequests;
            matched = true;
          }
        }
        if (matchLimited || (!matched && nested.length && resultLength(output.content) > 0)) overhead.unattributedResponses += 1;
        continue;
      }
      if (client === "codex" && !call.direct) {
        if (seenCalls.has(`${client}:${output.id}`)) continue;
        const blocks = codexResultBlocks(output.content, call.tools.length === 1 && !call.otherMcp ? call.tools[0]! : null);
        const observed = blocks.filter(block => block.tool !== null && call.tools.includes(block.tool));
        if (!observed.length) { overhead.unattributedResponses += 1; continue; }
        seenCalls.add(`${client}:${output.id}`);
        const distinctResults = new Set<string>();
        outputRequests.add(call.requestId);
        for (const block of observed) {
          const group = toolGroup(block.tool!);
          const size = Math.ceil(block.chars / 4);
          const identity = `${block.tool}:${block.digest}`;
          if (!distinctResults.has(identity)) {
            distinctResults.add(identity);
            overhead.calls += 1;
            group.calls += 1;
          }
          group.responseTokens += size;
          group.rereadTokensUpperBound += size * laterRequests;
          overhead.responseTokens += size;
          overhead.rereadTokensUpperBound += size * laterRequests;
          if (!toolOutputRequests.has(group.tool)) toolOutputRequests.set(group.tool, new Set());
          toolOutputRequests.get(group.tool)!.add(call.requestId);
        }
        if (observed.length < blocks.length) overhead.unattributedResponses += 1;
        continue;
      }
      const tokens = Math.ceil(resultLength(output.content) / 4);
      overhead.responseTokens += tokens;
      overhead.rereadTokensUpperBound += tokens * laterRequests;
      if (call.tools.length === 1) {
        const group = toolGroup(call.tools[0]!);
        group.responseTokens += tokens;
        group.rereadTokensUpperBound += tokens * laterRequests;
      } else overhead.unattributedResponses += 1;
    }
  }
  overhead.outputTokensUpperBound = [...outputRequests].reduce((sum, id) => sum + (selected.get(id)?.tokens.output ?? 0), 0);
  for (const group of overhead.byTool) group.outputTokensUpperBound = [...(toolOutputRequests.get(group.tool) ?? [])]
    .reduce((sum, id) => sum + (selected.get(id)?.tokens.output ?? 0), 0);
  overhead.byTool.sort((a, b) => a.tool.localeCompare(b.tool));
  return overhead;
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
export function readUsageReport(options: UsageOptions, cwd: string): { report: UsageReport; requestIds: string[]; beforeActivationRequestIds: string[]; excludedRequests: number } {
  const { report, requests, beforeActivationIds, excludedRequests } = parseUsageReport(options, cwd);
  return { report, requestIds: [...requests.keys()].map(key => `${options.client}:${key}`),
    beforeActivationRequestIds: [...beforeActivationIds].map(key => `${options.client}:${key}`), excludedRequests };
}

function parseUsageReport(options: UsageOptions, cwd: string): { report: UsageReport; requests: Map<string, RequestUsage>; turnGroups: Map<string, UsageTurn>; beforeActivationIds: Set<string>; excludedRequests: number } {
  if (options.client !== "codex" && options.client !== "claude") throw new Error("Usage supports codex or claude JSONL sources");
  if (!options.files.length) throw new Error("Usage requires at least one --file");
  const from = boundary(options.from, "--from");
  const to = boundary(options.to, "--to");
  if (from !== null && to !== null && from >= to) throw new Error("--from must be earlier than --to");
  if (options.intervals && (from !== null || to !== null)) throw new Error("Task intervals cannot be combined with --from or --to");
  const intervals = options.intervals?.map(interval => [boundary(interval.from, "interval start")!, boundary(interval.to ?? undefined, "interval end")] as const);
  const windows = options.preActivation?.map(window => [window.from === null ? Number.NEGATIVE_INFINITY : boundary(window.from, "pre-activation start")!, boundary(window.to, "pre-activation end")!] as const);
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
  const agentpackOverhead = emptyAgentpackOverhead();
  const seenAgentpackCalls = new Set<string>();
  const agentpackOverheadBefore = emptyAgentpackOverhead();
  const seenBeforeCalls = new Set<string>();
  const beforeActivationIds = new Set<string>();
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
    const requestLines = new Map<string, { line: number; tokens: Tokens }>();
    const beforeLines = new Map<string, { line: number; tokens: Tokens }>();
    const outsideLines = new Map<string, { line: number; tokens: Tokens }>();
    const allCodexRequests: Array<{ id: string; line: number }> = [];
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
    const lines = text.split(/\r?\n/u);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
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
      if (options.client === "codex" && typeof payload.response_id === "string") allCodexRequests.push({ id: payload.response_id, line: lineIndex });
      const turnKey = options.client === "codex" ? clientTurns.get(String(payload.turn_id)) || null : activeTurn;
      const selectedTurn = turnKey ? turnGroups.get(turnKey) : undefined;
      if (turnRange && (!selectedTurn || selectedTurn.turn < turnRange[0] || selectedTurn.turn > turnRange[1])) continue;
      const time = timestamp(row.timestamp);
      if (bounded && time === null) { source.missingTimestamps += 1; continue; }
      if (time !== null && ((from !== null && time < from) || (to !== null && time >= to))) continue;
      if (intervals && !intervals.some(([start, end]) => time! >= start && (end === null || time! < end))) {
        const beforeId = options.client === "codex" ? payload.response_id : message.id;
        if (windows && typeof beforeId === "string" && identifier.test(beforeId) && !options.exclude?.has(`${options.client}:${beforeId}`)) {
          // A gap request already counted from another source still stays in context here: reread only.
          const target = windows.some(([start, end]) => time! >= start && time! < end)
            && !options.excludeBeforeActivation?.has(`${options.client}:${beforeId}`) ? beforeLines : outsideLines;
          let beforeTokens: Tokens | null = null;
          try { beforeTokens = normalize(options.client, options.client === "codex" ? payload.usage : message.usage); } catch { /* Invalid pre-activation usage is ignored, not counted. */ }
          // Claude writes one line per content block; a boundary between them must not place one request in both maps.
          const firstBefore = beforeLines.get(beforeId) ?? outsideLines.get(beforeId);
          if (beforeTokens && firstBefore) firstBefore.tokens.output = Math.max(firstBefore.tokens.output, beforeTokens.output);
          else if (beforeTokens) target.set(beforeId, { line: lineIndex, tokens: beforeTokens });
        }
        continue;
      }
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
      const firstSeen = requestLines.get(key);
      if (firstSeen) {
        firstSeen.tokens.output = Math.max(firstSeen.tokens.output, tokens.output);
      } else requestLines.set(key, { line: lineIndex, tokens: { ...tokens } });
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
    addAgentpackOverhead(agentpackOverhead, estimateAgentpackOverhead(options.client, lines, requestLines, allCodexRequests, seenAgentpackCalls));
    if (windows) {
      for (const key of [...beforeLines.keys()]) if (requestLines.has(key)) beforeLines.delete(key);
      for (const key of beforeLines.keys()) beforeActivationIds.add(key);
      addAgentpackOverhead(agentpackOverheadBefore, estimateAgentpackOverhead(options.client, lines, beforeLines, allCodexRequests, seenBeforeCalls, requestLines));
      for (const key of [...outsideLines.keys()]) if (requestLines.has(key)) outsideLines.delete(key);
      // Responses from other tasks' periods stay in context: count only their reread in this task's requests.
      const carried = estimateAgentpackOverhead(options.client, lines, outsideLines, allCodexRequests, new Set(), requestLines);
      addAgentpackOverhead(agentpackOverheadBefore, { ...emptyAgentpackOverhead(), rereadTokensUpperBound: carried.rereadTokensUpperBound,
        byTool: carried.byTool.map(row => ({ tool: row.tool, calls: 0, responseTokens: 0, rereadTokensUpperBound: row.rereadTokensUpperBound, outputTokensUpperBound: 0 })) });
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
    turnSelection: options.turns || null, unassignedRequests, agentpackOverhead,
    ...(windows ? { agentpackOverheadBeforeActivation: agentpackOverheadBefore } : {}),
    ...(options.byTurn ? { turns: [...turnGroups.values()].filter(turn => turn.requests > 0) } : {})
  };
  return { report, requests, turnGroups, beforeActivationIds, excludedRequests };
}

function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}

export function beforeActivationLine(overhead: AgentpackOverhead): string {
  return `Agentpack before activation: ${overhead.calls} calls; response ~${overhead.responseTokens} tokens; later-context in task <=${overhead.rereadTokensUpperBound}; invoking-output <=${overhead.outputTokensUpperBound}`;
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
  const overhead = report.agentpackOverhead;
  lines.push("", `Agentpack: ${overhead.calls} calls; response ~${overhead.responseTokens} tokens; later-context <=${overhead.rereadTokensUpperBound} tokens; invoking-output <=${overhead.outputTokensUpperBound} tokens`);
  for (const tool of overhead.byTool) lines.push(`- ${tool.tool}: ${tool.calls} calls; response ~${tool.responseTokens}; later-context <=${tool.rereadTokensUpperBound}; invoking-output <=${tool.outputTokensUpperBound}`);
  if (overhead.unattributedResponses) lines.push(`Unresolved code-mode wrappers: ${overhead.unattributedResponses}`);
  if (report.agentpackOverheadBeforeActivation?.calls || report.agentpackOverheadBeforeActivation?.rereadTokensUpperBound) lines.push(beforeActivationLine(report.agentpackOverheadBeforeActivation));
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
