import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveMcpStartDir } from "../src/cli/index.js";
import { buildDoctorReport } from "../src/core/doctor.js";
import { findCeremonyDiagnostics } from "../src/core/ledger.js";
import { getGitInfo } from "../src/core/git.js";
import { sha256 } from "../src/core/hash.js";
import { buildResume } from "../src/core/resume.js";
import { writePackTransaction } from "../src/core/store.js";
import { formatClientGateCommand, installIntegration, mergeClaudeDesktopConfig } from "../src/integrations/install.js";
import { startMcpServer, TOOL_DEFINITIONS } from "../src/mcp/server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "src", "agentpack.js");

const DIRECTIONAL_SIGNALS = [
  "objective",
  "constraints",
  "development_state",
  "write_scope",
  "decisions",
  "open_findings",
  "verification",
  "authorization",
  "next_safe_action"
] as const;
type DirectionalSignal = typeof DIRECTIONAL_SIGNALS[number];

test("--version and --help run without an initialized pack", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-noinit-"));
  // repoRoot points at the compiled dist/ when tests run, so the real package.json sits one level above.
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "..", "package.json"), "utf8")) as { version: string };

  const version = run(dir, ["--version"]).trim();
  assert.equal(version, pkg.version);

  const versionShort = run(dir, ["-v"]).trim();
  assert.equal(versionShort, pkg.version);

  const help = run(dir, ["--help"]);
  assert.match(help, /Agentpack/);
  assert.match(help, /Default workflow/);
  assert.match(help, /Task Passport/);
  assert.match(help, /agentpack ledger status/);
  assert.match(help, /docs\/CLI\.md has the full manual/);
  assert.doesNotMatch(help, /Advanced\/debug commands/);
  assert.doesNotMatch(help, /agentpack record decision/);
  assert.match(help, /--version/);

  const taskHelp = run(dir, ["task", "--help"]);
  assert.match(taskHelp, /Agentpack Task Passports/);
  assert.match(taskHelp, /Common workflow/);
  assert.match(taskHelp, /task handoff/);
  assert.match(taskHelp, /task finalize refuses unknown or pending verification/);

  const resumeHelp = run(dir, ["resume", "--help"]);
  assert.match(resumeHelp, /agentpack resume/);
  assert.match(resumeHelp, /--preset quick\|chat\|agent\|deep/);
  assert.doesNotMatch(resumeHelp, /Pack root:/);

  const installHelp = run(dir, ["install", "--help"]);
  assert.match(installHelp, /agentpack install codex\|claude\|claude-desktop\|cursor/);
  assert.match(installHelp, /Defaults to dry-run/);

  const ledgerHelp = run(dir, ["ledger", "--help"]);
  assert.match(ledgerHelp, /agentpack ledger status/);
  assert.match(ledgerHelp, /No cleanup is performed/);

  const releaseHelp = run(dir, ["release", "--help"]);
  assert.match(releaseHelp, /agentpack release preflight/);
  assert.match(releaseHelp, /does not push, tag, publish, or create GitHub Releases/);

  const initHelp = run(dir, ["init", "--help"]);
  assert.match(initHelp, /agentpack init/);
  assert.match(initHelp, /Initialize \.agentpack\//);
  assert.equal(existsSync(path.join(dir, ".agentpack")), false);
});

test("ceremony diagnostics stay conservative and bounded", () => {
  const passport = (id: string, objective: string, createdAt: string, writeScope = ["src"]): any => ({ id, objective, createdAt, writeScope, status: "completed", closedAt: new Date(Date.parse(createdAt) + 60_000).toISOString() });
  const quiet = findCeremonyDiagnostics({
    passports: [passport("task_one", "One coherent task", "2026-01-01T00:00:00.000Z")],
    verificationTransitions: [{ taskId: "task_one", statuses: ["passed", "pending"] }],
    evidence: [],
    checkpoints: []
  });
  assert.deepEqual(quiet, [], "one remediation reset remains quiet");

  const diagnostics = findCeremonyDiagnostics({
    passports: [
      passport("task_one", "Same objective", "2026-01-01T00:00:00.000Z"),
      passport("task_two", "Same objective", "2026-01-01T01:00:00.000Z"),
      passport("task_three", "Same objective", "2026-01-01T02:00:00.000Z"),
      passport("task_phase", "Different coherent phase", "2026-01-01T02:00:00.000Z")
    ],
    verificationTransitions: [{ taskId: "task_one", statuses: ["passed", "pending", "passed", "unknown"] }],
    evidence: [{ id: "evt_one", fingerprint: "same" }, { id: "evt_two", fingerprint: "same" }, { id: "evt_three", fingerprint: "same" }],
    checkpoints: [
      { id: "one", fingerprint: "same", staleSourcePaths: ["src/a.ts"] },
      { id: "two", fingerprint: "same", staleSourcePaths: ["src/a.ts"] }
    ]
  });
  assert.deepEqual(diagnostics.map((item) => item.signal), [
    "repeated-verdict-resets",
    "duplicate-evidence",
    "duplicate-checkpoints",
    "repeated-stale-source-warnings",
    "fragmented-objective"
  ]);
  assert.ok(diagnostics.every((item) => item.samples.length <= 3));
  assert.ok(diagnostics.every((item) => item.message.length <= 240));
  assert.ok(diagnostics.every((item) => item.samples.every((sample) => sample.length <= 240)));
});

test("ceremony diagnostics remain additive across CLI, MCP, and malformed retained records", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-ceremony-status-test-"));
  run(dir, ["init"]);
  run(dir, ["task", "start", "Quiet task", "--write-scope", "src", "--next", "Verify output"]);
  const audit = JSON.parse(run(dir, ["task", "audit", "--json"]));
  const ledger = JSON.parse(run(dir, ["ledger", "status", "--json"]));
  assert.deepEqual(audit.ceremonyDiagnostics, []);
  assert.deepEqual(ledger.ceremonyDiagnostics, []);

  run(dir, ["evidence", "add", "--kind", "test", "--content", "same output", "--command", "check", "--exitCode", "0"]);
  run(dir, ["evidence", "add", "--kind", "test", "--content", "same output", "--command", "check", "--exitCode", "0"]);
  const globalEventsPath = path.join(dir, ".agentpack", "events.jsonl");

  const outsidePath = path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`);
  writeFileSync(outsidePath, "outside content", "utf8");
  const escapingEvidencePath = path.relative(path.join(dir, ".agentpack"), outsidePath);
  for (let index = 0; index < 3; index += 1) {
    writeFileSync(globalEventsPath, `${JSON.stringify({
      id: `ev_outside_${index}`,
      ts: new Date().toISOString(),
      type: "evidence",
      kind: "test",
      path: escapingEvidencePath,
      command: "check",
      exitCode: 0
    })}\n`, { encoding: "utf8", flag: "a" });
  }

  mkdirSync(path.join(dir, ".agentpack", "checkpoints", "broken"));
  mkdirSync(path.join(dir, ".agentpack", "tasks", "task_broken"));
  writeFileSync(path.join(dir, ".agentpack", "tasks", "task_broken", "passport.json"), "{not json", "utf8");
  const confinedLedger = JSON.parse(run(dir, ["ledger", "status", "--json"]));
  assert.doesNotMatch(
    JSON.stringify(confinedLedger.ceremonyDiagnostics),
    /duplicate-evidence/,
    "escaping retained evidence paths are not read or fingerprinted"
  );

  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), "before\n", "utf8");
  run(dir, ["source", "add", "src/a.ts", "--summary", "Tracked ceremony source"]);
  writeFileSync(path.join(dir, "src", "a.ts"), "after\n", "utf8");
  run(dir, ["checkpoint", "-m", "same retained snapshot"]);
  run(dir, ["checkpoint", "-m", "same retained snapshot"]);
  const checkpointLedger = JSON.parse(run(dir, ["ledger", "status", "--json"]));
  const checkpointSignals = checkpointLedger.ceremonyDiagnostics.map((item: any) => item.signal);
  assert.ok(checkpointSignals.includes("duplicate-checkpoints"), "real equivalent checkpoints are detected");
  assert.ok(checkpointSignals.includes("repeated-stale-source-warnings"), "real checkpoint resumes expose repeated stale sources");

  writeFileSync(globalEventsPath, "{not json\nnull\n", { encoding: "utf8", flag: "a" });
  const degradedLedger = JSON.parse(run(dir, ["ledger", "status", "--json"]));
  assert.equal(degradedLedger.evidence.events, 5, "valid global events survive a malformed retained line");
  assert.match(degradedLedger.warnings.join("\n"), /Skipped 2 malformed global event line/);

  const currentTask = JSON.parse(run(dir, ["task", "passport"]));
  const taskEventsPath = path.join(dir, ".agentpack", "tasks", currentTask.id, "events.jsonl");
  const taskEvent = (id: string, verificationStatus: string) => JSON.stringify({
    id,
    ts: new Date().toISOString(),
    type: "task-verify",
    verificationStatus
  });
  writeFileSync(taskEventsPath, `${taskEvent("evt_one", "passed")}\n${taskEvent("evt_two", "pending")}\n${taskEvent("evt_three", "passed")}\n${taskEvent("evt_four", "unknown")}\n${"x".repeat(256 * 1024)}\n`, "utf8");
  const boundedLedger = JSON.parse(run(dir, ["ledger", "status", "--json"]));
  assert.doesNotMatch(
    JSON.stringify(boundedLedger.ceremonyDiagnostics),
    /repeated-verdict-resets/,
    "oversized task history is skipped instead of parsed"
  );
  assert.match(run(dir, ["ledger", "status"]), /No cleanup was performed\.\s*$/);

  const symlinkDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-ceremony-symlink-root-test-"));
  run(symlinkDir, ["init"]);
  const outsideEvidenceDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-ceremony-outside-evidence-"));
  writeFileSync(path.join(outsideEvidenceDir, "outside.txt"), "outside content", "utf8");
  rmdirSync(path.join(symlinkDir, ".agentpack", "evidence"));
  symlinkSync(outsideEvidenceDir, path.join(symlinkDir, ".agentpack", "evidence"), "dir");
  const symlinkEventsPath = path.join(symlinkDir, ".agentpack", "events.jsonl");
  for (let index = 0; index < 3; index += 1) {
    writeFileSync(symlinkEventsPath, `${JSON.stringify({
      id: `ev_symlink_${index}`,
      ts: new Date().toISOString(),
      type: "evidence",
      kind: "test",
      path: "evidence/outside.txt",
      command: "check",
      exitCode: 0
    })}\n`, { encoding: "utf8", flag: "a" });
  }
  const symlinkLedger = JSON.parse(run(symlinkDir, ["ledger", "status", "--json"]));
  assert.equal(symlinkLedger.evidence.files, 0, "a symlinked evidence root is not inventoried outside the pack");
  assert.doesNotMatch(
    JSON.stringify(symlinkLedger.ceremonyDiagnostics),
    /duplicate-evidence/,
    "a symlinked evidence root is not trusted as a confinement boundary"
  );

  const sourceTasksDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-ceremony-source-tasks-"));
  run(sourceTasksDir, ["init"]);
  run(sourceTasksDir, ["task", "start", "External task must stay external", "--write-scope", "src"]);
  const symlinkTasksDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-ceremony-symlink-tasks-"));
  run(symlinkTasksDir, ["init"]);
  symlinkSync(path.join(sourceTasksDir, ".agentpack", "tasks"), path.join(symlinkTasksDir, ".agentpack", "tasks"), "dir");
  const symlinkTaskLedger = JSON.parse(run(symlinkTasksDir, ["ledger", "status", "--json"]));
  assert.equal(symlinkTaskLedger.tasks.active, 0, "a symlinked task root is not inventoried outside the pack");
  const symlinkTaskAudit = JSON.parse(run(symlinkTasksDir, ["task", "audit", "--json"]));
  assert.equal(symlinkTaskAudit.passport, null);
  assert.doesNotMatch(JSON.stringify(symlinkTaskAudit), /External task must stay external/);

  const compactedDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-ceremony-compacted-test-"));
  run(compactedDir, ["init"]);
  const misleadingNextAction = "not-a-source\n  - status: changed";
  run(compactedDir, ["checkpoint", "-m", "same compacted snapshot", "--next", misleadingNextAction]);
  run(compactedDir, ["checkpoint", "-m", "same compacted snapshot", "--next", misleadingNextAction]);
  const compactedCheckpointIds = readdirSync(path.join(compactedDir, ".agentpack", "checkpoints")).sort();
  writeFileSync(path.join(compactedDir, ".agentpack", "checkpoints", compactedCheckpointIds[0] || "", "diff.patch"), "first diff\n", "utf8");
  writeFileSync(path.join(compactedDir, ".agentpack", "checkpoints", compactedCheckpointIds[1] || "", "diff.patch"), "second diff\n", "utf8");
  const beforeCompact = JSON.parse(run(compactedDir, ["ledger", "status", "--json"]));
  assert.doesNotMatch(JSON.stringify(beforeCompact.ceremonyDiagnostics), /repeated-stale-source-warnings/);
  assert.doesNotMatch(JSON.stringify(beforeCompact.ceremonyDiagnostics), /duplicate-checkpoints/);
  run(compactedDir, ["ledger", "compact", "--write", "--keep-checkpoints", "0", "--evidence-age-days", "0"]);
  const afterCompact = JSON.parse(run(compactedDir, ["ledger", "status", "--json"]));
  assert.doesNotMatch(
    JSON.stringify(afterCompact.ceremonyDiagnostics),
    /duplicate-checkpoints/,
    "compacted checkpoints without comparison payloads are not treated as exact duplicates"
  );

  const mcp = createMcpHarness(dir);
  const response = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "task_audit", arguments: { json: true } }
  });
  const mcpAudit = JSON.parse(response.result.content[0].text);
  assert.ok(Array.isArray(mcpAudit.ceremonyDiagnostics));
});

test("directional-integrity benchmark covers critical handoff boundaries", { timeout: 30_000 }, () => {
  const sourceRoot = path.join(repoRoot, "..");
  const benchmark = path.join(sourceRoot, "scripts", "benchmark-token-overhead.mjs");
  const output = execFileSync(process.execPath, [benchmark, "--json"], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const report = JSON.parse(output) as {
    directionalIntegrity: { passed: number; total: number; failed: number; signals: Array<{ signal: string; passed: number; total: number }> };
    guardrails: { passed: number; total: number; failed: number };
    scenarios: Array<{
      id: string;
      checks?: Array<{ kind: string; signal: string; label: string; passed: boolean }>;
    }>;
  };

  assert.equal(report.directionalIntegrity.failed, 0);
  assert.equal(report.directionalIntegrity.passed, report.directionalIntegrity.total);
  assert.ok(report.directionalIntegrity.total >= 50);
  assert.equal(report.guardrails.failed, 0);
  assert.equal(report.guardrails.passed, report.guardrails.total);

  const scenarioContracts = new Map<string, Array<[signal: string, label: string]>>([
    ["latest_diff_review", [
      ["objective", "review objective"],
      ["write_scope", "source write scope"],
      ["write_scope", "test write scope"],
      ["development_state", "dirty review paths"],
      ["next_safe_action", "review next action"]
    ]],
    ["fresh_agent_context", [
      ["objective", "accepted task objective"],
      ["risk", "risk"],
      ["next_safe_action", "next action"],
      ["verification", "verification"],
      ["development_state", "local upstream drift"],
      ["development_state", "local commit subject"],
      ["development_state", "verification HEAD drift warning"],
      ["decisions", "release cadence decision"]
    ]],
    ["long_remediation_handoff", [
      ["objective", "remediation objective"],
      ["constraints", "rollback constraint"],
      ["authorization", "remote authorization boundary"],
      ["development_state", "worktree"],
      ["development_state", "branch"],
      ["development_state", "HEAD"],
      ["write_scope", "implementation scope"],
      ["decisions", "pending-verification decision"],
      ["open_findings", "remaining lifecycle finding"],
      ["verification", "verification remains pending"]
    ]],
    ["external_review_wait", [
      ["objective", "external-review objective"],
      ["constraints", "frozen-edit constraint"],
      ["verification", "frozen passed verdict"],
      ["verification", "verification evidence"],
      ["next_safe_action", "external-review resume action"],
      ["development_state", "parked lifecycle state"]
    ]],
    ["delivery_authorization", [
      ["objective", "delivery objective"],
      ["authorization", "allowed remote action"],
      ["authorization", "forbidden remote actions"],
      ["development_state", "delivery branch"],
      ["development_state", "delivery HEAD"],
      ["next_safe_action", "pre-push check"]
    ]],
    ["development_state_drift", [
      ["objective", "drift objective"],
      ["development_state", "current drifted HEAD"],
      ["development_state", "branch drift"],
      ["development_state", "HEAD drift"],
      ["development_state", "worktree drift"],
      ["next_safe_action", "drift remediation"]
    ]]
  ]);
  const scenarios = new Map(report.scenarios.map((scenario) => [scenario.id, scenario]));
  for (const [id, expectedChecks] of scenarioContracts) {
    const scenario = scenarios.get(id);
    assert.ok(scenario, `missing directional-integrity scenario: ${id}`);
    const expectedContract = expectedChecks.map(([signal, label]) => `${signal}/${label}`).sort();
    const actualContract = (scenario.checks || [])
      .filter((check) => check.kind === "directional")
      .map((check) => `${check.signal}/${check.label}`)
      .sort();
    assert.deepEqual(actualContract, expectedContract, `directional contract drifted: ${id}`);
    assert.equal(
      scenario.checks?.filter((check) => check.kind === "directional").every((check) => check.passed),
      true,
      `directional check failed: ${id}`
    );
  }

  const signals = new Map(report.directionalIntegrity.signals.map((signal) => [signal.signal, signal]));
  for (const signal of DIRECTIONAL_SIGNALS) {
    const result = signals.get(signal);
    assert.ok(result, `missing directional-integrity signal: ${signal}`);
    assert.equal(result.passed, result.total, `directional-integrity signal failed: ${signal}`);
  }
});

test("cross-client continuity preserves directional facts across drifted and imported handoffs", async () => {
  const source = mkdtempSync(path.join(os.tmpdir(), "agentpack-cross-client-source-"));
  const destination = mkdtempSync(path.join(os.tmpdir(), "agentpack-cross-client-destination-"));
  const desktopHome = mkdtempSync(path.join(os.tmpdir(), "agentpack-cross-client-desktop-"));
  const desktopConfig = path.join(desktopHome, "claude_desktop_config.json");

  mkdirSync(path.join(source, "src"), { recursive: true });
  writeFileSync(path.join(source, "src", "continuity.ts"), "export const continuity = 'recorded';\n", "utf8");
  runGit(source, ["init", "-b", "main"]);
  commitAll(source, "initial continuity fixture");
  run(source, ["init"]);
  run(source, [
    "task", "start", "Cross-client continuity", "--objective", "Preserve the reviewed continuity contract across every local client surface.",
    "--constraint", "Do not push, merge, publish, or edit global client configuration without separate authorization.",
    "--write-scope", "src/continuity.ts", "--next", "Await independent review before another edit", "--risk", "medium"
  ]);
  run(source, ["source", "add", "src/continuity.ts", "--summary", "The recorded implementation preserves the continuity boundary."]);
  run(source, ["record", "decision", "Keep lifecycle, scope, and authorization client-neutral."]);
  const evidence = run(source, ["evidence", "add", "--kind", "test-output", "--content", "Continuity fixture verification passed."])
    .match(/Attached evidence (evt_[^\s.]+)/)?.[1];
  assert.ok(evidence);
  run(source, ["task", "verify", "--status", "passed", "--evidence", evidence, "--summary", "Local verification is bound to the reviewed commit."]);
  run(source, ["task", "park"]);

  writeFileSync(path.join(source, "src", "continuity.ts"), "export const continuity = 'changed-after-review';\n", "utf8");
  commitAll(source, "introduce fixture drift");
  const sourceBundle = path.join(source, "continuity.agentpack-bundle.json");
  run(source, ["bundle", "export", "--output", path.basename(sourceBundle), "--source", "src/continuity.ts"]);

  const expectedSourceFacts: Record<DirectionalSignal, string> = {
    objective: "Preserve the reviewed continuity contract across every local client surface.",
    constraints: "Do not push, merge, publish, or edit global client configuration without separate authorization.",
    development_state: "HEAD changed from",
    write_scope: "src/continuity.ts",
    decisions: "Keep lifecycle, scope, and authorization client-neutral.",
    open_findings: "Await independent review before another edit",
    verification: "Local verification is bound to the reviewed commit.",
    authorization: "Do not push, merge, publish, or edit global client configuration without separate authorization.",
    next_safe_action: "Await independent review before another edit"
  };
  const cliResume = run(source, ["resume", "--preset", "agent"]);
  assertDirectionalFacts("CLI resume", cliResume, expectedSourceFacts);
  assert.match(cliResume, /src\/continuity\.ts\n\s+- status: changed/, "changed source conclusions are visible before a handoff");

  const sourceMcp = createMcpHarness(source);
  const mcpResume = await sourceMcp.send({
    jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "load_context", arguments: { preset: "agent" } }
  });
  assertDirectionalFacts("MCP load_context", mcpResume.result.content[0].text, expectedSourceFacts);

  rmdirSync(destination);
  runGit(path.dirname(destination), ["clone", source, destination]);
  run(destination, ["init"]);
  const imported = JSON.parse(run(destination, ["bundle", "import", sourceBundle, "--write", "--json"]));
  const importedPassport = JSON.parse(readFileSync(path.join(destination, ".agentpack", "tasks", imported.taskId, "passport.json"), "utf8"));
  assert.equal(importedPassport.status, "parked", "a transferred external wait remains non-editable");
  assert.equal(importedPassport.verification.status, "unknown", "imported verification must be re-established locally");
  assert.deepEqual(importedPassport.verification.evidence, []);
  run(destination, ["task", "switch", imported.taskId]);

  const freshResume = run(destination, ["resume", "--preset", "agent"]);
  assert.match(freshResume, /Objective: Preserve the reviewed continuity contract across every local client surface\./);
  assert.match(freshResume, /Write scope:\n\s+- src\/continuity\.ts/);
  assert.match(freshResume, /Verification: unknown/);
  assert.match(freshResume, new RegExp(`Worktree: ${escapeRegExp(realpathSync(destination))}`));
  assert.match(freshResume, /Branch: main/);
  assert.match(freshResume, /No inspected sources recorded yet\./, "a bundle carries selected source artifacts, not an unreviewed destination source-cache conclusion");

  writeFileSync(desktopConfig, JSON.stringify({ mcpServers: { preserved: { command: "preserve" } } }), "utf8");
  run(source, ["install", "codex", "--write"]);
  run(source, ["install", "claude", "--write"]);
  run(source, ["install", "cursor", "--write"]);
  installIntegration(realpathSync(source), "claude-desktop", { dryRun: false, claudeDesktopConfigPath: desktopConfig });

  const clientSurfaces: Array<[string, string, string[]]> = [
    ["Codex", readFileSync(path.join(source, ".codex", "agents", "builder.toml"), "utf8"), ["write scope", "final verification", "commits, and release actions", 'enabled_tools = ["load_context"]']],
    ["Claude Code", readFileSync(path.join(source, ".claude", "agents", "builder.md"), "utf8"), ["write scope", "commit or push unless", "state-changing tools"]],
    ["Cursor", readFileSync(path.join(source, ".cursor", "agents", "builder.md"), "utf8"), ["write scope", "commit or push unless", "state-changing tools"]],
    ["Claude Desktop", readFileSync(desktopConfig, "utf8"), ["mcpServers", "preserved"]]
  ];
  for (const [client, surface, required] of clientSurfaces) {
    for (const fact of required) {
      assert.match(surface, new RegExp(escapeRegExp(fact), "i"), `${client} must preserve its relevant client-neutral boundary: ${fact}`);
    }
  }
  const cursorCli = JSON.parse(readFileSync(path.join(source, ".cursor", "cli.json"), "utf8"));
  assert.equal(cursorCli.permissions.allow.some((entry: string) => /record_decision|task_finalize/.test(entry)), false, "Cursor only preauthorizes read-only MCP tools");
  assert.match(readFileSync(desktopConfig, "utf8"), /"preserved"/, "the hermetic Desktop config is merged, not replaced");
});

test("keeps MCP Registry publication retryable after npm publish", () => {
  const sourceRoot = path.join(repoRoot, "..");
  const workflow = readFileSync(path.join(sourceRoot, ".github", "workflows", "publish.yml"), "utf8");
  const registryJobAt = workflow.indexOf("  publish-mcp-registry:");
  assert.ok(registryJobAt > 0, "Registry publication must be a distinct workflow job");

  const npmJob = workflow.slice(0, registryJobAt);
  const registryJob = workflow.slice(registryJobAt);
  assert.match(registryJob, /needs: publish/);
  assert.match(registryJob, /mcp-publisher publish/);
  assert.doesNotMatch(npmJob, /mcp-publisher/, "retrying Registry metadata must not repeat npm publication");

  const releaseDocs = readFileSync(path.join(sourceRoot, "docs", "RELEASING.md"), "utf8");
  assert.match(releaseDocs, /Re-run failed jobs/);
  assert.match(releaseDocs, /npm versions are immutable/);
});

test("creates a pack, records source context, checkpoints, and exports handoff", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-test-"));
  writeFileSync(path.join(dir, "index.js"), "console.log('hello agentpack')\n", "utf8");

  run(dir, ["init"]);
  assert.match(readFileSync(path.join(dir, ".gitignore"), "utf8"), /\.agentpack\//);
  run(dir, ["set", "goal", "Ship a tiny Agentpack MVP"]);
  run(dir, ["source", "add", "index.js", "--summary", "Entry point already inspected."]);
  const initialSourceStatus = run(dir, ["source", "status"]);
  assert.match(initialSourceStatus, /UNCHANGED index\.js/);
  assert.match(initialSourceStatus, /hash: matches recorded hash/);
  assert.match(initialSourceStatus, /meaning: recorded summary is valid for the current file content/);
  run(dir, ["record", "decision", "Use local JSON and JSONL storage for v0."]);
  run(dir, ["note", "This is a local task-state note."]);
  const evidenceOutput = run(dir, ["evidence", "add", "--kind", "test-output", "--content", "Tests pass."]);
  const decisionEvidenceId = evidenceOutput.match(/Attached evidence ([^\n]+)/)?.[1] || "";
  assert.match(decisionEvidenceId, /^evt_/);
  run(dir, ["record", "decision", "Evidence can support durable decisions.", "--evidence", decisionEvidenceId]);
  run(dir, ["run", process.execPath, "--version"]);
  run(dir, [
    "checkpoint",
    "-m",
    "First checkpoint",
    "--status",
    "Ready for handoff",
    "--next",
    "Open MCP contract"
  ]);

  const resume = run(dir, ["resume", "--preset", "agent"]);
  assert.match(resume, /Pack root: .+agentpack-test-/);
  assert.match(resume, /Ship a tiny Agentpack MVP/);
  assert.match(resume, /Ready for handoff/);
  assert.match(resume, /Open MCP contract/);
  assert.match(resume, /Estimated usage: ~\d+ tokens/);
  assert.match(resume, /Budget status: within target/);
  assert.match(resume, /Source Cache/);
  assert.match(resume, /Do not re-open unless needed or unless hash changed/);
  assert.match(resume, /Summary is current for this file content/);
  assert.match(resume, /command-output/);
  assert.match(resume, /exit code: 0/);
  const timeline = resume.split("## Recent Timeline")[1] || "";
  assert.match(timeline, /Total events:/);
  assert.match(timeline, /Full chronology: `agentpack replay`/);
  assert.doesNotMatch(timeline, /Entry point already inspected/);

  const tinyResume = run(dir, ["resume", "--budget", "80"]);
  assert.match(tinyResume, /Estimated usage: ~\d+ tokens/);
  assert.match(tinyResume, /Budget status: limited/);
  assert.ok(estimatedTokensFromResume(tinyResume) <= 80);

  const strictFallbackResume = buildResume(dir, { budget: 40 });
  assert.ok(strictFallbackResume.estimatedTokens <= 40);
  assert.match(strictFallbackResume.markdown, /\[Truncated to fit budget\]$/);

  const markerlessFallbackResume = buildResume(dir, { budget: 5 });
  assert.ok(markerlessFallbackResume.estimatedTokens <= 5);
  assert.doesNotMatch(markerlessFallbackResume.markdown, /\[Truncated to fit budget\]/);

  const exported = run(dir, ["export", "--to", "chatgpt", "--preset", "agent"]);
  assert.match(exported, /chatgpt-handoff\.md/);
  assert.equal(existsSync(path.join(dir, ".agentpack", "exports", "chatgpt-handoff.md")), true);
  const defaultExport = run(dir, ["export", "--preset", "agent"]);
  assert.match(defaultExport, /markdown-handoff\.md/);
  assert.equal(existsSync(path.join(dir, ".agentpack", "exports", "markdown-handoff.md")), true);

  const replay = run(dir, ["replay"]);
  assert.match(replay, /decision/);
  assert.match(replay, /note/);
  assert.match(replay, /command-output/);
  assert.match(replay, /checkpoint/);

  const sourceDb = JSON.parse(readFileSync(path.join(dir, ".agentpack", "sources.json"), "utf8"));
  assert.equal(sourceDb.sources[0].path, "index.js");

  writeFileSync(path.join(dir, "index.js"), "console.log('changed')\n", "utf8");
  assert.match(run(dir, ["source", "status"]), /CHANGED index\.js/);

  const sourceStatus = JSON.parse(run(dir, ["source", "status", "--json"]));
  assert.equal(sourceStatus[0].status, "changed");

  const ledger = run(dir, ["ledger", "status"]);
  assert.match(ledger, /Ledger status/);
  assert.match(ledger, /Tasks: 0 active, 0 parked, 0 blocked, 0 verifying, 0 completed, 0 abandoned/);
  assert.match(ledger, /Events: \d+ entries, /);
  assert.match(ledger, /Evidence: 2 files, .* \(2 events, 1 referenced, 1 unreferenced\)/);
  assert.match(ledger, /Checkpoints: 1 snapshots, /);
  assert.match(ledger, /Exports: 2 files, /);
  assert.match(ledger, /Sources: 1 recorded, 0 unchanged, 1 changed, 0 missing/);
  assert.match(ledger, /No cleanup was performed\./);

  const doctor = run(dir, ["doctor"]);
  assert.match(doctor, /Agentpack doctor/);
  assert.match(doctor, /\[ok\] Pack/);
  assert.match(doctor, /\[ok\] \.gitignore/);
  assert.match(doctor, /\[warn\] Sources: 1 recorded, 1 changed, 0 missing; run `agentpack source status --changed --missing` for details/);
});

test("exposes expected MCP tools", () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "attach_evidence",
    "bundle_export",
    "bundle_import",
    "bundle_import_plan",
    "bundle_inspect",
    "checkpoint",
    "diff",
    "load_context",
    "record_dead_end",
    "record_decision",
    "record_source",
    "release_preflight",
    "replay",
    "resume",
    "source_status",
    "task_audit",
    "task_finalize",
    "task_handoff",
    "task_list",
    "task_park",
    "task_start",
    "task_status",
    "task_switch",
    "task_update",
    "task_update_verification"
  ]);

  const readOnlyTools = [
    "bundle_import_plan",
    "bundle_inspect",
    "diff",
    "load_context",
    "release_preflight",
    "replay",
    "resume",
    "source_status",
    "task_audit",
    "task_handoff",
    "task_list",
    "task_status"
  ];
  const additiveTools = [
    "attach_evidence",
    "bundle_export",
    "bundle_import",
    "record_dead_end",
    "record_decision",
    "task_start"
  ];
  const updatingTools = [
    "checkpoint",
    "record_source",
    "task_finalize",
    "task_park",
    "task_switch",
    "task_update",
    "task_update_verification"
  ];

  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.annotations.openWorldHint, false, `${tool.name} must stay repo-local`);
  }
  for (const name of readOnlyTools) {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    assert.deepEqual(tool?.annotations, { readOnlyHint: true, openWorldHint: false });
  }
  for (const name of additiveTools) {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    });
  }
  for (const name of updatingTools) {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    });
  }
  assert.equal(readOnlyTools.length + additiveTools.length + updatingTools.length, TOOL_DEFINITIONS.length);

  const sourceStatusTool = TOOL_DEFINITIONS.find((tool) => tool.name === "source_status");
  assert.match(sourceStatusTool?.description || "", /changed, or missing/);
  assert.match(sourceStatusTool?.description || "", /stale source-cache triage/);

  for (const name of ["task_start", "task_update"]) {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    const properties = tool?.inputSchema.properties as Record<string, { description?: string }>;
    assert.match(properties.writeScope?.description || "", /prefix paths/);
    assert.match(properties.writeScope?.description || "", /globs are not supported/);
  }
  const taskSwitchTool = TOOL_DEFINITIONS.find((tool) => tool.name === "task_switch");
  assert.match(taskSwitchTool?.description || "", /final verdict resumes as verifying/);

  for (const name of ["load_context", "resume"]) {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    const properties = tool?.inputSchema.properties as Record<string, { enum?: string[] }>;
    assert.ok(properties.preset);
    assert.deepEqual(properties.preset.enum, ["quick", "chat", "agent", "deep"]);
  }
});

test("validates MCP budget presets", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-mcp-preset-test-"));
  run(dir, ["init"]);
  const mcp = createMcpHarness(dir);

  const invalid = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "load_context",
      arguments: { preset: "small" }
    }
  });
  assert.equal(
    invalid.error?.message,
    "Unknown budget preset: small. Expected one of: quick, chat, agent, deep."
  );

  const invalidWithBudget = await mcp.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "resume",
      arguments: { preset: "small", budget: 220 }
    }
  });
  assert.equal(
    invalidWithBudget.error?.message,
    "Unknown budget preset: small. Expected one of: quick, chat, agent, deep."
  );

  const explicitBudget = await mcp.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "resume",
      arguments: { preset: "quick", budget: 220 }
    }
  });
  assert.match(explicitBudget.result.content[0].text, /Budget: ~220 tokens/);
});

test("exports, inspects, and plans read-only structured bundle imports", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-test-"));
  const noPackDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-inspect-no-pack-"));
  const destinationDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-import-plan-"));
  const writeDestinationDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-import-write-"));
  const asNewDestinationDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-import-as-new-"));
  const failureDestinationDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-import-failure-"));
  const mcpWriteDestinationDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-import-mcp-write-"));
  const concurrentDestinationDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-import-concurrent-"));
  const redactionDestinationDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-import-redaction-"));
  const symlinkDestinationDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-import-symlink-"));
  const symlinkOutsideDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-import-symlink-outside-"));
  const secret = "agentpack-bundle-secret-123";
  const destinationSecret = "destination-only-bundle-secret-456";
  const priorEnv = process.env.AGENTPACK_BUNDLE_TOKEN;
  const priorDestinationEnv = process.env.AGENTPACK_DESTINATION_BUNDLE_TOKEN;
  process.env.AGENTPACK_BUNDLE_TOKEN = secret;
  process.env.AGENTPACK_DESTINATION_BUNDLE_TOKEN = destinationSecret;

  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    runGit(dir, ["init"]);
    runGit(dir, ["config", "user.name", "Agentpack Test"]);
    runGit(dir, ["config", "user.email", "test@example.com"]);
    runGit(dir, ["remote", "add", "origin", "https://user:pass@example.com/org/example.git?token=bad#frag"]);
    run(dir, ["init"]);

    const configPath = path.join(dir, ".agentpack", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.redactions = [...config.redactions, "AGENTPACK_BUNDLE_TOKEN"];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    run(dir, [
      "task",
      "start",
      "Bundle checkout state",
      "--objective",
      `Export task context without leaking ${secret}; retain ${destinationSecret} for a destination-policy test.`,
      "--write-scope",
      "src/index.ts",
      "--next",
      "Inspect bundle"
    ]);
    run(dir, [
      "source",
      "add",
      "src/index.ts",
      "--summary",
      `Source summary with ${secret}.`,
      "--snippet",
      `token=${secret}`
    ]);
    const evidenceOutput = run(dir, [
      "evidence",
      "add",
      "--kind",
      "test-output",
      "--content",
      `Focused tests passed with token=${secret}.`
    ]);
    const evidenceId = evidenceOutput.match(/Attached evidence ([^\n]+)/)?.[1] || "";
    run(dir, [
      "task",
      "verify",
      "--status",
      "passed",
      "--evidence",
      evidenceId,
      "--summary",
      "Bundle export fixture verified."
    ]);
    const exportedTaskId = readFileSync(path.join(dir, ".agentpack", "tasks", "current"), "utf8").trim();

    const bundlePath = path.join(dir, "checkout.agentpack-bundle.json");
    const exported = run(dir, [
      "bundle",
      "export",
      "--task",
      "current",
      "--output",
      "checkout.agentpack-bundle.json",
      "--source",
      "src/index.ts"
    ]);
    assert.match(exported, /Exported bundle sha256:/);
    assert.match(exported, /Included: 1 source\(s\), 1 evidence item\(s\)/);
    assert.equal(existsSync(bundlePath), true);

    const bundleText = readFileSync(bundlePath, "utf8");
    const bundle = JSON.parse(bundleText);
    assert.equal(bundle.kind, "agentpack.task-bundle");
    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.sources[0].path, "src/index.ts");
    assert.equal(bundle.evidence[0].originId, evidenceId);
    assert.equal(bundle.origin.repository, "https://example.com/org/example.git");
    assert.equal(bundleText.includes(secret), false);
    assert.equal(bundleText.includes(destinationSecret), true);
    assert.equal(bundleText.includes(dir), false);
    assert.match(bundleText, /\[REDACTED:AGENTPACK_BUNDLE_TOKEN\]/);

    const sourceEvidenceEvent = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.id === evidenceId);
    const sourceEvidencePath = path.join(dir, ".agentpack", sourceEvidenceEvent.path);
    const sourceEvidenceContent = readFileSync(sourceEvidencePath, "utf8");
    const externalEvidenceDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-external-evidence-"));
    const externalEvidencePath = path.join(externalEvidenceDir, "outside.txt");
    writeFileSync(externalEvidencePath, "outside evidence must never be exported", "utf8");
    unlinkSync(sourceEvidencePath);
    symlinkSync(externalEvidencePath, sourceEvidencePath, "file");
    assert.match(
      runExpectError(dir, [
        "bundle",
        "export",
        "--task",
        "current",
        "--output",
        "symlink-evidence.agentpack-bundle.json",
        "--source",
        "src/index.ts"
      ]),
      /Refusing symbolic-link evidence path/
    );
    assert.equal(existsSync(path.join(dir, "symlink-evidence.agentpack-bundle.json")), false);
    unlinkSync(sourceEvidencePath);
    writeFileSync(sourceEvidencePath, sourceEvidenceContent, "utf8");

    const noPackPlan = JSON.parse(run(noPackDir, ["bundle", "import-plan", bundlePath, "--json"]));
    assert.equal(noPackPlan.readOnly, true);
    assert.deepEqual(noPackPlan.writes, []);
    assert.equal(noPackPlan.destination.status, "uninitialized");
    assert.equal(noPackPlan.destination.packInitialized, false);
    assert.equal(noPackPlan.action.outcome, "create");
    assert.equal(noPackPlan.action.task, "create");
    assert.equal(existsSync(path.join(noPackDir, ".agentpack")), false);

    const defaultImportPlan = JSON.parse(run(noPackDir, ["bundle", "import", bundlePath, "--json"]));
    assert.equal(defaultImportPlan.action.outcome, "create");
    assert.equal(defaultImportPlan.readOnly, true);
    assert.equal(existsSync(path.join(noPackDir, ".agentpack")), false);
    assert.match(
      runExpectError(noPackDir, ["bundle", "import", bundlePath, "--write"]),
      /requires an initialized destination pack/
    );

    mkdirSync(path.join(writeDestinationDir, "src"), { recursive: true });
    writeFileSync(path.join(writeDestinationDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    run(writeDestinationDir, ["init"]);
    run(writeDestinationDir, [
      "task",
      "start",
      "Destination current task",
      "--objective",
      "Remain current while another task is imported.",
      "--write-scope",
      "src/index.ts",
      "--next",
      "Stay current"
    ]);
    const destinationCurrentBefore = readFileSync(
      path.join(writeDestinationDir, ".agentpack", "tasks", "current"),
      "utf8"
    );
    const writeResult = JSON.parse(run(writeDestinationDir, [
      "bundle",
      "import",
      bundlePath,
      "--write",
      "--json"
    ]));
    assert.equal(writeResult.applied, true);
    assert.equal(writeResult.idempotent, false);
    assert.equal(writeResult.taskId, exportedTaskId);
    assert.equal(
      readFileSync(path.join(writeDestinationDir, ".agentpack", "tasks", "current"), "utf8"),
      destinationCurrentBefore
    );
    const importedPassport = JSON.parse(readFileSync(
      path.join(writeDestinationDir, ".agentpack", "tasks", exportedTaskId, "passport.json"),
      "utf8"
    ));
    assert.equal(importedPassport.status, "parked");
    assert.equal(importedPassport.verification.status, "unknown");
    assert.deepEqual(importedPassport.verification.evidence, []);
    assert.equal(importedPassport.worktree, realpathSync(writeDestinationDir));
    const portableBundleStorageId = bundle.bundleId.replace(":", "-");
    const importedBundleDir = path.join(writeDestinationDir, ".agentpack", "tasks", exportedTaskId, "imports");
    assert.deepEqual(readdirSync(importedBundleDir).sort(), [
      `${portableBundleStorageId}.bundle.json`,
      `${portableBundleStorageId}.import.json`
    ]);
    const writeManifestPath = path.join(importedBundleDir, `${portableBundleStorageId}.import.json`);
    const writeManifest = JSON.parse(readFileSync(writeManifestPath, "utf8"));
    assert.equal(writeManifest.destinationTaskId, exportedTaskId);
    assert.equal(writeManifest.originalStatus, "verifying");
    assert.equal(writeManifest.task.action, "created");
    assert.equal(writeManifest.sources[0].action, "created");
    assert.equal(writeManifest.evidence[0].action, "created");
    assert.equal(writeManifest.originVerification.evidence[0], evidenceId);
    const importedSources = JSON.parse(readFileSync(path.join(writeDestinationDir, ".agentpack", "sources.json"), "utf8"));
    assert.equal(importedSources.sources[0].path, "src/index.ts");
    assert.match(importedSources.sources[0].summary, /REDACTED:AGENTPACK_BUNDLE_TOKEN/);
    const importedEvidenceEvent = readFileSync(path.join(writeDestinationDir, ".agentpack", "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.id === evidenceId);
    assert.equal(importedEvidenceEvent.type, "evidence");
    assert.equal(existsSync(path.join(writeDestinationDir, ".agentpack", importedEvidenceEvent.path)), true);

    const idempotentWrite = JSON.parse(run(writeDestinationDir, [
      "bundle",
      "import",
      bundlePath,
      "--write",
      "--json"
    ]));
    assert.equal(idempotentWrite.applied, false);
    assert.equal(idempotentWrite.idempotent, true);
    assert.equal(idempotentWrite.taskId, exportedTaskId);
    assert.equal(
      readFileSync(path.join(writeDestinationDir, ".agentpack", "tasks", "current"), "utf8"),
      destinationCurrentBefore
    );
    const idempotentText = run(writeDestinationDir, ["bundle", "import", bundlePath, "--write"]);
    assert.match(idempotentText, /Applied: no \(idempotent\)/);
    assert.match(idempotentText, /Original import evidence: created 1/);
    assert.match(idempotentText, /Original import sources: created 1/);
    assert.doesNotMatch(idempotentText, /^Evidence: created 1$/m);
    assert.doesNotMatch(idempotentText, /^Sources: created 1$/m);

    const manifestCorruptions: Array<[string, (manifest: any) => void]> = [
      ["task action", (manifest) => { manifest.task.action = "deleted"; }],
      ["evidence field", (manifest) => { delete manifest.evidence[0].destinationId; }],
      ["evidence action", (manifest) => { manifest.evidence[0].action = "deleted"; }],
      ["source field", (manifest) => { manifest.sources[0].hash = "invalid"; }],
      ["source action", (manifest) => { manifest.sources[0].action = "deleted"; }],
      ["source reason", (manifest) => { manifest.sources[0].reason = 42; }]
    ];
    for (const [label, corrupt] of manifestCorruptions) {
      const malformedManifest = JSON.parse(JSON.stringify(writeManifest));
      corrupt(malformedManifest);
      writeFileSync(writeManifestPath, `${JSON.stringify(malformedManifest, null, 2)}\n`, "utf8");
      const malformedPlan = JSON.parse(run(writeDestinationDir, ["bundle", "import-plan", bundlePath, "--json"]));
      assert.equal(malformedPlan.destination.status, "import-conflict", label);
      assert.equal(malformedPlan.action.outcome, "conflict", label);
      assert.match(malformedPlan.conflicts[0].message, /Import manifest is missing or invalid/, label);
    }
    assert.match(
      runExpectError(writeDestinationDir, ["bundle", "import", bundlePath, "--write"]),
      /Bundle import conflict:.*Import manifest is missing or invalid/
    );
    writeFileSync(writeManifestPath, `${JSON.stringify(writeManifest, null, 2)}\n`, "utf8");

    run(destinationDir, ["init"]);
    const emptyPackPlan = JSON.parse(run(destinationDir, ["bundle", "import-plan", bundlePath, "--json"]));
    assert.equal(emptyPackPlan.destination.status, "task-missing");
    assert.equal(emptyPackPlan.destination.packInitialized, true);
    assert.equal(emptyPackPlan.action.outcome, "create");
    assert.equal(existsSync(path.join(destinationDir, ".agentpack", "tasks")), false);

    const destinationTaskDir = path.join(destinationDir, ".agentpack", "tasks", exportedTaskId);
    mkdirSync(destinationTaskDir, { recursive: true });
    const sourcePassportPath = path.join(dir, ".agentpack", "tasks", exportedTaskId, "passport.json");
    const destinationPassportPath = path.join(destinationTaskDir, "passport.json");
    const destinationPassportValue = JSON.parse(readFileSync(sourcePassportPath, "utf8"));
    destinationPassportValue.title = "Conflicting local task";
    const destinationPassport = `${JSON.stringify(destinationPassportValue, null, 2)}\n`;
    writeFileSync(destinationPassportPath, destinationPassport, "utf8");

    const conflictPlan = JSON.parse(run(destinationDir, ["bundle", "import-plan", bundlePath, "--json"]));
    assert.equal(conflictPlan.destination.status, "task-present");
    assert.equal(conflictPlan.action.outcome, "conflict");
    assert.equal(conflictPlan.action.task, "conflict");
    assert.equal(conflictPlan.conflicts[0].kind, "task-id");

    const importsDir = path.join(destinationTaskDir, "imports");
    mkdirSync(importsDir, { recursive: true });
    writeFileSync(path.join(importsDir, `${bundle.bundleId}.bundle.json`), bundleText, "utf8");
    const idempotentPlan = JSON.parse(run(destinationDir, ["bundle", "import-plan", bundlePath, "--json"]));
    assert.equal(idempotentPlan.destination.status, "import-conflict");
    assert.equal(idempotentPlan.action.outcome, "conflict");
    assert.equal(idempotentPlan.action.task, "conflict");
    assert.equal(idempotentPlan.action.bundle, "blocked");
    assert.match(idempotentPlan.conflicts[0].message, /Import manifest is missing or invalid/);
    assert.equal(readFileSync(destinationPassportPath, "utf8"), destinationPassport);
    assert.deepEqual(readdirSync(importsDir), [`${bundle.bundleId}.bundle.json`]);

    mkdirSync(path.join(asNewDestinationDir, "src"), { recursive: true });
    writeFileSync(path.join(asNewDestinationDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    run(asNewDestinationDir, ["init"]);
    const asNewTaskDir = path.join(asNewDestinationDir, ".agentpack", "tasks", exportedTaskId);
    mkdirSync(asNewTaskDir, { recursive: true });
    writeFileSync(path.join(asNewTaskDir, "passport.json"), destinationPassport, "utf8");
    run(asNewDestinationDir, [
      "source",
      "add",
      "src/index.ts",
      "--summary",
      "Existing destination conclusion wins."
    ]);
    const conflictingEvidencePath = path.join("evidence", "local-conflict.txt");
    writeFileSync(
      path.join(asNewDestinationDir, ".agentpack", conflictingEvidencePath),
      "different local evidence",
      "utf8"
    );
    writeFileSync(
      path.join(asNewDestinationDir, ".agentpack", "events.jsonl"),
      `${JSON.stringify({
        id: evidenceId,
        ts: new Date().toISOString(),
        type: "evidence",
        kind: "note",
        path: conflictingEvidencePath,
        command: "",
        exitCode: null
      })}\n`,
      { encoding: "utf8", flag: "a" }
    );
    const asNewResult = JSON.parse(run(asNewDestinationDir, [
      "bundle",
      "import",
      bundlePath,
      "--write",
      "--as-new",
      "--json"
    ]));
    assert.equal(asNewResult.applied, true);
    assert.notEqual(asNewResult.taskId, exportedTaskId);
    assert.match(asNewResult.taskId, new RegExp(`^${escapeRegExp(exportedTaskId)}_import_[0-9a-f]{12}$`));
    assert.equal(asNewResult.manifest.asNew, true);
    assert.equal(asNewResult.manifest.task.remappedFrom, exportedTaskId);
    assert.equal(asNewResult.manifest.evidence[0].action, "remapped");
    assert.notEqual(asNewResult.manifest.evidence[0].destinationId, evidenceId);
    assert.equal(
      asNewResult.manifest.originVerification.evidence[0],
      asNewResult.manifest.evidence[0].destinationId
    );
    assert.equal(asNewResult.manifest.sources[0].action, "reused");
    const asNewSources = JSON.parse(readFileSync(path.join(asNewDestinationDir, ".agentpack", "sources.json"), "utf8"));
    assert.equal(asNewSources.sources[0].summary, "Existing destination conclusion wins.");
    assert.equal(existsSync(path.join(asNewDestinationDir, ".agentpack", "tasks", "current")), false);
    const asNewRetry = JSON.parse(run(asNewDestinationDir, [
      "bundle",
      "import",
      bundlePath,
      "--write",
      "--as-new",
      "--json"
    ]));
    assert.equal(asNewRetry.idempotent, true);
    assert.equal(asNewRetry.taskId, asNewResult.taskId);

    mkdirSync(path.join(failureDestinationDir, "src"), { recursive: true });
    writeFileSync(path.join(failureDestinationDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    run(failureDestinationDir, ["init"]);
    const failureTaskDir = path.join(failureDestinationDir, ".agentpack", "tasks", exportedTaskId);
    mkdirSync(failureTaskDir, { recursive: true });
    writeFileSync(path.join(failureTaskDir, "imports"), "block imports directory", "utf8");
    const failureSourcesBefore = readFileSync(path.join(failureDestinationDir, ".agentpack", "sources.json"), "utf8");
    const failureEventsBefore = readFileSync(path.join(failureDestinationDir, ".agentpack", "events.jsonl"), "utf8");
    const failureEvidenceBefore = readdirSync(path.join(failureDestinationDir, ".agentpack", "evidence"));
    assert.match(
      runExpectError(failureDestinationDir, ["bundle", "import", bundlePath, "--write"]),
      /requires a directory/
    );
    assert.equal(existsSync(path.join(failureTaskDir, "passport.json")), false);
    assert.equal(existsSync(path.join(failureTaskDir, "events.jsonl")), false);
    assert.equal(readFileSync(path.join(failureTaskDir, "imports"), "utf8"), "block imports directory");
    assert.equal(
      readFileSync(path.join(failureDestinationDir, ".agentpack", "sources.json"), "utf8"),
      failureSourcesBefore
    );
    assert.equal(
      readFileSync(path.join(failureDestinationDir, ".agentpack", "events.jsonl"), "utf8"),
      failureEventsBefore
    );
    assert.deepEqual(
      readdirSync(path.join(failureDestinationDir, ".agentpack", "evidence")),
      failureEvidenceBefore
    );
    assert.equal(existsSync(path.join(failureDestinationDir, ".agentpack", "tasks", "current")), false);

    mkdirSync(path.join(concurrentDestinationDir, "src"), { recursive: true });
    writeFileSync(path.join(concurrentDestinationDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    run(concurrentDestinationDir, ["init"]);
    const concurrentResults = await Promise.all([
      runAsync(concurrentDestinationDir, ["bundle", "import", bundlePath, "--write"]),
      runAsync(concurrentDestinationDir, ["bundle", "import", bundlePath, "--write"])
    ]);
    assert.equal(concurrentResults.filter((output) => output.startsWith("Imported bundle")).length, 1);
    assert.equal(concurrentResults.filter((output) => output.startsWith("Reused bundle")).length, 1);
    const concurrentSources = JSON.parse(readFileSync(
      path.join(concurrentDestinationDir, ".agentpack", "sources.json"),
      "utf8"
    ));
    assert.equal(concurrentSources.sources.filter((source: { path: string }) => source.path === "src/index.ts").length, 1);
    const concurrentEvents = readFileSync(path.join(concurrentDestinationDir, ".agentpack", "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(concurrentEvents.filter((event) => event.type === "bundle-import").length, 1);

    run(redactionDestinationDir, ["init"]);
    const destinationConfigPath = path.join(redactionDestinationDir, ".agentpack", "config.json");
    const destinationConfig = JSON.parse(readFileSync(destinationConfigPath, "utf8"));
    destinationConfig.redactions.push("AGENTPACK_DESTINATION_BUNDLE_TOKEN");
    writeFileSync(destinationConfigPath, `${JSON.stringify(destinationConfig, null, 2)}\n`, "utf8");
    assert.match(
      runExpectError(redactionDestinationDir, ["bundle", "import", bundlePath, "--write"]),
      /values that require destination redaction/
    );
    assert.equal(
      existsSync(path.join(redactionDestinationDir, ".agentpack", "tasks", exportedTaskId)),
      false
    );

    run(symlinkDestinationDir, ["init"]);
    const symlinkTasksDir = path.join(symlinkDestinationDir, ".agentpack", "tasks");
    mkdirSync(symlinkTasksDir, { recursive: true });
    symlinkSync(symlinkOutsideDir, path.join(symlinkTasksDir, exportedTaskId), "dir");
    assert.match(
      runExpectError(symlinkDestinationDir, ["bundle", "import", bundlePath, "--write"]),
      /refuses a symbolic-link directory/
    );
    assert.deepEqual(readdirSync(symlinkOutsideDir), []);

    const secondExport = run(dir, [
      "bundle",
      "export",
      "--output",
      "checkout-repeat.agentpack-bundle.json",
      "--source",
      "src/index.ts"
    ]);
    const secondBundleId = secondExport.match(/Exported bundle (sha256:[^\n]+)/)?.[1] || "";
    assert.equal(secondBundleId, bundle.bundleId);

    run(dir, ["task", "finalize", "--status", "passed", "--summary", "Bundle fixture finalized."]);
    run(dir, [
      "task",
      "start",
      "Current unrelated task",
      "--objective",
      "Keep a different current task active while exporting a historical task.",
      "--write-scope",
      "src/index.ts",
      "--next",
      "Stay current"
    ]);
    run(dir, [
      "bundle",
      "export",
      "--task",
      exportedTaskId,
      "--output",
      "historical.agentpack-bundle.json",
      "--source",
      "src/index.ts"
    ]);
    const historicalBundle = JSON.parse(readFileSync(path.join(dir, "historical.agentpack-bundle.json"), "utf8"));
    assert.equal(historicalBundle.task.id, exportedTaskId);
    assert.equal(historicalBundle.task.title, "Bundle checkout state");
    assert.match(historicalBundle.handoffMarkdown, /Bundle checkout state \[completed\]/);
    assert.doesNotMatch(historicalBundle.handoffMarkdown, /Current unrelated task/);

    const inspect = run(noPackDir, ["bundle", "inspect", bundlePath]);
    assert.match(inspect, new RegExp(`Bundle ${escapeRegExp(bundle.bundleId)}`));
    assert.match(inspect, /Status: valid \(valid digest\)/);
    assert.match(inspect, /Task: task_.* - Bundle checkout state/);
    assert.match(inspect, /Included: 1 source\(s\), 1 evidence item\(s\)/);

    const inspectJson = JSON.parse(run(noPackDir, ["bundle", "inspect", bundlePath, "--json"]));
    assert.equal(inspectJson.bundleId, bundle.bundleId);
    assert.equal(inspectJson.valid, true);
    assert.equal(inspectJson.counts.sources, 1);
    assert.equal(inspectJson.counts.evidence, 1);

    const tamperedPath = path.join(dir, "tampered.agentpack-bundle.json");
    writeFileSync(tamperedPath, bundleText.replace("Bundle checkout state", "Bundle tampered state"), "utf8");
    assert.match(runExpectError(noPackDir, ["bundle", "inspect", tamperedPath]), /Bundle digest mismatch/);
    assert.match(runExpectError(noPackDir, ["bundle", "import-plan", tamperedPath]), /Bundle digest mismatch/);

    assert.match(
      runExpectError(dir, [
        "bundle",
        "export",
        "--output",
        "bad.agentpack-bundle.json",
        "--source",
        path.join(dir, "src", "index.ts")
      ]),
      /Refusing absolute bundle source path/
    );
    assert.match(
      runExpectError(dir, [
        "bundle",
        "export",
        "--output",
        path.join(dir, "absolute.agentpack-bundle.json"),
        "--source",
        "src/index.ts"
      ]),
      /Refusing absolute bundle output path/
    );
    assert.match(
      runExpectError(dir, [
        "bundle",
        "export",
        "--output",
        "../escape.agentpack-bundle.json",
        "--source",
        "src/index.ts"
      ]),
      /Refusing bundle output path outside project root/
    );
    assert.match(
      runExpectError(dir, [
        "bundle",
        "export",
        "--output",
        "src/index.ts",
        "--source",
        "src/index.ts"
      ]),
      /Refusing to overwrite existing bundle output/
    );
    assert.match(
      runExpectError(dir, [
        "bundle",
        "export",
        "--output",
        ".agentpack/exports/unsafe.agentpack-bundle.json",
        "--source",
        "src/index.ts"
      ]),
      /Refusing bundle output path inside \.agentpack/
    );
    assert.match(
      runExpectError(dir, [
        "bundle",
        "export",
        "--output",
        ".git/config",
        "--source",
        "src/index.ts"
      ]),
      /Refusing bundle output path inside \.git/
    );
    assert.match(
      runExpectError(dir, [
        "bundle",
        "export",
        "--output",
        "portable.agentpack-bundle.json",
        "--source",
        "C:/absolute-on-windows.ts"
      ]),
      /Refusing absolute bundle source path/
    );

    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-outside-"));
    symlinkSync(outsideDir, path.join(dir, "bundle-output-link"), "dir");
    assert.match(
      runExpectError(dir, [
        "bundle",
        "export",
        "--output",
        "bundle-output-link/escape.agentpack-bundle.json",
        "--source",
        "src/index.ts"
      ]),
      /Refusing bundle output path through a symlink outside project root/
    );

    runGit(dir, ["remote", "set-url", "origin", "git@example.com:org/example.git?token=bad#frag"]);
    run(dir, [
      "bundle",
      "export",
      "--output",
      "scp-remote.agentpack-bundle.json",
      "--source",
      "src/index.ts"
    ]);
    const scpBundleText = readFileSync(path.join(dir, "scp-remote.agentpack-bundle.json"), "utf8");
    const scpBundle = JSON.parse(scpBundleText);
    assert.equal(scpBundle.origin.repository, "ssh://example.com/org/example.git");
    assert.equal(scpBundleText.includes("token=bad"), false);

    const mcp = createMcpHarness(dir);
    const mcpExport = await mcp.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "bundle_export",
        arguments: {
          taskId: exportedTaskId,
          outputPath: "mcp.agentpack-bundle.json",
          sources: ["src/index.ts"]
        }
      }
    });
    assert.match(mcpExport.result.content[0].text, /Exported bundle sha256:/);

    const mcpInspect = await mcp.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "bundle_inspect",
        arguments: {
          path: path.join(dir, "mcp.agentpack-bundle.json"),
          json: true
        }
      }
    });
    const mcpInspectJson = JSON.parse(mcpInspect.result.content[0].text);
    assert.equal(mcpInspectJson.counts.sources, 1);
    assert.equal(mcpInspectJson.counts.evidence, 1);

    const cliImportPlan = JSON.parse(run(dir, ["bundle", "import-plan", bundlePath, "--json"]));
    const mcpImportPlan = await mcp.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "bundle_import_plan",
        arguments: {
          path: bundlePath,
          json: true
        }
      }
    });
    const mcpImportPlanJson = JSON.parse(mcpImportPlan.result.content[0].text);
    assert.deepEqual(mcpImportPlanJson, cliImportPlan);
    assert.equal(mcpImportPlanJson.action.outcome, "conflict");
    assert.equal(mcpImportPlanJson.readOnly, true);

    run(mcpWriteDestinationDir, ["init"]);
    const mcpWrite = createMcpHarness(mcpWriteDestinationDir);
    const mcpDefaultImport = await mcpWrite.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "bundle_import",
        arguments: {
          path: bundlePath,
          json: true
        }
      }
    });
    const mcpDefaultImportJson = JSON.parse(mcpDefaultImport.result.content[0].text);
    assert.equal(mcpDefaultImportJson.readOnly, true);
    assert.equal(mcpDefaultImportJson.action.outcome, "create");
    assert.match(mcpDefaultImportJson.warnings.join("\n"), /source src\/index\.ts is missing locally/);
    assert.equal(existsSync(path.join(mcpWriteDestinationDir, ".agentpack", "tasks", exportedTaskId)), false);

    const mcpAppliedImport = await mcpWrite.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "bundle_import",
        arguments: {
          path: bundlePath,
          write: true,
          json: true
        }
      }
    });
    const mcpAppliedImportJson = JSON.parse(mcpAppliedImport.result.content[0].text);
    assert.equal(mcpAppliedImportJson.applied, true);
    assert.equal(mcpAppliedImportJson.taskId, exportedTaskId);
    assert.equal(mcpAppliedImportJson.manifest.sources[0].action, "skipped");
    assert.equal(mcpAppliedImportJson.manifest.sources[0].reason, "local source file is missing");
    assert.equal(
      existsSync(path.join(mcpWriteDestinationDir, ".agentpack", "tasks", exportedTaskId, "passport.json")),
      true
    );
    assert.equal(existsSync(path.join(mcpWriteDestinationDir, ".agentpack", "tasks", "current")), false);
  } finally {
    if (priorEnv === undefined) {
      delete process.env.AGENTPACK_BUNDLE_TOKEN;
    } else {
      process.env.AGENTPACK_BUNDLE_TOKEN = priorEnv;
    }
    if (priorDestinationEnv === undefined) {
      delete process.env.AGENTPACK_DESTINATION_BUNDLE_TOKEN;
    } else {
      process.env.AGENTPACK_DESTINATION_BUNDLE_TOKEN = priorDestinationEnv;
    }
  }
});

test("imports a bundle carrying a legacy task.roles field without migrating it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-legacy-roles-"));
  const destinationDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-bundle-legacy-roles-dest-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "index.ts"), "export const value = 1;\n", "utf8");
  runGit(dir, ["init"]);
  run(dir, ["init"]);
  run(dir, [
    "task",
    "start",
    "Legacy roles bundle",
    "--objective",
    "Confirm bundles with a legacy roles field still import.",
    "--write-scope",
    "src/index.ts",
    "--next",
    "Import elsewhere"
  ]);
  const exportedTaskId = readFileSync(path.join(dir, ".agentpack", "tasks", "current"), "utf8").trim();
  const bundlePath = path.join(dir, "legacy-roles.agentpack-bundle.json");
  run(dir, ["bundle", "export", "--task", "current", "--output", "legacy-roles.agentpack-bundle.json"]);
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  bundle.task.roles = {
    scout: { status: "done", summary: "Legacy scout summary." }
  };
  const { bundleId: _bundleId, exportedAt: _exportedAt, ...payload } = bundle;
  bundle.bundleId = `sha256:${sha256(stableStringifyForTest(payload))}`;
  writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  const inspected = JSON.parse(run(dir, ["bundle", "inspect", bundlePath, "--json"]));
  assert.equal(inspected.valid, true);

  mkdirSync(path.join(destinationDir, "src"), { recursive: true });
  writeFileSync(path.join(destinationDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
  run(destinationDir, ["init"]);

  const imported = JSON.parse(run(destinationDir, ["bundle", "import", bundlePath, "--write", "--json"]));
  assert.equal(imported.applied, true);
  const importedPassport = JSON.parse(readFileSync(
    path.join(destinationDir, ".agentpack", "tasks", exportedTaskId, "passport.json"),
    "utf8"
  ));
  assert.equal(importedPassport.roles, undefined);
});

test("rolls back a pack transaction after a mid-install failure", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-transaction-rollback-"));
  run(dir, ["init"]);
  const statePath = path.join(dir, ".agentpack", "state.json");
  const stateBefore = readFileSync(statePath, "utf8");

  assert.throws(() => writePackTransaction(dir, [
    {
      relativePath: path.join("transaction-test", "first"),
      content: "first installed file",
      mode: "create"
    },
    {
      relativePath: path.join("transaction-test", "first", "second"),
      content: "must fail because its parent was installed as a file",
      mode: "create"
    },
    {
      relativePath: "state.json",
      content: `${JSON.stringify({ replaced: true })}\n`,
      mode: "replace"
    }
  ]), /ENOTDIR|not a directory/);

  assert.equal(readFileSync(statePath, "utf8"), stateBefore);
  assert.equal(existsSync(path.join(dir, ".agentpack", "transaction-test")), false);
  assert.equal(
    readdirSync(path.join(dir, ".agentpack", "cache")).some((name) => name.startsWith(".transaction-")),
    false
  );
});

test("init appends to existing gitignore without overwriting project rules", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-gitignore-test-"));
  const gitignorePath = path.join(dir, ".gitignore");
  const existingGitignore = [
    "# Project rules",
    "dist/",
    "*.log"
  ].join("\n");
  writeFileSync(gitignorePath, existingGitignore, "utf8");

  run(dir, ["init"]);
  const expectedGitignore = [
    existingGitignore,
    ".agentpack/",
    ".codex",
    ".claude",
    ".cursor",
    ".mcp.json",
    "AGENTS.md",
    "CLAUDE.md",
    ""
  ].join("\n");
  assert.equal(readFileSync(gitignorePath, "utf8"), expectedGitignore);

  run(dir, ["init"]);
  assert.equal(readFileSync(gitignorePath, "utf8"), expectedGitignore);
});

test("doctor warns about local-only ignore gaps and generic project MCP names", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "example-app-doctor-test-"));
  run(dir, ["init"]);
  writeFileSync(path.join(dir, ".gitignore"), ".agentpack/\n", "utf8");
  writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: {
      agentpack: {
        type: "stdio",
        command: "agentpack",
        args: ["mcp"]
      }
    }
  }, null, 2), "utf8");
  mkdirSync(path.join(dir, ".cursor"), { recursive: true });
  writeFileSync(path.join(dir, ".cursor", "mcp.json"), JSON.stringify({
    mcpServers: {
      [expectedMcpServerName(dir)]: {
        type: "stdio",
        command: "agentpack",
        args: ["mcp", "--root", "${workspaceFolder}"]
      }
    }
  }, null, 2), "utf8");

  const doctor = run(dir, ["doctor"]);
  assert.match(doctor, /\[warn\] Local ignores: .*\.mcp\.json/);
  assert.match(doctor, /\[warn\] Project MCP: generic server key "agentpack" can collide across repos/);
  assert.match(doctor, /\[warn\] Cursor MCP: .*Cursor GUI may not inherit your shell PATH/);
});

test("doctor warns about stale project roots and overwritten Claude Desktop config", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "get-cluster-doctor-test-"));
  const staleRoot = mkdtempSync(path.join(os.tmpdir(), "stale-agentpack-root-"));
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "agentpack-home-test-"));
  mkdirSync(path.join(fakeHome, "Library", "Application Support", "Claude"), { recursive: true });

  run(dir, ["init"]);
  writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "agentpack-get-cluster-doctor-test": {
        type: "stdio",
        command: "agentpack",
        args: ["mcp", "--root", staleRoot]
      }
    }
  }, null, 2), "utf8");
  writeFileSync(
    path.join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    JSON.stringify({ preferences: { coworkWebSearchEnabled: true } }, null, 2),
    "utf8"
  );

  const originalHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    const doctor = buildDoctorReport(dir).text;
    assert.match(doctor, /\[warn\] Project MCP: .*stale --root/);
    assert.match(doctor, /\[warn\] Claude Desktop: config has no mcpServers/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("doctor warns about legacy Claude Desktop launchers and missing entrypoints", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-desktop-doctor-test-"));
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "agentpack-home-test-"));
  const missingEntrypoint = path.join(dir, "missing-agentpack.js");
  mkdirSync(path.join(fakeHome, "Library", "Application Support", "Claude"), { recursive: true });

  run(dir, ["init"]);
  writeFileSync(
    path.join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    JSON.stringify({
      mcpServers: {
        "agentpack-legacy": {
          command: "agentpack",
          args: ["mcp", "--root", realpathSync(dir)],
          env: {
            AGENTPACK_ROOT: realpathSync(dir)
          }
        },
        "agentpack-missing": {
          command: process.execPath,
          args: [missingEntrypoint, "mcp", "--root", realpathSync(dir)],
          env: {
            AGENTPACK_ROOT: realpathSync(dir)
          }
        }
      }
    }, null, 2),
    "utf8"
  );

  const originalHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    const doctor = buildDoctorReport(dir).text;
    assert.match(doctor, /\[warn\] Claude Desktop: .*uses command "agentpack"/);
    assert.match(doctor, /Claude Desktop may not inherit your shell PATH/);
    assert.match(doctor, /Agentpack entrypoint does not exist/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("doctor names the Claude Desktop server key for the current repo", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-desktop-current-test-"));
  const otherRoot = mkdtempSync(path.join(os.tmpdir(), "agentpack-other-root-"));
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "agentpack-home-test-"));
  const serverName = expectedMcpServerName(dir);
  mkdirSync(path.join(fakeHome, "Library", "Application Support", "Claude"), { recursive: true });

  run(dir, ["init"]);
  writeFileSync(
    path.join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    JSON.stringify({
      mcpServers: {
        [serverName]: {
          command: process.execPath,
          args: [cli, "mcp", "--root", realpathSync(dir)],
          env: {
            AGENTPACK_ROOT: realpathSync(dir)
          }
        },
        "agentpack-other": {
          command: process.execPath,
          args: [cli, "mcp", "--root", otherRoot],
          env: {
            AGENTPACK_ROOT: otherRoot
          }
        }
      }
    }, null, 2),
    "utf8"
  );

  const originalHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    const doctor = buildDoctorReport(dir).text;
    assert.match(doctor, new RegExp(`\\[ok\\] Claude Desktop: server key "${serverName}" points at this pack root`));
    assert.match(doctor, /also has other Agentpack servers/);
    assert.match(doctor, /use the repo-specific server\/tool group/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("doctor clarifies when Claude Desktop points only at other repos", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-desktop-other-repo-test-"));
  const otherRoot = mkdtempSync(path.join(os.tmpdir(), "agentpack-other-root-"));
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "agentpack-home-test-"));
  mkdirSync(path.join(fakeHome, "Library", "Application Support", "Claude"), { recursive: true });

  run(dir, ["init"]);
  writeFileSync(
    path.join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    JSON.stringify({
      mcpServers: {
        "agentpack-other": {
          command: process.execPath,
          args: [cli, "mcp", "--root", otherRoot],
          env: {
            AGENTPACK_ROOT: otherRoot
          }
        }
      }
    }, null, 2),
    "utf8"
  );

  const originalHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    const doctor = buildDoctorReport(dir).text;
    assert.match(doctor, /\[warn\] Claude Desktop: no Claude Desktop Agentpack server points at this repo/);
    assert.match(doctor, /only fix this if you expect Claude Desktop to use this repo/);
    assert.match(doctor, /Existing Agentpack Desktop roots: agentpack-other=/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("mcp root resolution prefers --root, then AGENTPACK_ROOT, then cwd", () => {
  const originalRoot = process.env.AGENTPACK_ROOT;

  try {
    process.env.AGENTPACK_ROOT = "/env/repo";
    assert.equal(resolveMcpStartDir({ root: "/flag/repo" }, "/cwd/repo"), "/flag/repo");
    assert.equal(resolveMcpStartDir({}, "/cwd/repo"), "/env/repo");

    delete process.env.AGENTPACK_ROOT;
    assert.equal(resolveMcpStartDir({}, "/cwd/repo"), "/cwd/repo");
  } finally {
    if (originalRoot === undefined) {
      delete process.env.AGENTPACK_ROOT;
    } else {
      process.env.AGENTPACK_ROOT = originalRoot;
    }
  }
});

test("distinguishes source-cache status from git working tree status", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-source-git-test-"));
  writeFileSync(path.join(dir, "index.js"), "console.log('initial')\n", "utf8");

  runGit(dir, ["init"]);
  run(dir, ["init"]);
  runGit(dir, ["add", "index.js", ".gitignore"]);
  runGit(dir, [
    "-c",
    "user.name=Agentpack Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial"
  ]);

  writeFileSync(path.join(dir, "index.js"), "console.log('changed but recorded')\n", "utf8");
  writeFileSync(path.join(dir, "other.js"), "console.log('unrecorded')\n", "utf8");
  run(dir, ["source", "add", "index.js", "--summary", "Current changed version was inspected."]);

  const status = run(dir, ["source", "status"]);
  assert.match(status, /Agentpack source status tracks recorded source conclusions, not the full git working tree/);
  assert.match(status, /UNCHANGED index\.js/);
  assert.match(status, /hash: matches recorded hash/);
  assert.match(status, /git: modified/);
  assert.match(status, /Git changes not recorded as Agentpack sources/);
  assert.match(status, /untracked other\.js/);
});

test("loads full git diff only when requested and preserves checkpoint patches", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-git-diff-test-"));
  writeFileSync(path.join(dir, "tracked.txt"), "committed\n", "utf8");
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "agentpack@example.com"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["add", "tracked.txt"]);
  commit(dir, "initial");
  run(dir, ["init"]);

  writeFileSync(path.join(dir, "tracked.txt"), "committed\nworking tree marker\n", "utf8");

  const summaryOnly = getGitInfo(dir);
  assert.equal(summaryOnly.diff, "");
  assert.match(summaryOnly.diffStat || "", /1 file changed/);
  assert.match(buildResume(dir).markdown, /Current diff: 1 file changed, 1 insertion/);

  const withDiff = getGitInfo(dir, { includeDiff: true });
  assert.match(withDiff.diff, /working tree marker/);

  run(dir, ["checkpoint", "-m", "Capture working tree patch."]);
  const checkpoints = readdirSync(path.join(dir, ".agentpack", "checkpoints")).sort();
  const latest = checkpoints[checkpoints.length - 1];
  assert.ok(latest);
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "checkpoints", latest, "diff.patch"), "utf8"),
    /working tree marker/
  );
});

test("removes explicit and missing source records", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-source-prune-test-"));
  writeFileSync(path.join(dir, "active.js"), "console.log('active')\n", "utf8");
  writeFileSync(path.join(dir, "stale.js"), "console.log('stale')\n", "utf8");

  run(dir, ["init"]);
  run(dir, ["source", "add", "active.js", "--summary", "Active file was inspected."]);
  run(dir, ["source", "add", "stale.js", "--summary", "Soon-to-be deleted file was inspected."]);
  unlinkSync(path.join(dir, "stale.js"));

  const staleStatus = run(dir, ["source", "status"]);
  assert.match(staleStatus, /UNCHANGED active\.js/);
  assert.match(staleStatus, /MISSING stale\.js/);

  const doctor = run(dir, ["doctor"]);
  assert.match(doctor, /\[warn\] Sources: 2 recorded, 0 changed, 1 missing; run `agentpack source status --changed --missing` for details/);

  const prune = run(dir, ["source", "prune", "--missing"]);
  assert.match(prune, /Pruned 1 missing source record/);
  assert.match(prune, /- stale\.js/);

  const prunedStatus = run(dir, ["source", "status"]);
  assert.match(prunedStatus, /UNCHANGED active\.js/);
  assert.doesNotMatch(prunedStatus, /stale\.js/);

  const remove = run(dir, ["source", "remove", "active.js"]);
  assert.match(remove, /Removed source active\.js/);

  const sourceDb = JSON.parse(readFileSync(path.join(dir, ".agentpack", "sources.json"), "utf8"));
  assert.deepEqual(sourceDb.sources, []);

  const events = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; path?: string; count?: number });
  assert.equal(events.some((event) => event.type === "source-prune" && event.count === 1), true);
  assert.equal(events.some((event) => event.type === "source-remove" && event.path === "active.js"), true);
});

test("release preflight is read-only and checks release prep basics", async () => {
  const noPackDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-nopack-"));
  const noPack = runExpectFailureOutput(noPackDir, ["release", "preflight"]);
  assert.match(noPack, /Agentpack release preflight/);
  assert.match(noPack, /\[fail\] Pack: No \.agentpack directory found/);
  assert.match(noPack, /Result: fix failed checks before release prep/);

  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-test-"));
  writeReleaseFixture(dir);
  runGit(dir, ["init"]);
  run(dir, ["init"]);
  runGit(dir, ["add", ".gitignore", ".github", "docs", "package.json", "package-lock.json"]);
  runGit(dir, [
    "-c",
    "user.name=Agentpack Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial"
  ]);
  runGit(dir, ["branch", "-M", "main"]);
  addReleaseRemote(dir);

  const preflight = run(dir, ["release", "preflight"]);
  assert.match(preflight, /Agentpack release preflight/);
  assert.match(preflight, /\[ok\] package\.json: agentpack-cli@1\.2\.3/);
  assert.match(preflight, /\[ok\] package-lock\.json: version matches 1\.2\.3/);
  assert.match(preflight, /\[ok\] Git: main @ [0-9a-f]+, in sync with origin\/main/);
  assert.match(preflight, /\[ok\] Publish workflow: Trusted Publisher release workflow is present/);
  assert.match(preflight, /\[ok\] Release docs: weekly cadence and pre-flight checklist are documented/);
  assert.match(preflight, /Release actions are intentionally manual/);
  assert.match(preflight, /Result: ready for release-prep checks/);

  const mcp = createMcpHarness(dir);
  const releasePreflight = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "release_preflight",
      arguments: {}
    }
  });
  assert.match(releasePreflight.result.content[0].text, /Agentpack release preflight/);
  assert.match(releasePreflight.result.content[0].text, /Release actions are intentionally manual/);
});

test("release preflight blocks upstream drift and token-based npm auth", () => {
  const aheadDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-ahead-test-"));
  writeReleaseFixture(aheadDir);
  initializeReleaseRepo(aheadDir);
  writeFileSync(path.join(aheadDir, "README.md"), "# Local change\n", "utf8");
  runGit(aheadDir, ["add", "README.md"]);
  commit(aheadDir, "local change");

  const ahead = runExpectFailureOutput(aheadDir, ["release", "preflight"]);
  assert.match(ahead, /\[fail\] Git: main is ahead of origin\/main by 1 commit\(s\); push reviewed commits before release prep/);
  assert.match(ahead, /Result: fix failed checks before release prep/);

  const behindDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-behind-test-"));
  writeReleaseFixture(behindDir);
  const remote = initializeReleaseRepo(behindDir);
  const cloneDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-upstream-clone-"));
  runGit(os.tmpdir(), ["clone", "--branch", "main", remote, cloneDir]);
  runGit(cloneDir, ["config", "user.name", "Agentpack Test"]);
  runGit(cloneDir, ["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(cloneDir, "README.md"), "# Remote change\n", "utf8");
  runGit(cloneDir, ["add", "README.md"]);
  commit(cloneDir, "remote change");
  runGit(cloneDir, ["push", "origin", "main"]);
  runGit(behindDir, ["fetch", "origin"]);

  const behind = runExpectFailureOutput(behindDir, ["release", "preflight"]);
  assert.match(behind, /\[fail\] Git: main is behind origin\/main by 1 commit\(s\); update main before release prep/);

  const tokenDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-token-test-"));
  writeReleaseFixture(tokenDir, [
    "name: Publish to npm",
    "on:",
    "  release:",
    "    types: [published]",
    "permissions:",
    "  contents: read",
    "  id-token: write",
    "jobs:",
    "  publish:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm publish --access public",
    "        env:",
    "          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
    ""
  ].join("\n"));
  initializeReleaseRepo(tokenDir);

  const token = runExpectFailureOutput(tokenDir, ["release", "preflight"]);
  assert.match(token, /\[fail\] Publish workflow: must not reference NPM_TOKEN or NODE_AUTH_TOKEN when using Trusted Publisher/);
});

test("resume surfaces upstream drift and local commits before optional ledger sections", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-resume-git-test-"));
  writeReleaseFixture(dir);
  initializeReleaseRepo(dir);
  run(dir, ["set", "goal", "Keep release train context visible."]);
  run(dir, [
    "task",
    "start",
    "Prepare next release batch",
    "--objective",
    "Carry local commits as next-release candidates until the weekly batch.",
    "--write-scope",
    "README.md",
    "--next",
    "Review local commits before release prep"
  ]);
  writeFileSync(path.join(dir, "README.md"), "# Local release candidate\n", "utf8");
  runGit(dir, ["add", "README.md"]);
  commit(dir, "local release candidate");

  run(dir, [
    "record",
    "decision",
    "Use weekly batch release cadence; local commits remain next-release candidates until Thursday release prep."
  ]);
  run(dir, [
    "task",
    "verify",
    "--status",
    "passed",
    "--summary",
    "Context handoff checks passed."
  ]);

  for (let index = 0; index < 10; index += 1) {
    run(dir, ["record", "decision", `Release decision ${index} should be optional under a tight budget.`]);
  }

  const resume = run(dir, ["resume", "--budget", "520", "--query", "release cadence local commits verification"]);
  assert.ok(estimatedTokensFromResume(resume) <= 520);
  assert.match(resume, /Upstream: origin\/main \(1 ahead, 0 behind\)/);
  assert.match(resume, /Local commits ahead of upstream:\n  - [0-9a-f]+ local release candidate/);
  assert.match(resume, /Relevant Context/);
  assert.match(resume, /Use weekly batch release cadence; local commits remain next-release candidates until Thursday release prep/);
  assert.match(resume, /Verification: passed - Context handoff checks passed\./);
  assert.match(resume, /Review local commits before release prep/);
  assert.match(resume, /Budget status: limited/);
  assert.match(resume, /omitted .*Decisions.*Recent Timeline/);
});

test("preserves query-relevant source context just above the compact context budget", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-resume-mid-budget-test-"));
  run(dir, ["init"]);

  for (let index = 0; index < 20; index += 1) {
    const fileName = `source-${index}.js`;
    writeFileSync(path.join(dir, fileName), `console.log(${index})\n`, "utf8");
    run(dir, [
      "source",
      "add",
      fileName,
      "--summary",
      index === 0
        ? "Needle context must survive the mid-budget transition."
        : `Unrelated source summary ${index} expands the filtered Source Cache.`
    ]);
  }

  const resume = run(dir, ["resume", "--budget", "1201", "--query", "needle context"]);
  assert.ok(estimatedTokensFromResume(resume) <= 1201);
  assert.doesNotMatch(resume, /## Relevant Context/);
  assert.match(resume, /## Source Cache/);
  assert.match(resume, /Needle context must survive the mid-budget transition/);
});

test("requires semantic review to refresh changed source records", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-source-review-test-"));
  writeFileSync(path.join(dir, "reviewed.js"), "console.log('reviewed v1')\n", "utf8");

  run(dir, ["init"]);
  run(dir, ["source", "add", "reviewed.js", "--summary", "Reviewed v1 behavior."]);
  writeFileSync(path.join(dir, "reviewed.js"), "console.log('reviewed v2')\n", "utf8");

  const changedStatus = run(dir, ["source", "status", "--changed"]);
  assert.match(changedStatus, /CHANGED reviewed\.js/);
  assert.doesNotMatch(changedStatus, /UNCHANGED reviewed\.js/);

  const missingStatus = run(dir, ["source", "status", "--missing"]);
  assert.match(missingStatus, /No missing source records/);

  assert.match(
    runExpectError(dir, ["source", "add", "reviewed.js", "--summary", "Blindly update hash."]),
    /use `agentpack source review reviewed\.js --summary <text>` after semantic review/
  );

  const stillChanged = run(dir, ["source", "status", "--changed"]);
  assert.match(stillChanged, /CHANGED reviewed\.js/);

  assert.match(
    runExpectError(dir, ["source", "review", "reviewed.js"]),
    /source review requires --summary <text>/
  );

  const review = run(dir, ["source", "review", "reviewed.js", "--summary", "Reviewed v2 behavior."]);
  assert.match(review, /Reviewed source reviewed\.js/);

  const noChanged = run(dir, ["source", "status", "--changed"]);
  assert.match(noChanged, /No changed source records/);

  const refreshedStatus = run(dir, ["source", "status"]);
  assert.match(refreshedStatus, /UNCHANGED reviewed\.js/);
  assert.match(refreshedStatus, /summary: Reviewed v2 behavior\./);

  const changedJson = JSON.parse(run(dir, ["source", "status", "--changed", "--json"])) as unknown[];
  assert.deepEqual(changedJson, []);

  const events = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; path?: string });
  assert.equal(events.some((event) => event.type === "source-review" && event.path === "reviewed.js"), true);
});

test("filters MCP source_status to changed and missing records", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-mcp-source-status-test-"));
  writeFileSync(path.join(dir, "active.js"), "console.log('active')\n", "utf8");
  writeFileSync(path.join(dir, "changed.js"), "console.log('changed v1')\n", "utf8");
  writeFileSync(path.join(dir, "missing.js"), "console.log('missing')\n", "utf8");

  run(dir, ["init"]);
  run(dir, ["source", "add", "active.js", "--summary", "Active source was inspected."]);
  run(dir, ["source", "add", "changed.js", "--summary", "Changed source was inspected."]);
  run(dir, ["source", "add", "missing.js", "--summary", "Missing source was inspected."]);
  writeFileSync(path.join(dir, "changed.js"), "console.log('changed v2')\n", "utf8");
  unlinkSync(path.join(dir, "missing.js"));

  const mcp = createMcpHarness(dir);
  const tools = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  });
  const sourceStatusTool = tools.result.tools.find((tool: { name: string }) => tool.name === "source_status");
  assert.ok(sourceStatusTool);
  assert.ok(sourceStatusTool.inputSchema.properties.changed);
  assert.ok(sourceStatusTool.inputSchema.properties.missing);

  const changed = await mcp.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "source_status",
      arguments: {
        changed: true
      }
    }
  });
  assert.match(changed.result.content[0].text, /CHANGED changed\.js/);
  assert.doesNotMatch(changed.result.content[0].text, /UNCHANGED active\.js/);
  assert.doesNotMatch(changed.result.content[0].text, /MISSING missing\.js/);

  const stale = await mcp.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "source_status",
      arguments: {
        changed: true,
        missing: true
      }
    }
  });
  assert.match(stale.result.content[0].text, /CHANGED changed\.js/);
  assert.match(stale.result.content[0].text, /MISSING missing\.js/);
  assert.doesNotMatch(stale.result.content[0].text, /UNCHANGED active\.js/);

  const missingJson = await mcp.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "source_status",
      arguments: {
        missing: true,
        json: true
      }
    }
  });
  const parsed = JSON.parse(missingJson.result.content[0].text) as Array<{ path: string; status: string }>;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.path, "missing.js");
  assert.equal(parsed[0]?.status, "missing");
});

test("tolerates a legacy roles field in passport.json without migrating it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-task-legacy-roles-test-"));
  runGit(dir, ["init"]);
  run(dir, ["init"]);
  run(dir, [
    "task",
    "start",
    "Legacy roles passport",
    "--objective",
    "Confirm a legacy roles field does not break passport reads.",
    "--next",
    "Confirm task status still works"
  ]);
  const taskId = readFileSync(path.join(dir, ".agentpack", "tasks", "current"), "utf8").trim();
  const passportPath = path.join(dir, ".agentpack", "tasks", taskId, "passport.json");
  const legacyPassport = JSON.parse(readFileSync(passportPath, "utf8"));
  legacyPassport.roles = {
    scout: { status: "done", summary: "Legacy scout summary." }
  };
  writeFileSync(passportPath, `${JSON.stringify(legacyPassport, null, 2)}\n`, "utf8");

  const status = run(dir, ["task", "status"]);
  assert.match(status, /Legacy roles passport \[active\]/);
  assert.doesNotMatch(status, /Roles:/);

  const passportJson = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(passportJson.roles, undefined);

  run(dir, ["task", "update", "--next", "Confirm the field is dropped on write"]);
  const rewrittenPassport = JSON.parse(readFileSync(passportPath, "utf8"));
  assert.equal(rewrittenPassport.roles, undefined);
});

test("manages a current task passport", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-task-test-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "index.ts"), "export const value = 1;\n", "utf8");

  runGit(dir, ["init"]);
  runGit(dir, ["add", "src/index.ts"]);
  runGit(dir, [
    "-c",
    "user.name=Agentpack Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial"
  ]);

  run(dir, ["init"]);
  const started = run(dir, [
    "task",
    "start",
    "Add task passports",
    "--objective",
    "Model current task handoff state.",
    "--constraint",
    "Keep v0 state readable.",
    "--write-scope",
    "src/index.ts",
    "--next",
    "Wire CLI",
    "--tag",
    "task-passport",
    "--risk",
    "low"
  ]);
  assert.match(started, /Started task task_/);
  assert.match(
    runExpectError(dir, ["task", "start", "Overlapping task", "--write-scope", "src/index.ts"]),
    /Current task .* is active; park or close it before starting a new task\./
  );
  assert.match(runExpectError(dir, [
    "task",
    "start",
    "Invalid risk task",
    "--risk",
    "urgent"
  ]), /Unknown task risk: urgent/);

  const taskId = readFileSync(path.join(dir, ".agentpack", "tasks", "current"), "utf8").trim();
  const passportPath = path.join(dir, ".agentpack", "tasks", taskId, "passport.json");
  const passport = JSON.parse(readFileSync(passportPath, "utf8"));
  assert.equal(passport.title, "Add task passports");
  assert.equal(passport.objective, "Model current task handoff state.");
  assert.equal(passport.status, "active");
  assert.deepEqual(passport.constraints, ["Keep v0 state readable."]);
  assert.deepEqual(passport.writeScope, ["src/index.ts"]);
  assert.deepEqual(passport.nextActions, ["Wire CLI"]);
  assert.deepEqual(passport.tags, ["task-passport"]);
  assert.equal(passport.risk, "low");
  assert.equal(passport.worktree, realpathSync(dir));
  assert.equal(existsSync(path.join(dir, ".agentpack", "tasks", taskId, "events.jsonl")), true);

  const list = run(dir, ["task", "list"]);
  assert.match(list, new RegExp(`\\* ${taskId} \\[active\\] Add task passports`));

  const status = run(dir, ["task", "status"]);
  assert.match(status, /Task status/);
  assert.match(status, /Add task passports \[active\]/);
  assert.match(status, new RegExp(`ID: ${taskId}`));
  assert.match(status, /Risk: low/);
  assert.match(status, /Verification: unknown/);
  assert.match(status, /Next: Wire CLI/);
  assert.match(status, /Write scope: src\/index\.ts/);
  assert.match(status, /Drift: none/);

  const handoff = run(dir, ["task", "handoff"]);
  assert.match(handoff, /Task handoff/);
  assert.match(handoff, /Add task passports \[active\]/);
  assert.match(handoff, /Objective: Model current task handoff state\./);
  assert.match(handoff, /Constraints:\n- Keep v0 state readable\./);
  assert.match(handoff, /Write scope:\n- src\/index\.ts/);
  assert.match(handoff, /Next actions:\n- Wire CLI/);
  assert.match(handoff, /Audit: Verification is unknown/);

  const currentPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(currentPassport.id, taskId);

  const resume = run(dir, ["resume", "--preset", "agent"]);
  assert.match(resume, /## Current Task Passport/);
  const currentState = resume.split("## Git State")[0] || "";
  assert.match(currentState, /Status: active \(current Task Passport\)/);
  assert.match(currentState, /Task next actions:\n- Wire CLI/);
  assert.doesNotMatch(currentState, /Status: Initialized Agentpack/);
  assert.match(resume, new RegExp(`ID: ${taskId}`));
  assert.match(resume, /Title: Add task passports/);
  assert.match(resume, /Objective: Model current task handoff state\./);
  assert.match(resume, /Keep v0 state readable\./);
  assert.match(resume, /Write scope:\n  - src\/index\.ts/);
  assert.match(resume, /Task next actions:\n  - Wire CLI/);
  assert.match(resume, /Drift: none detected/);

  const initialAudit = run(dir, ["task", "audit"]);
  assert.match(initialAudit, /Task audit/);
  assert.match(initialAudit, new RegExp(`Current task: ${taskId} \\[active\\] Add task passports`));
  assert.match(initialAudit, /Verification is unknown/);
  assert.match(initialAudit, /Metadata/);
  assert.match(initialAudit, /No changed or missing recorded source conclusions/);

  assert.match(run(dir, [
    "task",
    "update",
    "--objective",
    "Model current task handoff state and update it after start.",
    "--constraint",
    "Keep task updates additive.",
    "--write-scope",
    ".",
    "--next",
    "Document task update flow",
    "--tag",
    "task-update",
    "--risk",
    "medium"
  ]), /Updated task .*/);
  const updated = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(updated.objective, "Model current task handoff state and update it after start.");
  assert.deepEqual(updated.constraints, ["Keep v0 state readable.", "Keep task updates additive."]);
  assert.deepEqual(updated.writeScope, ["src/index.ts", "."]);
  assert.deepEqual(updated.nextActions, ["Wire CLI", "Document task update flow"]);
  assert.deepEqual(updated.tags, ["task-passport", "task-update"]);
  assert.equal(updated.risk, "medium");
  assert.match(runExpectError(dir, ["task", "update"]), /task update requires at least one non-empty field/);
  assert.match(runExpectError(dir, ["task", "update", "--next", "Document task update flow"]), /task update did not change the current task/);
  assert.match(runExpectError(dir, ["task", "update", "--objective", ""]), /task update requires at least one non-empty field/);
  assert.match(runExpectError(dir, ["task", "update", "--risk", "urgent"]), /Unknown task risk: urgent/);

  assert.match(run(dir, ["task", "update", "--clear-next-actions", "--next", "Hand off for review"]), /Updated task .*/);
  assert.deepEqual(
    JSON.parse(run(dir, ["task", "passport"])).nextActions,
    ["Hand off for review"],
    "--clear-next-actions replaces the next actions instead of appending"
  );
  assert.match(run(dir, ["task", "update", "--clear-next-actions"]), /Updated task .*/);
  assert.deepEqual(JSON.parse(run(dir, ["task", "passport"])).nextActions, []);
  assert.match(runExpectError(dir, ["task", "update", "--clear-next-actions"]), /task update did not change the current task/);
  assert.match(run(dir, ["task", "update", "--clear-next-actions", "--next", "Wire CLI", "--next", "Document task update flow"]), /Updated task .*/);
  assert.deepEqual(JSON.parse(run(dir, ["task", "passport"])).nextActions, ["Wire CLI", "Document task update flow"]);

  run(dir, ["source", "add", "src/index.ts", "--summary", "Task passport fixture source."]);
  writeFileSync(path.join(dir, "src", "index.ts"), "export const value = 2;\n", "utf8");
  const staleAudit = run(dir, ["task", "audit"]);
  assert.match(staleAudit, /Source cache metadata has 1 changed or missing record\(s\): src\/index\.ts/);
  assert.match(staleAudit, /Refresh only records whose durable conclusions changed/);

  assert.match(run(dir, ["task", "block", "--reason", "Waiting for review"]), /Blocked task/);
  const blocked = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockedReason, "Waiting for review");

  assert.match(run(dir, ["task", "update-verification"]), /Updated verification for task .* \(pending\)/);
  const pendingAfterBlocked = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(pendingAfterBlocked.status, "active", "a non-final verdict returns the lifecycle to active, resolving the block");
  assert.equal(pendingAfterBlocked.verification.status, "pending");
  assert.equal(pendingAfterBlocked.blockedReason, undefined, "a verify-driven unblock clears the stale blockedReason");
  assert.match(runExpectError(dir, ["task", "finalize"]), /task finalize requires verification status passed, failed, or accepted/);

  assert.match(run(dir, [
    "task",
    "verify",
    "--status",
    "passed",
    "--evidence",
    "evt_task_test",
    "--summary",
    "Focused task passport checks passed."
  ]), /Updated verification for task .* \(passed\)/);
  const passed = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(passed.verification.status, "passed");
  assert.deepEqual(passed.verification.evidence, ["evt_task_test"]);
  assert.equal(passed.verification.summary, "Focused task passport checks passed.");
  const eventCountBeforeNoop = taskEventCount(dir, passed.id);
  assert.match(run(dir, [
    "task",
    "verify",
    "--status",
    "passed",
    "--evidence",
    "evt_task_test",
    "--summary",
    "Focused task passport checks passed."
  ]), /Verification unchanged for task .* \(passed\)/);
  assert.equal(taskEventCount(dir, passed.id), eventCountBeforeNoop);
  assert.doesNotMatch(run(dir, ["task", "audit"]), /Verification is/);
  const verifiedHandoff = run(dir, ["task", "handoff"]);
  assert.match(verifiedHandoff, /Verification: passed - Focused task passport checks passed\./);
  assert.match(verifiedHandoff, /Evidence: evt_task_test/);
  assert.match(verifiedHandoff, /Audit: No action-required task warnings\./);

  assert.match(run(dir, ["task", "finalize"]), /Finalized task .* \(passed\)/);
  const closed = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(closed.status, "completed");
  assert.equal(closed.verification.status, "passed");
  assert.equal(typeof closed.closedAt, "string");
  const closedResume = run(dir, ["resume", "--preset", "agent"]);
  const closedCurrentState = closedResume.split("## Git State")[0] || "";
  assert.match(closedCurrentState, /Status: completed \(current Task Passport\)/);
  assert.match(closedCurrentState, /Task next actions \(historical; task is closed\):\n- Wire CLI/);
  assert.match(closedResume, /Status: completed/);
  assert.match(closedResume, /Task next actions \(historical; task is closed\):\n  - Wire CLI/);
  assert.match(runExpectError(dir, ["task", "block", "--reason", "Too late"]), /Cannot update closed task/);

  assert.match(run(dir, ["task", "start", "Repo-wide follow-up", "--write-scope", "."]), /Started task task_/);
  const repoWide = JSON.parse(run(dir, ["task", "passport"]));
  assert.deepEqual(repoWide.writeScope, ["."]);
  assert.doesNotMatch(run(dir, ["task", "audit"]), /Task has no write scope/);

  assert.match(run(dir, ["task", "close"]), /Closed task/);
  assert.match(run(dir, ["task", "start", "Finalize direct", "--write-scope", ".", "--next", "Resume later"]), /Started task task_/);
  assert.match(runExpectError(dir, [
    "task",
    "finalize",
    "--status",
    "accepted",
    "--summary",
    "Small docs task accepted."
  ]), /Use `agentpack task park` for deferred work/);
  assert.match(run(dir, [
    "task",
    "finalize",
    "--status",
    "accepted",
    "--summary",
    "Small docs task accepted.",
    "--force"
  ]), /Finalized task .* \(accepted\)/);
  const finalized = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(finalized.status, "completed");
  assert.equal(finalized.verification.status, "accepted");
  assert.equal(finalized.verification.summary, "Small docs task accepted.");
  assert.match(runExpectError(dir, [
    "task",
    "start",
    "Invalid risk task",
    "--risk",
    "urgent"
  ]), /Unknown task risk: urgent/);
});

test("task status reports missing current passport without requiring audit", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-task-status-test-"));
  run(dir, ["init"]);

  const status = run(dir, ["task", "status"]);
  assert.match(status, /Task status/);
  assert.match(status, /No current task passport/);
});

test("redacts secrets from stored context and handoff outputs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-redaction-test-"));
  const secret = "agentpack-secret-value-12345";
  const priorEnv = process.env.AGENTPACK_TEST_TOKEN;
  process.env.AGENTPACK_TEST_TOKEN = secret;

  try {
    writeFileSync(path.join(dir, "index.js"), "console.log('redaction')\n", "utf8");
    run(dir, ["init"]);

    const configPath = path.join(dir, ".agentpack", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.redactions = [...config.redactions, "AGENTPACK_TEST_TOKEN"];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    run(dir, ["set", "goal", `Investigate ${secret}`]);
    run(dir, ["record", "decision", `Use api_key=${secret} and password=hunter2 for testing only.`]);
    run(dir, [
      "source",
      "add",
      "index.js",
      "--summary",
      `Read source that mentioned ${secret}.`,
      "--snippet",
      `token=${secret}`
    ]);
    run(dir, ["evidence", "add", "--kind", "test-output", "--content", `OPENAI_API_KEY=${secret}\npassword=hunter2`]);
    run(dir, [
      "checkpoint",
      "-m",
      `Checkpoint with ${secret}`,
      "--status",
      `Status has token=${secret}`,
      "--next",
      `Do not leak ${secret}`
    ]);

    const resume = run(dir, ["resume", "--preset", "deep"]);
    const replay = run(dir, ["replay"]);
    const sourceStatus = run(dir, ["source", "status"]);
    const sourceStatusJson = run(dir, ["source", "status", "--json"]);
    run(dir, ["export", "--to", "chatgpt", "--preset", "deep"]);

    const packText = [
      resume,
      replay,
      sourceStatus,
      sourceStatusJson,
      readFileSync(path.join(dir, ".agentpack", "state.json"), "utf8"),
      readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8"),
      readFileSync(path.join(dir, ".agentpack", "sources.json"), "utf8"),
      readFileSync(path.join(dir, ".agentpack", "exports", "chatgpt-handoff.md"), "utf8"),
      ...readdirSync(path.join(dir, ".agentpack", "checkpoints"))
        .flatMap((checkpointId) => ["checkpoint.json", "resume.md", "diff.patch"].map((fileName) => (
          path.join(dir, ".agentpack", "checkpoints", checkpointId, fileName)
        )))
        .filter((filePath) => existsSync(filePath))
        .map((filePath) => readFileSync(filePath, "utf8")),
      ...readdirSync(path.join(dir, ".agentpack", "evidence"))
        .map((fileName) => readFileSync(path.join(dir, ".agentpack", "evidence", fileName), "utf8"))
    ].join("\n");

    assert.equal(packText.includes(secret), false);
    assert.equal(packText.includes("hunter2"), false);
    assert.match(packText, /\[REDACTED/);
  } finally {
    if (priorEnv === undefined) {
      delete process.env.AGENTPACK_TEST_TOKEN;
    } else {
      process.env.AGENTPACK_TEST_TOKEN = priorEnv;
    }
  }
});

test("keeps recent timeline compact without duplicating source summaries", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-timeline-test-"));
  run(dir, ["init"]);

  for (let index = 0; index < 12; index += 1) {
    const fileName = `source-${index}.js`;
    writeFileSync(path.join(dir, fileName), `console.log(${index})\n`, "utf8");
    run(dir, [
      "source",
      "add",
      fileName,
      "--summary",
      `Detailed source summary ${index} that belongs in Source Cache but not in Recent Timeline.`
    ]);
  }

  run(dir, ["record", "decision", "Keep timeline as a compact digest."]);
  run(dir, ["checkpoint", "-m", "Timeline compaction checkpoint."]);

  const resume = run(dir, ["resume", "--preset", "deep"]);
  const timeline = resume.split("## Recent Timeline")[1] || "";

  assert.match(timeline, /Total events:/);
  assert.match(timeline, /source: 12/);
  assert.match(timeline, /Recent source records:/);
  assert.match(timeline, /Recent non-source events:/);
  assert.match(timeline, /Full chronology: `agentpack replay`/);
  assert.doesNotMatch(timeline, /Detailed source summary/);
  assert.equal((timeline.match(/\[checkpoint\]/g) || []).length, 0);
  assert.match(resume, /Detailed source summary 11/);
});

test("filters source cache summaries by query while preserving source stubs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-source-query-test-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "src", "auth.ts"), "export const auth = true;\n", "utf8");
  writeFileSync(path.join(dir, "src", "billing.ts"), "export const billing = true;\n", "utf8");
  writeFileSync(path.join(dir, "src", "stale.ts"), "export const stale = 'v1';\n", "utf8");
  writeFileSync(path.join(dir, "docs", "setup.md"), "# Setup\n", "utf8");
  writeFileSync(path.join(dir, "docs", "obsolete.md"), "# Obsolete\n", "utf8");

  run(dir, ["init"]);
  run(dir, [
    "source",
    "add",
    "src/auth.ts",
    "--summary",
    "Authentication middleware validates sessions and refresh tokens."
  ]);
  run(dir, [
    "source",
    "add",
    "src/billing.ts",
    "--summary",
    "Billing worker calculates invoices and payment retries."
  ]);
  run(dir, [
    "source",
    "add",
    "docs/setup.md",
    "--summary",
    "Developer setup docs for local MCP install."
  ]);
  run(dir, [
    "source",
    "add",
    "src/stale.ts",
    "--summary",
    "Stale source used to export a v1 marker."
  ]);
  run(dir, [
    "source",
    "add",
    "docs/obsolete.md",
    "--summary",
    "Obsolete docs described a removed setup note."
  ]);
  writeFileSync(path.join(dir, "src", "stale.ts"), "export const stale = 'v2';\n", "utf8");
  unlinkSync(path.join(dir, "docs", "obsolete.md"));

  const filtered = run(dir, ["resume", "--preset", "deep", "--query", "auth session"]);
  assert.match(filtered, /Query filter: full summaries for 1 query-relevant source\(s\), compact stubs for 4 query-unrelated source\(s\)/);
  assert.match(filtered, /Query-unrelated stale stubs: 2 changed\/missing/);
  assert.match(filtered, /src\/auth\.ts/);
  assert.match(filtered, /Authentication middleware validates sessions/);
  assert.match(filtered, /src\/billing\.ts/);
  assert.match(filtered, /docs\/setup\.md/);
  assert.match(filtered, /src\/stale\.ts/);
  assert.match(filtered, /docs\/obsolete\.md/);
  assert.match(filtered, /status: unchanged; topic: Billing worker calculates invoices/);
  assert.match(filtered, /status: unchanged; topic: Developer setup docs/);
  assert.match(filtered, /status: changed; topic: Stale source used to export a v1 marker\. \(recorded\); guidance: call `source_status` before relying/);
  assert.match(filtered, /status: missing; topic: Obsolete docs described a removed setup note\. \(recorded\); guidance: call `source_status` before relying/);
  assert.doesNotMatch(filtered, /summary: Billing worker calculates invoices/);
  assert.doesNotMatch(filtered, /summary: Developer setup docs/);
  assert.doesNotMatch(filtered, /summary: Stale source used to export a v1 marker/);
  assert.doesNotMatch(filtered, /summary: Obsolete docs described a removed setup note/);

  const unfiltered = run(dir, ["resume", "--preset", "deep"]);
  assert.match(unfiltered, /Billing worker calculates invoices/);
  assert.match(unfiltered, /Developer setup docs/);
  assert.match(unfiltered, /summary: Stale source used to export a v1 marker/);
  assert.match(unfiltered, /summary: Obsolete docs described a removed setup note/);

  const noMatch = run(dir, ["resume", "--preset", "deep", "--query", "vector database"]);
  assert.match(noMatch, /no source summaries matched `vector database`; showing compact stubs for all 5 recorded source\(s\)/);
  assert.match(noMatch, /Billing worker calculates invoices/);
  assert.match(noMatch, /Developer setup docs/);
  assert.match(noMatch, /Query-unrelated stale stubs: 2 changed\/missing/);
  assert.doesNotMatch(noMatch, /summary: Authentication middleware validates sessions/);
  assert.doesNotMatch(noMatch, /summary: Billing worker calculates invoices/);
});

test("serializes concurrent source record writes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-concurrent-source-test-"));
  const files = Array.from({ length: 16 }, (_, index) => `file-${index}.js`);

  for (const file of files) {
    writeFileSync(path.join(dir, file), `console.log(${JSON.stringify(file)})\n`, "utf8");
  }

  run(dir, ["init"]);

  await Promise.all(files.map((file) => runAsync(dir, [
    "source",
    "add",
    file,
    "--summary",
    `Reviewed ${file}.`
  ])));

  const sourceDb = JSON.parse(readFileSync(path.join(dir, ".agentpack", "sources.json"), "utf8"));
  const sourcePaths = sourceDb.sources.map((source: { path: string }) => source.path).sort();
  assert.deepEqual(sourcePaths, [...files].sort());

  const events = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });
  assert.equal(events.filter((event) => event.type === "source").length, files.length);
  assert.equal(existsSync(path.join(dir, ".agentpack", ".lock")), false);
});

test("init stays ledger-only and Claude Desktop CLI merge stays explicit", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentpack-init-only-root-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "agentpack-init-only-home-"));
  const configPath = path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const original = "{\n  \"mcpServers\": {}\n}\n";
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, original, "utf8");

  const commandOptions = {
    cwd: root,
    env: { ...process.env, HOME: home },
    encoding: "utf8" as const,
    stdio: "pipe" as const
  };
  execFileSync(process.execPath, [cli, "init"], commandOptions);
  assert.equal(readFileSync(configPath, "utf8"), original);
  assert.equal(existsSync(`${configPath}.agentpack-backup`), false);

  const preview = execFileSync(process.execPath, [cli, "install", "claude-desktop"], commandOptions);
  assert.match(preview, /dry run/i);
  assert.equal(readFileSync(configPath, "utf8"), original);
  assert.equal(existsSync(path.join(root, ".agentpack", "instructions", "claude-desktop-mcp.example.json")), false);

  const installed = execFileSync(process.execPath, [cli, "install", "claude-desktop", "--write"], commandOptions);
  assert.equal(existsSync(path.join(root, ".agentpack", "instructions", "claude-desktop-mcp.example.json")), true);
  if (process.platform === "darwin") {
    assert.match(installed, /Claude Desktop config: updated/);
    assert.ok(JSON.parse(readFileSync(configPath, "utf8")).mcpServers[expectedMcpServerName(root)]);
    assert.equal(readFileSync(`${configPath}.agentpack-backup`, "utf8"), original);
  } else {
    assert.match(installed, /skipped automatic merge/);
    assert.equal(readFileSync(configPath, "utf8"), original);
  }
});

test("Claude Desktop config merge fails closed on unsafe inputs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentpack-desktop-root-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-desktop-config-"));
  const configPath = path.join(configDir, "claude_desktop_config.json");
  const serverName = expectedMcpServerName(root);

  const malformed = "{ invalid json\n";
  writeFileSync(configPath, malformed, "utf8");
  assert.throws(() => mergeClaudeDesktopConfig(root, configPath), /invalid Claude Desktop config/);
  assert.equal(readFileSync(configPath, "utf8"), malformed);

  const collision = `${JSON.stringify({
    preserved: true,
    mcpServers: { [serverName]: { command: "/usr/bin/custom", args: ["serve"] } }
  }, null, 2)}\n`;
  writeFileSync(configPath, collision, "utf8");
  assert.throws(() => mergeClaudeDesktopConfig(root, configPath), /entry Agentpack does not own/);
  assert.equal(readFileSync(configPath, "utf8"), collision);

  const valid = `${JSON.stringify({ preserved: true, mcpServers: {} }, null, 2)}\n`;
  writeFileSync(configPath, valid, "utf8");
  const external = "{\n  \"external\": true,\n  \"mcpServers\": {}\n}\n";
  assert.throws(
    () => mergeClaudeDesktopConfig(root, configPath, () => writeFileSync(configPath, external, "utf8")),
    /config changed concurrently/
  );
  assert.equal(readFileSync(configPath, "utf8"), external);
  assert.equal(readFileSync(`${configPath}.agentpack-backup`, "utf8"), valid);
  unlinkSync(`${configPath}.agentpack-backup`);
  writeFileSync(configPath, valid, "utf8");

  writeFileSync(`${configPath}.agentpack.lock`, "busy\n", "utf8");
  assert.throws(() => mergeClaudeDesktopConfig(root, configPath), /registration lock already exists/);
  assert.equal(readFileSync(configPath, "utf8"), valid);
  unlinkSync(`${configPath}.agentpack.lock`);

  symlinkSync(path.join(configDir, "missing-backup"), `${configPath}.agentpack-backup`);
  assert.throws(() => mergeClaudeDesktopConfig(root, configPath), /backup must be an ordinary file, not a symlink/);
  assert.equal(readFileSync(configPath, "utf8"), valid);
  unlinkSync(`${configPath}.agentpack-backup`);

  const outside = path.join(configDir, "outside.json");
  writeFileSync(outside, "{\"outside\":true}\n", "utf8");
  unlinkSync(configPath);
  symlinkSync(outside, configPath);
  assert.throws(() => mergeClaudeDesktopConfig(root, configPath), /config must be an ordinary file, not a symlink/);
  assert.equal(readFileSync(outside, "utf8"), "{\"outside\":true}\n");

  const partialRoot = mkdtempSync(path.join(os.tmpdir(), "agentpack-desktop-partial-root-"));
  run(partialRoot, ["init"]);
  const malformedPartial = "{ still invalid\n";
  unlinkSync(configPath);
  writeFileSync(configPath, malformedPartial, "utf8");
  assert.throws(
    () => installIntegration(partialRoot, "claude-desktop", { dryRun: false, claudeDesktopConfigPath: configPath }),
    /recovery files were installed, but global config merge failed/
  );
  assert.equal(existsSync(path.join(partialRoot, ".agentpack", "instructions", "claude-desktop-mcp.example.json")), true);
  assert.equal(readFileSync(configPath, "utf8"), malformedPartial);
});

test("previews and writes project-local MCP client install files", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-install-test-"));
  const serverName = expectedMcpServerName(dir);
  runGit(dir, ["init"]);
  run(dir, ["init"]);
  const gitignorePath = path.join(dir, ".gitignore");
  writeFileSync(gitignorePath, readFileSync(gitignorePath, "utf8").replace(".cursor\n", ""), "utf8");

  const defaultPreview = run(dir, ["install", "cursor"]);
  assert.match(defaultPreview, /dry run/);
  assert.match(defaultPreview, /No files were changed/);
  assert.match(defaultPreview, /UPDATE \.gitignore/);
  assert.doesNotMatch(readFileSync(gitignorePath, "utf8"), /^\.cursor\/?$/m);
  assert.equal(existsSync(path.join(dir, ".cursor", "mcp.json")), false);

  const claudePreview = run(dir, ["install", "claude", "--dry-run"]);
  assert.match(claudePreview, /agentpack install claude --write/);
  assert.equal(existsSync(path.join(dir, "CLAUDE.md")), false);
  assert.equal(existsSync(path.join(dir, ".mcp.json")), false);
  assert.equal(existsSync(path.join(dir, ".claude", "agents", "builder.md")), false);

  const claudeInstall = run(dir, ["install", "claude", "--write"]);
  assert.match(claudeInstall, /Installed Agentpack claude integration/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /agentpack:start/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /preserve existing functionality/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /Coding defaults/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /do not log secrets/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /Collaboration modes/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /design mode: do not write code/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /Task lifecycle gate/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /treat review mode as a scope check/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /park deferred work with `task_park`\/`task park`/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /do not finalize a task just to free the current slot/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /PR bodies, release notes, or branch names/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /avoid branch names with AI or agent-style prefixes/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /load_context.*preset: "quick".*focused query/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /Delegation default \(builder subagent\)/);
  assert.match(readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /more than roughly 10-20 tool calls/);
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude.md"), "utf8"),
    /Delegation default \(builder subagent\)/
  );
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude.md"), "utf8"),
    /more than roughly 10-20 tool calls/
  );
  const claudeMcp = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"));
  assert.deepEqual(claudeMcp.mcpServers[serverName], {
    type: "stdio",
    command: "agentpack",
    args: ["mcp"]
  });
  assert.equal(claudeMcp.mcpServers.agentpack, undefined);
  const builderAgent = readFileSync(path.join(dir, ".claude", "agents", "builder.md"), "utf8");
  assert.match(builderAgent, /^name: builder$/m);
  assert.match(builderAgent, /^model: sonnet$/m);
  assert.ok(builderAgent.includes(`mcp__${serverName}__load_context`));
  assert.match(builderAgent, /Edit only inside the write scope/);
  assert.match(builderAgent, /warns by default and blocks when gateMode is "block"/);
  assert.match(builderAgent, /recording is the coordinator's job/);
  assert.doesNotMatch(builderAgent, /archivist/i);
  assert.match(claudeInstall, /builder subagent/);
  assert.match(builderAgent, /roughly 10-20 tool calls or multi-file changes/);

  writeFileSync(
    path.join(dir, ".claude", "agents", "builder.md"),
    builderAgent.replace("model: sonnet", "model: claude-sonnet-custom-id") + "\nStale user-edited template content.\n",
    "utf8"
  );
  const claudeReinstall = run(dir, ["install", "claude", "--write"]);
  assert.match(claudeReinstall, /Installed Agentpack claude integration/);
  const reinstalledBuilder = readFileSync(path.join(dir, ".claude", "agents", "builder.md"), "utf8");
  assert.match(reinstalledBuilder, /^model: claude-sonnet-custom-id$/m);
  assert.match(reinstalledBuilder, /recording is the coordinator's job/);
  assert.doesNotMatch(reinstalledBuilder, /Stale user-edited template content/);

  const claudeDesktopPreview = run(dir, ["install", "claude-desktop"]);
  assert.match(claudeDesktopPreview, /claude-desktop install plan/);
  assert.match(claudeDesktopPreview, /Dry-run changes nothing/);
  assert.equal(existsSync(path.join(dir, ".agentpack", "instructions", "claude-desktop-mcp.example.json")), false);

  const desktopConfigDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-desktop-config-"));
  const desktopConfigPath = path.join(desktopConfigDir, "claude_desktop_config.json");
  const originalDesktopConfig = `${JSON.stringify({
    theme: "dark",
    mcpServers: { existing: { command: "/usr/bin/existing" } }
  }, null, 2)}\n`;
  writeFileSync(desktopConfigPath, originalDesktopConfig, "utf8");
  const claudeDesktopInstall = installIntegration(realpathSync(dir), "claude-desktop", {
    dryRun: false,
    claudeDesktopConfigPath: desktopConfigPath
  });
  assert.match(claudeDesktopInstall, /Installed Agentpack claude-desktop integration/);
  assert.match(claudeDesktopInstall, /Claude Desktop config: updated/);
  const mergedDesktopConfig = JSON.parse(readFileSync(desktopConfigPath, "utf8"));
  assert.equal(mergedDesktopConfig.theme, "dark");
  assert.deepEqual(mergedDesktopConfig.mcpServers.existing, { command: "/usr/bin/existing" });
  assert.equal(readFileSync(`${desktopConfigPath}.agentpack-backup`, "utf8"), originalDesktopConfig);
  const claudeDesktopSnippet = JSON.parse(readFileSync(
    path.join(dir, ".agentpack", "instructions", "claude-desktop-mcp.example.json"),
    "utf8"
  ));
  assert.equal(claudeDesktopSnippet.mcpServers[serverName].command, process.execPath);
  assert.ok(path.isAbsolute(claudeDesktopSnippet.mcpServers[serverName].args[0]));
  assert.match(claudeDesktopSnippet.mcpServers[serverName].args[0], /agentpack\.js$/);
  assert.equal(claudeDesktopSnippet.mcpServers[serverName].args[0], cli);
  assert.deepEqual(claudeDesktopSnippet.mcpServers[serverName].args.slice(1), ["mcp", "--root", realpathSync(dir)]);
  assert.deepEqual(claudeDesktopSnippet.mcpServers[serverName].env, {
    AGENTPACK_ROOT: realpathSync(dir)
  });
  assert.deepEqual(mergedDesktopConfig.mcpServers[serverName], claudeDesktopSnippet.mcpServers[serverName]);
  const repeatedDesktopInstall = installIntegration(realpathSync(dir), "claude-desktop", {
    dryRun: false,
    claudeDesktopConfigPath: desktopConfigPath
  });
  assert.match(repeatedDesktopInstall, /already up to date/);
  assert.equal(readFileSync(`${desktopConfigPath}.agentpack-backup`, "utf8"), originalDesktopConfig);
  mergedDesktopConfig.mcpServers[serverName].command = "/opt/node";
  mergedDesktopConfig.mcpServers[serverName].args[0] = "/opt/agentpack.js";
  const staleDesktopConfig = `${JSON.stringify(mergedDesktopConfig, null, 2)}\n`;
  writeFileSync(desktopConfigPath, staleDesktopConfig, "utf8");
  const refreshedDesktopInstall = mergeClaudeDesktopConfig(realpathSync(dir), desktopConfigPath);
  assert.match(refreshedDesktopInstall, /updated/);
  assert.equal(JSON.parse(readFileSync(desktopConfigPath, "utf8")).mcpServers[serverName].command, process.execPath);
  assert.equal(readFileSync(`${desktopConfigPath}.agentpack-backup`, "utf8"), staleDesktopConfig);
  assert.notDeepEqual(claudeDesktopSnippet.mcpServers[serverName], {
    command: "agentpack",
    args: ["mcp", "--root", realpathSync(dir)],
    env: {
      AGENTPACK_ROOT: realpathSync(dir)
    }
  });
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude-desktop.md"), "utf8"),
    /Claude Desktop does not read project-local `\.mcp\.json`/
  );
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude-desktop.md"), "utf8"),
    /Do not copy the generated snippet over the Desktop config file/
  );
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude-desktop.md"), "utf8"),
    /current Node executable and Agentpack entrypoint/
  );
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude-desktop.md"), "utf8"),
    new RegExp(`Generated server key for this repo: \`${serverName}\``)
  );
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "claude-desktop.md"), "utf8"),
    new RegExp(`mcpServers\\.${serverName}`)
  );

  mkdirSync(path.join(dir, ".cursor"), { recursive: true });
  writeFileSync(path.join(dir, ".cursor", "cli.json"), JSON.stringify({
    customSetting: "preserved",
    permissions: {
      allow: ["Shell(git)"],
      deny: ["Shell(rm)"]
    }
  }), "utf8");

  const cursorInstall = run(dir, ["install", "cursor", "--write"]);
  assert.match(cursorInstall, /warn mode allows silently/);
  assert.match(cursorInstall, /inherits the parent model/);
  assert.match(cursorInstall, /read-only MCP tools/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /task-state ledger/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /preserve existing functionality/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /Collaboration modes/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /review mode: review the current diff/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /Task lifecycle gate/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /independent review that needs its own frozen snapshot/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /finalization means verification is passed, failed, or explicitly accepted as complete/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /load_context.*preset: "quick".*focused query/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /Delegation default \(builder subagent\)/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /inherits the parent model/);
  assert.match(readFileSync(path.join(dir, ".cursor", "rules", "agentpack.mdc"), "utf8"), /Cursor-specific notes/);
  const cursorBuilder = readFileSync(path.join(dir, ".cursor", "agents", "builder.md"), "utf8");
  assert.match(cursorBuilder, /^name: builder$/m);
  assert.match(cursorBuilder, /^model: inherit$/m);
  assert.ok(cursorBuilder.includes(`mcp__${serverName}__load_context`));
  assert.match(cursorBuilder, /Edit only inside the write scope/);
  assert.doesNotMatch(cursorBuilder, /archivist/i);
  const cursorMcp = JSON.parse(readFileSync(path.join(dir, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursorMcp.mcpServers[serverName].type, "stdio");
  assert.equal(cursorMcp.mcpServers[serverName].command, process.execPath);
  assert.ok(path.isAbsolute(cursorMcp.mcpServers[serverName].args[0]));
  assert.match(cursorMcp.mcpServers[serverName].args[0], /agentpack\.js$/);
  assert.equal(cursorMcp.mcpServers[serverName].args[0], cli);
  assert.deepEqual(cursorMcp.mcpServers[serverName].args.slice(1), ["mcp", "--root", "${workspaceFolder}"]);
  assert.equal(cursorMcp.mcpServers.agentpack, undefined);
  const cursorCli = JSON.parse(readFileSync(path.join(dir, ".cursor", "cli.json"), "utf8"));
  const expectedCursorReadOnlyPermissions = TOOL_DEFINITIONS
    .filter((tool) => tool.annotations.readOnlyHint)
    .map((tool) => `Mcp(${serverName}:${tool.name})`)
    .sort();
  assert.equal(cursorCli.customSetting, "preserved");
  assert.deepEqual(cursorCli.permissions.deny, ["Shell(rm)"]);
  assert.deepEqual(
    cursorCli.permissions.allow.filter((entry: string) => entry.startsWith("Mcp(")).sort(),
    expectedCursorReadOnlyPermissions
  );
  assert.ok(cursorCli.permissions.allow.includes("Shell(git)"));
  assert.ok(!cursorCli.permissions.allow.includes(`Mcp(${serverName}:record_decision)`));
  const cursorHooks = JSON.parse(readFileSync(path.join(dir, ".cursor", "hooks.json"), "utf8")) as {
    version: number;
    hooks: { preToolUse: Array<{ command: string; matcher: string }> };
  };
  assert.equal(cursorHooks.version, 1);
  assert.equal(cursorHooks.hooks.preToolUse.length, 1);
  assert.equal(cursorHooks.hooks.preToolUse[0]?.matcher, "Write|Delete");
  assert.match(cursorHooks.hooks.preToolUse[0]?.command || "", /task gate --client cursor$/);
  assert.match(runGit(dir, ["check-ignore", ".cursor/hooks.json"]), /\.cursor\/hooks\.json/);

  run(dir, ["install", "cursor", "--write"]);
  const reinstalledCursorCli = JSON.parse(readFileSync(path.join(dir, ".cursor", "cli.json"), "utf8"));
  for (const permission of expectedCursorReadOnlyPermissions) {
    assert.equal(reinstalledCursorCli.permissions.allow.filter((entry: string) => entry === permission).length, 1);
  }

  const codexInstall = run(dir, ["install", "codex", "--write"]);
  assert.match(codexInstall, /No global Codex config is modified/);
  assert.match(codexInstall, /project-local \.codex\/config\.toml/);
  assert.match(codexInstall, /gpt-5\.6-terra at medium reasoning/);
  assert.match(codexInstall, /sees only Agentpack load_context/);
  assert.match(codexInstall, /Remove any old ~\/\.codex\/config\.toml agentpack server/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /agentpack:start/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /preserve existing functionality/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Git and PR hygiene/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /do not add AI or agent prefixes/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /`claude\/`, `codex\/`, `ai\/`, or `agent\/`/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Focused skills\/rules/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Collaboration modes/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /treat named modes as explicit collaboration preferences/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /checkpoint mode: summarize what was decided/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Task lifecycle gate/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /declare a write scope when starting a task/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /commit the in-scope changes and confirm the commit changed nothing/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /one `task_finalize` call carrying the final status, evidence, and commit hash/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /record `passed` via `task_update_verification`, then `task_park`/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /keep next actions current: clear or replace a stale plan/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /verifying, blocked, closed/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /keep reviews that verify the current active\/verifying task inside that task/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /do not mutate a review task into implementation work/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Avoid turning Agentpack into an activity log/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /record_source` only when you have a durable conclusion/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /source_status` only when you need a full stale-source check/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /load_context.*preset: "quick".*focused query/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /prefer one aggregated verification evidence and one checkpoint/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /sequence state-changing Agentpack calls/);
  assert.doesNotMatch(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /source_status` before re-reading/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Delegation default \(builder subagent\)/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /one writer per slice/);
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /gpt-5\.6-terra at medium reasoning/);
  assert.match(
    readFileSync(path.join(dir, ".agentpack", "instructions", "codex.md"), "utf8"),
    /Delegation default \(builder subagent\)/
  );
  const codexConfig = readFileSync(path.join(dir, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, new RegExp(`\\[mcp_servers\\.${escapeRegExp(serverName)}\\]`));
  assert.doesNotMatch(codexConfig, /\[mcp_servers\.agentpack\]/);
  assert.match(codexConfig, /args = \["mcp"\]/);
  assert.doesNotMatch(codexConfig, /--root/);
  assert.doesNotMatch(codexConfig, /cwd =/);
  const codexHooks = JSON.parse(readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8")) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; commandWindows: string }> }> };
  };
  assert.equal(codexHooks.hooks.PreToolUse.length, 1);
  assert.equal(codexHooks.hooks.PreToolUse[0]?.matcher, "^apply_patch$");
  assert.match(codexHooks.hooks.PreToolUse[0]?.hooks[0]?.command || "", /task gate --client codex$/);
  assert.match(codexHooks.hooks.PreToolUse[0]?.hooks[0]?.commandWindows || "", /task gate --client codex$/);
  const codexSnippet = readFileSync(path.join(dir, ".agentpack", "instructions", "codex-mcp.example.toml"), "utf8");
  assert.match(codexSnippet, new RegExp(`\\[mcp_servers\\.${escapeRegExp(serverName)}\\]`));
  assert.match(codexSnippet, /args = \["mcp"\]/);
  assert.doesNotMatch(codexSnippet, /args = \["mcp", "--root"/);
  assert.doesNotMatch(codexSnippet, /cwd =/);

  const codexBuilderPath = path.join(dir, ".codex", "agents", "builder.toml");
  const codexBuilder = readFileSync(codexBuilderPath, "utf8");
  assert.match(codexBuilder, /^model = "gpt-5\.6-terra"$/m);
  assert.match(codexBuilder, /^model_reasoning_effort = "medium"$/m);
  assert.match(codexBuilder, /^# agentpack:builder:start$/m);
  assert.match(codexBuilder, /^name = "builder"$/m);
  assert.match(codexBuilder, /one bounded, coordinator-defined coding slice/);
  assert.ok(codexBuilder.includes(`mcp__${serverName}__load_context`));
  assert.match(codexBuilder, new RegExp(`^\\[mcp_servers\\.${escapeRegExp(serverName)}\\]$`, "m"));
  assert.match(codexBuilder, /^command = "agentpack"$/m);
  assert.match(codexBuilder, /^args = \["mcp"\]$/m);
  assert.match(codexBuilder, /^enabled_tools = \["load_context"\]$/m);
  assert.match(codexBuilder, new RegExp(`^\\[mcp_servers\\.${escapeRegExp(serverName)}\\.tools\\.load_context\\]$`, "m"));
  assert.match(codexBuilder, /^approval_mode = "approve"$/m);
  assert.doesNotMatch(codexBuilder, /record_decision|task_finalize|attach_evidence/);
  assert.match(codexBuilder, /^# agentpack:builder:end$/m);

  writeFileSync(
    codexBuilderPath,
    codexBuilder
      .replace('model = "gpt-5.6-terra"', 'model = "gpt-5.6-sol"')
      .replace('model_reasoning_effort = "medium"', 'model_reasoning_effort = "high"')
      .replace("# agentpack:builder:start", 'sandbox_mode = "workspace-write"\n\n# agentpack:builder:start')
      .replace("You are the builder for one scoped implementation slice.", "Stale managed builder instructions."),
    "utf8"
  );
  run(dir, ["install", "codex", "--write"]);
  const reinstalledCodexBuilder = readFileSync(codexBuilderPath, "utf8");
  assert.match(reinstalledCodexBuilder, /^model = "gpt-5\.6-sol"$/m);
  assert.match(reinstalledCodexBuilder, /^model_reasoning_effort = "high"$/m);
  assert.match(reinstalledCodexBuilder, /^sandbox_mode = "workspace-write"$/m);
  assert.match(reinstalledCodexBuilder, /You are the builder for one scoped implementation slice/);
  assert.doesNotMatch(reinstalledCodexBuilder, /Stale managed builder instructions/);
  assert.equal((reinstalledCodexBuilder.match(/# agentpack:builder:start/g) || []).length, 1);
  assert.equal((reinstalledCodexBuilder.match(/enabled_tools = \["load_context"\]/g) || []).length, 1);
  assert.equal((reinstalledCodexBuilder.match(/approval_mode = "approve"/g) || []).length, 1);
});

test("preserves an existing unmarked Codex builder agent", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-codex-builder-test-"));
  runGit(dir, ["init"]);
  run(dir, ["init"]);
  const builderPath = path.join(dir, ".codex", "agents", "builder.toml");
  const existingBuilder = `name = "builder"
description = "User-owned builder"
developer_instructions = "Do the user's custom workflow."
model = "custom-model"
`;
  mkdirSync(path.dirname(builderPath), { recursive: true });
  writeFileSync(builderPath, existingBuilder, "utf8");

  const install = run(dir, ["install", "codex", "--write"]);

  assert.match(install, /existing unmarked \.codex\/agents\/builder\.toml was left untouched/);
  assert.equal(readFileSync(builderPath, "utf8"), existingBuilder);
});

test("writes a schema-complete fresh Cursor CLI permission config", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-cursor-cli-test-"));
  const serverName = expectedMcpServerName(dir);
  runGit(dir, ["init"]);
  run(dir, ["init"]);

  run(dir, ["install", "cursor", "--write"]);

  const cursorCli = JSON.parse(readFileSync(path.join(dir, ".cursor", "cli.json"), "utf8"));
  const expectedCursorReadOnlyPermissions = TOOL_DEFINITIONS
    .filter((tool) => tool.annotations.readOnlyHint)
    .map((tool) => `Mcp(${serverName}:${tool.name})`)
    .sort();
  assert.deepEqual(cursorCli.permissions.allow.slice().sort(), expectedCursorReadOnlyPermissions);
  assert.deepEqual(cursorCli.permissions.deny, []);
});

test("writes ledger files and directories with owner-only permissions", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-perms-test-"));
  run(dir, ["init"]);
  run(dir, ["task", "start", "Permission check task"]);
  run(dir, ["record", "decision", "permission check decision"]);
  run(dir, ["run", "echo permission-check-output"]);
  run(dir, ["checkpoint", "-m", "permission check checkpoint"]);

  const packPath = path.join(dir, ".agentpack");
  for (const entry of walkEntries(packPath)) {
    const mode = statSync(entry).mode & 0o777;
    assert.equal(mode & 0o077, 0, `expected owner-only permissions for ${entry}, got ${mode.toString(8)}`);
  }
});

test("rolls back client install writes when a later file write fails", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-install-rollback-test-"));
  run(dir, ["init"]);

  const claudeMdPath = path.join(dir, "CLAUDE.md");
  const mcpJsonPath = path.join(dir, ".mcp.json");
  writeFileSync(claudeMdPath, "# Existing project instructions\n", "utf8");
  writeFileSync(mcpJsonPath, "{}\n", "utf8");
  chmodSync(mcpJsonPath, 0o444);

  try {
    const error = runExpectError(dir, ["install", "claude", "--write"]);
    assert.match(error, /Install failed; already-written files were rolled back/);
    assert.equal(readFileSync(claudeMdPath, "utf8"), "# Existing project instructions\n");
    assert.equal(existsSync(path.join(dir, ".agentpack", "instructions", "claude.md")), false);
    assert.equal(readFileSync(mcpJsonPath, "utf8"), "{}\n");
  } finally {
    chmodSync(mcpJsonPath, 0o644);
  }

  const install = run(dir, ["install", "claude", "--write"]);
  assert.match(install, /Installed Agentpack claude integration/);
  assert.match(readFileSync(claudeMdPath, "utf8"), /agentpack:start/);
});

test("task gate checks lifecycle, write scope, and gate modes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-gate-test-"));

  assert.equal(run(dir, ["task", "gate", "--file", "src/a.ts"]).trim(), "");

  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["init"]);

  const noTask = run(dir, ["task", "gate", "--file", "src/a.ts"]);
  assert.match(noTask, /No current task passport/);

  run(dir, ["task", "start", "Gate coverage task", "--write-scope", "src"]);
  assert.equal(run(dir, ["task", "gate", "--file", "src/nested/a.ts"]).trim(), "");

  run(dir, ["task", "update", "--write-scope", "./lib/"]);
  assert.equal(
    run(dir, ["task", "gate", "--file", "lib/b.ts"]).trim(),
    "",
    "a ./-prefixed write-scope entry must not produce a false out-of-scope violation"
  );

  const outOfScope = run(dir, ["task", "gate", "--file", "other/b.ts"]);
  assert.match(outOfScope, /Gate: warn \(mode: warn\)/);
  assert.match(outOfScope, /Outside the task write scope: other\/b\.ts/);

  const gateJson = JSON.parse(run(dir, ["task", "gate", "--file", "other/b.ts", "--json"])) as {
    decision: string;
    findings: Array<{ code: string; level: string }>;
  };
  assert.equal(gateJson.decision, "warn");
  assert.deepEqual(gateJson.findings.map((finding) => finding.code), ["out-of-scope"]);

  writeFileSync(path.join(dir, "outside.txt"), "outside\n", "utf8");
  runGit(dir, ["add", "outside.txt"]);
  assert.match(run(dir, ["task", "gate", "--staged"]), /Outside the task write scope: outside\.txt/);

  const configPath = path.join(dir, ".agentpack", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, gateMode: "block" }, null, 2), "utf8");

  const blocked = runWithStatus(dir, ["task", "gate", "--file", "other/b.ts"]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Gate: block \(mode: block\)/);
  assert.equal(runWithStatus(dir, ["task", "gate", "--file", "src/a.ts"]).status, 0);

  const deny = runWithInput(dir, ["task", "gate", "--client", "claude"], JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: "other/b.ts" }
  }));
  const denyOutput = JSON.parse(deny) as { hookSpecificOutput: Record<string, string> };
  assert.equal(denyOutput.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denyOutput.hookSpecificOutput.permissionDecisionReason || "", /Outside the task write scope/);

  const codexDeny = runWithInput(dir, ["task", "gate", "--client", "codex"], JSON.stringify({
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: other/b.ts\n*** End Patch" }
  }));
  const codexDenyOutput = JSON.parse(codexDeny) as { hookSpecificOutput: Record<string, string> };
  assert.equal(codexDenyOutput.hookSpecificOutput.permissionDecision, "deny");
  assert.match(codexDenyOutput.hookSpecificOutput.permissionDecisionReason || "", /other\/b\.ts/);

  const cursorDeny = runWithInput(dir, ["task", "gate", "--client", "cursor"], JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: "other/b.ts" }
  }));
  const cursorDenyOutput = JSON.parse(cursorDeny) as Record<string, string>;
  assert.equal(cursorDenyOutput.permission, "deny");
  assert.match(cursorDenyOutput.agent_message || "", /Outside the task write scope/);

  const malformedCodex = JSON.parse(runWithInput(dir, ["task", "gate", "--client", "codex"], JSON.stringify({
    tool_name: "apply_patch",
    tool_input: { unexpected_patch_field: "*** Update File: other/b.ts" }
  }))) as { hookSpecificOutput: Record<string, string> };
  assert.equal(malformedCodex.hookSpecificOutput.permissionDecision, "deny");
  assert.match(malformedCodex.hookSpecificOutput.permissionDecisionReason || "", /Cannot determine edited file paths/);

  writeFileSync(configPath, JSON.stringify({ ...config, gateMode: "warn" }, null, 2), "utf8");
  const warn = runWithInput(dir, ["task", "gate", "--client", "claude"], JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: "other/b.ts" }
  }));
  const warnOutput = JSON.parse(warn) as { hookSpecificOutput: Record<string, string> };
  assert.equal(warnOutput.hookSpecificOutput.permissionDecision, undefined);
  assert.match(warnOutput.hookSpecificOutput.additionalContext || "", /Agentpack gate warning/);

  const codexWarn = JSON.parse(runWithInput(dir, ["task", "gate", "--client", "codex"], JSON.stringify({
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Delete File: other/b.ts\n*** End Patch" }
  }))) as { hookSpecificOutput: Record<string, string> };
  assert.match(codexWarn.hookSpecificOutput.additionalContext || "", /Agentpack gate warning/);

  const cursorWarn = JSON.parse(runWithInput(dir, ["task", "gate", "--client", "cursor"], JSON.stringify({
    tool_name: "Delete",
    tool_input: { path: "other/b.ts" }
  }))) as Record<string, string>;
  assert.equal(cursorWarn.permission, "allow");
  assert.equal(cursorWarn.agent_message, undefined, "Cursor only guarantees agent feedback for denied actions");

  const malformedCursor = JSON.parse(runWithInput(dir, ["task", "gate", "--client", "cursor"], JSON.stringify({
    tool_name: "Write",
    tool_input: { unexpected_path_field: "other/b.ts" }
  }))) as Record<string, string>;
  assert.equal(malformedCursor.permission, "allow");
  assert.equal(malformedCursor.agent_message, undefined);

  const allow = runWithInput(dir, ["task", "gate", "--client", "claude"], JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: "src/a.ts" }
  }));
  assert.equal(allow.trim(), "");
  const codexAllow = runWithInput(dir, ["task", "gate", "--client", "codex"], JSON.stringify({
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/moved.ts\n*** End Patch" }
  }));
  assert.equal(codexAllow.trim(), "");
  const cursorAllow = JSON.parse(runWithInput(dir, ["task", "gate", "--client", "cursor"], JSON.stringify({
    tool_name: "Write",
    tool_input: { target_file: "src/a.ts" }
  }))) as Record<string, string>;
  assert.equal(cursorAllow.permission, "allow");

  writeFileSync(configPath, JSON.stringify({ ...config, gateMode: "off" }, null, 2), "utf8");
  assert.equal(run(dir, ["task", "gate", "--file", "other/b.ts"]).trim(), "");

  writeFileSync(configPath, "{ invalid json", "utf8");
  const invalidConfig = runWithStatus(dir, ["task", "gate", "--file", "src/a.ts"]);
  assert.equal(invalidConfig.status, 2, "an unreadable config must fail closed");
  assert.match(invalidConfig.stderr, /Cannot read \.agentpack\/config\.json/);
  const invalidConfigCodex = JSON.parse(runWithInput(dir, ["task", "gate", "--client", "codex"], JSON.stringify({
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }
  }))) as { hookSpecificOutput: Record<string, string> };
  assert.equal(invalidConfigCodex.hookSpecificOutput.permissionDecision, "deny");
  const invalidConfigCursor = JSON.parse(runWithInput(dir, ["task", "gate", "--client", "cursor"], JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: "src/a.ts" }
  }))) as Record<string, string>;
  assert.equal(invalidConfigCursor.permission, "deny");

  writeFileSync(configPath, JSON.stringify({ ...config, gateMode: "warn" }, null, 2), "utf8");

  run(dir, ["task", "park"]);
  assert.match(run(dir, ["task", "gate", "--file", "src/a.ts"]), /Current task is parked/);

  const mcp = createMcpHarness(dir);
  const status = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "task_status", arguments: {} }
  });
  assert.match(status.result.content[0].text, /## Gate Warnings/);
  assert.match(status.result.content[0].text, /Current task is parked/);
});

test("task gate --staged handles non-ASCII staged file names", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-gate-nonascii-test-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["init"]);
  run(dir, ["task", "start", "Non-ASCII gate task", "--write-scope", "docs"]);

  const configPath = path.join(dir, ".agentpack", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, gateMode: "block" }, null, 2), "utf8");

  mkdirSync(path.join(dir, "docs"));
  writeFileSync(path.join(dir, "docs", "файл.md"), "in scope\n", "utf8");
  runGit(dir, ["add", "docs/файл.md"]);

  const inScope = runWithStatus(dir, ["task", "gate", "--staged"]);
  assert.equal(inScope.status, 0, "a non-ASCII staged path inside the write scope must not be falsely blocked");
  assert.doesNotMatch(inScope.stdout + inScope.stderr, /Outside the task write scope/);

  writeFileSync(path.join(dir, "other-файл.md"), "out of scope\n", "utf8");
  runGit(dir, ["add", "other-файл.md"]);

  const outOfScope = runWithStatus(dir, ["task", "gate", "--staged"]);
  assert.equal(outOfScope.status, 2);
  assert.match(
    outOfScope.stdout + outOfScope.stderr,
    /Outside the task write scope: .*other-файл\.md/,
    "the reported path must be the readable, unquoted form"
  );
  assert.doesNotMatch(
    outOfScope.stdout + outOfScope.stderr,
    /\\\d{3}/,
    "the path must not be C-quoted octal escapes"
  );
});

test("pending verification returns lifecycle to active instead of getting stuck in verifying", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-verify-lifecycle-test-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["init"]);
  run(dir, ["task", "start", "Verify lifecycle task", "--write-scope", "src"]);

  assert.match(run(dir, ["task", "verify", "--status", "passed"]), /Updated verification for task .* \(passed\)/);
  const passedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(passedPassport.status, "verifying", "a final verdict moves the lifecycle to verifying");
  const warnOutput = run(dir, ["task", "gate", "--file", "src/a.ts"]);
  assert.match(warnOutput, /Gate: warn \(mode: warn\)/, "the gate warns while a final verdict is under review");
  assert.match(warnOutput, /Current task is verifying: a final verdict is recorded and code changes are frozen\. Finalize the task; to commit already-verified changes, set verification to pending, commit, then re-record the verdict\./);

  run(dir, ["task", "park"]);
  assert.match(run(dir, ["task", "switch", passedPassport.id]), /Switched to task/);
  const resumedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(resumedPassport.status, "verifying", "a parked final verdict remains frozen when it becomes current again");
  assert.match(run(dir, ["task", "gate", "--file", "src/a.ts"]), /Current task is verifying/);

  assert.match(run(dir, ["task", "verify"]), /Updated verification for task .* \(pending\)/);
  const pendingPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(pendingPassport.status, "active", "verification found more work: pending returns the lifecycle to active");
  assert.equal(
    run(dir, ["task", "gate", "--file", "src/a.ts"]).trim(),
    "",
    "the gate stops warning once the lifecycle is back to active"
  );

  const eventCountBeforeNoop = taskEventCount(dir, pendingPassport.id);
  assert.match(run(dir, ["task", "verify"]), /Verification unchanged for task .* \(pending\)/, "repeating the same pending verdict is a no-op");
  assert.equal(taskEventCount(dir, pendingPassport.id), eventCountBeforeNoop);
});

test("final verdict keeps its bound HEAD through metadata, parking, resuming, and finalization", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-final-head-binding-test-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["init"]);
  writeFileSync(path.join(dir, "tracked.ts"), "export const before = true;\n", "utf8");
  runGit(dir, ["add", "tracked.ts"]);
  commit(dir, "Add initial source");
  run(dir, ["task", "start", "Bound HEAD task", "--write-scope", "tracked.ts"]);

  const verifyOutput = run(dir, ["task", "verify", "--status", "passed", "--summary", "Reviewed initial source"]);
  const frozen = JSON.parse(run(dir, ["task", "passport"]));
  assert.match(verifyOutput, new RegExp(`Bound HEAD ${frozen.currentHead}`));
  assert.match(verifyOutput, /final verdict freezes code changes/);

  writeFileSync(path.join(dir, "tracked.ts"), "export const after = true;\n", "utf8");
  runGit(dir, ["add", "tracked.ts"]);
  commit(dir, "Advance source after verdict");
  const advancedHead = runGit(dir, ["rev-parse", "HEAD"]);
  assert.notEqual(frozen.currentHead, advancedHead);

  run(dir, ["task", "update", "--next", "Keep frozen review context"]);
  assert.equal(JSON.parse(run(dir, ["task", "passport"])).currentHead, frozen.currentHead, "task update preserves a frozen HEAD");
  run(dir, ["task", "park"]);
  assert.equal(JSON.parse(run(dir, ["task", "passport"])).currentHead, frozen.currentHead, "task park preserves a frozen HEAD");
  run(dir, ["task", "switch", frozen.id]);
  assert.equal(JSON.parse(run(dir, ["task", "passport"])).currentHead, frozen.currentHead, "resuming a final verdict preserves its bound HEAD");

  const finalizeOutput = run(dir, ["task", "finalize"]);
  assert.match(finalizeOutput, new RegExp(`Bound HEAD ${frozen.currentHead}`));
  assert.equal(JSON.parse(run(dir, ["task", "passport"])).currentHead, frozen.currentHead, "finalizing an already-final verdict preserves its bound HEAD");
});

test("remediation stays pending until one finalization without losing passport facts", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-remediation-cadence-test-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["init"]);
  run(dir, [
    "task", "start", "Remediate review findings", "--objective", "Resolve the independent review findings.",
    "--constraint", "Keep authorization boundary unchanged.", "--write-scope", "src", "--next", "Fix reported finding", "--risk", "medium"
  ]);
  const started = JSON.parse(run(dir, ["task", "passport"]));

  assert.match(run(dir, ["task", "verify", "--summary", "Fix loop remains open"]), /Verification remains pending: the task stays active for fixes and intermediate checks/);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "fix.ts"), "export const fixed = true;\n", "utf8");
  run(dir, ["checkpoint", "-m", "Focused remediation checks are green", "--status", "Fix loop active", "--next", "Commit remediation"]);
  const pending = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(pending.status, "active");
  assert.equal(pending.verification.status, "pending");
  const handoff = run(dir, ["task", "handoff"]);
  assert.match(handoff, /Resolve the independent review findings\./);
  assert.match(handoff, /Keep authorization boundary unchanged\./);
  assert.match(handoff, /Write scope:\n- src/);
  assert.match(handoff, /Verification: pending/);

  runGit(dir, ["add", "src/fix.ts"]);
  commit(dir, "Resolve review finding");
  run(dir, ["task", "update", "--clear-next-actions"]);
  const finalOutput = run(dir, ["task", "finalize", "--status", "passed", "--evidence", "evt_review", "--summary", "Independent review and tests passed"]);
  const completed = JSON.parse(run(dir, ["task", "passport"]));
  assert.match(finalOutput, new RegExp(`Bound HEAD ${completed.currentHead}`));
  assert.equal(completed.status, "completed");
  assert.equal(completed.verification.status, "passed");
  assert.deepEqual(completed.verification.evidence, ["evt_review"]);
  assert.equal(completed.objective, started.objective);
  assert.deepEqual(completed.constraints, started.constraints);
  assert.deepEqual(completed.writeScope, started.writeScope);
  assert.deepEqual(completed.nextActions, [], "the stale action is cleared before finalization");
  assert.equal(completed.constraints[0], started.constraints[0], "the authorization constraint survives the fix loop");
  const verifyStatuses = readFileSync(path.join(dir, ".agentpack", "tasks", completed.id, "events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((event) => event.type === "task-verify" || event.type === "task-finalize")
    .map((event) => event.verificationStatus).filter(Boolean);
  assert.deepEqual(verifyStatuses, ["pending", "passed"], "the flow reaches completion without a passed-to-pending reset");
});

test("task verify is rejected while the current task is parked", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-verify-parked-test-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["init"]);
  run(dir, ["task", "start", "Parked verify task", "--write-scope", "src"]);
  const passportId = JSON.parse(run(dir, ["task", "passport"])).id;

  run(dir, ["task", "park"]);
  const parked = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(parked.status, "parked");

  assert.match(
    runExpectError(dir, ["task", "verify", "--status", "passed"]),
    new RegExp(`Current task is parked; resume it first with \`agentpack task switch ${passportId}\` before updating verification\\.`)
  );
  const stillParked = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(stillParked.status, "parked", "a rejected verify must not re-activate the parked task");
});

test("task finalize prints hygiene advisories and stays silent when clean", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-finalize-advisories-test-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  run(dir, ["init"]);

  run(dir, ["task", "start", "Noisy task", "--write-scope", "src", "--next", "Ship it"]);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  run(dir, ["task", "verify", "--status", "passed"]);
  const noisy = run(dir, ["task", "finalize"]);
  assert.match(noisy, /Finalized task .* \(passed\)/);
  assert.match(noisy, /Advisories:/);
  assert.match(noisy, /Uncommitted changes remain inside the task write scope: src\/a\.ts/);
  assert.match(noisy, /Closed with 1 remaining next action\(s\)/);
  assert.match(noisy, /No repo checkpoint since this task started/);

  runGit(dir, ["add", "src"]);
  runGit(dir, ["commit", "-m", "Add src"]);
  run(dir, ["task", "start", "Clean task", "--write-scope", "src"]);
  run(dir, ["checkpoint", "-m", "Clean state", "--status", "Verified", "--next", "Finalize"]);
  run(dir, ["task", "verify", "--status", "passed"]);
  const clean = run(dir, ["task", "finalize"]);
  assert.match(clean, /Finalized task .* \(passed\)/);
  assert.doesNotMatch(clean, /Advisories:/, "a committed, planless, checkpointed task closes without advisory noise");

  run(dir, ["task", "start", "Stale plan task", "--write-scope", "src", "--next", "Old step"]);
  run(dir, ["task", "update", "--clear-next-actions"]);
  run(dir, ["task", "verify", "--status", "passed"]);
  assert.doesNotMatch(
    run(dir, ["task", "finalize"]),
    /remaining next action/,
    "clearing a stale plan removes the next-actions advisory"
  );

  run(dir, ["task", "start", "Path-safe advisory task", "--write-scope", "src"]);
  runGit(dir, ["mv", "src/a.ts", "src/renamed.ts"]);
  writeFileSync(path.join(dir, "src", "файл.ts"), "export const unicode = true;\n", "utf8");
  run(dir, ["task", "verify", "--status", "passed"]);
  const pathSafe = run(dir, ["task", "finalize"]);
  assert.match(pathSafe, /src\/renamed\.ts/, "rename destinations are reported, not their source paths");
  assert.match(pathSafe, /src\/файл\.ts/, "Unicode paths remain inside the write-scope advisory");
});

test("task gate rejects unknown modes, fail-closes on unreadable passports, and reports unchecked paths", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-gate-hardening-test-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["init"]);
  run(dir, ["task", "start", "Gate hardening task"]);

  const configPath = path.join(dir, ".agentpack", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;

  writeFileSync(configPath, JSON.stringify({ ...config, gateMode: "blokc" }, null, 2), "utf8");
  const invalidMode = JSON.parse(run(dir, ["task", "gate", "--file", "src/a.ts", "--json"])) as {
    mode: string;
    decision: string;
    findings: Array<{ code: string; level: string }>;
  };
  assert.equal(invalidMode.mode, "warn", "unknown gateMode must fall back to warn, not silently disable");
  assert.equal(invalidMode.decision, "warn");
  assert.ok(invalidMode.findings.some((finding) => finding.code === "invalid-gate-mode"));

  writeFileSync(configPath, JSON.stringify({ ...config, gateMode: "block" }, null, 2), "utf8");

  const noScope = JSON.parse(run(dir, ["task", "gate", "--file", "src/a.ts", "--json"])) as {
    decision: string;
    findings: Array<{ code: string; level: string }>;
  };
  assert.equal(noScope.decision, "warn", "missing write scope must surface, not block");
  assert.deepEqual(noScope.findings.map((finding) => finding.code), ["no-write-scope"]);

  const outside = JSON.parse(run(dir, ["task", "gate", "--file", "../elsewhere.txt", "--file", "/tmp/elsewhere.txt", "--json"])) as {
    findings: Array<{ code: string; level: string; message: string }>;
  };
  const outsideFinding = outside.findings.find((finding) => finding.code === "outside-root");
  assert.ok(outsideFinding, "paths outside the repository must produce a finding, not a silent skip");
  assert.equal(outsideFinding?.level, "warn");
  assert.match(outsideFinding?.message || "", /\.\.\/elsewhere\.txt/);
  assert.match(outsideFinding?.message || "", /\/tmp\/elsewhere\.txt/);

  run(dir, ["task", "park"]);
  const outsideParked = JSON.parse(run(dir, ["task", "gate", "--file", "/tmp/elsewhere.txt", "--json"])) as {
    decision: string;
    findings: Array<{ code: string }>;
  };
  assert.equal(outsideParked.decision, "warn", "outside-root-only checks must not block on task lifecycle");
  assert.ok(outsideParked.findings.some((finding) => finding.code === "outside-root"));
  assert.ok(
    !outsideParked.findings.some((finding) => finding.code === "task-not-active"),
    "lifecycle findings do not apply when the gate judges none of the paths"
  );
  const inRepoParked = runWithStatus(dir, ["task", "gate", "--file", "src/a.ts"]);
  assert.equal(inRepoParked.status, 2, "in-repo paths still enforce lifecycle in block mode");
  const parkedTaskId = readFileSync(path.join(dir, ".agentpack", "tasks", "current"), "utf8").trim();
  run(dir, ["task", "switch", parkedTaskId]);

  const currentTaskId = readFileSync(path.join(dir, ".agentpack", "tasks", "current"), "utf8").trim();
  const currentPassportPath = path.join(dir, ".agentpack", "tasks", currentTaskId, "passport.json");
  const currentPassport = JSON.parse(readFileSync(currentPassportPath, "utf8")) as Record<string, unknown>;
  delete currentPassport.writeScope;
  writeFileSync(currentPassportPath, JSON.stringify(currentPassport), "utf8");
  const invalidShape = runWithStatus(dir, ["task", "gate", "--file", "src/a.ts"]);
  assert.equal(invalidShape.status, 2, "structurally invalid passport must fail closed in block mode");
  assert.match(invalidShape.stderr, /Task passport is invalid/);

  writeFileSync(path.join(dir, ".agentpack", "tasks", "current"), "task_missing_passport\n", "utf8");
  const unreadable = runWithStatus(dir, ["task", "gate", "--file", "src/a.ts"]);
  assert.equal(unreadable.status, 2, "unreadable passport must fail closed in block mode");
  assert.match(unreadable.stderr, /Cannot read current task passport/);
});

test("task gate --staged skips lifecycle for packs the commit does not touch", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "agentpack-multipack-gate-test-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.name", "Agentpack Test"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);

  const packA = path.join(repo, "packA");
  const packB = path.join(repo, "packB");
  mkdirSync(packA);
  mkdirSync(packB);

  run(packA, ["init"]);
  run(packA, ["task", "start", "Valid work", "--write-scope", "src"]);
  run(packB, ["init"]);
  run(packB, ["task", "start", "Old work"]);
  run(packB, ["task", "finalize", "--status", "accepted", "--summary", "done"]);
  for (const pack of [packA, packB]) {
    const configPath = path.join(pack, ".agentpack", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, gateMode: "block" }, null, 2), "utf8");
  }

  // Switch branches after both tasks recorded their start branch, so an
  // untouched pack also has a genuine branch-drift condition to suppress.
  runGit(repo, ["checkout", "-b", "other-branch"]);

  mkdirSync(path.join(packA, "src"));
  writeFileSync(path.join(packA, "src", "a.txt"), "ok\n", "utf8");
  runGit(repo, ["add", "packA/src/a.txt"]);

  assert.equal(runWithStatus(packA, ["task", "gate", "--staged"]).status, 0);

  const untouched = runWithStatus(packB, ["task", "gate", "--staged"]);
  assert.equal(untouched.status, 0, "a pack with no staged files must not block the commit on its task lifecycle");
  assert.doesNotMatch(untouched.stdout + untouched.stderr, /Current task is closed/);

  const untouchedReport = JSON.parse(runWithStatus(packB, ["task", "gate", "--staged", "--json"]).stdout) as {
    findings: Array<{ code: string }>;
  };
  assert.deepEqual(
    untouchedReport.findings,
    [],
    "an untouched pack (no write scope, real branch drift) must report no findings at all, not even the no-write-scope or branch-drift advisories"
  );

  const noFiles = runWithStatus(packB, ["task", "gate", "--json"]);
  assert.equal(noFiles.status, 2, "no-path invocations must keep lifecycle checks for the MCP gate-warnings layer");
  const noFilesReport = JSON.parse(noFiles.stdout) as { findings: Array<{ code: string }> };
  assert.ok(noFilesReport.findings.some((finding) => finding.code === "task-not-active"));
  assert.ok(
    noFilesReport.findings.some((finding) => finding.code === "no-write-scope"),
    "no-path invocations must keep the no-write-scope advisory too"
  );
  assert.ok(
    noFilesReport.findings.some((finding) => finding.code === "branch-drift"),
    "no-path invocations must keep the branch-drift advisory too"
  );

  writeFileSync(path.join(packB, "b.txt"), "touch\n", "utf8");
  runGit(repo, ["add", "packB/b.txt"]);
  const touched = runWithStatus(packB, ["task", "gate", "--staged"]);
  assert.equal(touched.status, 2, "staging files under the pack root must still enforce lifecycle in block mode");
  assert.match(touched.stderr, /Current task is closed/);
});

test("installs the git-hooks gate and preserves foreign pre-commit hooks", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-githooks-test-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["init"]);

  const preview = run(dir, ["install", "git-hooks"]);
  assert.match(preview, /git-hooks install plan \(dry run\)/);
  const preCommitPath = path.join(dir, ".git", "hooks", "pre-commit");
  assert.equal(existsSync(preCommitPath), false);

  const install = run(dir, ["install", "git-hooks", "--write"]);
  assert.match(install, /Installed Agentpack git-hooks integration/);
  const hook = readFileSync(preCommitPath, "utf8");
  assert.match(hook, /# agentpack:gate/);
  assert.match(hook, /agentpack task gate --staged/);
  assert.match(hook, /-eq 2/, "hook must fail the commit only on gate exit code 2");
  assert.match(hook, /commit allowed \(gate skipped\)/, "hook must degrade gracefully on gate errors");
  assert.match(hook, /agentpack not on PATH; Agentpack task gate skipped/, "hook must say so when agentpack is missing from PATH");
  // The skip branch only uses shell builtins, so an empty PATH directory makes
  // this hermetic: agentpack can never resolve, wherever the host installed it.
  const emptyPathDir = path.join(dir, "empty-path");
  mkdirSync(emptyPathDir);
  const strippedPathRun = execFileSync("/bin/sh", [preCommitPath], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: emptyPathDir }
  });
  assert.match(strippedPathRun, /agentpack not on PATH; Agentpack task gate skipped/, "hook must print the skip notice and allow the commit without agentpack on PATH");
  assert.ok(statSync(preCommitPath).mode & 0o100, "pre-commit hook must be executable");
  assert.match(readFileSync(path.join(dir, ".agentpack", "instructions", "pre-commit-gate.example.sh"), "utf8"), /task gate --staged/);

  const rerun = run(dir, ["install", "git-hooks", "--write"]);
  assert.match(rerun, /UNCHANGED \.git\/hooks\/pre-commit/i);

  chmodSync(preCommitPath, 0o644);
  run(dir, ["install", "git-hooks", "--write"]);
  assert.ok(statSync(preCommitPath).mode & 0o100, "reinstall must restore a lost executable bit");

  const externalHooks = mkdtempSync(path.join(os.tmpdir(), "agentpack-external-hooks-"));
  runGit(dir, ["config", "core.hooksPath", externalHooks]);
  const external = run(dir, ["install", "git-hooks", "--write"]);
  assert.match(external, /outside this repository/);
  assert.equal(existsSync(path.join(externalHooks, "pre-commit")), false, "installer must not write outside the repository");
  runGit(dir, ["config", "--unset", "core.hooksPath"]);

  const foreignHook = "#!/bin/sh\necho custom hook\n";
  writeFileSync(preCommitPath, foreignHook, "utf8");
  const preserved = run(dir, ["install", "git-hooks", "--write"]);
  assert.match(preserved, /Existing pre-commit hook detected and left untouched/);
  assert.equal(readFileSync(preCommitPath, "utf8"), foreignHook);
});

test("ledger compact archives old checkpoints, superseded source events, and stale evidence", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-compact-test-"));
  run(dir, ["init"]);

  writeFileSync(path.join(dir, "a.txt"), "one\n", "utf8");
  run(dir, ["source", "add", "a.txt", "--summary", "first conclusion"]);
  writeFileSync(path.join(dir, "a.txt"), "two\n", "utf8");
  run(dir, ["source", "review", "a.txt", "--summary", "second conclusion"]);
  writeFileSync(path.join(dir, "b.txt"), "gone\n", "utf8");
  run(dir, ["source", "add", "b.txt", "--summary", "to be removed"]);
  run(dir, ["source", "remove", "b.txt"]);

  run(dir, ["record", "decision", "Keep decisions forever."]);
  run(dir, ["record", "dead-end", "Do not try the slow path again."]);
  run(dir, ["evidence", "add", "--kind", "note", "--content", "unreferenced and stale"]);

  run(dir, ["checkpoint", "-m", "first"]);
  run(dir, ["checkpoint", "-m", "second"]);
  run(dir, ["checkpoint", "-m", "third"]);

  const checkpointsDir = path.join(dir, ".agentpack", "checkpoints");
  const before = readdirSync(checkpointsDir).sort();
  assert.equal(before.length, 3);

  const dryRun = run(dir, ["ledger", "compact", "--keep-checkpoints", "1", "--evidence-age-days", "0"]);
  assert.match(dryRun, /dry run, archive mode/);
  assert.match(dryRun, /slim 2 older snapshot/);
  assert.equal(readdirSync(checkpointsDir).sort().length, 3);
  assert.ok(existsSync(path.join(checkpointsDir, before[0] || "", "resume.md")), "dry run must not touch checkpoint files");

  const applied = run(dir, ["ledger", "compact", "--write", "--keep-checkpoints", "1", "--evidence-age-days", "0"]);
  assert.match(applied, /Ledger compact applied \(archive mode\)/);

  for (const slimmed of before.slice(0, 2)) {
    assert.ok(existsSync(path.join(checkpointsDir, slimmed, "checkpoint.json")), "checkpoint.json must stay");
    assert.equal(existsSync(path.join(checkpointsDir, slimmed, "resume.md")), false, "heavy files must be archived");
    assert.ok(existsSync(path.join(dir, ".agentpack", "archive", "checkpoints", slimmed, "resume.md")), "heavy files must land in the archive");
  }
  assert.ok(existsSync(path.join(checkpointsDir, before[2] || "", "resume.md")), "newest checkpoint stays full");

  const events = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8");
  assert.match(events, /Keep decisions forever/);
  assert.match(events, /Do not try the slow path again/);
  assert.match(events, /second conclusion/, "latest source conclusion for a live path must stay");
  assert.doesNotMatch(events, /first conclusion/, "superseded source events must be archived");
  assert.doesNotMatch(events, /to be removed/, "events for pruned sources must be archived");
  assert.match(events, /ledger-compact/, "compaction must be recorded as an event");

  const archiveEvents = readdirSync(path.join(dir, ".agentpack", "archive")).filter((name) => name.startsWith("events-"));
  assert.equal(archiveEvents.length, 1);
  assert.match(readFileSync(path.join(dir, ".agentpack", "archive", archiveEvents[0] || ""), "utf8"), /first conclusion/);

  assert.equal(readdirSync(path.join(dir, ".agentpack", "evidence")).length, 0, "unreferenced stale evidence must be archived");
  assert.equal(readdirSync(path.join(dir, ".agentpack", "archive", "evidence")).length, 1);

  assert.match(run(dir, ["replay"]), /ledger-compact/);
  assert.match(run(dir, ["resume", "--preset", "quick"]), /Keep decisions forever|Agentpack Resume/);

  const again = run(dir, ["ledger", "compact", "--write", "--keep-checkpoints", "1", "--evidence-age-days", "0"]);
  assert.match(again, /Nothing to compact/);

  run(dir, ["evidence", "add", "--kind", "note", "--content", "purge me"]);
  const purged = run(dir, ["ledger", "compact", "--write", "--purge", "--keep-checkpoints", "1", "--evidence-age-days", "0"]);
  assert.match(purged, /purge mode/);
  assert.equal(readdirSync(path.join(dir, ".agentpack", "evidence")).length, 0, "purge must delete instead of archiving");
  assert.equal(readdirSync(path.join(dir, ".agentpack", "archive", "evidence")).length, 1, "purge must not add to the archive");
});

test("ledger compact refuses traversal and symlink evidence paths", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-compact-traversal-test-"));
  run(dir, ["init"]);
  run(dir, ["task", "start", "Traversal target task"]);
  run(dir, ["task", "park"]);

  const tasksDir = path.join(dir, ".agentpack", "tasks");
  const taskId = readdirSync(tasksDir).find((name) => name.startsWith("task_")) || "";
  const passportPath = path.join(tasksDir, taskId, "passport.json");
  assert.ok(existsSync(passportPath));

  const outsideFile = path.join(dir, "outside-secret.txt");
  writeFileSync(outsideFile, "keep me\n", "utf8");
  const evidenceDir = path.join(dir, ".agentpack", "evidence");
  symlinkSync(outsideFile, path.join(evidenceDir, "ev_link.txt"));

  const maliciousEvents = [
    { id: "evt_traversal", ts: "2020-01-01T00:00:00.000Z", type: "evidence", kind: "note", path: `evidence/../tasks/${taskId}/passport.json` },
    { id: "evt_absolute", ts: "2020-01-01T00:00:01.000Z", type: "evidence", kind: "note", path: "evidence/nested/../../sources.json" },
    { id: "evt_symlink", ts: "2020-01-01T00:00:02.000Z", type: "evidence", kind: "note", path: "evidence/ev_link.txt" }
  ].map((event) => JSON.stringify(event)).join("\n");
  const eventsPath = path.join(dir, ".agentpack", "events.jsonl");
  writeFileSync(eventsPath, `${readFileSync(eventsPath, "utf8")}${maliciousEvents}\n`, "utf8");

  const plan = run(dir, ["ledger", "compact", "--evidence-age-days", "0"]);
  assert.match(plan, /archive 0 unreferenced file\(s\)/, "traversal and symlink evidence paths must not enter the plan");

  run(dir, ["ledger", "compact", "--write", "--purge", "--evidence-age-days", "0"]);
  assert.ok(existsSync(passportPath), "purge must never delete files outside evidence/");
  assert.ok(existsSync(path.join(dir, ".agentpack", "sources.json")), "purge must never delete pack metadata");
  assert.ok(existsSync(outsideFile), "symlink targets must survive");
  assert.ok(existsSync(path.join(evidenceDir, "ev_link.txt")), "symlinked evidence entries must be left untouched");
});

test("ledger compact fails closed when a task passport hides its referenced evidence", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-compact-passport-test-"));
  run(dir, ["init"]);
  run(dir, ["task", "start", "Broken passport task"]);
  run(dir, ["evidence", "add", "--kind", "note", "--content", "must survive a broken passport"]);
  run(dir, ["task", "park"]);

  const tasksDir = path.join(dir, ".agentpack", "tasks");
  const taskId = readdirSync(tasksDir).find((name) => name.startsWith("task_")) || "";
  const passportPath = path.join(tasksDir, taskId, "passport.json");
  const passport = JSON.parse(readFileSync(passportPath, "utf8")) as Record<string, unknown>;
  delete passport.verification;
  writeFileSync(passportPath, JSON.stringify(passport), "utf8");

  const error = runExpectError(dir, ["ledger", "compact", "--write", "--purge", "--evidence-age-days", "0"]);
  assert.match(error, /cannot determine its referenced evidence/);
  assert.equal(readdirSync(path.join(dir, ".agentpack", "evidence")).length, 1, "evidence must stay when a passport cannot be read");

  assert.match(run(dir, ["ledger", "status"]), /Evidence/, "ledger status must stay best-effort with a broken passport");
});

test("ledger compact keeps aliased referenced evidence and evidence with malformed timestamps", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-compact-alias-test-"));
  run(dir, ["init"]);
  run(dir, ["evidence", "add", "--kind", "note", "--content", "referenced payload"]);

  const evidenceDir = path.join(dir, ".agentpack", "evidence");
  const referencedFile = readdirSync(evidenceDir)[0] || "";
  assert.ok(referencedFile, "evidence add must create a file");

  const eventsPath = path.join(dir, ".agentpack", "events.jsonl");
  const evidenceEvent = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string; type: string })
    .find((event) => event.type === "evidence");
  assert.ok(evidenceEvent, "evidence add must record an event");

  writeFileSync(path.join(evidenceDir, "ev_unknown_age.txt"), "unknown age\n", "utf8");

  const crafted = [
    { id: "evt_ref", ts: "2020-01-01T00:00:00.000Z", type: "verification", evidence: [evidenceEvent.id] },
    { id: "evt_alias", ts: "2020-01-01T00:00:01.000Z", type: "evidence", kind: "note", path: `evidence/${referencedFile}` },
    { id: "evt_bad_ts", ts: "not-a-date", type: "evidence", kind: "note", path: "evidence/ev_unknown_age.txt" }
  ].map((event) => JSON.stringify(event)).join("\n");
  writeFileSync(eventsPath, `${readFileSync(eventsPath, "utf8")}${crafted}\n`, "utf8");

  const plan = run(dir, ["ledger", "compact", "--evidence-age-days", "0"]);
  assert.match(plan, /archive 0 unreferenced file\(s\)/, "aliased and unknown-age evidence must not enter the plan");

  run(dir, ["ledger", "compact", "--write", "--purge", "--evidence-age-days", "0"]);
  assert.ok(existsSync(path.join(evidenceDir, referencedFile)), "an unreferenced event aliasing a referenced file's path must not purge it");
  assert.ok(existsSync(path.join(evidenceDir, "ev_unknown_age.txt")), "evidence with a malformed timestamp must survive purge");
});

test("ledger compact rejects invalid numeric options", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-compact-options-test-"));
  run(dir, ["init"]);
  assert.match(
    runExpectError(dir, ["ledger", "compact", "--keep-checkpoints", "abc"]),
    /--keep-checkpoints requires a non-negative number/
  );
  assert.match(
    runExpectError(dir, ["ledger", "compact", "--evidence-age-days", "3O"]),
    /--evidence-age-days requires a non-negative number/
  );

  run(dir, ["checkpoint", "-m", "inline false must stay dry"]);
  const checkpointId = readdirSync(path.join(dir, ".agentpack", "checkpoints"))[0] || "";
  const checkpointDir = path.join(dir, ".agentpack", "checkpoints", checkpointId);
  const dryRun = run(dir, ["ledger", "compact", "--write=false", "--purge=false", "--keep-checkpoints=0"]);
  assert.match(dryRun, /dry run, archive mode/);
  assert.ok(existsSync(path.join(checkpointDir, "resume.md")), "--write=false must not apply compaction");
});

test("resume and evidence ingestion reject escaping and symlinked files", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-evidence-containment-test-"));
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-evidence-outside-test-"));
  const outsideFile = path.join(outsideDir, "secret.txt");
  writeFileSync(outsideFile, "outside-secret-value\n", "utf8");
  run(dir, ["init"]);

  symlinkSync(outsideFile, path.join(dir, "secret-link.txt"));
  assert.match(runExpectError(dir, ["evidence", "add", "--file", "secret-link.txt"]), /symbolic-link evidence file/);
  assert.match(runExpectError(dir, ["source", "add", "secret-link.txt", "--summary", "unsafe"]), /symbolic-link source file/);

  const eventsPath = path.join(dir, ".agentpack", "events.jsonl");
  writeFileSync(eventsPath, `${JSON.stringify({
    id: "evt_escape",
    ts: new Date().toISOString(),
    type: "evidence",
    kind: "note",
    path: path.relative(path.join(dir, ".agentpack"), outsideFile)
  })}\n`, "utf8");
  const resume = run(dir, ["resume", "--preset", "deep"]);
  assert.match(resume, /unsafe or unreadable evidence path omitted/);
  assert.doesNotMatch(resume, /outside-secret-value/);
});

test("legacy export targets stay inside the exports directory and note evidence omits exit code", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-export-containment-test-"));
  run(dir, ["init"]);
  assert.match(runExpectError(dir, ["export", "--to", "../../outside"]), /Invalid export target/);
  assert.equal(existsSync(path.join(dir, "outside-handoff.md")), false);

  run(dir, ["evidence", "add", "--content", "plain note"]);
  const event = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; exitCode?: number | null })
    .find((entry) => entry.type === "evidence");
  assert.equal(event?.exitCode, null);
});

test("install dry-run is pure and installer rejects symlink destinations", { skip: process.platform === "win32" }, () => {
  const dryRunDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-install-pure-test-"));
  mkdirSync(path.join(dryRunDir, ".agentpack"));
  assert.match(run(dryRunDir, ["install", "codex"]), /No files were changed/);
  assert.equal(existsSync(path.join(dryRunDir, ".agentpack", "instructions")), false);

  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-install-symlink-test-"));
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), "agentpack-install-outside-test-"));
  const victim = path.join(outsideDir, "AGENTS.md");
  writeFileSync(victim, "victim-original\n", "utf8");
  run(dir, ["init"]);
  symlinkSync(victim, path.join(dir, "AGENTS.md"));
  assert.match(runExpectError(dir, ["install", "codex", "--write"]), /symbolic link/);
  assert.equal(readFileSync(victim, "utf8"), "victim-original\n");
});

test("git hook shell-quotes repository roots", { skip: process.platform === "win32" }, () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "agentpack-hook-quote-test-"));
  const dir = path.join(parent, "repo-$(touch marker)-'quote");
  mkdirSync(dir);
  runGit(dir, ["init"]);
  run(dir, ["init"]);
  run(dir, ["install", "git-hooks", "--write"]);
  const hook = readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(hook, /run_gate '\/.*\$\(touch marker\).*'"'"'quote'/);
  assert.doesNotMatch(hook, /run_gate "[^\n]*\$\(touch marker\)/);
});

test("ledger compact rolls back on staging failure and rejects symlinked archives", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-compact-rollback-test-"));
  writeFileSync(path.join(dir, "source.txt"), "source\n", "utf8");
  run(dir, ["init"]);
  run(dir, ["source", "add", "source.txt", "--summary", "first"]);
  run(dir, ["source", "add", "source.txt", "--summary", "second"]);
  run(dir, ["checkpoint", "-m", "must survive failed compact"]);
  const checkpointId = readdirSync(path.join(dir, ".agentpack", "checkpoints"))[0] || "";
  const checkpointDir = path.join(dir, ".agentpack", "checkpoints", checkpointId);
  const cacheDir = path.join(dir, ".agentpack", "cache");
  chmodSync(cacheDir, 0o500);
  try {
    assert.match(
      runExpectError(dir, ["ledger", "compact", "--write", "--purge", "--keep-checkpoints", "0"]),
      /EACCES|permission denied/
    );
  } finally {
    chmodSync(cacheDir, 0o700);
  }
  assert.ok(existsSync(path.join(checkpointDir, "resume.md")), "failed compact must not delete checkpoint files");

  const archiveTarget = mkdtempSync(path.join(os.tmpdir(), "agentpack-compact-archive-target-"));
  symlinkSync(archiveTarget, path.join(dir, ".agentpack", "archive"));
  assert.match(runExpectError(dir, ["ledger", "compact", "--write", "--keep-checkpoints", "0"]), /unsafe directory/);
  assert.deepEqual(readdirSync(archiveTarget), []);
  assert.ok(existsSync(path.join(checkpointDir, "resume.md")));
});

test("installs the git-hooks gate for a pack in a repository subdirectory", { skip: process.platform === "win32" }, () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "agentpack-subdir-hooks-test-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.name", "Agentpack Test"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  const packDir = path.join(repo, "services", "ledger");
  mkdirSync(packDir, { recursive: true });
  run(packDir, ["init"]);

  const install = run(packDir, ["install", "git-hooks", "--write"]);
  assert.match(install, /Installed Agentpack git-hooks integration/);
  assert.match(install, /The hook runs the gate for the Agentpack pack at/);

  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  const hook = readFileSync(hookPath, "utf8");
  assert.match(hook, /cd "/, "hook must change into the pack directory before running the gate");
  assert.match(hook, /services\/ledger/);
  assert.match(hook, /task gate --staged/);

  const secondPack = path.join(repo, "tools", "ops");
  mkdirSync(secondPack, { recursive: true });
  run(secondPack, ["init"]);
  const second = run(secondPack, ["install", "git-hooks", "--write"]);
  assert.match(second, /gates 2 packs/);
  const merged = readFileSync(hookPath, "utf8");
  assert.match(merged, /services\/ledger/, "adding a second pack must keep the first pack gated");
  assert.match(merged, /tools\/ops/);
  assert.equal(merged.match(/^\s*# agentpack:root-base64 /gm)?.length, 2);

  const rerun = run(secondPack, ["install", "git-hooks", "--write"]);
  assert.match(rerun, /UNCHANGED/i, "re-installing from either pack must be idempotent");

  const binDir = path.join(repo, "test-bin");
  mkdirSync(binDir);
  const agentpackShim = path.join(binDir, "agentpack");
  writeFileSync(agentpackShim, [
    "#!/usr/bin/env node",
    "const { spawnSync } = require('node:child_process');",
    `const result = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
    "process.exit(result.status ?? 1);",
    ""
  ].join("\n"), "utf8");
  chmodSync(agentpackShim, 0o755);
  const hookEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` };

  run(packDir, ["task", "start", "Pack one hook coverage", "--write-scope", "allowed.txt"]);
  run(secondPack, ["task", "start", "Pack two hook coverage", "--write-scope", "allowed.txt"]);
  const secondConfigPath = path.join(secondPack, ".agentpack", "config.json");
  const secondConfig = JSON.parse(readFileSync(secondConfigPath, "utf8")) as Record<string, unknown>;
  writeFileSync(secondConfigPath, JSON.stringify({ ...secondConfig, gateMode: "block" }, null, 2), "utf8");

  writeFileSync(path.join(packDir, "allowed.txt"), "clean\n", "utf8");
  runGit(repo, ["add", "services/ledger/allowed.txt"]);
  const clean = spawnSync("/bin/sh", [hookPath], { cwd: repo, encoding: "utf8", env: hookEnv });
  assert.equal(clean.status, 0);
  assert.equal(`${clean.stdout}${clean.stderr}`.trim(), "", "clean and untouched packs must not print labels");

  writeFileSync(path.join(packDir, "unexpected.txt"), "warn\n", "utf8");
  writeFileSync(path.join(secondPack, "unexpected.txt"), "block\n", "utf8");
  runGit(repo, ["add", "services/ledger/unexpected.txt", "tools/ops/unexpected.txt"]);
  const mixed = spawnSync("/bin/sh", [hookPath], { cwd: repo, encoding: "utf8", env: hookEnv });
  const mixedOutput = `${mixed.stdout}${mixed.stderr}`;
  assert.equal(mixed.status, 2, "one blocking pack must still block the shared hook");
  assert.match(mixedOutput, /Agentpack gate \[services\/ledger\][\s\S]*Gate: warn/);
  assert.match(mixedOutput, /Agentpack gate \[tools\/ops\][\s\S]*Gate: block/);
});

test("claude install registers the gate PreToolUse hook idempotently", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-claude-hooks-test-"));
  run(dir, ["init"]);
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({
    env: { KEEP: "1" },
    hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] }],
      PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "agentpack task gate --client claude" }] }]
    }
  }, null, 2), "utf8");

  run(dir, ["install", "claude", "--write"]);
  run(dir, ["install", "claude", "--write"]);

  const settings = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")) as {
    env: Record<string, string>;
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>; PostToolUse: unknown[] };
  };
  assert.equal(settings.env.KEEP, "1");
  assert.equal(settings.hooks.PostToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse.length, 1, "old PATH-based gate entries must be upgraded, not duplicated");
  assert.equal(settings.hooks.PreToolUse[0]?.matcher, "Edit|Write|MultiEdit|NotebookEdit");
  const gateCommand = settings.hooks.PreToolUse[0]?.hooks[0]?.command || "";
  assert.match(gateCommand, /task gate --client claude$/);
  assert.match(gateCommand, /agentpack\.js/, "hook must launch through the Agentpack entrypoint, not the shell PATH");
  assert.ok(!gateCommand.startsWith("agentpack "), "hook must not depend on agentpack being on PATH");
});

test("codex and cursor installs merge native task-gate hooks idempotently", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-native-hooks-test-"));
  run(dir, ["init"]);
  mkdirSync(path.join(dir, ".codex"), { recursive: true });
  mkdirSync(path.join(dir, ".cursor"), { recursive: true });
  writeFileSync(path.join(dir, ".codex", "hooks.json"), JSON.stringify({
    keep: true,
    hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] }],
      PreToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command: "agentpack task gate --client codex" }] }]
    }
  }, null, 2), "utf8");
  writeFileSync(path.join(dir, ".cursor", "hooks.json"), JSON.stringify({
    version: 1,
    keep: true,
    hooks: {
      postToolUse: [{ command: "echo done", matcher: "Shell" }],
      preToolUse: [{ command: "agentpack task gate --client cursor", matcher: "Write" }]
    }
  }, null, 2), "utf8");

  run(dir, ["install", "codex", "--write"]);
  run(dir, ["install", "codex", "--write"]);
  run(dir, ["install", "cursor", "--write"]);
  run(dir, ["install", "cursor", "--write"]);

  const codex = JSON.parse(readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8")) as {
    keep: boolean;
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; commandWindows: string }> }>; PostToolUse: unknown[] };
  };
  assert.equal(codex.keep, true);
  assert.equal(codex.hooks.PostToolUse.length, 1);
  assert.equal(codex.hooks.PreToolUse.length, 1);
  assert.match(codex.hooks.PreToolUse[0]?.hooks[0]?.command || "", /agentpack\.js.*task gate --client codex$/);
  assert.match(codex.hooks.PreToolUse[0]?.hooks[0]?.commandWindows || "", /^".*agentpack\.js" task gate --client codex$/);

  const cursor = JSON.parse(readFileSync(path.join(dir, ".cursor", "hooks.json"), "utf8")) as {
    keep: boolean;
    hooks: { preToolUse: Array<{ command: string }>; postToolUse: unknown[] };
  };
  assert.equal(cursor.keep, true);
  assert.equal(cursor.hooks.postToolUse.length, 1);
  assert.equal(cursor.hooks.preToolUse.length, 1);
  assert.match(cursor.hooks.preToolUse[0]?.command || "", /agentpack\.js.*task gate --client cursor$/);

  const doctor = buildDoctorReport(dir).text;
  assert.match(doctor, /\[ok\] Codex gate: native task gate configured/);
  assert.match(doctor, /\[ok\] Cursor gate: native task gate configured/);

  unlinkSync(path.join(dir, ".cursor", "hooks.json"));
  const missingCursorGate = buildDoctorReport(dir).text;
  assert.match(missingCursorGate, /\[warn\] Cursor gate: native task gate is missing/);
});

test("doctor distinguishes compatible alternate gate launchers from broken launchers", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-gate-doctor-test-"));
  run(dir, ["init"]);
  run(dir, ["install", "codex", "--write"]);
  run(dir, ["install", "cursor", "--write"]);

  const currentDoctor = buildDoctorReport(dir).text;
  assert.match(currentDoctor, /\[ok\] Codex gate: native task gate configured/);
  assert.match(currentDoctor, /\[ok\] Cursor gate: native task gate configured/);

  const alternateRoot = path.join(dir, "alternate Agent's pack");
  const alternateNode = process.platform === "win32" ? process.execPath : path.join(alternateRoot, "bin", "nodejs");
  const alternateEntrypoint = path.join(alternateRoot, "dist", "src", "agentpack.js");
  if (process.platform !== "win32") {
    mkdirSync(path.dirname(alternateNode), { recursive: true });
    symlinkSync(process.execPath, alternateNode);
  }
  mkdirSync(path.dirname(alternateEntrypoint), { recursive: true });
  const alternateEntrypointContent = `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(cli).href)};\n`;
  writeFileSync(alternateEntrypoint, alternateEntrypointContent, "utf8");
  writeFileSync(path.join(alternateRoot, "package.json"), JSON.stringify({
    name: "agentpack-cli",
    version: "1.6.1",
    type: "module",
    bin: { agentpack: "dist/src/agentpack.js" }
  }), "utf8");

  const codexHooksPath = path.join(dir, ".codex", "hooks.json");
  const cursorHooksPath = path.join(dir, ".cursor", "hooks.json");
  const codexHooks = JSON.parse(readFileSync(codexHooksPath, "utf8"));
  const cursorHooks = JSON.parse(readFileSync(cursorHooksPath, "utf8"));
  const codexHandler = codexHooks.hooks.PreToolUse[0].hooks[0];
  const cursorHandler = cursorHooks.hooks.preToolUse[0];
  const alternateCodexCommand = formatClientGateCommand(alternateNode, alternateEntrypoint, "codex", "posix");
  const alternateCursorCommand = formatClientGateCommand(
    alternateNode,
    alternateEntrypoint,
    "cursor",
    process.platform === "win32" ? "win32" : "posix"
  );
  codexHandler.command = alternateCodexCommand;
  codexHandler.commandWindows = formatClientGateCommand(alternateNode, alternateEntrypoint, "codex", "win32");
  cursorHandler.command = alternateCursorCommand;
  writeFileSync(codexHooksPath, JSON.stringify(codexHooks, null, 2), "utf8");
  writeFileSync(cursorHooksPath, JSON.stringify(cursorHooks, null, 2), "utf8");

  const alternateDoctor = buildDoctorReport(dir).text;
  assert.match(execFileSync(alternateNode, [alternateEntrypoint, "--help"], { encoding: "utf8" }), /Agentpack/);
  assert.match(alternateDoctor, /\[ok\] Codex gate: native task gate launcher is structurally compatible with another Agentpack installation; runtime not probed/);
  assert.match(alternateDoctor, /\[ok\] Cursor gate: native task gate launcher is structurally compatible with another Agentpack installation; runtime not probed/);

  const missingNode = path.join(alternateRoot, "missing", process.platform === "win32" ? "node.exe" : "node");
  codexHandler.command = formatClientGateCommand(missingNode, alternateEntrypoint, "codex", "posix");
  codexHandler.commandWindows = formatClientGateCommand(missingNode, alternateEntrypoint, "codex", "win32");
  cursorHandler.command = formatClientGateCommand(
    missingNode,
    alternateEntrypoint,
    "cursor",
    process.platform === "win32" ? "win32" : "posix"
  );
  writeFileSync(codexHooksPath, JSON.stringify(codexHooks, null, 2), "utf8");
  writeFileSync(cursorHooksPath, JSON.stringify(cursorHooks, null, 2), "utf8");
  const missingNodeDoctor = buildDoctorReport(dir).text;
  assert.match(missingNodeDoctor, /\[warn\] Codex gate: launcher Node\.js executable does not exist or is not executable/);
  assert.match(missingNodeDoctor, /\[warn\] Cursor gate: launcher Node\.js executable does not exist or is not executable/);

  codexHandler.command = alternateCodexCommand;
  codexHandler.commandWindows = formatClientGateCommand(alternateNode, alternateEntrypoint, "codex", "win32");
  cursorHandler.command = alternateCursorCommand;
  writeFileSync(codexHooksPath, JSON.stringify(codexHooks, null, 2), "utf8");
  writeFileSync(cursorHooksPath, JSON.stringify(cursorHooks, null, 2), "utf8");

  unlinkSync(alternateEntrypoint);
  const missingEntrypointDoctor = buildDoctorReport(dir).text;
  assert.match(missingEntrypointDoctor, /\[warn\] Codex gate: Agentpack entrypoint does not exist, is unreadable, or is empty/);
  assert.match(missingEntrypointDoctor, /\[warn\] Cursor gate: Agentpack entrypoint does not exist, is unreadable, or is empty/);
  writeFileSync(alternateEntrypoint, "", "utf8");
  const emptyEntrypointDoctor = buildDoctorReport(dir).text;
  assert.match(emptyEntrypointDoctor, /\[warn\] Codex gate: Agentpack entrypoint does not exist, is unreadable, or is empty/);
  assert.match(emptyEntrypointDoctor, /\[warn\] Cursor gate: Agentpack entrypoint does not exist, is unreadable, or is empty/);
  writeFileSync(alternateEntrypoint, alternateEntrypointContent, "utf8");

  cursorHandler.command = `${alternateCursorCommand} --unexpected`;
  writeFileSync(cursorHooksPath, JSON.stringify(cursorHooks, null, 2), "utf8");
  const malformedDoctor = buildDoctorReport(dir).text;
  assert.match(malformedDoctor, /\[warn\] Cursor gate: launcher command is malformed/);

  cursorHandler.command = alternateCursorCommand;
  writeFileSync(cursorHooksPath, JSON.stringify(cursorHooks, null, 2), "utf8");
  writeFileSync(path.join(alternateRoot, "package.json"), JSON.stringify({
    name: "agentpack-cli",
    version: "1.2.0-alpha.1",
    type: "module",
    bin: { agentpack: "dist/src/agentpack.js" }
  }), "utf8");
  const prereleaseDoctor = buildDoctorReport(dir).text;
  assert.match(prereleaseDoctor, /\[warn\] Codex gate: launcher does not point at a compatible agentpack-cli installation/);
  assert.match(prereleaseDoctor, /\[warn\] Cursor gate: launcher does not point at a compatible agentpack-cli installation/);

  writeFileSync(path.join(alternateRoot, "package.json"), JSON.stringify({
    name: "agentpack-cli",
    version: "2.0.0",
    type: "module",
    bin: { agentpack: "dist/src/agentpack.js" }
  }), "utf8");
  const nextMajorDoctor = buildDoctorReport(dir).text;
  assert.match(nextMajorDoctor, /\[warn\] Codex gate: launcher does not point at a compatible agentpack-cli installation/);
  assert.match(nextMajorDoctor, /\[warn\] Cursor gate: launcher does not point at a compatible agentpack-cli installation/);

  writeFileSync(path.join(alternateRoot, "package.json"), JSON.stringify({
    name: "agentpack-cli",
    version: "01.2.0+invalid..metadata",
    type: "module",
    bin: { agentpack: "dist/src/agentpack.js" }
  }), "utf8");
  const malformedVersionDoctor = buildDoctorReport(dir).text;
  assert.match(malformedVersionDoctor, /\[warn\] Codex gate: launcher does not point at a compatible agentpack-cli installation/);
  assert.match(malformedVersionDoctor, /\[warn\] Cursor gate: launcher does not point at a compatible agentpack-cli installation/);
});

test("formats native gate commands for POSIX and Windows shells", () => {
  assert.equal(
    formatClientGateCommand("/opt/Node's/bin/node", "/tmp/Agent Pack/agentpack.js", "codex", "posix"),
    "'/opt/Node'\"'\"'s/bin/node' '/tmp/Agent Pack/agentpack.js' task gate --client codex"
  );
  assert.equal(
    formatClientGateCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\Agent Pack\\agentpack.js", "cursor", "win32"),
    "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Agent Pack\\agentpack.js\" task gate --client cursor"
  );
});

test("task list survives a corrupt background passport and reports a warning", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-tasklist-corrupt-test-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "Agentpack Test"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["init"]);

  run(dir, ["task", "start", "Good background task"]);
  const goodId = JSON.parse(run(dir, ["task", "passport"])).id;
  run(dir, ["task", "park"]);

  run(dir, ["task", "start", "Current task"]);
  const currentId = JSON.parse(run(dir, ["task", "passport"])).id;

  const corruptPassportPath = path.join(dir, ".agentpack", "tasks", goodId, "passport.json");
  writeFileSync(corruptPassportPath, "{ invalid json", "utf8");

  const listing = runWithStatus(dir, ["task", "list"]);
  assert.equal(listing.status, 0, "a corrupt background passport must not crash task list");
  assert.match(listing.stdout, new RegExp(`\\[warn\\] Unreadable task passport ${goodId}:`));
  assert.match(listing.stdout, new RegExp(`\\* ${currentId} \\[active\\] Current task`));
  assert.doesNotMatch(listing.stdout, /Good background task/);

  const mcp = createMcpHarness(dir);
  const mcpListing = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "task_list", arguments: {} }
  });
  const mcpText = mcpListing.result.content[0].text;
  assert.match(mcpText, new RegExp(`\\[warn\\] Unreadable task passport ${goodId}:`));
  assert.match(mcpText, new RegExp(`\\* ${currentId} \\[active\\] Current task`));

  const mcpListingJson = await mcp.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "task_list", arguments: { json: true } }
  });
  const parsed: Array<{ id: string }> = JSON.parse(mcpListingJson.result.content[0].text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.id, currentId);
  const warnings = mcpListingJson.result._meta?.["io.agentpack/taskListWarnings"] as string[];
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] || "", new RegExp(`Unreadable task passport ${goodId}:`));

  const modernListingJson = await mcp.send({
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "agentpack-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      },
      name: "task_list",
      arguments: { json: true }
    }
  });
  assert.deepEqual(JSON.parse(modernListingJson.result.content[0].text), parsed);
  assert.deepEqual(modernListingJson.result._meta["io.agentpack/taskListWarnings"], warnings);
  assert.equal(modernListingJson.result._meta["io.modelcontextprotocol/serverInfo"].name, "agentpack");
  assert.equal(modernListingJson.result.resultType, "complete");

  writeFileSync(path.join(dir, ".agentpack", "tasks", currentId, "passport.json"), "{ invalid json", "utf8");
  const mcpAllCorruptJson = await mcp.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "task_list", arguments: { json: true } }
  });
  assert.deepEqual(JSON.parse(mcpAllCorruptJson.result.content[0].text), []);
  assert.equal(mcpAllCorruptJson.result._meta?.["io.agentpack/taskListWarnings"]?.length, 2);
});

test("parks current task over MCP so a new task can start", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-mcp-park-test-"));
  writeFileSync(path.join(dir, "index.js"), "console.log('park')\n", "utf8");
  run(dir, ["init"]);

  const mcp = createMcpHarness(dir);

  const emptyListJson = await mcp.send({
    jsonrpc: "2.0",
    id: 90,
    method: "tools/call",
    params: { name: "task_list", arguments: { json: true } }
  });
  assert.deepEqual(JSON.parse(emptyListJson.result.content[0].text), []);
  assert.equal(emptyListJson.result._meta, undefined);

  const taskStart = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "task_start",
      arguments: {
        title: "Parkable MCP task",
        nextActions: ["Resume later"],
        writeScope: ["api", "frontend", "cron", "service"]
      }
    }
  });
  assert.match(taskStart.result.content[0].text, /Started task task_/);

  const refusedFinalize = await mcp.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "task_finalize",
      arguments: {
        status: "accepted",
        summary: "Pause for another task."
      }
    }
  });
  assert.match(refusedFinalize.error?.message, /Use `agentpack task park` for deferred work/);

  const taskPark = await mcp.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "task_park",
      arguments: {}
    }
  });
  assert.match(taskPark.result.content[0].text, /Parked task task_/);
  const parkedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(parkedPassport.status, "parked");
  assert.equal(parkedPassport.title, "Parkable MCP task");

  const replacementStart = await mcp.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "task_start",
      arguments: {
        title: "Replacement MCP task"
      }
    }
  });
  assert.match(replacementStart.result.content[0].text, /Started task task_/);

  const status = await mcp.send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "task_status",
      arguments: {}
    }
  });
  assert.match(status.result.content[0].text, /Replacement MCP task \[active\]/);

  const tasks = run(dir, ["task", "list"]);
  assert.match(tasks, /- task_.* \[parked\] Parkable MCP task \(scope: api, frontend, cron \+1 more\)/);
  assert.match(tasks, /\* task_.* \[active\] Replacement MCP task/);
  assert.doesNotMatch(tasks, /Replacement MCP task.*scope:/);

  const scopedTasks = run(dir, ["task", "list", "--scope", "api/auth"]);
  assert.match(scopedTasks, /Parkable MCP task/);
  assert.doesNotMatch(scopedTasks, /Replacement MCP task/, "tasks without a write scope are omitted from filtered output");
  assert.match(run(dir, ["task", "list", "--scope", "docs"]), /No task passports match scope docs/);
  assert.match(runExpectError(dir, ["task", "list", "--scope"]), /--scope requires a path/);
  assert.match(runExpectError(dir, ["task", "list", "--scope="]), /--scope requires a path/, "empty inline value must not match everything");
  assert.match(runExpectError(dir, ["task", "list", "--scope", "  "]), /--scope requires a path/);
  assert.match(run(dir, ["task", "list", "--scope=api"]), /Parkable MCP task/, "inline --scope=value form");
  assert.match(run(dir, ["task", "list", "--scope", "./api"]), /Parkable MCP task/, "leading ./ is normalized");
  assert.match(run(dir, ["task", "list", "--scope", "api/"]), /Parkable MCP task/, "trailing slash is normalized");
  const dotScoped = run(dir, ["task", "list", "--scope", "."]);
  assert.match(dotScoped, /Parkable MCP task/);
  assert.doesNotMatch(dotScoped, /Replacement MCP task/, "dot filter still omits scopeless tasks");
  const unionScoped = run(dir, ["task", "list", "--scope", "docs", "--scope", "cron"]);
  assert.match(unionScoped, /Parkable MCP task/, "repeated --scope unions filters");

  const parkedOnly = run(dir, ["task", "list", "--status", "parked"]);
  assert.match(parkedOnly, /Parkable MCP task/);
  assert.doesNotMatch(parkedOnly, /Replacement MCP task/);
  const statusUnion = run(dir, ["task", "list", "--status", "parked", "--status", "active"]);
  assert.match(statusUnion, /Parkable MCP task/);
  assert.match(statusUnion, /Replacement MCP task/, "repeated --status unions filters");
  const openTasks = run(dir, ["task", "list", "--open"]);
  assert.match(openTasks, /Parkable MCP task/);
  assert.match(openTasks, /Replacement MCP task/);
  assert.match(
    run(dir, ["task", "list", "--status", "completed"]),
    /No task passports match status completed/
  );
  const openScoped = run(dir, ["task", "list", "--open", "--scope", "api"]);
  assert.match(openScoped, /Parkable MCP task/, "--open combines with --scope as AND");
  assert.doesNotMatch(openScoped, /Replacement MCP task/, "scopeless open task filtered out by --scope");
  assert.match(runExpectError(dir, ["task", "list", "--status", "bogus"]), /--status requires one of: active, parked/);
  assert.match(runExpectError(dir, ["task", "list", "--status"]), /--status requires one of/);
  assert.match(runExpectError(dir, ["task", "list", "--open", "--status", "parked"]), /--open cannot be combined with --status/);
  assert.match(runExpectError(dir, ["task", "list", "--open", "now"]), /--open takes no value/);
  assert.match(run(dir, ["task", "list", "--status=parked"]), /Parkable MCP task/, "inline --status=value form");
  assert.match(run(dir, ["task", "list", "--open", "--open"]), /Parkable MCP task/, "duplicate --open is idempotent");
  const statusScoped = run(dir, ["task", "list", "--status", "parked", "--scope", "api"]);
  assert.match(statusScoped, /Parkable MCP task/, "--status combines with --scope as AND");
  assert.match(
    run(dir, ["task", "list", "--status", "completed", "--scope", "api"]),
    /No task passports match scope api and status completed/,
    "combined no-match message names both filters"
  );
  assert.match(
    run(dir, ["task", "list", "--status", "completed", "--status", "completed"]),
    /No task passports match status completed\./,
    "repeated identical --status values are deduped"
  );

  const mcpList = await mcp.send({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "task_list",
      arguments: {}
    }
  });
  assert.match(mcpList.result.content[0].text, /- task_.* \[parked\] Parkable MCP task/);
  assert.match(mcpList.result.content[0].text, /\* task_.* \[active\] Replacement MCP task/);

  const mcpListJson = await mcp.send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "task_list",
      arguments: { json: true }
    }
  });
  const parsedList: Array<{ id: string; title: string; status: string; current: boolean }> = JSON.parse(mcpListJson.result.content[0].text);
  assert.equal(mcpListJson.result._meta, undefined);
  const parkedEntry = parsedList.find((task) => task.title === "Parkable MCP task");
  const replacementEntry = parsedList.find((task) => task.title === "Replacement MCP task");
  assert.ok(parkedEntry);
  assert.ok(replacementEntry);
  assert.equal(parkedEntry.status, "parked");
  assert.equal(parkedEntry.current, false);

  const emptySwitch = await mcp.send({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "task_switch",
      arguments: { id: "  " }
    }
  });
  assert.match(emptySwitch.error?.message, /task_switch requires a task id/);

  const unknownSwitch = await mcp.send({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "task_switch",
      arguments: { id: "task_missing" }
    }
  });
  assert.match(unknownSwitch.error?.message, /Task passport not found: task_missing/);

  const activeSwitch = await mcp.send({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "task_switch",
      arguments: { id: parkedEntry.id }
    }
  });
  assert.match(activeSwitch.error?.message, /park or finalize it first/);

  await mcp.send({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "task_park",
      arguments: {}
    }
  });

  const mcpSwitch = await mcp.send({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "task_switch",
      arguments: { id: parkedEntry.id }
    }
  });
  assert.match(mcpSwitch.result.content[0].text, /Switched to task task_.* \(active\)\./);

  const switchedStatus = await mcp.send({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "task_status",
      arguments: {}
    }
  });
  assert.match(switchedStatus.result.content[0].text, /Parkable MCP task \[active\]/);

  run(dir, ["task", "park"]);

  run(dir, ["task", "switch", replacementEntry.id]);
  run(dir, ["task", "close"]);
  const closedSwitch = await mcp.send({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: {
      name: "task_switch",
      arguments: { id: replacementEntry.id }
    }
  });
  assert.match(closedSwitch.error?.message, /Cannot switch to closed task/);
});

test("serves MCP JSON-RPC tools over newline-delimited stdio", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-mcp-test-"));
  writeFileSync(path.join(dir, "index.js"), "console.log('mcp')\n", "utf8");
  writeFileSync(path.join(dir, "other.js"), "console.log('other')\n", "utf8");
  run(dir, ["init"]);
  run(dir, ["set", "goal", "Exercise MCP smoke flow"]);

  const mcp = createMcpHarness(dir);

  const initialize = await mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {}
  });
  assert.equal(initialize.result.serverInfo.name, "agentpack");
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "..", "package.json"), "utf8")) as { version: string };
  assert.equal(initialize.result.serverInfo.version, pkg.version);
  assert.equal(initialize.result.resultType, undefined, "legacy initialize responses must stay unchanged");

  const beforeNotification = mcp.messages.length;
  mcp.input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {}
  })}\n`);
  await sleep(20);
  assert.equal(mcp.messages.length, beforeNotification);

  const tools = await mcp.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  assert.ok(tools.result.tools.some((tool: { name: string }) => tool.name === "record_decision"));
  assert.equal(tools.result.resultType, undefined, "legacy tool responses must not gain modern envelope fields");
  assert.equal(tools.result.ttlMs, undefined, "legacy tool responses must not gain modern cache fields");
  assert.equal(tools.result.cacheScope, undefined, "legacy tool responses must not gain modern cache fields");

  const legacyResourceTemplates = await mcp.send({
    jsonrpc: "2.0",
    id: 500,
    method: "resources/templates/list",
    params: {}
  });
  assert.deepEqual(legacyResourceTemplates.result.resourceTemplates, []);
  assert.equal(legacyResourceTemplates.result.resultType, undefined, "legacy resource-template responses must not gain modern envelope fields");
  assert.equal(legacyResourceTemplates.result.ttlMs, undefined, "legacy resource-template responses must not gain modern cache fields");
  assert.equal(legacyResourceTemplates.result.cacheScope, undefined, "legacy resource-template responses must not gain modern cache fields");

  const modernMeta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "agentpack-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
  const discover = await mcp.send({
    jsonrpc: "2.0",
    id: 200,
    method: "server/discover",
    params: { _meta: modernMeta }
  });
  assert.deepEqual(discover.result.supportedVersions, ["2026-07-28"]);
  assert.equal(discover.result.resultType, "complete");
  assert.equal(discover.result.ttlMs, 0);
  assert.equal(discover.result.cacheScope, "private");
  assert.equal(discover.result._meta["io.modelcontextprotocol/serverInfo"].name, "agentpack");
  assert.equal(discover.result.serverInfo, undefined, "modern server identity belongs in result metadata");

  const modernTools = await mcp.send({
    jsonrpc: "2.0",
    id: 201,
    method: "tools/list",
    params: { _meta: modernMeta }
  });
  assert.equal(modernTools.result.resultType, "complete");
  assert.equal(modernTools.result.ttlMs, 0);
  assert.equal(modernTools.result.cacheScope, "private");
  assert.ok(modernTools.result.tools.some((tool: { name: string }) => tool.name === "load_context"));

  for (const [id, method, params] of [
    [205, "prompts/list", {}],
    [206, "resources/list", {}],
    [207, "resources/templates/list", {}],
    [208, "resources/read", { uri: "agentpack://resume/latest" }]
  ] as const) {
    const response = await mcp.send({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: modernMeta }
    });
    assert.equal(response.result.resultType, "complete", `${method} returns a modern complete result`);
    assert.equal(response.result.ttlMs, 0, `${method} uses a conservative cache TTL`);
    assert.equal(response.result.cacheScope, "private", `${method} uses a private cache scope`);
    if (method === "resources/templates/list") {
      assert.deepEqual(response.result.resourceTemplates, []);
    }
  }

  const modernCall = await mcp.send({
    jsonrpc: "2.0",
    id: 202,
    method: "tools/call",
    params: { _meta: modernMeta, name: "task_status", arguments: {} }
  });
  assert.equal(modernCall.result.resultType, "complete");
  assert.equal(modernCall.result.ttlMs, undefined, "non-cacheable tools/call omits ttlMs");
  assert.equal(modernCall.result.cacheScope, undefined, "non-cacheable tools/call omits cacheScope");
  assert.match(modernCall.result.content[0].text, /No current task passport/);

  const unsupportedVersion = await mcp.send({
    jsonrpc: "2.0",
    id: 203,
    method: "tools/list",
    params: {
      _meta: {
        ...modernMeta,
        "io.modelcontextprotocol/protocolVersion": "2027-01-01"
      }
    }
  });
  assert.equal(unsupportedVersion.error.code, -32022);
  assert.deepEqual(unsupportedVersion.error.data, {
    supported: ["2026-07-28"],
    requested: "2027-01-01"
  });

  const missingCapabilities = await mcp.send({
    jsonrpc: "2.0",
    id: 204,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28"
      }
    }
  });
  assert.equal(missingCapabilities.error.code, -32602);
  assert.match(missingCapabilities.error.message, /clientCapabilities/);

  const decision = await mcp.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "record_decision",
      arguments: {
        text: "MCP can record decisions through stdio.",
        files: ["index.js"]
      }
    }
  });
  assert.match(decision.result.content[0].text, /Recorded decision/);

  const source = await mcp.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "record_source",
      arguments: {
        path: "index.js",
        summary: "MCP smoke source."
      }
    }
  });
  assert.match(source.result.content[0].text, /Recorded source index\.js/);

  const otherSource = await mcp.send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "record_source",
      arguments: {
        path: "other.js",
        summary: "Unrelated billing source for query filter coverage."
      }
    }
  });
  assert.match(otherSource.result.content[0].text, /Recorded source other\.js/);

  const sourceStatus = await mcp.send({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "source_status",
      arguments: {}
    }
  });
  assert.match(sourceStatus.result.content[0].text, /UNCHANGED index\.js/);
  assert.match(sourceStatus.result.content[0].text, /do not re-open unless needed/);
  assert.match(sourceStatus.result.content[0].text, /hash: matches recorded hash/);

  const taskAudit = await mcp.send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "task_audit",
      arguments: {}
    }
  });
  assert.match(taskAudit.result.content[0].text, /Task audit/);
  assert.match(taskAudit.result.content[0].text, /No current task passport/);

  const taskStatusBeforeStart = await mcp.send({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "task_status",
      arguments: {}
    }
  });
  assert.match(taskStatusBeforeStart.result.content[0].text, /Task status/);
  assert.match(taskStatusBeforeStart.result.content[0].text, /No current task passport/);

  const taskStart = await mcp.send({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "task_start",
      arguments: {
        title: "MCP verification flow",
        objective: "Exercise MCP task lifecycle flow.",
        constraints: ["Keep task lifecycle reachable through MCP."],
        writeScope: ["index.js"],
        nextActions: ["Finish MCP verification"],
        tags: ["mcp-lifecycle"],
        risk: "medium"
      }
    }
  });
  assert.match(taskStart.result.content[0].text, /Started task task_/);
  const startedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(startedPassport.title, "MCP verification flow");
  assert.equal(startedPassport.objective, "Exercise MCP task lifecycle flow.");
  assert.deepEqual(startedPassport.constraints, ["Keep task lifecycle reachable through MCP."]);
  assert.deepEqual(startedPassport.writeScope, ["index.js"]);
  assert.deepEqual(startedPassport.nextActions, ["Finish MCP verification"]);
  assert.deepEqual(startedPassport.tags, ["mcp-lifecycle"]);
  assert.equal(startedPassport.risk, "medium");

  const taskStatusAfterStart = await mcp.send({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "task_status",
      arguments: {}
    }
  });
  assert.match(taskStatusAfterStart.result.content[0].text, /MCP verification flow \[active\]/);
  assert.match(taskStatusAfterStart.result.content[0].text, /ID: task_/);
  assert.match(taskStatusAfterStart.result.content[0].text, /Verification: unknown/);
  assert.match(taskStatusAfterStart.result.content[0].text, /Next: Finish MCP verification/);
  assert.match(taskStatusAfterStart.result.content[0].text, /Write scope: index\.js/);

  const duplicateTaskStart = await mcp.send({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "task_start",
      arguments: {
        title: "Overlapping MCP task"
      }
    }
  });
  assert.match(duplicateTaskStart.error?.message, /park or close it before starting a new task/);

  const taskHandoff = await mcp.send({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "task_handoff",
      arguments: {}
    }
  });
  assert.match(taskHandoff.result.content[0].text, /Task handoff/);
  assert.match(taskHandoff.result.content[0].text, /MCP verification flow \[active\]/);
  assert.match(taskHandoff.result.content[0].text, /Next actions:\n- Finish MCP verification/);

  const evidence = await mcp.send({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "attach_evidence",
      arguments: {
        kind: "test-output",
        content: "MCP task verification passed."
      }
    }
  });
  const evidenceId = String(evidence.result.content[0].text).match(/Attached evidence ([^.]+)\./)?.[1] || "";
  assert.match(evidenceId, /^evt_/);

  const taskVerify = await mcp.send({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: {
      name: "task_update_verification",
      arguments: {
        status: "passed",
        evidence: [evidenceId],
        summary: "MCP smoke verification passed."
      }
    }
  });
  assert.match(taskVerify.result.content[0].text, /Updated verification for task .* \(passed\)/);
  assert.match(taskVerify.result.content[0].text, /Bound HEAD .*final verdict freezes code changes/);

  const verifiedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(verifiedPassport.verification.status, "passed");
  assert.deepEqual(verifiedPassport.verification.evidence, [evidenceId]);
  assert.equal(verifiedPassport.verification.summary, "MCP smoke verification passed.");

  const taskUpdate = await mcp.send({
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: {
      name: "task_update",
      arguments: {
        objective: "Exercise MCP task update flow.",
        constraints: ["Keep MCP task updates additive."],
        writeScope: ["."],
        nextActions: ["Inspect updated passport"],
        tags: ["mcp-task-update"],
        risk: "medium"
      }
    }
  });
  assert.match(taskUpdate.result.content[0].text, /Updated task .*/);
  const mcpUpdatedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(mcpUpdatedPassport.objective, "Exercise MCP task update flow.");
  assert.deepEqual(mcpUpdatedPassport.constraints, ["Keep task lifecycle reachable through MCP.", "Keep MCP task updates additive."]);
  assert.deepEqual(mcpUpdatedPassport.writeScope, ["index.js", "."]);
  assert.deepEqual(mcpUpdatedPassport.nextActions, ["Finish MCP verification", "Inspect updated passport"]);
  assert.deepEqual(mcpUpdatedPassport.tags, ["mcp-lifecycle", "mcp-task-update"]);
  assert.equal(mcpUpdatedPassport.risk, "medium");
  assert.equal(mcpUpdatedPassport.currentHead, verifiedPassport.currentHead, "MCP task updates preserve the final verdict's bound HEAD");

  const eventCountBeforeMcpNoop = taskEventCount(dir, mcpUpdatedPassport.id);
  const taskVerifyNoop = await mcp.send({
    jsonrpc: "2.0",
    id: 16,
    method: "tools/call",
    params: {
      name: "task_update_verification",
      arguments: {
        status: "passed",
        evidence: [evidenceId],
        summary: "MCP smoke verification passed."
      }
    }
  });
  assert.match(taskVerifyNoop.result.content[0].text, /Verification unchanged for task .* \(passed\)/);
  assert.equal(taskEventCount(dir, mcpUpdatedPassport.id), eventCountBeforeMcpNoop);

  const invalidMcpRisk = await mcp.send({
    jsonrpc: "2.0",
    id: 17,
    method: "tools/call",
    params: {
      name: "task_update",
      arguments: {
        risk: "urgent"
      }
    }
  });
  assert.equal(invalidMcpRisk.error?.message, "Unknown task risk: urgent");

  const clearNextActions = await mcp.send({
    jsonrpc: "2.0",
    id: 171,
    method: "tools/call",
    params: {
      name: "task_update",
      arguments: {
        clearNextActions: true,
        nextActions: ["Inspect updated passport"]
      }
    }
  });
  assert.match(clearNextActions.result.content[0].text, /Updated task .*/);
  assert.deepEqual(
    JSON.parse(run(dir, ["task", "passport"])).nextActions,
    ["Inspect updated passport"],
    "clearNextActions replaces the next actions instead of appending"
  );
  await mcp.send({
    jsonrpc: "2.0",
    id: 172,
    method: "tools/call",
    params: {
      name: "task_update",
      arguments: {
        clearNextActions: true,
        nextActions: ["Finish MCP verification", "Inspect updated passport"]
      }
    }
  });

  const taskFinalize = await mcp.send({
    jsonrpc: "2.0",
    id: 18,
    method: "tools/call",
    params: {
      name: "task_finalize",
      arguments: {}
    }
  });
  assert.match(taskFinalize.result.content[0].text, /Finalized task .* \(passed\)/);
  assert.match(taskFinalize.result.content[0].text, /Bound HEAD .*final verdict is frozen and the task is completed/);
  assert.match(taskFinalize.result.content[0].text, /Advisories:/, "MCP finalize appends the same hygiene advisories as the CLI");
  const finalizedPassport = JSON.parse(run(dir, ["task", "passport"]));
  assert.equal(finalizedPassport.status, "completed");
  assert.equal(finalizedPassport.verification.status, "passed");

  const resume = await mcp.send({
    jsonrpc: "2.0",
    id: 19,
    method: "tools/call",
    params: {
      name: "resume",
      arguments: {
        preset: "deep",
        query: "smoke flow"
      }
    }
  });
  assert.match(resume.result.content[0].text, /Exercise MCP smoke flow/);
  assert.match(resume.result.content[0].text, /Estimated usage: ~\d+ tokens/);
  assert.match(resume.result.content[0].text, /Query filter: full summaries for 1 query-relevant source\(s\), compact stubs for 1 query-unrelated source\(s\)/);
  assert.match(resume.result.content[0].text, /MCP smoke source/);
  assert.match(resume.result.content[0].text, /topic: Unrelated billing source/);
  assert.doesNotMatch(resume.result.content[0].text, /summary: Unrelated billing source/);
  assert.match(resume.result.content[0].text, /MCP can record decisions/);

  const events = readFileSync(path.join(dir, ".agentpack", "events.jsonl"), "utf8");
  assert.match(events, /MCP can record decisions through stdio/);
});

function walkEntries(rootPath: string): string[] {
  const entries: string[] = [rootPath];
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      entries.push(...walkEntries(entryPath));
    } else {
      entries.push(entryPath);
    }
  }
  return entries;
}

function run(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runWithStatus(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = run(cwd, args);
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: typeof failure.status === "number" ? failure.status : 1,
      stdout: String(failure.stdout || ""),
      stderr: String(failure.stderr || "")
    };
  }
}

function runWithInput(cwd: string, args: string[], input: string): string {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function runExpectError(cwd: string, args: string[]): string {
  try {
    run(cwd, args);
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; message?: string };
    return String(failure.stderr || failure.message || error);
  }
  assert.fail(`Expected command to fail: agentpack ${args.join(" ")}`);
}

function runExpectFailureOutput(cwd: string, args: string[]): string {
  try {
    run(cwd, args);
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return String(failure.stdout || failure.stderr || failure.message || error);
  }
  assert.fail(`Expected command to fail: agentpack ${args.join(" ")}`);
}

function estimatedTokensFromResume(output: string): number {
  const match = output.match(/Estimated usage: ~(\d+) tokens/);
  assert.ok(match, "resume should include estimated token usage");
  const tokenText = match[1];
  assert.ok(tokenText, "resume should include numeric estimated token usage");
  return Number.parseInt(tokenText, 10);
}

function runAsync(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function commitAll(cwd: string, message: string): void {
  runGit(cwd, ["add", "."]);
  runGit(cwd, [
    "-c", "user.name=Agentpack Test",
    "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false",
    "commit", "-m", message
  ]);
}

function assertDirectionalFacts(
  surface: string,
  output: string,
  expected: Record<DirectionalSignal, string>
): void {
  assert.deepEqual(Object.keys(expected).sort(), [...DIRECTIONAL_SIGNALS].sort(), `${surface} must cover every critical signal`);
  for (const signal of DIRECTIONAL_SIGNALS) {
    assert.match(output, new RegExp(escapeRegExp(expected[signal])), `${surface} lost ${signal}`);
  }
}

function writeReleaseFixture(dir: string, publishWorkflow?: string): void {
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "agentpack-cli",
    version: "1.2.3",
    publishConfig: {
      access: "public",
      provenance: true
    }
  }, null, 2), "utf8");
  writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({
    name: "agentpack-cli",
    version: "1.2.3",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "agentpack-cli",
        version: "1.2.3"
      }
    }
  }, null, 2), "utf8");
  writeFileSync(path.join(dir, ".github", "workflows", "publish.yml"), publishWorkflow || [
    "name: Publish to npm",
    "on:",
    "  release:",
    "    types: [published]",
    "permissions:",
    "  contents: read",
    "  id-token: write",
    "jobs:",
    "  publish:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm publish --access public",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(dir, "docs", "RELEASING.md"), [
    "# Releasing",
    "",
    "Use a weekly release cadence for normal releases.",
    "",
    "## Pre-flight checklist",
    "",
    "- npm test",
    ""
  ].join("\n"), "utf8");
}

function initializeReleaseRepo(dir: string): string {
  runGit(dir, ["init"]);
  run(dir, ["init"]);
  runGit(dir, ["add", ".gitignore", ".github", "docs", "package.json", "package-lock.json"]);
  commit(dir, "initial");
  runGit(dir, ["branch", "-M", "main"]);
  return addReleaseRemote(dir);
}

function addReleaseRemote(dir: string): string {
  const remote = mkdtempSync(path.join(os.tmpdir(), "agentpack-release-remote-"));
  runGit(remote, ["init", "--bare"]);
  runGit(dir, ["remote", "add", "origin", remote]);
  runGit(dir, ["push", "-u", "origin", "main"]);
  return remote;
}

function commit(dir: string, message: string): void {
  runGit(dir, [
    "-c",
    "user.name=Agentpack Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message
  ]);
}

function taskEventCount(root: string, taskId: string): number {
  const eventsPath = path.join(root, ".agentpack", "tasks", taskId, "events.jsonl");
  return readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).length;
}

interface McpMessage {
  id?: string | number | null;
  result?: any;
  error?: any;
}

function createMcpHarness(cwd: string): {
  input: PassThrough;
  messages: McpMessage[];
  send: (message: Record<string, unknown>) => Promise<McpMessage>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: McpMessage[] = [];
  let buffer = "";

  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        messages.push(JSON.parse(line) as McpMessage);
      }
    }
  });

  startMcpServer(cwd, input, output);

  return {
    input,
    messages,
    async send(message: Record<string, unknown>): Promise<McpMessage> {
      const expectedId = message.id;
      input.write(`${JSON.stringify(message)}\n`);
      return waitForMessage(messages, expectedId);
    }
  };
}

async function waitForMessage(messages: McpMessage[], id: unknown): Promise<McpMessage> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = messages.find((candidate) => candidate.id === id);
    if (message) {
      return message;
    }
    await sleep(10);
  }

  throw new Error(`Timed out waiting for MCP response ${String(id)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function expectedMcpServerName(root: string): string {
  const slug = path.basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return !slug || slug === "agentpack" ? "agentpack" : `agentpack-${slug}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Mirrors bundles.ts's canonical stringify so tests can recompute a bundle
// digest after mutating a payload (e.g. injecting a legacy field to test).
function stableStringifyForTest(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyForTest(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyForTest(item)}`).join(",")}}`;
}
