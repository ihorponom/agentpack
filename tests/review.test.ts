import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/agentpack.js", import.meta.url));
const report = {
  summary: "Reviewed the retry branch",
  challenge: {
    assumption: "Every failure is transient",
    counterexample: "A permanent failure returns immediately",
    observation: "The permanent failure branch is preserved"
  },
  findings: [],
  limitations: ["Diff only"]
};

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agentpack-review-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repo");
  const bin = path.join(directory, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  const env = { ...process.env, PATH: [bin, process.env.PATH].join(path.delimiter) };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env, encoding: "utf8"
  });
  const setup = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Review Test");
  git("config", "user.email", "review@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", path.join(directory, "empty-hooks"));
  writeFileSync(path.join(root, "retry.ts"), "export const retry = false;\n");
  git("add", ".");
  git("commit", "-m", "Base");
  const baseSha = git("rev-parse", "HEAD");
  git("branch", "base");
  setup("init");
  setup("task", "start", "Check retry behavior", "--objective", "Keep permanent failures terminal",
    "--write-scope", "retry.ts", "--risk", "medium");
  writeFileSync(path.join(root, "retry.ts"), "export const retry = true;\n");
  git("commit", "-am", "Candidate");
  const headSha = git("rev-parse", "HEAD");

  function stub(provider: string, body: string) {
    writeFileSync(path.join(bin, provider), `#!/usr/bin/env node
const fs = require("node:fs");
const child = require("node:child_process");
const input = fs.readFileSync(0, "utf8");
const emit = (value) => console.log(JSON.stringify(value));
${body}
`, { mode: 0o755 });
  }

  const review = (provider: string) => run("task", "review", "--base", "base", "--reviewer", provider,
    "--criteria", "Never retry permanent errors");
  return { root, git, review, stub, baseSha, headSha };
}

test("task review accepts structured output from either provider and pins both SHAs", (t) => {
  const f = fixture(t);
  const assertInput = `
if (require("node:path").basename(process.cwd()).startsWith("agentpack-review-") === false
  || fs.existsSync("retry.ts") || !input.includes("export const retry = true;")
  || !input.includes("Never retry permanent errors")) process.exit(2);
`;
  f.stub("claude", assertInput + `emit({type: "result", subtype: "success", is_error: false,
    structured_output: ${JSON.stringify(report)}});`);
  f.stub("codex", assertInput + `emit({type: "turn.started"});
    emit({type: "item.completed", item: {type: "agent_message",
    text: ${JSON.stringify(JSON.stringify(report))}}});
    emit({type: "turn.completed"});`);
  for (const provider of ["claude", "codex"]) {
    const result = f.review(provider);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const response = JSON.parse(result.stdout);
    assert.match(response.taskId, /^task_/);
    assert.deepEqual(response, {
      taskId: response.taskId, branch: "main", baseSha: f.baseSha, headSha: f.headSha,
      reviewer: provider, status: "reviewed", report
    });
    assert.equal(result.stderr, "");
  }
});

test("task review warns on a branch that differs from the Passport and reviews its commits", (t) => {
  const f = fixture(t);
  f.stub("codex", `emit({type: "turn.started"});
    emit({type: "item.completed", item: {type: "agent_message", text: ${JSON.stringify(JSON.stringify(report))}}});
    emit({type: "turn.completed"});`);
  f.git("switch", "-c", "stacked");
  const result = f.review("codex");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const response = JSON.parse(result.stdout);
  assert.equal(response.status, "reviewed");
  assert.equal(response.branch, "stacked");
  assert.equal(response.headSha, f.headSha);
  assert.match(result.stderr, /checkout branch stacked differs from the Passport branch main/);

  f.stub("codex", `child.execFileSync("git", ["switch", "-q", "main"], {cwd: ${JSON.stringify(f.root)}});
    emit({type: "turn.started"});
    emit({type: "item.completed", item: {type: "agent_message", text: ${JSON.stringify(JSON.stringify(report))}}});
    emit({type: "turn.completed"});`);
  const switched = f.review("codex");
  assert.equal(switched.status, 1);
  assert.equal(JSON.parse(switched.stdout).reason, "stale_snapshot");
});

test("task review reports exhausted usage and rejects partial output", (t) => {
  const f = fixture(t);
  f.stub("claude", `emit({type: "rate_limit_event", rate_limit_info: {status: "rejected", resetsAt: 42}});
    process.exitCode = 1;`);
  const claude = f.review("claude");
  assert.equal(claude.status, 1);
  assert.equal(JSON.parse(claude.stdout).reason, "usage_limit");
  assert.equal(JSON.parse(claude.stdout).resetsAt, 42);

  f.stub("codex", `emit({type: "turn.failed", error: {message: "You've hit your usage limit."}});
    process.exitCode = 1;`);
  const codex = f.review("codex");
  assert.equal(codex.status, 1);
  assert.equal(JSON.parse(codex.stdout).reason, "usage_limit");

  f.stub("codex", `emit({type: "turn.started"}); emit({type: "turn.completed"});`);
  const partial = f.review("codex");
  assert.equal(partial.status, 1);
  assert.equal(JSON.parse(partial.stdout).reason, "invalid_output");
});

test("task review rejects reports from contradictory or multiple terminal events", (t) => {
  const f = fixture(t);
  const success = `emit({type: "result", subtype: "success", is_error: false,
    structured_output: ${JSON.stringify(report)}});`;
  const rejection = 'emit({type: "rate_limit_event", rate_limit_info: {status: "rejected"}});';
  for (const events of [success + rejection, rejection + success]) {
    f.stub("claude", events);
    const claude = f.review("claude");
    assert.equal(claude.status, 1);
    assert.equal(JSON.parse(claude.stdout).reason, "usage_limit");
  }

  f.stub("codex", `emit({type: "turn.started"});
    emit({type: "item.completed", item: {type: "agent_message", text: ${JSON.stringify(JSON.stringify(report))}}});
    emit({type: "turn.failed"});
    emit({type: "turn.started"});
    emit({type: "turn.completed"});`);
  const codex = f.review("codex");
  assert.equal(codex.status, 1);
  assert.equal(JSON.parse(codex.stdout).reason, "invalid_output");
});

test("task review rejects stale and out-of-scope candidates", (t) => {
  const f = fixture(t);
  f.stub("claude", `child.execFileSync("git", ["commit", "--allow-empty", "-m", "Concurrent change"],
    {cwd: ${JSON.stringify(f.root)}});
    emit({type: "result", subtype: "success", is_error: false,
    structured_output: ${JSON.stringify(report)}});`);
  const stale = f.review("claude");
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).reason, "stale_snapshot");

  writeFileSync(path.join(f.root, "unrelated.ts"), "other change\n");
  f.git("add", "unrelated.ts");
  f.git("commit", "-m", "Unrelated change");
  const outOfScope = f.review("claude");
  assert.equal(outOfScope.status, 1);
  assert.match(outOfScope.stderr, /outside the primary Passport write scope/);
});
