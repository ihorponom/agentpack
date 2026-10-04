import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PassThrough } from "node:stream";
import { startMcpServer, TOOL_DEFINITIONS } from "../src/mcp/server.js";
import { initPack } from "../src/core/store.js";
import { buildUsageReport, formatUsageReport } from "../src/core/usage.js";
import { buildLinkedTaskUsageReport, buildTaskUsageReport, formatTaskUsageReport, linkTaskUsage, taskUsageManifestPath, unlinkTaskUsage } from "../src/core/usage-manifest.js";
import { findUsageCandidates } from "../src/core/usage-discovery.js";
import { closeCurrentTask, parkCurrentTask, readTaskActiveIntervals, startTask } from "../src/core/tasks.js";
import { buildTuiModel, loadTuiTaskUsage } from "../src/core/tui.js";

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

test("Agentpack overhead estimates Claude and wrapped Codex calls without exposing response text", t => {
  const claudeCall = { ...claude("c1"), message: { ...claude("c1").message,
    content: [{ type: "tool_use", id: "tool-1", name: "mcp__agentpack__task_park", input: {} }] } };
  const claudeResult = { type: "user", timestamp: time, message: { content: [
    { type: "tool_result", tool_use_id: "tool-1", content: "PRIVATE_RESULT_1234" }] } };
  const { dir, file } = fixture(t, [claudeCall, claudeResult, claude("c2")]);
  const claudeReport = buildUsageReport({ client: "claude", files: [file] }, dir);
  assert.equal(claudeReport.agentpackOverhead.calls, 1);
  assert.equal(claudeReport.agentpackOverhead.responseTokens, Math.ceil("PRIVATE_RESULT_1234".length / 4));
  assert.equal(claudeReport.agentpackOverhead.rereadTokensUpperBound, claudeReport.agentpackOverhead.responseTokens);
  assert.equal(claudeReport.agentpackOverhead.outputTokensUpperBound, 20);
  assert.equal(claudeReport.agentpackOverhead.byTool[0]?.tool, "task_park");
  assert.doesNotMatch(JSON.stringify(claudeReport), /PRIVATE_RESULT/);

  const wrapped = "const r = await tools.mcp__agentpack__task_switch({id:'task_test'}); text(r);";
  const resultBlock = JSON.stringify({ content: [{ type: "text", text: "Switched to task task_test" }] });
  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec", input: wrapped } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1", output: [{ type: "text", text: resultBlock }] } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
  const codexReport = buildUsageReport({ client: "codex", files: [file] }, dir);
  assert.equal(codexReport.agentpackOverhead.calls, 1);
  assert.equal(codexReport.agentpackOverhead.responseTokens, Math.ceil(resultBlock.length / 4));
  assert.equal(codexReport.agentpackOverhead.rereadTokensUpperBound, codexReport.agentpackOverhead.responseTokens);
  assert.equal(codexReport.agentpackOverhead.outputTokensUpperBound, 20);
  assert.equal(codexReport.agentpackOverhead.byTool[0]?.tool, "task_switch");

  const mixed = "const r = await Promise.all([tools.mcp__agentpack__task_switch({id:'task_test'}), tools.exec_command({cmd:'pwd'})]); text(r);";
  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-2", name: "exec", input: mixed } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-2", output: "PRIVATE_MIXED_RESULT" } },
    codex("r2", usage, "2026-10-02T12:01:00Z")].map(row => JSON.stringify(row)).join("\n") + "\n");
  const mixedReport = buildUsageReport({ client: "codex", files: [file] }, dir);
  assert.equal(mixedReport.agentpackOverhead.calls, 0, "wrapper source is not proof of execution");
  assert.equal(mixedReport.agentpackOverhead.unattributedResponses, 1);
  assert.equal(mixedReport.agentpackOverhead.responseTokens, 0);
  const laterOnly = buildUsageReport({ client: "codex", files: [file], from: "2026-10-02T12:01:00Z" }, dir);
  assert.equal(laterOnly.requests, 1);
  assert.equal(laterOnly.agentpackOverhead.calls, 0, "a call made by an excluded request cannot attach to the next selected request");

  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-3", name: "exec", input: mixed } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-3", output: [
      { type: "text", text: "Script completed" }, { type: "text", text: resultBlock },
      { type: "text", text: JSON.stringify({ output: "PRIVATE_SHELL_RESULT" }) }] } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
  const separated = buildUsageReport({ client: "codex", files: [file] }, dir);
  assert.equal(separated.agentpackOverhead.unattributedResponses, 0);
  assert.equal(separated.agentpackOverhead.responseTokens, Math.ceil(resultBlock.length / 4));
  assert.equal(separated.agentpackOverhead.byTool[0]?.responseTokens, Math.ceil(resultBlock.length / 4));
  assert.doesNotMatch(JSON.stringify(separated), /PRIVATE_SHELL_RESULT/);
  const copy = path.join(dir, "fork.jsonl");
  writeFileSync(copy, readFileSync(file));
  const repeated = buildUsageReport({ client: "codex", files: [file, copy] }, dir);
  assert.equal(repeated.requests, 2);
  assert.equal(repeated.agentpackOverhead.calls, 1, "a copied call in a fork is not counted twice");
  assert.equal(repeated.agentpackOverhead.responseTokens, separated.agentpackOverhead.responseTokens);

  const twoCalls = "const r = await Promise.all([tools.mcp__agentpack__attach_evidence({content:'x'}), tools.mcp__agentpack__checkpoint({summary:'y'})]); r.forEach(text);";
  const evidenceBlock = JSON.stringify({ content: [{ type: "text", text: "Attached evidence evt_test." }] });
  const checkpointBlock = JSON.stringify({ content: [{ type: "text", text: "Created checkpoint cp_test." }] });
  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-4", name: "exec", input: twoCalls } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-4", output: [
      { type: "text", text: checkpointBlock }, { type: "text", text: evidenceBlock }] } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
  const separatedPair = buildUsageReport({ client: "codex", files: [file] }, dir);
  assert.equal(separatedPair.agentpackOverhead.calls, 2);
  assert.equal(separatedPair.agentpackOverhead.unattributedResponses, 0);
  assert.deepEqual(separatedPair.agentpackOverhead.byTool.map(row => [row.tool, row.responseTokens]), [
    ["attach_evidence", Math.ceil(evidenceBlock.length / 4)], ["checkpoint", Math.ceil(checkpointBlock.length / 4)]]);

  const loop = "const ids = ['a','b','c','d','e']; const r = await Promise.all(ids.map(id => tools.mcp__agentpack__task_status({id}))); r.forEach(text);";
  const statusBlock = (id: number) => JSON.stringify({ id: `task_${id}`, status: "fulfilled", result: { content: [{ type: "text", text: "Task inspection (read-only)\n" }] } });
  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-5", name: "exec", input: loop } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-5", output: Array.from({ length: 5 }, (_, i) => ({ type: "text", text: statusBlock(i) })) } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
  const loopReport = buildUsageReport({ client: "codex", files: [file] }, dir);
  assert.equal(loopReport.agentpackOverhead.calls, 5, "executed results determine looped call count");
  assert.equal(loopReport.agentpackOverhead.byTool[0]?.calls, 5);
  const errorBlock = (id: number) => JSON.stringify({ id: `short_${id}`, status: "fulfilled", result: { content: [{ type: "text", text: "tool call error: Invalid task id" }], isError: true } });
  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-5a", name: "exec", input: loop } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-5a", output: Array.from({ length: 5 }, (_, i) => ({ type: "text", text: errorBlock(i) })) } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead.calls, 5,
    "MCP errors still prove that five tool calls executed");

  const mixedMcp = "const r = await Promise.all([tools.mcp__agentpack__task_status({id:'a'}), tools.mcp__other__lookup({id:'b'})]); r.forEach(text);";
  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-5b", name: "exec", input: mixedMcp } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-5b", output: [{ type: "text", text: errorBlock(0) }] } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead.calls, 0,
    "an unlabeled result in a wrapper with another MCP server is ambiguous");

  const duplicatePrint = "const r = await tools.mcp__agentpack__task_status({id:'a'}); text(r); text(r);";
  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-5c", name: "exec", input: duplicatePrint } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-5c", output: [
      { type: "text", text: statusBlock(0) }, { type: "text", text: statusBlock(0) }] } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
  const duplicated = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(duplicated.calls, 1, "printing one result twice does not execute the tool twice");
  assert.equal(duplicated.responseTokens, 2 * Math.ceil(statusBlock(0).length / 4), "both printed copies occupy context");

  const quoted = "await tools.apply_patch(\"+ tools.mcp__agentpack__task_status({id:'unused'})\");";
  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-6", name: "exec", input: quoted } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-6", output: [{ type: "text", text: "{}" }] } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead.calls, 0,
    "quoted source code is not an Agentpack invocation");
});

test("Agentpack overhead attributes compact task status printed directly in Codex", t => {
  const status = "Task task_example. State: active; Verification: pending; Next: Review; Branch: main; Write scope: src; Drift: none";
  const { dir, file } = fixture(t, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-status", name: "exec",
      input: "const r = await tools.mcp__agentpack__task_status({}); text(r.content[0]);" } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-status",
      output: [{ type: "text", text: status }] } },
    codex("r2")]);
  const overhead = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(overhead.calls, 1);
  assert.equal(overhead.responseTokens, Math.ceil(status.length / 4));
  assert.equal(overhead.byTool[0]?.tool, "task_status");
});

test("Codex overhead recognizes lifecycle results in a mixed code-mode wrapper", t => {
  const source = "await tools.mcp__agentpack__task_list({open:true,compact:true}); await tools.exec_command({cmd:'pwd'}); await tools.mcp__agentpack__task_update_verification({status:'pending'}); await tools.mcp__agentpack__task_finalize({status:'passed'});";
  const list = "* task_example [active] Probe task\n- task_other [parked] Other task";
  const verification = "Updated verification for task task_example (pending). Verification remains pending.";
  const finalization = "Finalized task task_example (passed). Bound HEAD abc1234.";
  const { dir, file } = fixture(t, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-lifecycle", name: "exec", input: source } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-lifecycle", output: [
      { type: "text", text: "RESULT 0" }, { type: "text", text: list },
      { type: "text", text: "PRIVATE_SHELL_RESULT" }, { type: "text", text: verification },
      { type: "text", text: finalization }] } },
    codex("r2")]);
  const overhead = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(overhead.calls, 3);
  assert.equal(overhead.responseTokens, [list, verification, finalization].reduce((sum, value) => sum + Math.ceil(value.length / 4), 0));
  assert.equal(overhead.unattributedResponses, 0);
  assert.deepEqual(overhead.byTool.map(row => [row.tool, row.calls]), [
    ["task_finalize", 1], ["task_list", 1], ["task_update_verification", 1]]);
  assert.doesNotMatch(JSON.stringify(overhead), /PRIVATE_SHELL_RESULT|Probe task/);

  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-noop", name: "exec",
      input: "await tools.mcp__agentpack__task_update_verification({status:'pending'});" } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-noop", output: [
      { type: "text", text: "Verification unchanged for task task_example (pending)." }] } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead.byTool[0]?.tool, "task_update_verification");

  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-ambiguous", name: "exec", input: source } },
    codex("r1"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-ambiguous", output: [
      { type: "text", text: "PRIVATE_SHELL_RESULT without any Agentpack result" }] } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
  const ambiguous = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(ambiguous.calls, 0, "source expressions and unrelated shell output do not prove execution");
  assert.equal(ambiguous.unattributedResponses, 1);
});

test("Codex overhead recognizes supported task-list text and validated JSON results", t => {
  const { dir, file } = fixture(t, []);
  const reportFor = (result: string) => {
    writeFileSync(file, [context,
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-list", name: "exec",
        input: "const r = await tools.mcp__agentpack__task_list({}); text(r.content[0]);" } },
      codex("r1"),
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-list",
        output: [{ type: "text", text: result }] } },
      codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
    return buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  };
  const listed = "* task_example [active] Probe task";
  const json = JSON.stringify([{ id: "task_example", title: "Probe task", status: "active",
    branch: null, current: true, updatedAt: time, writeScope: [] }]);
  for (const result of [listed, `[warn] skipped one invalid passport\n${listed}`,
    "No task passports yet. Call `task_start` first.", "No task passports match the filters.",
    "[warn] skipped one invalid passport\nNo task passports match the filters.", json]) {
    const overhead = reportFor(result);
    assert.equal(overhead.calls, 1, result);
    assert.equal(overhead.byTool[0]?.tool, "task_list");
    assert.equal(overhead.responseTokens, Math.ceil(result.length / 4));
    assert.equal(overhead.unattributedResponses, 0);
  }
  for (const result of ["[]", "[warn] skipped one invalid passport", '[{"id":"task_example"}]']) {
    const overhead = reportFor(result);
    assert.equal(overhead.calls, 0, result);
    assert.equal(overhead.unattributedResponses, 1);
  }
});

test("Codex overhead counts completed nested MCP calls with dynamic code-mode dispatch", t => {
  const nested = (id: string, tool: string, text: string, server = "agentpack") => ({ type: "event_msg",
    payload: { type: "item_completed", item: { type: "McpToolCall", id, server, tool, status: "completed",
      result: { content: [{ type: "text", text }] } } } });
  const source = "const name = ALL_TOOLS.find(x => x.name.endsWith('task_status')).name; const r = await tools[name]({}); text(r.content[0]);";
  const status = "Task task_example. State: active; Verification: pending; Next: Review; Branch: main; Write scope: src; Drift: none";
  const list = "* task_example [active] Probe task";
  const rows = (input: string, events: unknown[], output?: unknown) => [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-nested", name: "exec", input } },
    codex("r1"), ...events,
    ...(output === undefined ? [] : [{ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-nested", output } }]),
    codex("r2")];
  const { dir, file } = fixture(t, rows(source, [nested("exec-status", "task_status", status),
    nested("exec-list", "task_list", list)], [
      { type: "text", text: `CALL task_status\n${status}\nEND_CALL` },
      { type: "text", text: `CALL task_list\n${list}\nEND_CALL` },
      { type: "text", text: "PRIVATE_SHELL_RESULT" }]));
  const report = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(report.calls, 2);
  assert.equal(report.responseTokens, Math.ceil(status.length / 4) + Math.ceil(list.length / 4));
  assert.equal(report.unattributedResponses, 0);
  assert.deepEqual(report.byTool.map(row => [row.tool, row.calls]), [["task_list", 1], ["task_status", 1]]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SHELL_RESULT|Probe task/);

  writeFileSync(file, rows("const r = await tools.mcp__agentpack__task_status({}); text(r.content[0]);",
    [nested("exec-status", "task_status", status)], [{ type: "text", text: status }, { type: "text", text: status }])
    .map(row => JSON.stringify(row)).join("\n") + "\n");
  const repeated = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(repeated.calls, 1, "nested event and printed result must not double count the call");
  assert.equal(repeated.responseTokens, 2 * Math.ceil(status.length / 4));

  const wrapped = JSON.stringify({ content: [{ type: "text", text: status }] });
  writeFileSync(file, rows(source, [nested("exec-status", "task_status", status),
    nested("exec-status", "task_status", status)], [{ type: "text", text: wrapped }])
    .map(row => JSON.stringify(row)).join("\n") + "\n");
  const wrappedReport = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(wrappedReport.calls, 1, "repeated completion for one nested id is one call");
  assert.equal(wrappedReport.responseTokens, Math.ceil(wrapped.length / 4), "JSON printed result remains visible");

  writeFileSync(file, rows(source, [nested("exec-status", "task_status", status)],
    [{ type: "text", text: "PRIVATE_SHELL_RESULT" }]).map(row => JSON.stringify(row)).join("\n") + "\n");
  const hidden = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(hidden.calls, 1, "completed event proves a call even when its result is not printed");
  assert.equal(hidden.responseTokens, 0, "unprinted MCP results do not enter visible response estimates");
  assert.equal(hidden.unattributedResponses, 1);
  assert.equal(hidden.outputTokensUpperBound, usage.output_tokens, "the invoking request output counts without a printed result");
  assert.equal(hidden.byTool[0]!.outputTokensUpperBound, usage.output_tokens);

  writeFileSync(file, rows(source, [nested("exec-list", "task_list", "[]")], [{ type: "text", text: "[] [] []" }])
    .map(row => JSON.stringify(row)).join("\n") + "\n");
  const short = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(short.calls, 1);
  assert.equal(short.responseTokens, 0, "short results are not matched as substrings of unrelated output");

  writeFileSync(file, rows(source, [nested("exec-other", "task_status", status, "other")])
    .map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead.calls, 0);

  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-a", name: "exec", input: source } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-b", name: "exec", input: source } },
    codex("r1"), nested("exec-status", "task_status", status),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-a", output: [] } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-b", output: [] } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n");
  const parallel = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(parallel.calls, 0, "a nested event cannot be assigned when two exec wrappers are open");
  assert.equal(parallel.unattributedResponses, 1, "an unassigned nested event remains visible");

  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-orphan", name: "exec", input: source } },
    codex("r1"), { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-nested", name: "exec", input: source } },
    codex("r2"), nested("exec-status", "task_status", status),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-nested", output: [{ type: "text", text: status }] } },
    codex("r3")].map(row => JSON.stringify(row)).join("\n") + "\n");
  const orphan = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(orphan.calls, 0, "a wrapper without output keeps later nested events unassigned");
  assert.equal(orphan.unattributedResponses, 1, "a wrapper without output does not hide later nested events");

  const direct = (prefix: unknown[]) => [context, ...prefix,
    { type: "response_item", payload: { type: "function_call", call_id: "call-direct", name: "mcp__agentpack__task_status", arguments: "{}" } },
    codex("r1"), nested("call-direct", "task_status", status),
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-direct", output: status } },
    codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(file, direct([]));
  const directReport = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.deepEqual([directReport.calls, directReport.unattributedResponses], [1, 0], "a direct call completion is not a nested call");
  writeFileSync(file, direct([{ type: "response_item", payload: { type: "custom_tool_call", call_id: "call-stale", name: "exec", input: source } }, codex("r0")]));
  const stale = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.deepEqual([stale.calls, stale.outputTokensUpperBound], [1, usage.output_tokens], "a stale wrapper does not claim a later direct call");

  const inner = "Task task_example. State: active";
  const outer = `${inner}; Verification: pending`;
  writeFileSync(file, rows(source, [nested("exec-inner", "task_status", inner), nested("exec-outer", "task_status", outer)],
    [{ type: "text", text: `out: ${outer}` }]).map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead.responseTokens, Math.ceil(outer.length / 4),
    "a result contained in another printed result is not counted twice");

  const twoOpen = [context,
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-a", name: "exec", input: source } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-b", name: "exec", input: source } },
    codex("r1"), nested("exec-status", "task_status", status), codex("r2")].map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(file, twoOpen);
  const copy = path.join(dir, "copy.jsonl");
  writeFileSync(copy, twoOpen);
  assert.equal(buildUsageReport({ client: "codex", files: [file, copy] }, dir).agentpackOverhead.unattributedResponses, 1,
    "duplicate sources report an unassigned nested event once");
});

test("Agentpack overhead recognizes project-scoped server names and ignores look-alikes", t => {
  const claudeCall = (id: string, name: string) => ({ ...claude(id), message: { ...claude(id).message,
    content: [{ type: "tool_use", id: `tool-${id}`, name, input: {} }] } });
  const claudeResult = (id: string) => ({ type: "user", timestamp: time, message: { content: [
    { type: "tool_result", tool_use_id: `tool-${id}`, content: "result" }] } });
  const { dir, file } = fixture(t, [claudeCall("c1", "mcp__agentpack-demo-repo__task_status"), claudeResult("c1"),
    claudeCall("c2", "mcp__agentpackish__task_status"), claudeResult("c2"), claude("c3")]);
  const claudeReport = buildUsageReport({ client: "claude", files: [file] }, dir).agentpackOverhead;
  assert.deepEqual(claudeReport.byTool.map(row => [row.tool, row.calls]), [["task_status", 1]]);

  const status = "Task task_example. State: active; Verification: pending; Next: Review";
  const list = "* task_example [active] Demo task";
  writeFileSync(file, [context,
    { type: "response_item", payload: { type: "function_call", call_id: "call-direct", namespace: "mcp__agentpack_demo_repo__", name: "task_status", arguments: "{}" } },
    codex("r1"),
    { type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", id: "call-direct", server: "agentpack-demo-repo",
      tool: "task_status", status: "completed", result: { content: [{ type: "text", text: status }] } } } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-direct", output: status } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-wrapped", name: "exec",
      input: "const r = await tools.mcp__agentpack_demo_repo__task_list({}); text(r.content[0]);" } },
    codex("r2"),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-wrapped", output: [{ type: "text", text: list }] } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-nested", name: "exec", input: "await tools[n]({})" } },
    codex("r3"),
    { type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", id: "exec-1", server: "agentpack-demo-repo",
      tool: "checkpoint", status: "completed", result: { content: [{ type: "text", text: "Created checkpoint 2026-10-04" }] } } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", id: "exec-2", server: "agentpackish",
      tool: "checkpoint", status: "completed", result: { content: [{ type: "text", text: "Created checkpoint 2026-10-05" }] } } } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-nested", output: [] } },
    { type: "response_item", payload: { type: "function_call", call_id: "call-other", namespace: "mcp__agentpackish__", name: "task_status", arguments: "{}" } },
    codex("r4")].map(row => JSON.stringify(row)).join("\n") + "\n");
  const codexReport = buildUsageReport({ client: "codex", files: [file] }, dir).agentpackOverhead;
  assert.equal(codexReport.calls, 3);
  assert.deepEqual(codexReport.byTool.map(row => [row.tool, row.calls]), [["checkpoint", 1], ["task_list", 1], ["task_status", 1]]);
  assert.equal(codexReport.unattributedResponses, 0);
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
  assert.equal(buildUsageReport({ client: "codex", files: [file], turns: "2:" }, dir).requests, 1);
  assert.equal(buildUsageReport({ client: "codex", files: [file], turns: "1:" }, dir).turnSelection, "1:");
  for (const turns of ["0", "2:1", "1,2", ":2", "9007199254740992", "9007199254740992:"]) assert.throws(() => buildUsageReport({ client: "codex", files: [file], turns }, dir), /turn/i);
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

test("Task usage links suggested sessions once and reports by Task Passport id across CLI, MCP and TUI", async t => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentpack-task-usage-")));
  const home = mkdtempSync(path.join(os.tmpdir(), "agentpack-usage-home-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  initPack(dir);
  const passport = startTask(dir, { title: "Usage task" });
  const created = Date.parse(passport.createdAt);
  const before = new Date(created - 3_600_000).toISOString();
  const after = new Date(created + 60_000).toISOString();
  const user = (id: string, at: string) => ({ type: "user", promptId: id, timestamp: at, message: { content: "PRIVATE_USER" } });
  const write = (file: string, rows: unknown[]) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    return file;
  };
  const project = path.join(home, "claude", "projects", path.resolve(passport.worktree).replace(/[^A-Za-z0-9]/gu, "-"));
  const main = write(path.join(project, "main.jsonl"), [user("p1", before), claude("a1", 20, before), user("p2", before),
    claude("a2", 20, after), user("p3", after), claude("a3", 20, after)]);
  const child = write(path.join(project, "main", "subagents", "agent-x.jsonl"), [claude("b1", 20, after)]);
  // Coarse filesystem clocks can stamp a just-written file slightly before the task start.
  for (const file of [main, child]) utimesSync(file, new Date(created - 5), new Date(created - 5));
  write(path.join(project, "old.jsonl"), [user("p0", before), claude("c1", 20, before)]);
  const day = new Date(created);
  const codexDay = path.join(home, "codex", "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
  const meta = (cwd: string) => ({ type: "session_meta", timestamp: after, payload: { id: "session", cwd } });
  const codexFile = write(path.join(codexDay, "rollout-a.jsonl"), [meta(dir), started("turn1", after), context, codex("r1", usage, after), completed("turn1")]);
  write(path.join(codexDay, "rollout-other.jsonl"), [meta(home), started("turn1", after), context, codex("r9", usage, after)]);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, "claude"), CODEX_HOME: path.join(home, "codex") };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "usage", ...args], { cwd: dir, encoding: "utf8", env });

  const found = findUsageCandidates(dir, passport.id, env);
  assert.deepEqual(found.candidates.map(c => [c.client, c.id, c.subagent, c.taskRequests, c.requests]), [
    ["claude", "main", false, 2, 3],
    ["codex", "rollout-a", false, 1, 1],
    ["claude", "agent-x", true, 1, 1]
  ]);

  const listed = run("report");
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /No usage sources linked yet/);
  assert.match(listed.stdout, /1\. main \(claude\)/);
  assert.match(listed.stdout, /2\/3 requests counted for the task/);
  assert.doesNotMatch(listed.stdout, /old\.jsonl|rollout-other|PRIVATE/);
  const candidatesJson = JSON.parse(run("report", "--json").stdout);
  assert.deepEqual(Object.keys(candidatesJson).sort(), ["candidates", "intervals", "kind", "linked", "searched", "taskId", "warnings"], "candidates JSON contract");
  assert.equal(candidatesJson.kind, "task-usage-candidates");
  assert.deepEqual(Object.keys(candidatesJson.candidates[0]).sort(), ["client", "file", "id", "linked", "number", "requests", "started", "subagent", "taskRequests", "traced"], "candidate JSON contract");
  assert.match(run("link", "--coverage", "partial", "--note", "Main only").stderr, /link sources before declaring coverage/);
  assert.equal(existsSync(taskUsageManifestPath(dir, passport.id)), false, "listing does not link");

  const linked = run("link", "--pick", "main,2", "--phase", "implementation");
  assert.equal(linked.status, 0, linked.stderr);
  assert.match(linked.stdout, /Linked to task_.*: main\.jsonl, rollout-a\.jsonl/);
  const manifest = JSON.parse(readFileSync(taskUsageManifestPath(dir, passport.id), "utf8"));
  assert.deepEqual(manifest.sources.map((source: { file: string; turns?: string }) => [source.file, source.turns]), [[realpathSync(main), undefined], [realpathSync(codexFile), undefined]]);
  const report = JSON.parse(run("report", "--task", passport.id, "--json").stdout);
  assert.equal(report.kind, "task-usage-report");
  assert.deepEqual(Object.keys(report).sort(), ["agentpackOverhead", "billedUsd", "coverage", "kind", "manifest", "requests", "slices", "taskId", "totals", "version", "warnings"], "task report JSON contract");
  const linkJson = JSON.parse(run("link", "--client", "codex", "--file", codexFile, "--phase", "implementation", "--json").stdout);
  assert.deepEqual(Object.keys(linkJson).sort(), ["kind", "linked", "report", "taskId"], "link JSON contract");
  assert.equal(linkJson.kind, "task-usage-link");
  assert.equal(report.taskId, passport.id);
  assert.equal(report.requests, 3);
  assert.equal(report.coverage.status, "partial");
  assert.deepEqual(JSON.parse(run("report", "--json").stdout), report, "current task is the default");

  assert.equal(run("link", "--client", "claude", "--file", main, "--turns", "3").status, 0);
  assert.equal(JSON.parse(run("report", "--json").stdout).requests, 2, "re-linking a file replaces its selection");
  assert.match(run("unlink", "--file", main).stdout, /1 linked source\(s\) remain/);
  for (const args of [["link", "--pick", "9"], ["link", "--pick", "unknown-session"], ["link", "--pick", "1", "--turns", "2"],
    ["link", "--coverage", "declared-complete"], ["link", "--phase", "review"], ["link", "--client", "claude", "--file", main, "--file", child],
    ["report", "--turns", "1"], ["report", "--task", "task_missing"], ["unlink", "--file", main]]) {
    const failed = run(...args);
    assert.equal(failed.status, 1, args.join(" "));
  }
  assert.match(run("report", "--task", "Fix retries").stderr, /descriptive label use --client\/--file/);

  const savedEnv = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = env.CODEX_HOME;
  const input = new PassThrough();
  const output = new PassThrough();
  t.after(() => {
    input.destroy(); output.destroy();
    if (savedEnv.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedEnv.claude;
    if (savedEnv.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedEnv.codex;
  });
  startMcpServer(dir, input, output);
  let id = 0;
  const call = (name: string, args: Record<string, unknown>): Promise<{ result?: { content: Array<{ text: string }> }; error?: unknown }> => new Promise(resolve => {
    output.once("data", data => resolve(JSON.parse(data.toString())));
    input.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  const candidates = await call("usage_link", { json: true });
  assert.deepEqual(JSON.parse(candidates.result!.content[0]!.text).candidates.map((c: { linked: boolean }) => c.linked), [false, true, false]);
  const pickedChild = await call("usage_link", { pick: ["agent-x"], phase: "subagent" });
  assert.match(pickedChild.result!.content[0]!.text, /Linked to task_.*: agent-x\.jsonl/);
  assert.ok((await call("usage_link", { coverage: "declared-complete", note: "Main, Codex and subagent sessions" })).result);
  const mcpReport = JSON.parse((await call("usage_report", { task: passport.id, json: true })).result!.content[0]!.text);
  assert.deepEqual(mcpReport, JSON.parse(run("report", "--json").stdout));
  assert.equal(mcpReport.requests, 2);
  assert.equal(mcpReport.coverage.status, "declared-complete");
  for (const [name, args] of [["usage_report", { from: time }], ["usage_link", { pick: [1], file: main }], ["usage_link", { remove: child, phase: "x" }], ["usage_link", { coverage: "partial" }]] as const) {
    assert.ok((await call(name, args)).error, JSON.stringify(args));
  }
  assert.match((await call("usage_link", { remove: "agent-x" })).result!.content[0]!.text, /1 linked source/, "unlink accepts the session id");

  closeCurrentTask(dir);
  const closedAt = new Date(created + 120_000).toISOString();
  writeFileSync(path.join(dir, ".agentpack", "tasks", passport.id, "events.jsonl"),
    [{ type: "task-start", ts: passport.createdAt }, { type: "task-close", ts: closedAt }].map(event => JSON.stringify(event)).join("\n") + "\n");
  writeFileSync(codexFile, readFileSync(codexFile, "utf8") + JSON.stringify(codex("r2", usage, new Date(created + 180_000).toISOString())) + "\n");
  const closed = JSON.parse(run("report", "--task", passport.id, "--json").stdout);
  assert.equal(closed.requests, 1, "requests after the task closed are excluded");
  assert.ok(closed.warnings.some((warning: string) => warning.includes("while the task was the current Passport")));
  assert.deepEqual(closed.slices[0].report.boundary.intervals, [{ from: passport.createdAt, to: closedAt }]);

  const tui = loadTuiTaskUsage(buildTuiModel(dir), { passport, current: false }).join("\n");
  assert.match(tui, new RegExp(`Task usage: ${passport.id}`));
  assert.match(tui, /Requests: 1/);
  assert.doesNotMatch(tui, /PRIVATE/);
});

test("Tasks sharing one session split it by the periods each task was current", t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-usage-intervals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initPack(dir);
  const a = startTask(dir, { title: "First" });
  parkCurrentTask(dir);
  const b = startTask(dir, { title: "Second" });
  const at = (minutes: number) => new Date(Date.parse("2026-10-01T10:00:00Z") + minutes * 60_000).toISOString();
  const events = (id: string, rows: Array<[string, number]>) => writeFileSync(path.join(dir, ".agentpack", "tasks", id, "events.jsonl"),
    rows.map(([type, minutes]) => JSON.stringify({ type, ts: at(minutes) })).join("\n") + "\n");
  events(a.id, [["task-start", 0], ["task-park", 10], ["task-switch", 30], ["task-park", 40]]);
  events(b.id, [["task-start", 10], ["task-park", 30], ["task-switch", 40]]);
  const session = path.join(dir, "shared.jsonl");
  writeFileSync(session, [claude("m0", 20, at(-5)), claude("m1", 20, at(5)), claude("m2", 20, at(10)), claude("m3", 20, at(35)), claude("m4", 20, at(45))]
    .map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.deepEqual(readTaskActiveIntervals(dir, a.id), [{ from: at(0), to: at(10) }, { from: at(30), to: at(40) }]);
  assert.deepEqual(readTaskActiveIntervals(dir, b.id), [{ from: at(10), to: at(30) }, { from: at(40), to: null }]);
  for (const task of [a, b]) linkTaskUsage(dir, task.id, [{ client: "claude", file: session, phase: "main" }], dir);
  const first = buildLinkedTaskUsageReport(dir, a.id);
  const second = buildLinkedTaskUsageReport(dir, b.id);
  assert.equal(first.requests, 2, "m1 and m3; m0 predates the task");
  assert.equal(second.requests, 2, "m2 at the boundary belongs to the task that became current, plus m4");
  assert.equal(first.requests + second.requests, buildUsageReport({ client: "claude", files: [session] }, dir).requests - 1);

  const subagent = path.join(dir, "s", "subagents", "agent-y.jsonl");
  mkdirSync(path.dirname(subagent), { recursive: true });
  writeFileSync(subagent, [claude("y1", 20, at(35)), claude("y2", 20, at(45))].map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(linkTaskUsage(dir, a.id, [{ client: "claude", file: subagent, phase: "review" }], dir).requests, 4,
    "a subagent started while A was current counts whole for A, even after the main session switched to B");
  const forB = linkTaskUsage(dir, b.id, [{ client: "claude", file: subagent, phase: "review" }], dir);
  assert.equal(forB.requests, 2, "and not at all for B");
  assert.match(forB.warnings.join(" "), /Subagent sessions started while another task was current are not counted: agent-y/);
  unlinkTaskUsage(dir, b.id, subagent, dir);
  linkTaskUsage(dir, b.id, [], dir, { status: "declared-complete", note: "Shared session only" });
  assert.equal(unlinkTaskUsage(dir, b.id, session, dir), 0);
  assert.equal(existsSync(taskUsageManifestPath(dir, b.id)), false, "an emptied manifest is removed when no traced session keeps its coverage meaningful");
  linkTaskUsage(dir, b.id, [{ client: "claude", file: session, phase: "main" }], dir);

  const copy = path.join(dir, "copy", "shared.jsonl");
  mkdirSync(path.dirname(copy));
  writeFileSync(copy, JSON.stringify(claude("m9", 20, at(6))) + "\n");
  linkTaskUsage(dir, a.id, [{ client: "claude", file: copy, phase: "copy" }], dir);
  assert.throws(() => unlinkTaskUsage(dir, a.id, "shared", dir), /matches 2 linked sources; unlink by path/);
  assert.equal(unlinkTaskUsage(dir, a.id, copy, dir), 2);

  parkCurrentTask(dir);
  const imported = startTask(dir, { title: "Imported" });
  parkCurrentTask(dir);
  writeFileSync(path.join(dir, ".agentpack", "tasks", imported.id, "events.jsonl"), JSON.stringify({ type: "task-import", ts: at(50) }) + "\n");
  assert.deepEqual(readTaskActiveIntervals(dir, imported.id), [], "a task that was never current owns no period");
  const legacyPark = new Date(Date.parse(imported.createdAt) + 60_000).toISOString();
  writeFileSync(path.join(dir, ".agentpack", "tasks", imported.id, "events.jsonl"), JSON.stringify({ type: "task-park", ts: legacyPark }) + "\n");
  assert.deepEqual(readTaskActiveIntervals(dir, imported.id), [{ from: imported.createdAt, to: legacyPark }], "a legacy task parked before lifecycle events was current from creation");
  writeFileSync(path.join(dir, ".agentpack", "tasks", imported.id, "events.jsonl"), JSON.stringify({ type: "task-import", ts: at(50) }) + "\n");
  assert.throws(() => linkTaskUsage(dir, imported.id, [{ client: "claude", file: session, phase: "main" }], dir), /never been the current Task Passport/);
  assert.match(findUsageCandidates(dir, imported.id, { CLAUDE_CONFIG_DIR: dir, CODEX_HOME: dir }).warnings.join(" "), /never been the current/);
});

test("Sessions with an Agentpack trace of the task are reported without linking", t => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentpack-usage-trace-")));
  const home = mkdtempSync(path.join(os.tmpdir(), "agentpack-usage-trace-home-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  initPack(dir);
  const passport = startTask(dir, { title: "Traced task" });
  const after = (seconds: number) => new Date(Date.parse(passport.createdAt) + seconds * 1000).toISOString();
  const project = path.join(home, "claude", "projects", path.resolve(passport.worktree).replace(/[^A-Za-z0-9]/gu, "-"));
  const write = (file: string, rows: unknown[]) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  };
  const toolResult = (text: string) => ({ type: "user", timestamp: after(1), message: { content: [{ type: "tool_result", content: text }] } });
  write(path.join(project, "worker.jsonl"), [toolResult(`Started task ${passport.id}.`), claude("w1", 20, after(2)), claude("w2", 20, after(3))]);
  write(path.join(project, "worker", "subagents", "agent-r.jsonl"), [claude("r1", 20, after(4))]);
  write(path.join(project, "chat.jsonl"), [claude("c1", 20, after(5))]);
  const forked = (row: { sessionId: string }) => ({ ...row, sessionId: "fork" });
  write(path.join(project, "worker-fork.jsonl"), [toolResult(`Started task ${passport.id}.`), forked(claude("w1", 20, after(2))), forked(claude("w2", 20, after(3))), forked(claude("w3", 20, after(9)))]);
  write(path.join(project, "prose.jsonl"), [{ type: "user", timestamp: after(1), message: { content: `Earlier output said: Started task ${passport.id}.` } }, claude("q1", 20, after(10))]);
  write(path.join(project, "mention.jsonl"), [toolResult(`Inspected task: ${passport.id} (not current)`), claude("n1", 20, after(6))]);
  const day = new Date(Date.parse(passport.createdAt));
  const codexDay = path.join(home, "codex", "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
  const codexMeta = (payload: Record<string, unknown>) => ({ type: "session_meta", timestamp: after(1), payload: { cwd: dir, ...payload } });
  write(path.join(codexDay, "rollout-parent.jsonl"), [codexMeta({ id: "p1" }), context,
    { type: "response_item", timestamp: after(1), payload: { type: "function_call_output", output: `## Current Task Passport\n- ID: ${passport.id}\n` } },
    codex("cx1", usage, after(7))]);
  // Codex code-mode tools wrap MCP output in a JSON string, so its newlines are escaped twice in the rollout.
  write(path.join(codexDay, "rollout-codemode.jsonl"), [codexMeta({ id: "m1" }), context,
    { type: "response_item", timestamp: after(1), payload: { type: "custom_tool_call_output", output: `text(${JSON.stringify(`## Current Task Passport\n- ID: ${passport.id}\n`)})` } },
    codex("cm1", usage, after(12))]);
  write(path.join(codexDay, "rollout-sub.jsonl"), [codexMeta({ id: "s1", thread_source: "subagent", parent_thread_id: "p1" }), context, codex("cs1", usage, after(8))]);
  write(path.join(codexDay, "rollout-guardian.jsonl"), [codexMeta({ id: "g1", thread_source: "guardian_review", parent_thread_id: "p1" }), context,
    { type: "response_item", timestamp: after(1), payload: { type: "message", role: "user", content: [{ type: "input_text", text: `history: Started task ${passport.id}.` }] } },
    codex("cg1", usage, after(11))]);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, "claude"), CODEX_HOME: path.join(home, "codex") };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env });

  const listed = JSON.parse(run("usage", "link", passport.id, "--json").stdout);
  assert.deepEqual(listed.candidates.map((c: { id: string; traced: boolean }) => [c.id, c.traced]).sort(),
    [["agent-r", true], ["chat", false], ["mention", false], ["prose", false], ["rollout-codemode", true], ["rollout-guardian", true], ["rollout-parent", true], ["rollout-sub", true], ["worker", true], ["worker-fork", true]],
    "only tool output of start/switch/current-passport traces a session; Codex child threads (subagent, guardian) follow their parent");
  assert.equal(listed.candidates.find((c: { id: string }) => c.id === "rollout-guardian").subagent, true);
  const report = JSON.parse(run("usage", "report", "--json", passport.id).stdout);
  assert.equal(report.kind, "task-usage-report", "a positional id after a boolean flag selects the task");
  assert.equal(report.requests, 8, "traced sessions and their subagents; the fork's copied requests count once");
  assert.deepEqual(report.slices.map((slice: { phase: string }) => slice.phase), ["traced", "traced", "traced", "traced", "traced", "traced"]);
  assert.match(report.warnings.join(" "), /Sources without new requests while the task was current: worker\./, "the original adds nothing once its fork was counted");
  assert.match(report.warnings.join(" "), /2 request\(s\) repeated across sources \(resumed or forked sessions\) were counted once/);
  assert.match(report.warnings.join(" "), /3 other candidate session\(s\)/);
  assert.equal(existsSync(taskUsageManifestPath(dir, passport.id)), false, "reading never writes");
  assert.match(run("usage", "unlink", passport.id, "--file", "worker").stderr, /always included/);
  assert.equal(run("usage", "link", passport.id, "--coverage", "declared-complete", "--note", "Worker session only").status, 0);
  assert.equal(JSON.parse(run("usage", "report", passport.id, "--json").stdout).coverage.status, "declared-complete");
  for (const bad of [["--client", "codex", "--file", path.join(project, "chat.jsonl")], ["--client", "claude", "--file", path.join(dir, "notes.txt")]]) {
    writeFileSync(path.join(dir, "notes.txt"), "hello\n");
    assert.match(run("usage", "link", passport.id, ...bad).stderr, /No supported usage records/, "linking still rejects sources without usage");
  }
  assert.equal(JSON.parse(run("usage", "link", passport.id, "--pick", "chat", "--json").stdout).report.requests, 9);
  assert.equal(run("usage", "unlink", passport.id, "--file", "chat").status, 0);
  assert.equal(JSON.parse(run("usage", "report", passport.id, "--json").stdout).coverage.status, "declared-complete", "declared coverage survives removing the last linked source");
  assert.match(run("task", "usage", "report").stderr, /top-level command: agentpack usage report/);
  assert.match(run("usage", "report", passport.id, "--client", "claude", "--file", "x.jsonl").stderr, /positional task id cannot be combined/);
  const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = env.CODEX_HOME;
  try {
    assert.match(loadTuiTaskUsage(buildTuiModel(dir), { passport, current: true }).join("\n"), /Phase: traced/);
  } finally {
    if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.claude;
    if (saved.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.codex;
  }
});
