#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const cliPath = path.join(repoRoot, "dist", "src", "agentpack.js");
const args = new Set(process.argv.slice(2));
const keepFixtures = args.has("--keep-fixtures");
const jsonOutput = args.has("--json");

if (!existsSync(cliPath)) {
  console.error("Missing dist/src/agentpack.js. Run `npm run build` before this benchmark.");
  process.exit(1);
}

const fixturesRoot = mkdtempSync(path.join(os.tmpdir(), "agentpack-token-bench-"));

try {
  const scenarios = [
    tinyQuestionScenario(),
    latestDiffReviewScenario(),
    resumedImplementationScenario(),
    tightBudgetContextScenario(),
    freshAgentContextScenario(),
    longRemediationHandoffScenario(),
    externalReviewWaitScenario(),
    deliveryAuthorizationScenario(),
    developmentStateDriftScenario(),
    staleSourceCacheScenario(),
    releasePrepHandoffScenario()
  ];
  const summarizedScenarios = scenarios.map((scenario) => summarizeScenario(scenario));
  const report = {
    generatedAt: new Date().toISOString(),
    estimate: "ceil(characters / 4)",
    mcpWrapper: "modeled JSON-RPC tools/call text response",
    directionalIntegrity: summarizeChecks(summarizedScenarios, "directional"),
    guardrails: summarizeChecks(summarizedScenarios, "guardrail"),
    scenarios: summarizedScenarios
  };

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }

  const failedChecks = report.scenarios.flatMap((scenario) => (
    scenario.checks || []
  ).filter((check) => !check.passed).map((check) => `${scenario.id}: ${check.label}`));
  if (failedChecks.length > 0) {
    console.error(`Directional-integrity or guardrail check(s) failed:\n${failedChecks.map((check) => `- ${check}`).join("\n")}`);
    process.exitCode = 1;
  }
} finally {
  if (keepFixtures) {
    console.error(`Kept benchmark fixtures at ${fixturesRoot}`);
  } else {
    rmSync(fixturesRoot, { recursive: true, force: true });
  }
}

function tinyQuestionScenario() {
  const dir = createFixture("tiny-question", {
    "src/index.ts": [
      "export function statusLabel(done) {",
      "  return done ? \"ready\" : \"pending\";",
      "}",
      ""
    ].join("\n")
  });
  runCli(dir, [
    "set",
    "goal",
    "Answer a tiny status question without reopening unrelated files."
  ]);
  runCli(dir, [
    "task",
    "start",
    "Answer tiny status question",
    "--objective",
    "Report whether the current task has a next action and clean git state.",
    "--write-scope",
    "src/index.ts",
    "--next",
    "Answer the status question",
    "--risk",
    "low"
  ]);

  return {
    id: "tiny_question",
    label: "Tiny question",
    question: "What is the active task status?",
    agentpackCommand: "agentpack task status",
    agentpackOutput: runCli(dir, ["task", "status"]),
    directCommand: "git status --short --branch",
    directOutput: runGit(dir, ["status", "--short", "--branch"]),
    checks: [
      directionalMustInclude("next_safe_action", "next action", "Next: Answer the status question"),
      directionalMustInclude("development_state", "task branch", "Branch: main"),
      directionalMustInclude("write_scope", "write scope", "Write scope: src/index.ts")
    ]
  };
}

function latestDiffReviewScenario() {
  const dir = createFixture("latest-diff-review", {
    "src/search.ts": [
      "export function buildQuery(input) {",
      "  return input.trim().toLowerCase();",
      "}",
      ""
    ].join("\n"),
    "tests/search.test.ts": [
      "import assert from \"node:assert/strict\";",
      "import { buildQuery } from \"../src/search.js\";",
      "",
      "assert.equal(buildQuery(\"  HELLO  \"), \"hello\");",
      ""
    ].join("\n")
  });
  runCli(dir, [
    "task",
    "start",
    "Review latest diff",
    "--objective",
    "Review the pending search-query change for behavior risk and missing tests.",
    "--write-scope",
    "src/search.ts",
    "--write-scope",
    "tests/search.test.ts",
    "--next",
    "Inspect changed files and call out regressions first",
    "--risk",
    "medium"
  ]);
  runCli(dir, [
    "source",
    "add",
    "src/search.ts",
    "--summary",
    "Search query normalization trims input and lowercases it before lookup."
  ]);
  runCli(dir, [
    "source",
    "add",
    "tests/search.test.ts",
    "--summary",
    "Search tests cover whitespace trimming and lowercase normalization."
  ]);
  writeFileSync(path.join(dir, "src", "search.ts"), [
    "export function buildQuery(input) {",
    "  return input.normalize(\"NFKC\").trim().toLowerCase();",
    "}",
    "",
    "export function shouldSearch(input) {",
    "  return buildQuery(input).length >= 2;",
    "}",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(dir, "tests", "search.test.ts"), [
    "import assert from \"node:assert/strict\";",
    "import { buildQuery, shouldSearch } from \"../src/search.js\";",
    "",
    "assert.equal(buildQuery(\"  HELLO  \"), \"hello\");",
    "assert.equal(shouldSearch(\" x \"), false);",
    ""
  ].join("\n"), "utf8");

  return {
    id: "latest_diff_review",
    label: "Latest-diff review",
    question: "Review only the current diff.",
    agentpackCommand: "agentpack resume --preset quick --query \"latest diff review\"",
    agentpackOutput: runCli(dir, ["resume", "--preset", "quick", "--query", "latest diff review"]),
    directCommand: "git status --short && git diff -- src/search.ts tests/search.test.ts",
    directOutput: [
      runGit(dir, ["status", "--short"]),
      runGit(dir, ["diff", "--", "src/search.ts", "tests/search.test.ts"])
    ].join("\n"),
    checks: [
      directionalMustInclude("objective", "review objective", "Review the pending search-query change for behavior risk and missing tests."),
      directionalMustInclude("write_scope", "source write scope", "src/search.ts"),
      directionalMustInclude("write_scope", "test write scope", "tests/search.test.ts"),
      directionalMustInclude("development_state", "dirty review paths", [
        "- Changed files:",
        "  -  M src/search.ts",
        "  -  M tests/search.test.ts"
      ].join("\n")),
      directionalMustInclude("next_safe_action", "review next action", "Inspect changed files and call out regressions first")
    ]
  };
}

function resumedImplementationScenario() {
  const dir = createFixture("resumed-implementation", {
    "src/cache.ts": [
      "export class CacheStore {",
      "  constructor() {",
      "    this.values = new Map();",
      "  }",
      "",
      "  get(key) {",
      "    return this.values.get(key);",
      "  }",
      "",
      "  set(key, value) {",
      "    this.values.set(key, value);",
      "  }",
      "}",
      ""
    ].join("\n"),
    "src/pipeline.ts": [
      "import { CacheStore } from \"./cache.js\";",
      "",
      "export function createPipeline(cache = new CacheStore()) {",
      "  return {",
      "    cache,",
      "    run(input) {",
      "      return input.trim();",
      "    }",
      "  };",
      "}",
      ""
    ].join("\n"),
    "tests/pipeline.test.ts": [
      "import assert from \"node:assert/strict\";",
      "import { createPipeline } from \"../src/pipeline.js\";",
      "",
      "assert.equal(createPipeline().run(\" x \"), \"x\");",
      ""
    ].join("\n"),
    "docs/CACHE.md": [
      "# Cache",
      "",
      "Pipeline cache state is intentionally local to each pipeline instance.",
      ""
    ].join("\n")
  });
  runCli(dir, ["set", "goal", "Finish cache-aware pipeline resume flow."]);
  runCli(dir, ["set", "status", "Implementation paused after cache API review."]);
  runCli(dir, [
    "set",
    "next",
    "Wire cache invalidation tests",
    "--next",
    "Keep handoff under the chat budget"
  ]);
  runCli(dir, [
    "task",
    "start",
    "Resume cache pipeline implementation",
    "--objective",
    "Continue the cache-aware pipeline change from recorded source conclusions.",
    "--constraint",
    "Do not re-open files whose source conclusions are unchanged unless needed.",
    "--constraint",
    "Preserve existing pipeline API behavior.",
    "--write-scope",
    "src/cache.ts",
    "--write-scope",
    "src/pipeline.ts",
    "--write-scope",
    "tests/pipeline.test.ts",
    "--next",
    "Add cache invalidation regression coverage",
    "--next",
    "Update docs only if behavior changes",
    "--risk",
    "medium"
  ]);
  runCli(dir, [
    "source",
    "add",
    "src/cache.ts",
    "--summary",
    "CacheStore wraps a Map and exposes get/set without persistence or eviction."
  ]);
  runCli(dir, [
    "source",
    "add",
    "src/pipeline.ts",
    "--summary",
    "createPipeline accepts an optional CacheStore and returns a run method that trims input."
  ]);
  runCli(dir, [
    "source",
    "add",
    "tests/pipeline.test.ts",
    "--summary",
    "Pipeline test currently verifies whitespace trimming only; cache invalidation coverage is still missing."
  ]);
  runCli(dir, [
    "record",
    "decision",
    "Keep cache state per pipeline instance so tests can avoid shared global state."
  ]);
  runCli(dir, [
    "record",
    "decision",
    "Resume should prefer source conclusions over re-reading unchanged implementation files."
  ]);
  runCli(dir, [
    "evidence",
    "add",
    "--kind",
    "test-output",
    "--content",
    "Focused pipeline test passed before pausing."
  ]);
  runCli(dir, [
    "checkpoint",
    "-m",
    "Paused with cache API reviewed",
    "--status",
    "Ready to resume implementation",
    "--next",
    "Add invalidation tests"
  ]);

  return {
    id: "resumed_implementation",
    label: "Resumed implementation",
    question: "Recover enough context to continue a paused coding task.",
    agentpackCommand: "agentpack resume --preset chat --query \"cache pipeline implementation\"",
    agentpackOutput: runCli(dir, ["resume", "--preset", "chat", "--query", "cache pipeline implementation"]),
    directCommand: "git status --short --branch && cat src/cache.ts src/pipeline.ts tests/pipeline.test.ts docs/CACHE.md",
    directOutput: [
      runGit(dir, ["status", "--short", "--branch"]),
      readFiles(dir, ["src/cache.ts", "src/pipeline.ts", "tests/pipeline.test.ts", "docs/CACHE.md"])
    ].join("\n"),
    checks: [
      directionalMustInclude("objective", "implementation objective", "Continue the cache-aware pipeline change from recorded source conclusions."),
      directionalMustInclude("constraints", "API compatibility constraint", "Preserve existing pipeline API behavior."),
      directionalMustInclude("decisions", "cache ownership decision", "Keep cache state per pipeline instance"),
      directionalMustInclude("next_safe_action", "implementation next action", "Add cache invalidation regression coverage")
    ]
  };
}

function staleSourceCacheScenario() {
  const dir = createFixture("stale-source-cache", {
    "src/active.ts": "export const active = true;\n",
    "src/changed.ts": "export const changed = \"v1\";\n",
    "docs/removed.md": "This document will be removed.\n"
  });
  runCli(dir, [
    "task",
    "start",
    "Triage stale source cache",
    "--objective",
    "Find changed or missing source records without dumping unchanged records.",
    "--write-scope",
    "src/changed.ts",
    "--write-scope",
    "docs/removed.md",
    "--next",
    "Refresh only conclusions that changed",
    "--risk",
    "low"
  ]);
  runCli(dir, [
    "source",
    "add",
    "src/active.ts",
    "--summary",
    "Active source remains current and should stay out of stale-only triage."
  ]);
  runCli(dir, [
    "source",
    "add",
    "src/changed.ts",
    "--summary",
    "Changed source exported a v1 marker."
  ]);
  runCli(dir, [
    "source",
    "add",
    "docs/removed.md",
    "--summary",
    "Removed docs file described an obsolete setup note."
  ]);
  writeFileSync(path.join(dir, "src", "changed.ts"), "export const changed = \"v2\";\n", "utf8");
  unlinkSync(path.join(dir, "docs", "removed.md"));

  return {
    id: "stale_source_cache",
    label: "Stale source triage",
    question: "Find stale source-cache entries only.",
    agentpackCommand: "agentpack source status --changed --missing",
    agentpackOutput: runCli(dir, ["source", "status", "--changed", "--missing"]),
    directCommand: "git status --short && git diff -- src/changed.ts",
    directOutput: [
      runGit(dir, ["status", "--short"]),
      runGit(dir, ["diff", "--", "src/changed.ts"])
    ].join("\n"),
    checks: [
      directionalMustInclude("source_state", "changed source record", "CHANGED src/changed.ts"),
      directionalMustInclude("source_state", "missing source record", "MISSING docs/removed.md"),
      directionalMustExclude("source_state", "unchanged source omitted", "src/active.ts")
    ]
  };
}

function tightBudgetContextScenario() {
  const dir = createFixture("tight-budget-context", {
    "README.md": "# Tight budget fixture\n",
    "docs/RELEASING.md": [
      "# Releasing",
      "",
      "Normal releases use the weekly batch cadence.",
      ""
    ].join("\n"),
    "src/index.ts": "export const ready = true;\n"
  });
  addOriginUpstream(dir, "tight-budget-context-origin.git");
  runCli(dir, ["set", "goal", "Keep release context visible under a tight resume budget."]);
  runCli(dir, [
    "task",
    "start",
    "Continue weekly release batch",
    "--objective",
    "Carry local commits as next-release candidates without dumping the full ledger.",
    "--constraint",
    "Do not rewrite ledger facts to save tokens.",
    "--constraint",
    "Show omitted context explicitly when the budget is tight.",
    "--write-scope",
    "README.md",
    "--write-scope",
    "docs/RELEASING.md",
    "--next",
    "Review local commits before release prep",
    "--risk",
    "medium"
  ]);

  for (let index = 0; index < 14; index += 1) {
    const filePath = `src/context-${index}.ts`;
    writeFixtureFile(dir, filePath, `export const context${index} = ${index};\n`);
    runCli(dir, [
      "source",
      "add",
      filePath,
      "--summary",
      `Context source ${index} has a deliberately detailed recorded conclusion for tight-budget omission checks.`
    ]);
  }

  for (let index = 0; index < 10; index += 1) {
    runCli(dir, [
      "record",
      "decision",
      `Decision ${index}: keep release-batch context explicit without lossy summarization.`
    ]);
  }

  runCli(dir, [
    "evidence",
    "add",
    "--kind",
    "benchmark-fixture",
    "--content",
    "Tight budget fixture evidence should be omitted before current git context."
  ]);
  runCli(dir, [
    "checkpoint",
    "-m",
    "Tight budget context fixture prepared",
    "--status",
    "Ready for compact resume",
    "--next",
    "Inspect omitted-section metadata"
  ]);
  writeFixtureFile(dir, "README.md", "# Local release candidate\n");
  runGit(dir, ["add", "README.md"]);
  commitFixture(dir, "local release candidate");

  return {
    id: "tight_budget_context",
    label: "Tight-budget context",
    question: "Recover current task and local commits under a tight context budget.",
    agentpackCommand: "agentpack resume --budget 220 --query \"release local commits budget\"",
    agentpackOutput: runCli(dir, ["resume", "--budget", "220", "--query", "release local commits budget"]),
    directCommand: "git status --short --branch && git log --oneline origin/main..HEAD",
    directOutput: [
      runGit(dir, ["status", "--short", "--branch"]),
      runGit(dir, ["log", "--oneline", "origin/main..HEAD"])
    ].join("\n"),
    checks: [
      maxEstimatedUsage(220),
      directionalMustInclude("development_state", "local upstream drift", "Upstream: origin/main (1 ahead, 0 behind)"),
      directionalMustInclude("development_state", "local commit subject", "local release candidate")
    ]
  };
}

function freshAgentContextScenario() {
  const dir = createFixture("fresh-agent-context", {
    "README.md": "# Fresh agent fixture\n",
    "docs/RELEASING.md": [
      "# Releasing",
      "",
      "Normal releases use the weekly batch cadence.",
      ""
    ].join("\n"),
    "src/context.ts": "export const context = true;\n"
  });
  addOriginUpstream(dir, "fresh-agent-context-origin.git");
  runCli(dir, ["set", "goal", "Make task context portable to a fresh agent."]);
  runCli(dir, [
    "task",
    "start",
    "Improve context transfer",
    "--objective",
    "Help a fresh agent recover the accepted task, release cadence, local commits, risks, next actions, and verification.",
    "--constraint",
    "Budget is a contract and stress test, not the product goal.",
    "--constraint",
    "Token count is diagnostic; context utility is the product metric.",
    "--write-scope",
    "src/context.ts",
    "--write-scope",
    "docs/RELEASING.md",
    "--next",
    "Review local commits before release prep",
    "--risk",
    "medium"
  ]);
  runCli(dir, [
    "source",
    "add",
    "docs/RELEASING.md",
    "--summary",
    "Release docs describe the weekly batch cadence for normal releases."
  ]);
  runCli(dir, [
    "record",
    "decision",
    "Use weekly batch release cadence; local commits remain next-release candidates until Thursday release prep."
  ]);
  runCli(dir, [
    "evidence",
    "add",
    "--kind",
    "test-output",
    "--content",
    "Context handoff checks passed."
  ]);
  runCli(dir, [
    "task",
    "verify",
    "--status",
    "passed",
    "--summary",
    "Context handoff checks passed."
  ]);
  runCli(dir, [
    "checkpoint",
    "-m",
    "Fresh-agent context ready",
    "--status",
    "Ready for handoff",
    "--next",
    "Review local commits before release prep"
  ]);
  const verifiedHead = runGit(dir, ["rev-parse", "--short", "HEAD"]).trim();
  writeFixtureFile(dir, "README.md", "# Local release candidate\n");
  runGit(dir, ["add", "README.md"]);
  commitFixture(dir, "local release candidate");
  const currentHead = runGit(dir, ["rev-parse", "--short", "HEAD"]).trim();

  return {
    id: "fresh_agent_context",
    label: "Fresh-agent context",
    question: "Can a fresh agent recover the accepted task and release context without ledger archaeology?",
    agentpackCommand: "agentpack resume --budget 900 --query \"release cadence local commits verification next actions\"",
    agentpackOutput: runCli(dir, ["resume", "--budget", "900", "--query", "release cadence local commits verification next actions"]),
    directCommand: "git status --short --branch && git log --oneline origin/main..HEAD && cat docs/RELEASING.md",
    directOutput: [
      runGit(dir, ["status", "--short", "--branch"]),
      runGit(dir, ["log", "--oneline", "origin/main..HEAD"]),
      readFiles(dir, ["docs/RELEASING.md"])
    ].join("\n"),
    checks: [
      maxEstimatedUsage(900),
      directionalMustInclude("objective", "accepted task objective", "Help a fresh agent recover the accepted task"),
      directionalMustInclude("risk", "risk", "Risk: medium"),
      directionalMustInclude("next_safe_action", "next action", "Review local commits before release prep"),
      directionalMustInclude("verification", "verification", "Verification: passed - Context handoff checks passed."),
      directionalMustInclude("development_state", "local upstream drift", "Upstream: origin/main (1 ahead, 0 behind)"),
      directionalMustInclude("development_state", "local commit subject", "local release candidate"),
      directionalMustInclude("development_state", "verification HEAD drift warning", `Drift: HEAD changed from ${verifiedHead} to ${currentHead}. Verify task state before continuing.`),
      directionalMustInclude("decisions", "release cadence decision", "Use weekly batch release cadence; local commits remain next-release candidates until Thursday release prep")
    ]
  };
}

function longRemediationHandoffScenario() {
  const dir = createFixture("long-remediation-handoff", {
    "src/lifecycle.ts": "export const lifecycle = \"pending\";\n",
    "tests/lifecycle.test.ts": "export const deterministicInterleavingCovered = false;\n"
  });
  const head = runGit(dir, ["rev-parse", "--short", "HEAD"]).trim();
  runCli(dir, [
    "task",
    "start",
    "Fix lifecycle remediation findings",
    "--objective",
    "Resolve the remaining publication race without weakening rollback or capability revocation.",
    "--constraint",
    "Preserve the published generation on every failed replacement.",
    "--constraint",
    "Do not push or comment on the pull request without separate authorization.",
    "--write-scope",
    "src/lifecycle.ts",
    "--write-scope",
    "tests/lifecycle.test.ts",
    "--next",
    "Fix the deterministic publish-versus-revoke interleaving",
    "--risk",
    "high"
  ]);
  runCli(dir, [
    "record",
    "decision",
    "Keep verification pending during the remediation loop; intermediate green checks are checkpoint evidence, not a final verdict.",
    "--file",
    "src/lifecycle.ts"
  ]);
  runCli(dir, ["task", "verify", "--status", "pending"]);
  runCli(dir, [
    "checkpoint",
    "-m",
    "Three lifecycle findings are fixed; the publish-versus-revoke interleaving remains open.",
    "--status",
    "Remediation continues with verification pending",
    "--next",
    "Fix the deterministic publish-versus-revoke interleaving"
  ]);

  return {
    id: "long_remediation_handoff",
    label: "Long remediation handoff",
    question: "Can another agent continue a security-sensitive fix loop without losing its direction?",
    agentpackCommand: "agentpack resume --preset chat --query \"lifecycle remediation publish revoke verification\"",
    agentpackOutput: runCli(dir, ["resume", "--preset", "chat", "--query", "lifecycle remediation publish revoke verification"]),
    directCommand: "git status --short --branch && git log -1 --format=%H && cat src/lifecycle.ts tests/lifecycle.test.ts",
    directOutput: [
      runGit(dir, ["status", "--short", "--branch"]),
      runGit(dir, ["log", "-1", "--format=%H"]),
      readFiles(dir, ["src/lifecycle.ts", "tests/lifecycle.test.ts"])
    ].join("\n"),
    checks: [
      directionalMustInclude("objective", "remediation objective", "Resolve the remaining publication race without weakening rollback or capability revocation."),
      directionalMustInclude("constraints", "rollback constraint", "Preserve the published generation on every failed replacement."),
      directionalMustInclude("authorization", "remote authorization boundary", "Do not push or comment on the pull request without separate authorization."),
      directionalMustInclude("development_state", "worktree", `- Worktree: ${realpathSync(dir)}`),
      directionalMustInclude("development_state", "branch", "- Branch: main"),
      directionalMustInclude("development_state", "HEAD", `- Commit: ${head}`),
      directionalMustInclude("write_scope", "implementation scope", "src/lifecycle.ts"),
      directionalMustInclude("decisions", "pending-verification decision", "Keep verification pending during the remediation loop"),
      directionalMustInclude("open_findings", "remaining lifecycle finding", "Fix the deterministic publish-versus-revoke interleaving"),
      directionalMustInclude("verification", "verification remains pending", "- Verification: pending")
    ]
  };
}

function externalReviewWaitScenario() {
  const dir = createFixture("external-review-wait", {
    "src/reviewed.ts": "export const reviewed = true;\n",
    "tests/reviewed.test.ts": "export const verified = true;\n"
  });
  runCli(dir, [
    "task",
    "start",
    "Wait for independent verification",
    "--objective",
    "Preserve a commit-bound local PASS while an independent reviewer evaluates the same HEAD.",
    "--constraint",
    "Do not edit while the external review is pending; return verification to pending before any remediation.",
    "--write-scope",
    "src/reviewed.ts",
    "--write-scope",
    "tests/reviewed.test.ts",
    "--next",
    "Resume after the independent review verdict",
    "--risk",
    "high"
  ]);
  const evidenceOutput = runCli(dir, [
    "evidence",
    "add",
    "--kind",
    "test-output",
    "--content",
    "Focused verification passed on the committed HEAD."
  ]);
  const evidenceId = requiredEventId(evidenceOutput);
  runCli(dir, [
    "task",
    "verify",
    "--status",
    "passed",
    "--evidence",
    evidenceId,
    "--summary",
    "Local commit-bound verification passed; independent review remains external."
  ]);
  runCli(dir, ["task", "park"]);

  return {
    id: "external_review_wait",
    label: "External-review wait",
    question: "Does a parked external wait retain its frozen verdict and safe resume action?",
    agentpackCommand: "agentpack task handoff",
    agentpackOutput: runCli(dir, ["task", "handoff"]),
    directCommand: "git status --short --branch && git log -1 --oneline",
    directOutput: [
      runGit(dir, ["status", "--short", "--branch"]),
      runGit(dir, ["log", "-1", "--oneline"])
    ].join("\n"),
    checks: [
      directionalMustInclude("objective", "external-review objective", "Preserve a commit-bound local PASS while an independent reviewer evaluates the same HEAD."),
      directionalMustInclude("constraints", "frozen-edit constraint", "Do not edit while the external review is pending"),
      directionalMustInclude("verification", "frozen passed verdict", "Verification: passed - Local commit-bound verification passed; independent review remains external."),
      directionalMustInclude("verification", "verification evidence", `Evidence: ${evidenceId}`),
      directionalMustInclude("next_safe_action", "external-review resume action", "Resume after the independent review verdict"),
      directionalMustInclude("development_state", "parked lifecycle state", "Wait for independent verification [parked]")
    ]
  };
}

function deliveryAuthorizationScenario() {
  const dir = createFixture("delivery-authorization", {
    "README.md": "# Delivery fixture\n"
  });
  runGit(dir, ["checkout", "-b", "feature/delivery-boundary"]);
  const head = runGit(dir, ["rev-parse", "--short", "HEAD"]).trim();
  runCli(dir, [
    "task",
    "start",
    "Deliver reviewed change",
    "--objective",
    "Push the reviewed commit and open a draft pull request against main.",
    "--constraint",
    "Authorization covers one normal push and draft pull-request creation only.",
    "--constraint",
    "Do not force-push, merge, approve, comment, close, retitle, tag, publish, or resolve review threads.",
    "--next",
    "Verify the exact branch and HEAD before the authorized push",
    "--risk",
    "medium"
  ]);

  return {
    id: "delivery_authorization",
    label: "Delivery authorization",
    question: "Can a delivery agent distinguish an allowed push/PR action from forbidden remote mutations?",
    agentpackCommand: "agentpack task handoff",
    agentpackOutput: runCli(dir, ["task", "handoff"]),
    directCommand: "git status --short --branch && git log -1 --format=%H",
    directOutput: [
      runGit(dir, ["status", "--short", "--branch"]),
      runGit(dir, ["log", "-1", "--format=%H"])
    ].join("\n"),
    checks: [
      directionalMustInclude("objective", "delivery objective", "Push the reviewed commit and open a draft pull request against main."),
      directionalMustInclude("authorization", "allowed remote action", "Authorization covers one normal push and draft pull-request creation only."),
      directionalMustInclude("authorization", "forbidden remote actions", "Do not force-push, merge, approve, comment, close, retitle, tag, publish, or resolve review threads."),
      directionalMustInclude("development_state", "delivery branch", "Branch: feature/delivery-boundary"),
      directionalMustInclude("development_state", "delivery HEAD", `HEAD: ${head}`),
      directionalMustInclude("next_safe_action", "pre-push check", "Verify the exact branch and HEAD before the authorized push")
    ]
  };
}

function developmentStateDriftScenario() {
  const dir = createFixture("development-state-drift", {
    "src/state.ts": "export const state = \"baseline\";\n"
  });
  runCli(dir, [
    "task",
    "start",
    "Detect development-state drift",
    "--objective",
    "Stop a handoff when the branch, HEAD, or worktree no longer matches the accepted Task Passport.",
    "--write-scope",
    "src/state.ts",
    "--next",
    "Resolve every drift warning before editing",
    "--risk",
    "high"
  ]);
  const passport = JSON.parse(runCli(dir, ["task", "passport"]));
  const expectedHead = passport.currentHead;
  writeFixtureFile(dir, "src/state.ts", "export const state = \"drifted\";\n");
  runGit(dir, ["add", "src/state.ts"]);
  commitFixture(dir, "unexpected state drift");
  const actualHead = runGit(dir, ["rev-parse", "--short", "HEAD"]).trim();
  runGit(dir, ["checkout", "-b", "unexpected/review"]);
  const passportPath = path.join(dir, ".agentpack", "tasks", passport.id, "passport.json");
  writeFileSync(passportPath, `${JSON.stringify({
    ...passport,
    worktree: path.join(dir, "other-worktree")
  }, null, 2)}\n`, "utf8");

  return {
    id: "development_state_drift",
    label: "Development-state drift",
    question: "Does handoff fail visibly when branch, HEAD, and worktree identity drift?",
    agentpackCommand: "agentpack task handoff",
    agentpackOutput: runCli(dir, ["task", "handoff"]),
    directCommand: "git status --short --branch && git log -1 --format=%H",
    directOutput: [
      runGit(dir, ["status", "--short", "--branch"]),
      runGit(dir, ["log", "-1", "--format=%H"])
    ].join("\n"),
    checks: [
      directionalMustInclude("objective", "drift objective", "Stop a handoff when the branch, HEAD, or worktree no longer matches the accepted Task Passport."),
      directionalMustInclude("development_state", "current drifted HEAD", `HEAD: ${actualHead}`),
      directionalMustInclude("development_state", "branch drift", "Branch drift: passport branch is main, current branch is unexpected/review."),
      directionalMustInclude("development_state", "HEAD drift", `HEAD drift: passport head is ${expectedHead}, current head is ${actualHead}.`),
      directionalMustInclude("development_state", "worktree drift", "Worktree path differs from the current pack root; verify this passport belongs to this workspace."),
      directionalMustInclude("next_safe_action", "drift remediation", "Resolve every drift warning before editing")
    ]
  };
}

function releasePrepHandoffScenario() {
  const dir = createFixture("release-prep-handoff", {
    "package.json": JSON.stringify({
      name: "example-release-fixture",
      version: "1.2.3",
      scripts: {
        test: "node --test"
      }
    }, null, 2),
    "docs/RELEASING.md": [
      "# Releasing",
      "",
      "Run focused tests, inspect the staged diff, then publish from GitHub Actions.",
      ""
    ].join("\n"),
    ".github/workflows/publish.yml": [
      "name: Publish",
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
    ].join("\n")
  });
  runCli(dir, ["set", "goal", "Prepare a normal weekly release handoff."]);
  runCli(dir, [
    "task",
    "start",
    "Prepare release handoff",
    "--objective",
    "Summarize release readiness, remaining checks, and rollout constraints.",
    "--constraint",
    "Do not push, tag, publish, or create GitHub Releases from benchmark fixtures.",
    "--write-scope",
    "docs/RELEASING.md",
    "--write-scope",
    ".github/workflows/publish.yml",
    "--next",
    "Run release preflight in the real repo",
    "--next",
    "Inspect staged diff before commit",
    "--risk",
    "medium"
  ]);
  runCli(dir, [
    "source",
    "add",
    "docs/RELEASING.md",
    "--summary",
    "Release docs require focused tests, staged diff inspection, and workflow-based publishing."
  ]);
  runCli(dir, [
    "source",
    "add",
    ".github/workflows/publish.yml",
    "--summary",
    "Publish workflow uses a release event and id-token permission for provenance."
  ]);
  runCli(dir, [
    "record",
    "decision",
    "Release actions remain manual; benchmark fixtures must not publish."
  ]);
  runCli(dir, [
    "checkpoint",
    "-m",
    "Release handoff scaffolded",
    "--status",
    "Ready for preflight",
    "--next",
    "Run preflight in the real repo"
  ]);

  return {
    id: "release_prep_handoff",
    label: "Release-prep handoff",
    question: "Hand off release readiness without running release actions.",
    agentpackCommand: "agentpack task handoff",
    agentpackOutput: runCli(dir, ["task", "handoff"]),
    directCommand: "git status --short --branch && git log --oneline -5 && cat docs/RELEASING.md .github/workflows/publish.yml",
    directOutput: [
      runGit(dir, ["status", "--short", "--branch"]),
      runGit(dir, ["log", "--oneline", "-5"]),
      readFiles(dir, ["docs/RELEASING.md", ".github/workflows/publish.yml"])
    ].join("\n"),
    checks: [
      directionalMustInclude("objective", "release objective", "Summarize release readiness, remaining checks, and rollout constraints."),
      directionalMustInclude("authorization", "release authorization boundary", "Do not push, tag, publish, or create GitHub Releases from benchmark fixtures."),
      directionalMustInclude("write_scope", "release docs scope", "docs/RELEASING.md"),
      directionalMustInclude("next_safe_action", "release next action", "Run release preflight in the real repo")
    ]
  };
}

function createFixture(name, files) {
  const dir = path.join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    writeFixtureFile(dir, filePath, content);
  }
  runGit(dir, ["init"]);
  runGit(dir, ["branch", "-M", "main"]);
  runCli(dir, ["init"]);
  runGit(dir, ["add", "."]);
  runGit(dir, [
    "-c",
    "user.name=Agentpack Benchmark",
    "-c",
    "user.email=benchmark@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial"
  ]);
  return dir;
}

function addOriginUpstream(dir, name) {
  const remote = path.join(fixturesRoot, name);
  mkdirSync(remote, { recursive: true });
  runGit(remote, ["init", "--bare"]);
  runGit(dir, ["remote", "add", "origin", remote]);
  runGit(dir, ["push", "-u", "origin", "main"]);
}

function commitFixture(dir, message) {
  runGit(dir, [
    "-c",
    "user.name=Agentpack Benchmark",
    "-c",
    "user.email=benchmark@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message
  ]);
}

function writeFixtureFile(root, filePath, content) {
  const absolutePath = path.join(root, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

function summarizeScenario(scenario) {
  const agentpack = measure(scenario.agentpackOutput);
  const mcp = measure(wrapMcpText(scenario.agentpackOutput));
  const direct = measure(scenario.directOutput);
  const sectionBreakdown = measureMarkdownSections(scenario.agentpackOutput);
  const summary = {
    agentpack,
    mcp,
    direct,
    sectionBreakdown
  };
  const checks = (scenario.checks || []).map((check) => ({
    kind: check.kind,
    signal: check.signal,
    label: check.label,
    passed: Boolean(check.check(scenario.agentpackOutput, summary))
  }));

  return {
    id: scenario.id,
    label: scenario.label,
    question: scenario.question,
    agentpackCommand: scenario.agentpackCommand,
    directCommand: scenario.directCommand,
    agentpack,
    mcp,
    mcpOverhead: {
      characters: mcp.characters - agentpack.characters,
      estimatedTokens: mcp.estimatedTokens - agentpack.estimatedTokens
    },
    direct,
    deltaVsDirect: {
      agentpackTokens: agentpack.estimatedTokens - direct.estimatedTokens,
      mcpTokens: mcp.estimatedTokens - direct.estimatedTokens
    },
    ...(sectionBreakdown.length > 0 ? { sectionBreakdown } : {}),
    ...(checks.length > 0 ? { checks } : {})
  };
}

function summarizeChecks(scenarios, kind) {
  const checks = scenarios.flatMap((scenario) => (
    scenario.checks || []
  ).filter((check) => check.kind === kind).map((check) => ({
    scenario: scenario.id,
    ...check
  })));
  const signalMap = new Map();
  for (const check of checks) {
    const current = signalMap.get(check.signal) || { signal: check.signal, passed: 0, total: 0 };
    current.total += 1;
    current.passed += check.passed ? 1 : 0;
    signalMap.set(check.signal, current);
  }
  const passed = checks.filter((check) => check.passed).length;
  return {
    passed,
    total: checks.length,
    failed: checks.length - passed,
    signals: [...signalMap.values()]
  };
}

function directionalMustInclude(signal, label, text) {
  return {
    kind: "directional",
    signal,
    label,
    check: (output) => output.includes(text)
  };
}

function directionalMustExclude(signal, label, text) {
  return {
    kind: "directional",
    signal,
    label,
    check: (output) => !output.includes(text)
  };
}

function maxEstimatedUsage(maxTokens) {
  return {
    kind: "guardrail",
    signal: "token_budget",
    label: `estimated usage <= ${maxTokens}`,
    check: (output) => {
      const tokens = estimatedUsageFromOutput(output);
      return tokens !== null && tokens <= maxTokens;
    }
  };
}

function requiredEventId(output) {
  const eventId = String(output || "").match(/evt_[A-Za-z0-9_-]+/u)?.[0];
  if (!eventId) {
    throw new Error(`Expected an evidence event id, got: ${String(output || "").trim()}`);
  }
  return eventId;
}

function estimatedUsageFromOutput(output) {
  const match = String(output || "").match(/Estimated usage: ~(\d+) tokens/u);
  return match ? Number.parseInt(match[1], 10) : null;
}

function measure(output) {
  return {
    characters: output.length,
    estimatedTokens: estimateTokens(output)
  };
}

function estimateTokens(output) {
  return Math.max(1, Math.ceil(String(output || "").length / 4));
}

function measureMarkdownSections(output) {
  const text = String(output || "");
  if (!/^## /mu.test(text)) {
    return [];
  }

  const sections = [];
  let title = "Header";
  let lines = [];

  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      pushMeasuredSection(sections, title, lines);
      title = line.replace(/^##\s+/u, "").trim() || "Untitled";
      lines = [line];
    } else {
      lines.push(line);
    }
  }

  pushMeasuredSection(sections, title, lines);
  return sections;
}

function pushMeasuredSection(sections, title, lines) {
  const text = lines.join("\n").trim();
  if (!text) {
    return;
  }

  sections.push({
    title,
    ...measure(text)
  });
}

function wrapMcpText(text) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text
        }
      ]
    }
  }, null, 2);
}

function runCli(cwd, cliArgs) {
  const home = path.join(fixturesRoot, "_homes", path.basename(cwd));
  mkdirSync(home, { recursive: true });
  return execFileSync(process.execPath, [cliPath, ...cliArgs], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local")
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runGit(cwd, gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function readFiles(cwd, filePaths) {
  return filePaths.map((filePath) => [
    `$ cat ${filePath}`,
    readFileSync(path.join(cwd, filePath), "utf8")
  ].join("\n")).join("\n");
}

function printReport(report) {
  const sectionRows = report.scenarios.flatMap((scenario) => (
    scenario.sectionBreakdown || []
  ).map((section) => [
    scenario.id,
    section.title,
    formatTokenCount(section.estimatedTokens),
    String(section.characters)
  ]));
  const lines = [
    "Agentpack directional-integrity benchmark",
    `Generated: ${report.generatedAt}`,
    `Estimate: ${report.estimate}`,
    `MCP wrapper: ${report.mcpWrapper}`,
    `Directional integrity: ${report.directionalIntegrity.passed}/${report.directionalIntegrity.total} checks passed`,
    `Guardrails: ${report.guardrails.passed}/${report.guardrails.total} checks passed`,
    "",
    table([
      [
        "Scenario",
        "Agentpack",
        "MCP total",
        "MCP overhead",
        "Direct",
        "AP-direct",
        "MCP-direct"
      ],
      ...report.scenarios.map((scenario) => [
        scenario.label,
        formatTokenCount(scenario.agentpack.estimatedTokens),
        formatTokenCount(scenario.mcp.estimatedTokens),
        formatSignedTokenCount(scenario.mcpOverhead.estimatedTokens),
        formatTokenCount(scenario.direct.estimatedTokens),
        formatSignedTokenCount(scenario.deltaVsDirect.agentpackTokens),
        formatSignedTokenCount(scenario.deltaVsDirect.mcpTokens)
      ])
    ]),
    ""
  ];

  if (sectionRows.length > 0) {
    lines.push(
      "Agentpack section breakdown:",
      table([
        ["Scenario", "Section", "Tokens", "Characters"],
        ...sectionRows
      ]),
      ""
    );
  }

  const checkRows = report.scenarios.flatMap((scenario) => (
    scenario.checks || []
  ).map((check) => [
    scenario.id,
    check.kind,
    check.signal,
    check.label,
    check.passed ? "pass" : "fail"
  ]));

  if (checkRows.length > 0) {
    lines.push(
      "Directional-integrity and guardrail checks:",
      table([
        ["Scenario", "Kind", "Signal", "Check", "Status"],
        ...checkRows
      ]),
      ""
    );
  }

  lines.push(
    "Commands:",
    ...report.scenarios.flatMap((scenario) => [
      `- ${scenario.id}: ${scenario.agentpackCommand}`,
      `  direct: ${scenario.directCommand}`
    ]),
    "",
    "Notes:",
    "- Token counts use Agentpack's rough local estimate, not a model tokenizer.",
    "- Directional checks assert must-have handoff facts; any failure is a continuity regression.",
    "- Guardrails diagnose ceremony and output cost without redefining the product goal.",
    "- Direct baselines show the likely git/file reads an agent would do without Agentpack context.",
    "- Positive deltas are overhead; negative deltas mean Agentpack output was shorter than the direct baseline.",
    "- Section breakdown attributes Markdown resume growth to buckets such as Source Cache, Evidence, and Current Task Passport."
  );

  process.stdout.write(lines.join("\n"));
  process.stdout.write("\n");
}

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row, rowIndex) => {
    const line = row.map((cell, column) => cell.padEnd(widths[column])).join("  ");
    if (rowIndex === 0) {
      return `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}`;
    }
    return line;
  }).join("\n");
}

function formatTokenCount(value) {
  return String(value);
}

function formatSignedTokenCount(value) {
  return value > 0 ? `+${value}` : String(value);
}
