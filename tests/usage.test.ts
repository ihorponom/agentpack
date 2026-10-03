import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PassThrough } from "node:stream";
import { startMcpServer, TOOL_DEFINITIONS } from "../src/mcp/server.js";
import { initPack } from "../src/core/store.js";
import { buildUsageReport, formatUsageReport } from "../src/core/usage.js";
import { buildTaskUsageReport, formatTaskUsageReport } from "../src/core/usage-manifest.js";

const cli = fileURLToPath(new URL("../src/agentpack.js", import.meta.url));
const time = "2026-10-02T12:00:00Z";
const usage = { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };
const context = { type: "turn_context", payload: { turn_id: "turn1", model: "model-a" } };
const codex = (id: string, tokens = usage, at = time) => ({ type: "token_usage_record", timestamp: at,
  payload: { response_id: id, turn_id: "turn1", usage: tokens, thread_token_usage: tokens } });
const claude = (id: string, output = 20, at = time) => ({ type: "assistant", sessionId: "s1", timestamp: at,
  message: { id, model: "claude-test", content: [{ text: "PRIVATE_PROMPT_SENTINEL" }], usage: {
    input_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 30, output_tokens: output } } });
const cost = { type: "cost-state", sessionId: "s1", totalCostUSD: 0.25, hasUnknownModelCost: false };

function fixture(t: { after: (fn: () => void) => void }, rows: unknown[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "input.jsonl");
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { dir, file };
}

test("Codex deduplicates requests and files without adding cumulative or subset counters", t => {
  const { dir, file } = fixture(t, [context, codex("r1"), codex("r1"), { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage } } }]);
  const alias = path.join(dir, "alias.jsonl");
  symlinkSync(file, alias);
  const r = buildUsageReport({ client: "codex", files: [file, alias] }, dir);
  assert.equal(r.requests, 1);
  assert.equal(r.duplicateRecords, 1);
  assert.equal(r.duplicateFiles, 1);
  assert.deepEqual(r.totals, { input: 100, uncachedInput: 40, cacheRead: 60, cacheWrite: 0, output: 20, reasoning: 5 });
  assert.equal(r.sources[0]?.cumulativeCheck, "matched");
  assert.equal(r.sources[0]?.cost.usd, null);
});

test("Claude content snapshots use final counters, normalize cache categories and keep cost separate", t => {
  const { dir, file } = fixture(t, [claude("m1", 2), claude("m1"), cost]);
  const r = buildUsageReport({ client: "claude", files: [file] }, dir);
  assert.equal(r.requests, 1);
  assert.equal(r.duplicateRecords, 1);
  assert.deepEqual(r.totals, { input: 100, uncachedInput: 10, cacheRead: 60, cacheWrite: 30, output: 20, reasoning: null });
  assert.equal(r.sources[0]?.cost.usd, 0.25);
  assert.equal(r.billedUsd, null);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_PROMPT_SENTINEL|content/);
});

test("Codex cumulative reconciliation includes reasoning and does not confirm unknown counters", t => {
  const request = codex("r1");
  const { dir, file } = fixture(t, [context, { ...request, payload: { ...request.payload,
    thread_token_usage: { ...usage, reasoning_output_tokens: 15 } } }]);
  assert.equal(buildUsageReport({ client: "codex", files: [file] }, dir).sources[0]?.cumulativeCheck, "mismatch");
  for (const missing of ["request", "cumulative", "both"]) {
    const row = codex("r1");
    const record: { reasoning_output_tokens?: number } = row.payload.usage = { ...usage };
    const total: { reasoning_output_tokens?: number } = row.payload.thread_token_usage = { ...usage };
    if (missing !== "cumulative") delete record.reasoning_output_tokens;
    if (missing !== "request") delete total.reasoning_output_tokens;
    writeFileSync(file, [context, row].map(value => JSON.stringify(value)).join("\n"));
    assert.equal(buildUsageReport({ client: "codex", files: [file] }, dir).sources[0]?.cumulativeCheck, "unavailable");
  }
});

test("Duplicate requests recover available turn boundaries regardless of partial-source order", t => {
  const { dir, file } = fixture(t, [context, codex("r1")]);
  const complete = path.join(dir, "complete.jsonl");
  writeFileSync(complete, [started("turn1"), context, codex("r1"), completed("turn1")].map(row => JSON.stringify(row)).join("\n"));
  for (const files of [[file, complete], [complete, file]]) {
    const report = buildUsageReport({ client: "codex", files, byTurn: true }, dir);
    assert.equal(report.requests, 1);
    assert.equal(report.duplicateRecords, 1);
    assert.equal(report.unassignedRequests, 0);
    assert.equal(report.turns?.length, 1);
    assert.equal(report.turns?.[0]?.requests, 1);
    assert.equal(report.turns?.[0]?.complete, true);
    assert.deepEqual(report.turns?.[0]?.tokens, report.totals);
    assert.equal(report.sources[report.turns![0]!.source - 1]?.path, realpathSync(complete));
  }
});

test("Time filtering is inclusive/exclusive and never attributes cumulative session cost", t => {
  const { dir, file } = fixture(t, [claude("before", 20, "2026-10-02T11:59:59Z"), claude("in"), claude("end", 20, "2026-10-02T12:01:00Z"),
    { ...claude("untimed"), timestamp: undefined }, cost]);
  const r = buildUsageReport({ client: "claude", files: [file], from: time, to: "2026-10-02T12:01:00Z" }, dir);
  assert.equal(r.requests, 1);
  assert.equal(r.sources[0]?.cost.usd, null);
  assert.equal(r.sources[0]?.missingTimestamps, 1);
  assert.match(r.sources[0]?.cost.reason || "", /time range/);
  assert.throws(() => buildUsageReport({ client: "claude", files: [file], from: "2026-10-02" }, dir), /timezone/);
  assert.throws(() => buildUsageReport({ client: "claude", files: [file], from: time, to: time }, dir), /earlier/);
});

test("Conflicting duplicates across sources fail instead of producing invented totals", t => {
  const { dir, file } = fixture(t, [context, codex("same")]);
  const other = path.join(dir, "other.jsonl");
  writeFileSync(other, [context, codex("same", { ...usage, input_tokens: 101, total_tokens: 121 })].map(row => JSON.stringify(row)).join("\n"));
  assert.throws(() => buildUsageReport({ client: "codex", files: [file, other] }, dir), /Conflicting usage/);
});

test("Malformed and invalid usage are counted without echoing private data; cumulative mismatch is visible", t => {
  const { dir, file } = fixture(t, [context, codex("r1"), codex("bad", { ...usage, input_tokens: -1 }), codex("bad-cache", { ...usage, cached_input_tokens: 200 })]);
  writeFileSync(file, readFileSync(file, "utf8") + '{"PRIVATE_SECRET_SENTINEL":\n');
  const r = buildUsageReport({ client: "codex", files: [file] }, dir);
  assert.equal(r.sources[0]?.malformedLines, 1);
  assert.equal(r.sources[0]?.invalidUsage, 2);
  assert.equal(r.requests, 1);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_SECRET_SENTINEL/);
  const partial = path.join(dir, "partial.jsonl");
  writeFileSync(partial, JSON.stringify({ ...codex("r1"), payload: { ...codex("r1").payload, thread_token_usage: { ...usage, input_tokens: 200, total_tokens: 220 } } }));
  const mismatch = buildUsageReport({ client: "codex", files: [partial] }, dir);
  assert.equal(mismatch.sources[0]?.cumulativeCheck, "mismatch");
  assert.match(mismatch.warnings.join("\n"), /do not reconcile/);
});

test("Unknown model pricing and invalid cost snapshots remain unavailable", t => {
  const { dir, file } = fixture(t, [claude("m1"), { ...cost, hasUnknownModelCost: true }]);
  assert.equal(buildUsageReport({ client: "claude", files: [file] }, dir).sources[0]?.cost.usd, null);
  writeFileSync(file, [claude("m1"), { ...cost, totalCostUSD: -1 }].map(r => JSON.stringify(r)).join("\n"));
  assert.equal(buildUsageReport({ client: "claude", files: [file] }, dir).sources[0]?.cost.usd, null);
});

test("Report is deterministic, model-separated and rejects empty or unsupported sources", t => {
  const { dir, file } = fixture(t, [context, codex("r1"), { type: "turn_context", payload: { turn_id: "turn2", model: "model-b" } },
    { ...codex("r2"), payload: { ...codex("r2").payload, turn_id: "turn2" } }]);
  const a = buildUsageReport({ client: "codex", files: [file], task: "task\u001b[31m" }, dir);
  assert.deepEqual(a, buildUsageReport({ client: "codex", files: [file], task: "task\u001b[31m" }, dir));
  assert.equal(a.models.length, 2);
  assert.equal(a.totals.input, 200);
  assert.doesNotMatch(formatUsageReport(a), /\u001b/);
  writeFileSync(file, JSON.stringify({ type: "user", content: "PRIVATE" }));
  assert.throws(() => buildUsageReport({ client: "codex", files: [file] }, dir), /No supported usage/);
  assert.throws(() => buildUsageReport({ client: "codex", files: [] }, dir), /--file/);
});

test("CLI runs without init, validates options and preserves sources and directory bytes", t => {
  const { dir, file } = fixture(t, [context, codex("r1")]);
  const before = readFileSync(file);
  const listing = readdirSync(dir);
  const stdout = execFileSync(process.execPath, [cli, "usage", "report", "--client", "codex", "--file", file, "--json"], { cwd: dir, encoding: "utf8" });
  assert.equal(JSON.parse(stdout).totals.input, 100);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(dir), listing);
  const help = execFileSync(process.execPath, [cli, "usage", "--help"], { cwd: dir, encoding: "utf8" });
  assert.match(help, /No initialized pack/);
  for (const args of [["--client", "cursor", "--file", file], ["--client", "codex", "--file", file, "--typo"], ["--client", "codex", "--file"], ["--client", "codex", "--file", file, "--file"], ["--client", "codex", "--file", file, "--json=no"]]) {
    const r = spawnSync(process.execPath, [cli, "usage", "report", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
  }
});

const started = (id: string, at = time) => ({ type: "event_msg", timestamp: at, payload: { type: "task_started", turn_id: id } });
const completed = (id: string) => ({ type: "event_msg", payload: { type: "task_complete", turn_id: id, duration_ms: 1500 } });
const secondRequest = () => ({ ...codex("r2"), payload: { ...codex("r2").payload, turn_id: "turn2" } });

test("Codex turn rows reconcile with total requests and retain incomplete turns", t => {
  const { dir, file } = fixture(t, [started("turn1"), context, codex("r1"), completed("turn1"), started("turn2"), secondRequest()]);
  const r = buildUsageReport({ client: "codex", files: [file], byTurn: true }, dir);
  assert.equal(r.turns?.length, 2);
  assert.equal(r.turns?.[0]?.durationMs, 1500);
  assert.equal(r.turns?.[0]?.complete, true);
  assert.equal(r.turns?.[1]?.complete, false);
  assert.equal(r.turns?.[1]?.durationMs, null);
  assert.equal(r.turns?.reduce((sum, turn) => sum + turn.tokens.input, 0), r.totals.input);
  const selected = buildUsageReport({ client: "codex", files: [file], turns: "2", byTurn: true }, dir);
  assert.equal(selected.requests, 1);
  assert.equal(selected.turns?.[0]?.turn, 2);
  assert.equal(selected.sources[0]?.cumulativeCheck, "turn-filtered");
  assert.equal(buildUsageReport({ client: "codex", files: [file], turns: "1:2" }, dir).requests, 2);
  for (const turns of ["0", "2:1", "1,2", "9007199254740992"]) assert.throws(() => buildUsageReport({ client: "codex", files: [file], turns }, dir), /turn/i);
  assert.throws(() => buildUsageReport({ client: "codex", files: [file, file], turns: "1" }, dir), /one source/);
});

test("Claude user boundaries ignore tool results; selected turns suppress session cost", t => {
  const user = (id: string) => ({ type: "user", promptId: id, timestamp: time, message: { content: [{ type: "text", text: "PRIVATE_USER" }] } });
  const { dir, file } = fixture(t, [user("p1"), claude("m1"), { type: "user", promptId: "tool", message: { content: [{ type: "tool_result", content: "PRIVATE_TOOL" }] } }, claude("m2"), user("p2"), claude("m3"), cost]);
  const all = buildUsageReport({ client: "claude", files: [file], byTurn: true }, dir);
  assert.deepEqual(all.turns?.map(turn => turn.requests), [2, 1]);
  assert.equal(all.turns?.[0]?.complete, null);
  assert.equal(all.turns?.[0]?.durationMs, null);
  const selected = buildUsageReport({ client: "claude", files: [file], turns: "2" }, dir);
  assert.equal(selected.requests, 1);
  assert.equal(selected.sources[0]?.cost.usd, null);
  assert.doesNotMatch(JSON.stringify(all), /PRIVATE_USER|PRIVATE_TOOL/);
});

test("Missing turn metadata is disclosed and time filters do not show full-turn duration", t => {
  const { dir, file } = fixture(t, [codex("unassigned"), started("turn1"), codex("assigned"), completed("turn1")]);
  const all = buildUsageReport({ client: "codex", files: [file], byTurn: true }, dir);
  assert.equal(all.unassignedRequests, 1);
  const filtered = buildUsageReport({ client: "codex", files: [file], from: time, byTurn: true }, dir);
  assert.equal(filtered.turns?.[0]?.durationMs, null);
  writeFileSync(file, JSON.stringify(codex("no-boundaries")));
  assert.throws(() => buildUsageReport({ client: "codex", files: [file], turns: "1" }, dir), /No supported usage/);
});

test("usage_report MCP shares CLI calculation, is read-only and validates its arguments", async t => {
  const { dir, file } = fixture(t, [started("turn1"), context, codex("r1"), completed("turn1")]);
  initPack(dir);
  const state = readFileSync(path.join(dir, ".agentpack", "state.json"));
  const input = new PassThrough();
  const output = new PassThrough();
  t.after(() => { input.destroy(); output.destroy(); });
  startMcpServer(dir, input, output);
  let id = 0;
  const send = (args: Record<string, unknown>): Promise<{ result?: { content: Array<{ text: string }> }; error?: unknown }> => new Promise(resolve => {
    output.once("data", data => resolve(JSON.parse(data.toString())));
    input.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "usage_report", arguments: args } }) + "\n");
  });
  const response = await send({ client: "codex", files: [file], byTurn: true, turns: "1", json: true });
  assert.ok(response.result);
  const cliReport = JSON.parse(execFileSync(process.execPath, [cli, "usage", "report", "--client", "codex", "--file", file, "--by-turn", "--turns", "1", "--json"], { cwd: dir, encoding: "utf8" }));
  assert.deepEqual(JSON.parse(response.result.content[0]!.text), cliReport);
  const manifestFile = path.join(dir, "task-usage.json");
  writeFileSync(manifestFile, JSON.stringify({ version: 1, taskId: "task_test", coverage: { status: "partial", note: "Main session only" }, sources: [
    { client: "codex", file: "input.jsonl", turns: "1", phase: "implementation" }
  ] }));
  const mapped = await send({ manifest: manifestFile, byTurn: true, json: true });
  assert.ok(mapped.result);
  const mappedCli = JSON.parse(execFileSync(process.execPath, [cli, "usage", "report", "--manifest", manifestFile, "--by-turn", "--json"], { cwd: dir, encoding: "utf8" }));
  assert.deepEqual(JSON.parse(mapped.result.content[0]!.text), mappedCli);
  assert.equal(mappedCli.slices[0].report.turns[0].complete, true);
  assert.ok((await send({ manifest: manifestFile, client: "codex", files: [file] })).error);
  assert.ok((await send({ manifest: manifestFile, json: "true" })).error);
  assert.ok((await send({ manifest: " " })).error);
  assert.equal(spawnSync(process.execPath, [cli, "usage", "report", "--manifest", manifestFile, "--client", "codex"], { cwd: dir }).status, 1);
  assert.equal(TOOL_DEFINITIONS.find(tool => tool.name === "usage_report")?.annotations.readOnlyHint, true);
  assert.deepEqual(readFileSync(path.join(dir, ".agentpack", "state.json")), state);
  for (const args of [{ client: "cursor", files: [file] }, { client: "codex", files: [] }, { client: "codex", files: [false] }, { client: "codex", files: [file], byTurn: "true" }, { client: "codex", files: [file], unexpected: true }]) {
    assert.ok((await send(args)).error);
  }
});


test("Task usage manifest aggregates disjoint phases and clients with explicit coverage", t => {
  const { dir } = fixture(t, [started("turn1"), context, codex("r1"), completed("turn1"),
    started("turn2"), { type: "turn_context", payload: { turn_id: "turn2", model: "model-b" } },
    { ...codex("r2"), payload: { ...codex("r2").payload, turn_id: "turn2" } }, completed("turn2")]);
  writeFileSync(path.join(dir, "claude.jsonl"), [claude("m1"), cost].map(row => JSON.stringify(row)).join("\n"));
  const manifest = path.join(dir, "usage.json");
  const data = { version: 1, taskId: "task_test", coverage: { status: "declared-complete", note: "Author declaration, not verified" }, sources: [
    { client: "codex", file: "input.jsonl", turns: "1", phase: "implementation" },
    { client: "codex", file: "input.jsonl", turns: "2", phase: "fixes" },
    { client: "claude", file: "claude.jsonl", phase: "review" }
  ] };
  writeFileSync(manifest, JSON.stringify(data));
  const before = readdirSync(dir);
  const bytes = readFileSync(manifest);
  const r = buildTaskUsageReport(manifest, os.tmpdir(), true);
  assert.equal(r.requests, 3);
  assert.deepEqual(r.totals, { input: 300, uncachedInput: 90, cacheRead: 180, cacheWrite: 30, output: 60, reasoning: null });
  assert.equal(r.slices[1]?.report.models[0]?.model, "model-b");
  assert.equal(r.slices[2]?.report.sources[0]?.cost.usd, 0.25);
  assert.equal(r.billedUsd, null);
  assert.equal(r.coverage.status, "declared-complete");
  assert.match(formatTaskUsageReport(r), /not independently verified/);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_PROMPT_SENTINEL|requestIds/);
  assert.deepEqual(readdirSync(dir), before);
  assert.deepEqual(readFileSync(manifest), bytes);
});

test("Task usage rejects overlapping requests across ranges, aliases and copied exports", t => {
  const { dir, file } = fixture(t, [started("turn1"), context, codex("r1"), completed("turn1")]);
  const manifest = path.join(dir, "usage.json");
  writeFileSync(path.join(dir, "copy.jsonl"), readFileSync(file));
  symlinkSync(file, path.join(dir, "alias.jsonl"));
  for (const second of ["input.jsonl", "copy.jsonl", "alias.jsonl"]) {
    writeFileSync(manifest, JSON.stringify({ version: 1, taskId: "task_test", coverage: { status: "partial", note: "Main session" }, sources: [
      { client: "codex", file: "input.jsonl", turns: "1", phase: "implementation" },
      { client: "codex", file: second, phase: "review" }
    ] }));
    assert.throws(() => buildTaskUsageReport(manifest, dir), /Overlapping usage selections/);
  }
});

test("Task usage validates bounded manifests without leaking malformed content", t => {
  const { dir } = fixture(t, [context, codex("r1")]);
  const file = path.join(dir, "usage.json");
  const valid = { version: 1, taskId: "task_test", coverage: { status: "partial", note: "Selected source" }, sources: [
    { client: "codex", file: "input.jsonl", phase: "implementation" }
  ] };
  for (const value of [null, { ...valid, version: 2 }, { ...valid, unexpected: true }, { ...valid, taskId: "label" },
    { ...valid, coverage: { status: "complete", note: "Unchecked" } }, { ...valid, sources: [] },
    { ...valid, sources: Array(33).fill(valid.sources[0]) },
    { ...valid, sources: [{ ...valid.sources[0], from: time }] },
    { ...valid, sources: [{ ...valid.sources[0], client: "cursor" }] },
    { ...valid, coverage: { status: "partial", note: "\u001b[31m" } }]) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => buildTaskUsageReport(file, dir), /usage|Usage|Invalid|Unsupported|Supported/);
  }
  writeFileSync(file, "PRIVATE_PROMPT_SENTINEL invalid JSON");
  assert.throws(() => buildTaskUsageReport(file, dir), /must contain valid JSON/);
  writeFileSync(file, " ".repeat(1024 * 1024 + 1));
  assert.throws(() => buildTaskUsageReport(file, dir), /at most 1 MiB/);
  assert.throws(() => buildTaskUsageReport(dir, dir), /regular local JSON/);
});
