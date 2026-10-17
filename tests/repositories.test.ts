import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
import { exportTaskBundle, importTaskBundle, inspectTaskBundle } from "../src/core/bundles.js";
import { evaluateGate } from "../src/core/gate.js";
import { initPack } from "../src/core/store.js";
import { bindRepositories, parseRepositoryInputs, repositoryGit } from "../src/core/repositories.js";
import { auditCurrentTask, finalizeCurrentTask, formatCurrentTaskHandoff, getCurrentPassport, parkCurrentTask, readPassport, startTask, switchTask, updateCurrentTaskPassport, updateCurrentTaskVerification } from "../src/core/tasks.js";
import { buildResume } from "../src/core/resume.js";
import { addEvidence } from "../src/operations.js";
import { startMcpServer } from "../src/mcp/server.js";
import type { TaskBundle } from "../src/core/types.js";

const cli = fileURLToPath(new URL("../src/agentpack.js", import.meta.url));
function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(root: string, message: string): void {
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", message]);
}
function repo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/app.txt"), "initial\n");
  git(root, ["add", "."]); commit(root, "initial");
}
function fixture(t: { after(fn: () => void): void }) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentpack-repositories-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const primary = path.join(base, "primary"); const api = path.join(base, "api"); const ui = path.join(base, "ui");
  for (const root of [primary, api, ui]) repo(root);
  initPack(primary);
  const binding = { id: "api", worktree: api, writeScope: ["src"] };
  return { base, primary, api, ui, binding };
}

test("one Passport owns scopes in two independent checkouts and preserves single-repo schema", t => {
  const { primary, api, ui, binding } = fixture(t);
  const legacy = startTask(primary, { title: "legacy", writeScope: ["src"] });
  assert.equal(legacy.schemaVersion, 1); assert.equal(legacy.repositories, undefined);
  parkCurrentTask(primary);
  const task = startTask(primary, { title: "integration", writeScope: ["src"], repositories: [binding, { id: "ui", worktree: ui, writeScope: ["src"] }] });
  assert.equal(task.schemaVersion, 2); assert.match(task.repositories![0]!.baseHead!, /^[a-f0-9]{40}$/);
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(api, "src/new.ts"), path.join(ui, "src/new.ts")] }).decision, "allow");
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(api, "config.ts")] }).decision, "block");
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(primary, "src/new.ts")] }).decision, "allow");
  assert.equal(evaluateGate(primary, { mode: "block", repository: "unknown", staged: true }).decision, "block");
  const handoff = formatCurrentTaskHandoff(primary);
  assert.match(handoff, /Additional repositories:/); assert.ok(handoff.includes(api));
  assert.match(buildResume(primary, { budget: 4000 }).markdown, /Additional repositories:/);
  assert.equal(getCurrentPassport(primary)!.id, task.id);
});

test("repository declarations reject ambiguous identities, escaping scopes and malformed data", t => {
  const { primary, api, binding } = fixture(t);
  for (const invalid of [null, {}, [{ id: "primary", worktree: api, writeScope: ["src"] }], [binding, binding], [{ ...binding, writeScope: [] }], [{ ...binding, branch: "injected" }]]) {
    assert.throws(() => parseRepositoryInputs(invalid));
  }
  for (const invalid of [ { ...binding, worktree: primary }, { ...binding, worktree: path.join(api, "src") }, { ...binding, writeScope: ["../primary"] } ]) {
    assert.throws(() => bindRepositories(primary, [], [invalid]));
  }
  assert.throws(() => bindRepositories(primary, [], [binding, { ...binding, id: "duplicate" }]), /Duplicate/);
  const alias = path.join(path.dirname(api), "alias"); symlinkSync(api, alias);
  assert.throws(() => bindRepositories(primary, [], [binding, { ...binding, id: "alias", worktree: alias }]), /Duplicate/);
  const task = startTask(primary, { title: "scope", repositories: [binding] });
  updateCurrentTaskPassport(primary, { repositories: [{ ...binding, writeScope: ["tests"] }] });
  assert.deepEqual(getCurrentPassport(primary)!.repositories![0]!.writeScope, ["src", "tests"]);
  assert.equal(getCurrentPassport(primary)!.repositories![0]!.baseHead, task.repositories![0]!.baseHead);
  assert.throws(() => updateCurrentTaskPassport(primary, { repositories: [{ ...binding, worktree: primary }] }));
});

test("staged gate inspects each bound checkout and can select one explicitly", t => {
  const { primary, api, ui, binding } = fixture(t);
  startTask(primary, { title: "integration", writeScope: ["src"], repositories: [binding, { id: "ui", worktree: ui, writeScope: ["src"] }] });
  writeFileSync(path.join(api, "src/app.txt"), "changed"); git(api, ["add", "src"]);
  writeFileSync(path.join(ui, "private.txt"), "outside scope"); git(ui, ["add", "private.txt"]);
  assert.equal(evaluateGate(primary, { mode: "block", staged: true }).decision, "block");
  assert.equal(evaluateGate(primary, { mode: "block", staged: true, repository: "api" }).decision, "allow");
  parkCurrentTask(primary);
  assert.equal(evaluateGate(primary, { mode: "block", staged: true, repository: "api" }).decision, "block");
});

test("symlinks cannot bypass a binding scope, including through primary and alias paths", t => {
  const { primary, api, ui, binding } = fixture(t);
  startTask(primary, { title: "integration", writeScope: ["."], repositories: [binding] });
  symlinkSync(path.join(ui, "does-not-exist"), path.join(api, "src/dangling"));
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(api, "src/dangling/new.txt")] }).decision, "block");
  assert.throws(() => bindRepositories(primary, [], [{ ...binding, writeScope: ["src/dangling"] }]));
  symlinkSync(ui, path.join(api, "src/escape"));
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(api, "src/escape/new.txt")] }).decision, "block");
  symlinkSync(api, path.join(primary, "alias"));
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(primary, "alias/config.txt")] }).decision, "block");
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(primary, "alias/src/new.txt")] }).decision, "allow");
  symlinkSync(ui, path.join(primary, "unbound"));
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(primary, "unbound/new.txt")] }).decision, "block");
  mkdirSync(path.join(api, "config")); symlinkSync(path.join(api, "config"), path.join(api, "src/config"));
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(api, "src/config/new.txt")] }).decision, "block");
});

test("missing checkout and branch drift stay visible; no final snapshot with unknown state", t => {
  const { primary, api, binding } = fixture(t);
  startTask(primary, { title: "integration", repositories: [binding] });
  git(api, ["checkout", "-qb", "other"]);
  assert.ok(evaluateGate(primary, { mode: "block" }).findings.some(f => f.code === "branch-drift"));
  assert.match(formatCurrentTaskHandoff(primary), /Repository api branch drift/);
  assert.throws(() => updateCurrentTaskVerification(primary, { status: "passed" }), /branch drift/);
  assert.equal(getCurrentPassport(primary)!.verification.status, "unknown");
  renameSync(api, `${api}-gone`);
  assert.equal(evaluateGate(primary, { mode: "block", staged: true }).decision, "block");
  assert.ok(auditCurrentTask(primary).issues.some(issue => /Repository api is unavailable/.test(issue.message)));
  assert.throws(() => finalizeCurrentTask(primary, { status: "passed" }));
});

test("all repository HEADs freeze with final verification and survive park/switch/finalize", t => {
  const { primary, api, binding } = fixture(t);
  const task = startTask(primary, { title: "integration", repositories: [binding] });
  writeFileSync(path.join(api, "src/app.txt"), "updated"); git(api, ["add", "src"]); commit(api, "change");
  const reviewed = repositoryGit(api).head;
  updateCurrentTaskVerification(primary, { status: "passed", summary: "local checks" });
  assert.equal(getCurrentPassport(primary)!.repositories![0]!.currentHead, reviewed);
  assert.notEqual(reviewed, task.repositories![0]!.baseHead);
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(api, "src/new.txt")] }).decision, "block");
  assert.throws(() => updateCurrentTaskPassport(primary, { repositories: [{ ...binding, writeScope: ["tests"] }] }), /active task/);
  writeFileSync(path.join(api, "src/app.txt"), "later"); git(api, ["add", "src"]); commit(api, "later");
  parkCurrentTask(primary); switchTask(primary, task.id);
  assert.equal(getCurrentPassport(primary)!.status, "verifying");
  const finished = finalizeCurrentTask(primary);
  assert.equal(finished.repositories![0]!.currentHead, reviewed);
  assert.match(formatCurrentTaskHandoff(primary), /Repository api HEAD drift/);
});

test("multi-repo portable bundle imports unbound, scrubs paths and requires explicit local binding", t => {
  const { primary, api, ui, binding } = fixture(t);
  startTask(primary, { title: "integration", repositories: [binding] });
  const evidence = addEvidence(primary, { content: `Tested checkout ${api}/src/app.txt`, command: `check ${api}` });
  updateCurrentTaskVerification(primary, { status: "pending", evidence: [evidence.id] });
  const file = path.join(primary, "bundle.json"); exportTaskBundle(primary, { outputPath: "bundle.json" });
  const content = readFileSync(file, "utf8"); const bundle = JSON.parse(content) as TaskBundle;
  assert.equal(bundle.schemaVersion, 2); assert.equal(bundle.task.repositories![0]!.worktree, null);
  assert.equal(bundle.task.repositories![0]!.identity, null);
  assert.ok(!content.includes(api)); assert.equal(inspectTaskBundle(file).valid, true);
  const forged = path.join(primary, "forged.json");
  writeFileSync(forged, JSON.stringify({ ...bundle, task: { ...bundle.task, repositories: [{ ...bundle.task.repositories![0], worktree: api }] } }));
  assert.throws(() => inspectTaskBundle(forged), /Bundle task is invalid/);
  initPack(ui);
  const imported = importTaskBundle(ui, file);
  assert.equal(readPassport(ui, imported.taskId).repositories![0]!.worktree, null);
  switchTask(ui, imported.taskId);
  assert.equal(evaluateGate(ui, { mode: "block", files: ["src/new.ts"] }).decision, "block");
  assert.throws(() => updateCurrentTaskVerification(ui, { status: "passed" }), /unbound/);
  updateCurrentTaskPassport(ui, { repositories: [binding] });
  assert.equal(getCurrentPassport(ui)!.repositories![0]!.worktree, api);
  assert.equal(getCurrentPassport(ui)!.verification.status, "unknown");
  assert.match(bundle.evidence[0]!.content, /REDACTED:REPOSITORY/);
  assert.equal(importTaskBundle(ui, file).idempotent, true);
});

test("schema validation refuses downgraded or malformed repository-bearing Passports", t => {
  const { primary, binding } = fixture(t);
  const task = startTask(primary, { title: "integration", repositories: [binding] });
  const file = path.join(primary, ".agentpack/tasks", task.id, "passport.json");
  for (const invalid of [ { ...task, schemaVersion: 1 }, { ...task, repositories: [{ ...task.repositories![0], writeScope: ["../escape"] }] }, { ...task, repositories: "oops" } ]) {
    writeFileSync(file, JSON.stringify(invalid));
    assert.equal(evaluateGate(primary, { mode: "block" }).decision, "block");
    assert.throws(() => readPassport(primary, task.id), /invalid/);
  }
});

test("CLI repository declarations, updates and staged selection share core behavior", t => {
  const { primary, api, binding } = fixture(t);
  const run = (args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: primary, encoding: "utf8" });
  run(["task", "start", "integration", "--repository", JSON.stringify(binding)]);
  assert.match(run(["task", "status", "--full"]), /Additional repositories:/);
  assert.match(run(["task", "list", "--scope", "api:src"]), /integration/);
  assert.match(run(["task", "list", "--scope", "api:config"]), /No task passports match/);
  run(["task", "update", "--repository", JSON.stringify({ ...binding, writeScope: ["tests"] })]);
  writeFileSync(path.join(api, "config.txt"), "outside"); git(api, ["add", "config.txt"]);
  const result = JSON.parse(run(["task", "gate", "--staged", "--repository", "api", "--json"])) as { decision: string };
  assert.equal(result.decision, "warn");
  const invalid = spawnSync(process.execPath, [cli, "task", "update", "--repository"], { cwd: primary, encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.equal(getCurrentPassport(primary)!.repositories!.length, 1);
});

test("MCP exposes and validates the same repository contract on start and update", async t => {
  const { primary, binding } = fixture(t);
  const input = new PassThrough(); const output = new PassThrough(); let buffer = "";
  const pending = new Map<number, (value: { result: { isError?: boolean; content: Array<{ text: string }> } }) => void>();
  output.on("data", chunk => {
    buffer += String(chunk); const lines = buffer.split("\n"); buffer = lines.pop() || "";
    for (const line of lines) { const result = JSON.parse(line); pending.get(result.id)?.(result); pending.delete(result.id); }
  });
  startMcpServer(primary, input, output); t.after(() => { input.end(); output.end(); });
  let id = 0;
  const call = (name: string, args: Record<string, unknown>) => new Promise<{ result: { isError?: boolean; content: Array<{ text: string }> } }>(resolve => {
    const requestId = ++id; pending.set(requestId, resolve);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
  assert.ok(!(await call("task_start", { title: "integration", repositories: [binding] })).result.isError);
  assert.equal(getCurrentPassport(primary)!.repositories![0]!.id, "api");
  assert.ok(!(await call("task_update", { repositories: [{ ...binding, writeScope: ["tests"] }] })).result.isError);
  assert.deepEqual(getCurrentPassport(primary)!.repositories![0]!.writeScope, ["src", "tests"]);
  assert.match(JSON.stringify(await call("task_update", { repositories: [{}] })), /Repository binding requires/);
});


test("linked worktrees and detached HEADs retain independent immutable bindings", t => {
  const { primary, api, base } = fixture(t);
  const linked = path.join(base, "linked");
  git(api, ["worktree", "add", "-qb", "integration", linked]);
  const detached = path.join(base, "detached");
  git(api, ["worktree", "add", "--detach", detached]);
  startTask(primary, { title: "linked integration", repositories: [
    { id: "linked", worktree: linked, writeScope: ["src"] },
    { id: "detached", worktree: detached, writeScope: ["src"] }
  ] });
  assert.equal(getCurrentPassport(primary)!.repositories![0]!.branch, "integration");
  assert.equal(getCurrentPassport(primary)!.repositories![1]!.branch, "detached");
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(linked, "src/new.txt")] }).decision, "allow");
  writeFileSync(path.join(linked, "src/app.txt"), "normal linked worktree commit");
  git(linked, ["add", "src"]); commit(linked, "linked change");
  const completed = finalizeCurrentTask(primary, { status: "passed" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.repositories![0]!.currentHead, repositoryGit(linked).head);
});

test("a corrupt external index is unknown instead of a silently empty staging area", t => {
  const { primary, api, binding } = fixture(t);
  startTask(primary, { title: "integration", repositories: [binding] });
  writeFileSync(path.join(api, ".git/index"), "corrupted index");
  // HEAD metadata is still readable, but staged inspection must fail closed.
  assert.match(repositoryGit(api).head, /^[a-f0-9]{40}$/);
  const gate = evaluateGate(primary, { mode: "block", staged: true });
  assert.equal(gate.decision, "block");
  assert.ok(gate.findings.some(f => /staged state cannot be read/.test(f.message)));
});

test("an explicitly bound nested checkout takes precedence over primary scope", t => {
  const { primary } = fixture(t);
  const nested = path.join(primary, "nested"); repo(nested);
  startTask(primary, { title: "nested integration", writeScope: ["."], repositories: [{ id: "nested", worktree: nested, writeScope: ["src"] }] });
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(nested, "config.txt")] }).decision, "block");
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(nested, "src/new.txt")] }).decision, "allow");
});


test("a workspace ledger can own two repositories without a primary Git checkout", t => {
  const { base, api, ui, binding } = fixture(t);
  initPack(base);
  startTask(base, { title: "workspace integration", repositories: [binding, { id: "ui", worktree: ui, writeScope: ["src"] }] });
  assert.equal(evaluateGate(base, { mode: "block", files: [path.join(api, "src/new.ts"), path.join(ui, "src/new.ts")] }).decision, "allow");
  assert.ok(!auditCurrentTask(base).issues.some(issue => /Task has no write scope/.test(issue.message)));
  assert.equal(evaluateGate(base, { mode: "block" }).decision, "allow");
  const finished = finalizeCurrentTask(base, { status: "passed" });
  assert.equal(finished.currentHead, null);
  assert.ok(finished.repositories!.every(repo => repo.currentHead === repositoryGit(repo.worktree!).head));
});

test("staged renames check source and destination scopes in primary and additional repositories", t => {
  const { primary, api, binding } = fixture(t);
  for (const root of [primary, api]) {
    writeFileSync(path.join(root, "outside.txt"), "outside scope");
    git(root, ["add", "outside.txt"]); commit(root, "outside baseline");
  }
  startTask(primary, { title: "rename integration", writeScope: ["src"], repositories: [binding] });
  for (const [id, root] of [["primary", primary], ["api", api]] as const) {
    git(root, ["mv", "outside.txt", "src/moved.txt"]);
    const report = evaluateGate(primary, { mode: "block", staged: true, repository: id });
    assert.equal(report.decision, "block");
    assert.ok(report.findings.some(f => f.code === "out-of-scope" && /outside.txt/.test(f.message)));
  }
});

test("initial local binding never promotes imported scope provenance into authority", t => {
  const { primary, api, ui, binding } = fixture(t);
  startTask(primary, { title: "portable integration", repositories: [{ ...binding, writeScope: ["."] }] });
  exportTaskBundle(primary, { outputPath: "broad-origin.json" });
  const bundlePath = path.join(primary, "broad-origin.json");
  initPack(ui);
  const imported = importTaskBundle(ui, bundlePath);
  switchTask(ui, imported.taskId);
  assert.deepEqual(getCurrentPassport(ui)!.repositories![0]!.writeScope, ["."]);
  updateCurrentTaskPassport(ui, { repositories: [binding] });
  assert.deepEqual(getCurrentPassport(ui)!.repositories![0]!.writeScope, ["src"]);
  assert.equal(evaluateGate(ui, { mode: "block", files: [path.join(api, "production-secret.txt")] }).decision, "block");
  assert.equal(evaluateGate(ui, { mode: "block", files: [path.join(api, "src/new.ts")] }).decision, "allow");
  updateCurrentTaskPassport(ui, { repositories: [{ ...binding, writeScope: ["tests"] }] });
  assert.deepEqual(getCurrentPassport(ui)!.repositories![0]!.writeScope, ["src", "tests"]);
  assert.deepEqual((JSON.parse(readFileSync(bundlePath, "utf8")) as TaskBundle).task.repositories![0]!.writeScope, ["."]);
});

test("aliases inside additional parents must respect the most-specific physical checkout", t => {
  const { primary, api } = fixture(t);
  const inner = path.join(api, "inner"); repo(inner);
  symlinkSync(inner, path.join(api, "alias"));
  startTask(primary, { title: "nested aliases", writeScope: ["."], repositories: [
    { id: "outer", worktree: api, writeScope: ["."] },
    { id: "inner", worktree: inner, writeScope: ["src"] }
  ] });
  for (const file of [path.join(inner, "config.txt"), path.join(api, "alias/config.txt")]) {
    assert.equal(evaluateGate(primary, { mode: "block", files: [file] }).decision, "block");
  }
  for (const file of [path.join(inner, "src/new.ts"), path.join(api, "alias/src/new.ts")]) {
    assert.equal(evaluateGate(primary, { mode: "block", files: [file] }).decision, "allow");
  }
});

for (const parentId of ["primary", "api"] as const) {
  test(`staged paths in ${parentId} route through nested ownership for default and selected inspection`, t => {
    const { primary, api } = fixture(t);
    const parent = parentId === "primary" ? primary : api;
    const inner = path.join(parent, "inner");
    mkdirSync(inner); writeFileSync(path.join(inner, "config.txt"), "tracked by parent");
    git(parent, ["add", "inner/config.txt"]); commit(parent, "parent tracks nested path");
    repo(inner);
    startTask(primary, { title: "nested staging", writeScope: ["."], repositories: [
      ...(parentId === "api" ? [{ id: "api", worktree: api, writeScope: ["."] }] : []),
      { id: "inner", worktree: inner, writeScope: ["src"] }
    ] });
    writeFileSync(path.join(inner, "config.txt"), "changed through parent index");
    git(parent, ["add", "inner/config.txt"]);
    assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(inner, "config.txt")] }).decision, "block");
    for (const selection of [{}, { repository: parentId }]) {
      const report = evaluateGate(primary, { mode: "block", staged: true, ...selection });
      assert.equal(report.decision, "block");
      assert.ok(report.findings.some(f => f.code === "out-of-scope" && /inner/.test(f.message)));
    }
  });
}

test("checkout replacement at the same path cannot acquire the original binding or final verdict", t => {
  const { primary, api, ui, binding } = fixture(t);
  const task = startTask(primary, { title: "checkout identity", repositories: [binding] });
  git(ui, ["fetch", api, "HEAD"]); git(ui, ["reset", "--hard", "FETCH_HEAD"]);
  assert.equal(repositoryGit(api).head, repositoryGit(ui).head);
  renameSync(api, `${api}-original`); renameSync(ui, api);
  assert.equal(evaluateGate(primary, { mode: "block", files: [path.join(api, "src/new.ts")] }).decision, "block");
  assert.throws(() => updateCurrentTaskVerification(primary, { status: "passed" }), /identity|replaced/);
  assert.throws(() => finalizeCurrentTask(primary, { status: "passed" }), /identity|replaced/);
  assert.throws(() => updateCurrentTaskPassport(primary, { repositories: [{ ...binding, writeScope: ["tests"] }] }), /identity|replaced/);
  assert.equal(getCurrentPassport(primary)!.verification.status, "unknown");
  assert.equal(getCurrentPassport(primary)!.repositories![0]!.currentHead, task.repositories![0]!.currentHead);
  assert.ok(auditCurrentTask(primary).issues.some(issue => /api.*unavailable|identity|replaced/.test(issue.message)));
});

for (const parentId of ["primary", "api"] as const) {
  test(`a staged Git link remains an authorized ${parentId} index operation`, t => {
    const { primary, api } = fixture(t);
    const parent = parentId === "primary" ? primary : api;
    const inner = path.join(parent, "inner"); repo(inner);
    git(parent, ["add", "inner"]); commit(parent, "record nested Git link");
    const bindings = [
      ...(parentId === "api" ? [{ id: "api", worktree: api, writeScope: ["."] }] : []),
      { id: "inner", worktree: inner, writeScope: ["src"] }
    ];
    startTask(primary, { title: "gitlink update", writeScope: ["."], repositories: bindings });
    writeFileSync(path.join(inner, "src/app.txt"), "in-scope nested commit");
    git(inner, ["add", "src"]); commit(inner, "nested source change");
    git(parent, ["add", "inner"]);
    assert.match(git(parent, ["diff", "--cached", "--raw"]), /:160000 160000/);
    for (const selection of [{}, { repository: parentId }]) {
      assert.equal(evaluateGate(primary, { mode: "block", staged: true, ...selection }).decision, "allow");
    }
    // A pointer operation is still subject to the parent's own declared scope.
    parkCurrentTask(primary);
    startTask(primary, { title: "restricted parent", writeScope: ["src"], repositories: bindings.map(binding => binding.id === parentId ? { ...binding, writeScope: ["src"] } : binding) });
    assert.equal(evaluateGate(primary, { mode: "block", staged: true, repository: parentId }).decision, "block");
  });
}
