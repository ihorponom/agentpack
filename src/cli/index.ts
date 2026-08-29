import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createCheckpoint, diffCheckpoints } from "../core/checkpoints.js";
import {
  exportTaskBundle,
  formatBundleExportResult,
  formatBundleImportPlan,
  formatBundleImportResult,
  formatBundleInspectResult,
  importTaskBundle,
  inspectTaskBundle,
  planTaskBundleImport
} from "../core/bundles.js";
import { buildResume } from "../core/resume.js";
import { formatBudgetPresets, resolveBudget } from "../core/presets.js";
import {
  applyCompactPlan,
  buildCompactPlan,
  DEFAULT_EVIDENCE_AGE_DAYS,
  DEFAULT_KEEP_CHECKPOINTS,
  formatCompactPlan
} from "../core/compact.js";
import type { CompactOptions } from "../core/compact.js";
import { buildDoctorReport } from "../core/doctor.js";
import { buildReleasePreflightReport } from "../core/release.js";
import { redactForRoot } from "../core/redaction.js";
import {
  auditCurrentTask,
  blockCurrentTask,
  closeCurrentTask,
  finalizeAdvisories,
  finalizeCurrentTask,
  formatCurrentTaskHandoff,
  formatCurrentTaskStatus,
  formatTaskAuditReport,
  formatTaskFinalizationMessage,
  formatTaskList,
  formatVerificationUpdateMessage,
  getCurrentPassport,
  listTasks,
  parkCurrentTask,
  readPassport,
  scopeOverlaps,
  startTask,
  switchTask,
  type TaskUpdateOptions,
  updateCurrentTaskPassport,
  updateCurrentTaskVerification
} from "../core/tasks.js";
import type { TaskStatus } from "../core/types.js";
import {
  appendEvent,
  findPackRoot,
  getPackPath,
  initPack,
  readState,
  requirePackRoot,
  withPackWriteLock,
  writeState
} from "../core/store.js";
import {
  addEvidence,
  addSourceRecord,
  formatLedgerStatus,
  formatSourceStatuses,
  getSourceStatus,
  getSourceStatuses,
  getCeremonyDiagnostics,
  getLedgerStatus,
  pruneMissingSourceRecords,
  removeSourceRecord,
  reviewSourceRecord,
  replayEvents
} from "../operations.js";
import type { SourceStatusKind } from "../operations.js";
import { installIntegration } from "../integrations/install.js";
import { evaluateGate, formatGateReport, type GateOptions, type GateReport } from "../core/gate.js";
import { startMcpServer } from "../mcp/server.js";
import { startTui } from "../core/tui.js";

export type ArgValue = string | boolean | string[];

interface ParsedArgs {
  options: Record<string, ArgValue>;
  positionals: string[];
}

export async function runCli(argv: string[], cwd: string): Promise<void> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }

  if (isExplicitHelpRequest(rest[0]) && printCommandHelp(command)) {
    return;
  }

  if (command === "init") {
    const packPath = initPack(cwd);
    process.stdout.write(`Initialized Agentpack at ${packPath}\n`);
    return;
  }

  if (command === "mcp") {
    const parsed = parseArgs(rest);
    startMcpServer(resolveMcpStartDir(parsed.options, cwd));
    return;
  }

  if (command === "doctor") {
    const report = buildDoctorReport(cwd);
    process.stdout.write(`${report.text}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "release") {
    releaseCommand(cwd, rest);
    return;
  }

  if (command === "bundle" && isHelpRequest(rest[0])) {
    printBundleHelp();
    return;
  }

  if (command === "bundle" && rest[0] === "inspect") {
    bundleInspectCommand(rest.slice(1));
    return;
  }

  if (command === "bundle" && rest[0] === "import-plan") {
    bundleImportPlanCommand(findPackRoot(cwd) || path.resolve(cwd), rest.slice(1));
    return;
  }

  if (command === "bundle" && rest[0] === "import") {
    bundleImportCommand(findPackRoot(cwd) || path.resolve(cwd), rest.slice(1));
    return;
  }

  if (command === "task" && isHelpRequest(rest[0])) {
    printTaskHelp();
    return;
  }

  if (command === "task" && rest[0] === "gate") {
    // The gate must stay silent and permissive where Agentpack is not set up, so hooks are safe to
    // install globally without breaking repos that do not use it.
    gateCommand(findPackRoot(cwd), rest.slice(1));
    return;
  }

  const root = requirePackRoot(cwd);

  if (command === "status") {
    const state = readState(root);
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  if (command === "tui") {
    startTui(root);
    return;
  }

  if (command === "record") {
    recordCommand(root, rest);
    return;
  }

  if (command === "task") {
    taskCommand(root, rest);
    return;
  }

  if (command === "note") {
    noteCommand(root, rest);
    return;
  }

  if (command === "source") {
    sourceCommand(root, rest);
    return;
  }

  if (command === "ledger") {
    ledgerCommand(root, rest);
    return;
  }

  if (command === "evidence") {
    evidenceCommand(root, rest);
    return;
  }

  if (command === "run") {
    runCommand(root, rest);
    return;
  }

  if (command === "checkpoint") {
    const parsed = parseArgs(rest);
    const checkpoint = createCheckpoint(root, {
      summary: stringOption(parsed.options.message) || stringOption(parsed.options.m) || stringOption(parsed.options.summary),
      status: stringOption(parsed.options.status),
      nextActions: toArray(parsed.options.next)
    });
    process.stdout.write(`Created checkpoint ${checkpoint.id}\n`);
    return;
  }

  if (command === "resume") {
    const parsed = parseArgs(rest);
    const resume = buildResume(root, {
      budget: budgetOption(parsed.options),
      query: stringOption(parsed.options.query)
    });
    process.stdout.write(`${resume.markdown}\n`);
    return;
  }

  if (command === "export") {
    const parsed = parseArgs(rest);
    const target = stringOption(parsed.options.to) || parsed.positionals[0] || "markdown";
    const resume = buildResume(root, {
      budget: budgetOption(parsed.options, 4000),
      query: stringOption(parsed.options.query)
    });
    const filePath = exportPath(root, target);
    writeFileSync(filePath, resume.markdown, "utf8");
    process.stdout.write(`Exported ${target} handoff to ${filePath}\n`);
    return;
  }

  if (command === "bundle") {
    bundleCommand(root, rest);
    return;
  }

  if (command === "diff") {
    const parsed = parseArgs(rest);
    const diff = diffCheckpoints(root, parsed.positionals[0], parsed.positionals[1]);
    process.stdout.write(`${redactForRoot(root, diff)}\n`);
    return;
  }

  if (command === "replay") {
    const parsed = parseArgs(rest);
    const replay = replayEvents(root, numberOption(parsed.options.limit) || 50);
    process.stdout.write(`${redactForRoot(root, replay)}\n`);
    return;
  }

  if (command === "install") {
    const target = rest[0];
    if (!target) {
      throw new Error("install requires target: codex, claude, claude-desktop, or cursor");
    }
    const parsed = parseArgs(rest.slice(1));
    const dryRun = installDryRun(parsed.options);
    const message = installIntegration(root, target, { dryRun });
    process.stdout.write(`${message}\n`);
    return;
  }

  if (command === "set") {
    setCommand(root, rest);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

export function resolveMcpStartDir(options: Record<string, ArgValue>, cwd: string): string {
  return stringOption(options.root) || process.env.AGENTPACK_ROOT || cwd;
}

function printHelp(): void {
  process.stdout.write(`Agentpack

Repo-native task continuity for AI coding agents.

Default workflow:
  Initialize a repo, install an MCP client surface, then let connected agents
  use the generated project instructions. The CLI is for setup, inspection,
  task handoff, debugging, demos, and fallback.

Setup:
  agentpack init
  agentpack install codex|claude|claude-desktop|cursor|git-hooks [--dry-run|--write]
  agentpack doctor
  agentpack mcp [--root <path>]

Task Passport:
  agentpack task start <title> [--objective <text>] [--write-scope <path>] [--next <item>] [--risk low|medium|high]
  agentpack task status
  agentpack task handoff
  agentpack task verify --status passed|failed|accepted [--evidence <id>] [--summary <text>]
  agentpack task finalize
  agentpack task --help

Inspect and export:
  agentpack tui
  agentpack resume --preset agent [--query <text>]
  agentpack source status [--json] [--changed] [--missing]
  agentpack ledger status
  agentpack export --to markdown --preset chat [--query <text>]
  agentpack bundle export --task current --output task.agentpack-bundle.json [--source <path>]
  agentpack bundle inspect task.agentpack-bundle.json [--json]
  agentpack bundle import-plan task.agentpack-bundle.json [--as-new] [--json]
  agentpack bundle import task.agentpack-bundle.json [--write] [--as-new] [--json]
  agentpack release preflight

More:
  agentpack --version
  agentpack --help
  docs/CLI.md has the full manual and fallback command reference.

MCP root resolution: --root, then AGENTPACK_ROOT, then current working directory.
Install defaults to dry-run; pass --write to apply generated client config.
Budget presets: ${formatBudgetPresets()}
`);
}

function isHelpRequest(value: string | undefined): boolean {
  return !value || value === "--help" || value === "-h" || value === "help";
}

function isExplicitHelpRequest(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

function printCommandHelp(command: string): boolean {
  if (command === "task") {
    printTaskHelp();
    return true;
  }

  const helpText = commandHelpText(command);
  if (!helpText) {
    return false;
  }
  process.stdout.write(`${helpText}\n`);
  return true;
}

function commandHelpText(command: string): string {
  if (command === "init") {
    return `agentpack init

Initialize .agentpack/ in the current repository and add local Agentpack files to .gitignore.`;
  }

  if (command === "install") {
    return `agentpack install codex|claude|claude-desktop|cursor|git-hooks [--dry-run|--write]

Generate MCP client configuration and project instructions for one client surface.
git-hooks installs a pre-commit hook that runs \`agentpack task gate --staged\`.
Defaults to dry-run; pass --write to apply generated files.
On macOS, claude-desktop --write also reports and atomically merges the repo entry into the user-local Desktop config.
This uses optimistic conflict detection; unrelated active writers are not locked.`;
  }

  if (command === "mcp") {
    return `agentpack mcp [--root <path>]

Start the Agentpack MCP stdio server.
Root resolution: --root, then AGENTPACK_ROOT, then current working directory.`;
  }

  if (command === "doctor") {
    return `agentpack doctor

Check local Agentpack setup, generated client config, git state, source-cache health, and Node runtime.`;
  }

  if (command === "release") {
    return `agentpack release preflight

Print a read-only release-prep report and checklist. It does not push, tag, publish, or create GitHub Releases.`;
  }

  if (command === "resume") {
    return `agentpack resume [--preset quick|chat|agent|deep] [--budget <tokens>] [--query <text>]

Print a compact markdown handoff for the current repository.
Budget presets: ${formatBudgetPresets()}`;
  }

  if (command === "tui") {
    return `agentpack tui

Open the dependency-free, keyboard-driven read-only ledger inspector. In a non-terminal
environment it prints a deterministic static task snapshot and exits. It never changes
the current task or any .agentpack file.`;
  }

  if (command === "source") {
    return `agentpack source status [--json] [--changed] [--missing]
agentpack source add <file> --summary <text> [--snippet <text>]
agentpack source review <file> --summary <text> [--snippet <text>]
agentpack source remove <file>
agentpack source prune --missing

Record, inspect, refresh, and prune durable source conclusions.`;
  }

  if (command === "ledger") {
    return `agentpack ledger status [--json]
agentpack ledger compact [--write] [--purge] [--keep-checkpoints <n>] [--evidence-age-days <n>]

Print a read-only ledger hygiene inventory: task counts, event/evidence/checkpoint/export sizes, source-cache status counts, referenced evidence counts, and bounded advisory review candidates.
compact slims old checkpoints (keeps checkpoint.json, moves diff/status/resume of snapshots beyond the newest ${DEFAULT_KEEP_CHECKPOINTS}), archives superseded source-cache events from events.jsonl, and archives unreferenced evidence older than ${DEFAULT_EVIDENCE_AGE_DAYS} days.
Decisions, dead ends, referenced evidence, and checkpoint metadata always stay. Dry-run by default; --write moves data into .agentpack/archive/; --purge deletes instead of archiving.
No cleanup is performed.`;
  }

  if (command === "evidence") {
    return `agentpack evidence add [--kind <type>] [--file <path>] [--content <text>] [--command <text>] [--exitCode <code>]

Attach meaningful verification, review, command, or note evidence to the ledger.`;
  }

  if (command === "checkpoint") {
    return `agentpack checkpoint [-m <summary>] [--status <text>] [--next <item>]

Create a task-state checkpoint with an optional status and next actions.`;
  }

  if (command === "export") {
    return `agentpack export [--to markdown|chatgpt|<name>] [--preset quick|chat|agent|deep] [--budget <tokens>] [--query <text>]

Write a markdown handoff under .agentpack/exports/ for clients that cannot use MCP.`;
  }

  if (command === "bundle") {
    return `agentpack bundle export --task current|<id> --output <file> [--source <path>] [--no-evidence]
agentpack bundle inspect <file> [--json]
agentpack bundle import-plan <file> [--as-new] [--json]
agentpack bundle import <file> [--write] [--as-new] [--json]

Export, inspect, plan, or explicitly apply a structured task bundle import. Import defaults to a read-only plan; --write is required to change destination pack state.`;
  }

  if (command === "diff") {
    return `agentpack diff [from-checkpoint] [to-checkpoint]

Compare two checkpoints, defaulting to recent checkpoint history when ids are omitted.`;
  }

  if (command === "replay") {
    return `agentpack replay [--limit <count>]

Print recent ledger events for debugging and handoff inspection.`;
  }

  if (command === "status") {
    return `agentpack status

Print raw Agentpack repo state as JSON. Mostly useful for debugging.`;
  }

  if (command === "record") {
    return `agentpack record decision|dead-end|note <text> [--reason <text>] [--file <path>] [--evidence <id>]

Record durable decisions, failed approaches, or notes that future agents should reuse.`;
  }

  if (command === "note") {
    return `agentpack note <text>

Record a lightweight local task-state note.`;
  }

  if (command === "run") {
    return `agentpack run <command>

Run a shell command from the repository root and attach stdout, stderr, and exit code as evidence.`;
  }

  if (command === "set") {
    return `agentpack set goal|status|next <text>

Update the repo-level goal, current status, or next actions.`;
  }

  return "";
}

function printTaskHelp(): void {
  process.stdout.write(`Agentpack Task Passports

Task Passports keep the current task's reviewed state close to the repo:
objective, constraints, write scope, next actions, verification, evidence,
handoff context, and lifecycle status.

Common workflow:
  agentpack task start <title> [--objective <text>] [--write-scope <path>] [--next <item>] [--risk low|medium|high]
  agentpack task status
  agentpack task update [--objective <text>] [--write-scope <path>] [--next <item>] [--clear-next-actions] [--risk low|medium|high]
  agentpack task verify [--status pending|passed|failed|accepted] [--evidence <id>] [--summary <text>]
  agentpack task handoff
  agentpack task finalize [--status passed|failed|accepted] [--evidence <id>] [--summary <text>] [--force]

Inspection and coordination:
  agentpack task list [--scope <path>] [--status <status>] [--open]
  agentpack task passport
  agentpack task switch <id>
  agentpack task audit [--json]
  agentpack task gate [--file <path> ...] [--staged] [--client claude|codex|cursor] [--json]
  agentpack task park
  agentpack task block --reason <text>
  agentpack task close

Notes:
  Write scopes are repo-relative paths; . means the repository root.
  task status is the quick current-task view.
  task audit is the diagnostic continuity check; --json exposes additive structured review candidates.
  task handoff is the compact summary for another chat, client, worktree, or agent.
  task finalize refuses unknown or pending verification by default.
  task finalize --status accepted refuses tasks with remaining next actions unless --force is passed.
  task audit and finalize print advisory-only adversarial-verification guidance: low risk needs a concrete self-challenge; medium/high needs independent read-only review plus a named disconfirming check. Generic risks-considered or tests-passed prose is not enough.
  task finalize prints advisories (uncommitted in-scope changes, remaining next actions, missing checkpoint); they never block.
  task gate checks the current passport lifecycle, write scope, and branch before edits or commits.
  task gate --client adapts native Claude, Codex, or Cursor pre-tool hook JSON on stdin.
  task gate warns by default; set "gateMode": "block" in .agentpack/config.json to enforce (exit code 2).
  task gate exits 0 quietly when no .agentpack exists, so hooks are safe in non-Agentpack repos.
`);
}

function recordCommand(root: string, rest: string[]): void {
  const type = rest[0];
  const args = rest.slice(1);
  const parsed = parseArgs(args);
  const text = stringOption(parsed.options.text) || parsed.positionals.join(" ");

  if (!isRecordType(type)) {
    throw new Error("record type must be decision, dead-end, or note");
  }

  if (!text) {
    throw new Error("record requires text");
  }

  const event = appendEvent(root, type, {
    text: redactForRoot(root, text),
    reason: redactForRoot(root, stringOption(parsed.options.reason) || ""),
    files: toArray(parsed.options.file),
    evidence: toArray(parsed.options.evidence)
  });

  process.stdout.write(`Recorded ${type} ${event.id}\n`);
}

function noteCommand(root: string, rest: string[]): void {
  const parsed = parseArgs(rest);
  const text = stringOption(parsed.options.text) || parsed.positionals.join(" ");

  if (!text) {
    throw new Error("note requires text");
  }

  const event = appendEvent(root, "note", { text: redactForRoot(root, text) });
  process.stdout.write(`Recorded note ${event.id}\n`);
}

const TASK_LIST_STATUSES = ["active", "parked", "blocked", "verifying", "completed", "abandoned"] as const satisfies readonly TaskStatus[];
const OPEN_TASK_STATUSES = ["active", "parked", "blocked", "verifying"] as const satisfies readonly TaskStatus[];

function taskListStatusFilters(options: Record<string, ArgValue>): string[] {
  if (options.open !== undefined && options.status !== undefined) {
    throw new Error("task list --open cannot be combined with --status");
  }
  if (options.open !== undefined) {
    // A repeated bare --open collapses to an empty array in addOption; both
    // forms mean the same thing, only a string payload is a usage error.
    const bare = options.open === true || (Array.isArray(options.open) && options.open.length === 0);
    if (!bare) {
      throw new Error("task list --open takes no value");
    }
    return [...OPEN_TASK_STATUSES];
  }
  if (options.status === undefined) {
    return [];
  }
  const values = [...new Set(toArray(options.status).map((value) => value.trim()))];
  const invalid = values.filter((value) => !(TASK_LIST_STATUSES as readonly string[]).includes(value));
  if (values.length === 0 || invalid.length > 0) {
    throw new Error(`task list --status requires one of: ${TASK_LIST_STATUSES.join(", ")}`);
  }
  return values;
}

function gateCommand(root: string | null, args: string[]): void {
  const parsed = parseArgs(args);
  const client = stringOption(parsed.options.client);
  if (client && !["claude", "codex", "cursor"].includes(client)) {
    throw new Error(`Unknown gate client: ${client}`);
  }

  if (!root) {
    if (parsed.options.json) {
      process.stdout.write(`${JSON.stringify({ mode: "off", decision: "allow", taskId: null, taskStatus: null, findings: [] }, null, 2)}\n`);
    }
    return;
  }

  const gateOptions: GateOptions = {
    files: toArray(parsed.options.file),
    staged: Boolean(parsed.options.staged)
  };

  if (client) {
    const hookInput = readHookFilePaths(client);
    gateOptions.files = [...(gateOptions.files || []), ...hookInput.files];
    const report = withHookInputFinding(evaluateGate(root, gateOptions), client, hookInput.understood);
    writeHookOutput(client, report);
    return;
  }

  const report = evaluateGate(root, gateOptions);

  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.decision === "block") {
    process.stderr.write(`${formatGateReport(report)}\n`);
  } else if (report.findings.length > 0) {
    process.stdout.write(`${formatGateReport(report)}\n`);
  }

  if (report.decision === "block") {
    process.exitCode = 2;
  }
}

function readHookFilePaths(client: string): { files: string[]; understood: boolean } {
  let payload = "";
  try {
    payload = readFileSync(0, "utf8");
  } catch {
    return { files: [], understood: false };
  }
  if (!payload.trim()) {
    return { files: [], understood: false };
  }
  try {
    const hook = JSON.parse(payload) as { tool_input?: Record<string, unknown> };
    if (client === "codex") {
      const patch = hook.tool_input?.command;
      const files = typeof patch === "string" ? codexPatchFilePaths(patch) : [];
      return { files, understood: files.length > 0 };
    }
    const filePath = hook.tool_input?.file_path
      ?? hook.tool_input?.notebook_path
      ?? hook.tool_input?.path
      ?? hook.tool_input?.target_file
      ?? hook.tool_input?.target_path;
    const files = typeof filePath === "string" && filePath ? [filePath] : [];
    return { files, understood: files.length > 0 };
  } catch {
    return { files: [], understood: false };
  }
}

function withHookInputFinding(report: GateReport, client: string, understood: boolean): GateReport {
  if (understood || report.mode === "off") {
    return report;
  }
  const level = report.mode === "block" ? "block" : "warn";
  return {
    ...report,
    decision: level === "block" ? "block" : "warn",
    findings: [
      ...report.findings,
      {
        code: "hook-input-unreadable",
        level,
        message: `Cannot determine edited file paths from the ${client} hook payload; the gate cannot enforce task write scope.`
      }
    ]
  };
}

function codexPatchFilePaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
      || line.match(/^\*\*\* Move to: (.+)$/);
    const filePath = match?.[1]?.trim();
    if (filePath) {
      paths.push(filePath);
    }
  }
  return [...new Set(paths)];
}

function writeHookOutput(client: string, report: ReturnType<typeof evaluateGate>): void {
  if (client === "cursor") {
    const summary = report.findings.map((finding) => finding.message).join(" ");
    const output = report.decision === "block"
      ? {
        permission: "deny",
        user_message: `Agentpack gate: ${summary}`,
        agent_message: `Agentpack gate blocked this edit: ${summary}`
      }
      : {
        permission: "allow"
      };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  if (report.findings.length === 0) {
    return;
  }
  const summary = report.findings.map((finding) => finding.message).join(" ");
  const hookSpecificOutput = report.decision === "block"
    ? {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Agentpack gate: ${summary}`
    }
    : {
      hookEventName: "PreToolUse",
      additionalContext: `Agentpack gate warning: ${summary}`
    };
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
}

function taskCommand(root: string, rest: string[]): void {
  const subcommand = rest[0];
  const args = rest.slice(1);

  if (isHelpRequest(subcommand)) {
    printTaskHelp();
    return;
  }

  if (subcommand === "start") {
    const parsed = parseArgs(args);
    const title = parsed.positionals.join(" ").trim();
    const startOptions = {
      title: redactForRoot(root, title),
      objective: redactForRoot(root, stringOption(parsed.options.objective)),
      constraints: toArray(parsed.options.constraint).map((item) => redactForRoot(root, item)),
      writeScope: toArray(parsed.options["write-scope"]),
      nextActions: toArray(parsed.options.next).map((item) => redactForRoot(root, item)),
      tags: toArray(parsed.options.tag)
    };
    const passport = startTask(root, optionValue(parsed.options, "risk")
      ? { ...startOptions, risk: taskRiskOption(parsed.options.risk) }
      : startOptions);
    process.stdout.write(`Started task ${passport.id}\n`);
    return;
  }

  if (subcommand === "list") {
    const parsed = parseArgs(args);
    // A bare --scope or --status mixed with a valued one is silently dropped by
    // addOption's union semantics before these checks can see it; only a lone
    // bare flag or an empty value is detectable here.
    if (typeof parsed.options.scope === "boolean") {
      throw new Error("task list --scope requires a path");
    }
    const scopeFilters = toArray(parsed.options.scope);
    if (scopeFilters.some((filter) => !filter.trim())) {
      throw new Error("task list --scope requires a path");
    }
    const statusFilters = taskListStatusFilters(parsed.options);
    const { tasks: all, warnings } = listTasks(root);
    const warningOutput = warnings.map((warning) => `[warn] ${warning}\n`).join("");
    if (all.length === 0) {
      process.stdout.write(`${warningOutput}No task passports yet. Run \`agentpack task start <title>\`.\n`);
      return;
    }

    let tasks = scopeFilters.length > 0
      ? all.filter((task) => scopeOverlaps(task.writeScope, scopeFilters))
      : all;
    if (statusFilters.length > 0) {
      tasks = tasks.filter((task) => statusFilters.includes(task.status));
    }
    if (tasks.length === 0) {
      const applied = [
        scopeFilters.length > 0 ? `scope ${scopeFilters.join(", ")}` : "",
        statusFilters.length > 0 ? `status ${statusFilters.join(", ")}` : ""
      ].filter(Boolean).join(" and ");
      process.stdout.write(redactForRoot(root, `${warningOutput}No task passports match ${applied}.\n`));
      return;
    }

    process.stdout.write(redactForRoot(root, `${warningOutput}${formatTaskList(tasks)}\n`));
    return;
  }

  if (subcommand === "status") {
    process.stdout.write(`${redactForRoot(root, formatCurrentTaskStatus(root))}\n`);
    return;
  }

  if (subcommand === "handoff") {
    process.stdout.write(`${redactForRoot(root, formatCurrentTaskHandoff(root, getSourceStatuses(root)))}\n`);
    return;
  }

  if (subcommand === "update") {
    const parsed = parseArgs(args);
    const updateOptions: TaskUpdateOptions = {
      constraints: toArray(parsed.options.constraint).map((item) => redactForRoot(root, item)),
      writeScope: toArray(parsed.options["write-scope"]),
      nextActions: toArray(parsed.options.next).map((item) => redactForRoot(root, item)),
      tags: toArray(parsed.options.tag)
    };
    if (optionValue(parsed.options, "objective")) {
      updateOptions.objective = redactForRoot(root, stringOption(parsed.options.objective));
    }
    if (optionValue(parsed.options, "risk")) {
      updateOptions.risk = taskRiskOption(parsed.options.risk);
    }
    if (parsed.options["clear-next-actions"] === true) {
      updateOptions.clearNextActions = true;
    }
    const passport = updateCurrentTaskPassport(root, updateOptions);
    process.stdout.write(`Updated task ${passport.id}\n`);
    return;
  }

  if (subcommand === "passport") {
    const parsed = parseArgs(args);
    const passport = parsed.positionals[0]
      ? readPassport(root, parsed.positionals[0])
      : getCurrentPassport(root);
    if (!passport) {
      throw new Error("No current task. Run `agentpack task start <title>` first.");
    }
    process.stdout.write(`${redactForRoot(root, JSON.stringify(passport, null, 2))}\n`);
    return;
  }

  if (subcommand === "switch") {
    const parsed = parseArgs(args);
    const taskId = parsed.positionals[0];
    if (!taskId) {
      throw new Error("task switch requires a task id");
    }
    const passport = switchTask(root, taskId);
    process.stdout.write(`Switched to task ${passport.id}\n`);
    return;
  }

  if (subcommand === "audit") {
    const parsed = parseArgs(args);
    const report = auditCurrentTask(root, getSourceStatuses(root), getCeremonyDiagnostics(root));
    process.stdout.write(`${parsed.options.json === true ? JSON.stringify(report, null, 2) : formatTaskAuditReport(report)}\n`);
    return;
  }

  if (subcommand === "park") {
    const passport = parkCurrentTask(root);
    process.stdout.write(`Parked task ${passport.id}\n`);
    return;
  }

  if (subcommand === "block") {
    const parsed = parseArgs(args);
    const reason = redactForRoot(root, stringOption(parsed.options.reason) || parsed.positionals.join(" "));
    const passport = blockCurrentTask(root, reason);
    process.stdout.write(`Blocked task ${passport.id}\n`);
    return;
  }

  if (subcommand === "verify" || subcommand === "update-verification") {
    const parsed = parseArgs(args);
    const result = updateCurrentTaskVerification(root, {
      status: stringOption(parsed.options.status),
      evidence: toArray(parsed.options.evidence),
      summary: redactForRoot(root, stringOption(parsed.options.summary))
    });
    const { passport } = result;
    process.stdout.write(`${formatVerificationUpdateMessage(passport, result.changed)}\n`);
    return;
  }

  if (subcommand === "finalize") {
    const parsed = parseArgs(args);
    const passport = finalizeCurrentTask(root, {
      status: stringOption(parsed.options.status),
      evidence: toArray(parsed.options.evidence),
      summary: redactForRoot(root, stringOption(parsed.options.summary)),
      force: parsed.options.force === true
    });
    process.stdout.write(`${formatTaskFinalizationMessage(passport)}\n`);
    const advisories = finalizeAdvisories(root, passport);
    if (advisories.length > 0) {
      process.stdout.write(`Advisories:\n${advisories.map((advisory) => `- ${advisory}`).join("\n")}\n`);
    }
    return;
  }

  if (subcommand === "close") {
    const passport = closeCurrentTask(root);
    process.stdout.write(`Closed task ${passport.id}\n`);
    return;
  }

  throw new Error("task command supports start, update, list, status, handoff, passport, switch, audit, park, block, verify, update-verification, finalize, and close");
}

function printBundleHelp(): void {
  process.stdout.write(`${commandHelpText("bundle")}\n`);
}

function bundleCommand(root: string, rest: string[]): void {
  const subcommand = rest[0];
  const args = rest.slice(1);

  if (subcommand === "export") {
    const parsed = parseArgs(args);
    const outputPath = stringOption(parsed.options.output) || stringOption(parsed.options.o);
    const result = exportTaskBundle(root, {
      taskId: stringOption(parsed.options.task) || "current",
      outputPath,
      sourcePaths: toArray(parsed.options.source),
      includeEvidence: !booleanOption(parsed.options["no-evidence"], "--no-evidence"),
      producerVersion: readPackageVersion()
    });
    process.stdout.write(`${formatBundleExportResult(result)}\n`);
    return;
  }

  // inspect, import-plan, and import are dispatched earlier in runCli so they
  // work before `agentpack init`; only export reaches here.
  throw new Error("bundle command supports export, inspect, import-plan, and import");
}

function bundleInspectCommand(args: string[]): void {
  const parsed = parseArgs(args);
  const filePath = parsed.positionals[0];
  if (!filePath) {
    throw new Error("bundle inspect requires a bundle file path");
  }
  const result = inspectTaskBundle(filePath);
  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatBundleInspectResult(result)}\n`);
}

function bundleImportPlanCommand(root: string, args: string[]): void {
  const parsed = parseArgs(args);
  const filePath = parsed.positionals[0];
  if (!filePath) {
    throw new Error("bundle import-plan requires a bundle file path");
  }
  const plan = planTaskBundleImport(root, filePath, { asNew: booleanOption(parsed.options["as-new"], "--as-new") });
  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatBundleImportPlan(plan)}\n`);
}

function bundleImportCommand(root: string, args: string[]): void {
  const parsed = parseArgs(args);
  const filePath = parsed.positionals[0];
  if (!filePath) {
    throw new Error("bundle import requires a bundle file path");
  }
  const options = { asNew: booleanOption(parsed.options["as-new"], "--as-new") };
  if (!booleanOption(parsed.options.write, "--write")) {
    const plan = planTaskBundleImport(root, filePath, options);
    if (parsed.options.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${formatBundleImportPlan(plan)}\n`);
    return;
  }
  const result = importTaskBundle(root, filePath, options);
  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatBundleImportResult(result)}\n`);
}

function sourceCommand(root: string, rest: string[]): void {
  const subcommand = rest[0];
  const args = rest.slice(1);

  if (subcommand === "status") {
    const parsed = parseArgs(args);
    const filters = sourceStatusFilters(parsed.options);
    if (parsed.options.json) {
      const statuses = JSON.stringify(getSourceStatuses(root, filters), null, 2);
      process.stdout.write(`${redactForRoot(root, statuses)}\n`);
    } else {
      process.stdout.write(`${formatSourceStatuses(root, filters)}\n`);
    }
    return;
  }

  if (subcommand === "remove") {
    const parsed = parseArgs(args);
    const filePath = parsed.positionals[0];
    if (!filePath) {
      throw new Error("source remove requires a file path");
    }

    const source = removeSourceRecord(root, filePath);
    process.stdout.write(`Removed source ${source.path}\n`);
    return;
  }

  if (subcommand === "prune") {
    const parsed = parseArgs(args);
    if (!booleanOption(parsed.options.missing, "--missing")) {
      throw new Error("source prune requires --missing");
    }

    const removed = pruneMissingSourceRecords(root);
    const label = removed.length === 1 ? "record" : "records";
    process.stdout.write(`Pruned ${removed.length} missing source ${label}\n`);
    if (removed.length > 0) {
      process.stdout.write(`${removed.map((source) => `- ${source.path}`).join("\n")}\n`);
    }
    return;
  }

  if (subcommand !== "add" && subcommand !== "review") {
    throw new Error("source command supports `add`, `review`, `remove`, `prune`, and `status`");
  }

  const parsed = parseArgs(args);
  const filePath = parsed.positionals[0];
  if (!filePath) {
    throw new Error(`source ${subcommand} requires a file path`);
  }

  const summary = stringOption(parsed.options.summary) || stringOption(parsed.options.s) || parsed.positionals.slice(1).join(" ");

  if (subcommand === "review") {
    const source = reviewSourceRecord(root, filePath, {
      summary,
      snippet: stringOption(parsed.options.snippet) || ""
    });
    process.stdout.write(`Reviewed source ${source.path} (${source.hash.slice(0, 12)})\n`);
    return;
  }

  const existingStatus = getSourceStatus(root, filePath);
  if (existingStatus?.status === "changed") {
    throw new Error(`Source record for ${existingStatus.path} is changed; use \`agentpack source review ${existingStatus.path} --summary <text>\` after semantic review.`);
  }

  const source = addSourceRecord(root, filePath, {
    summary,
    snippet: stringOption(parsed.options.snippet) || ""
  });

  process.stdout.write(`Recorded source ${source.path} (${source.hash.slice(0, 12)})\n`);
}

function ledgerCommand(root: string, rest: string[]): void {
  const subcommand = rest[0];

  if (isHelpRequest(subcommand)) {
    process.stdout.write(`${commandHelpText("ledger")}\n`);
    return;
  }

  if (subcommand === "status") {
    const parsed = parseArgs(rest.slice(1));
    process.stdout.write(`${parsed.options.json === true ? JSON.stringify(getLedgerStatus(root), null, 2) : formatLedgerStatus(root)}\n`);
    return;
  }

  if (subcommand === "compact") {
    const parsed = parseArgs(rest.slice(1));
    const options: CompactOptions = { purge: booleanOption(parsed.options.purge, "--purge") };
    if (optionValue(parsed.options, "keep-checkpoints")) {
      options.keepCheckpoints = countOption(parsed.options["keep-checkpoints"], "--keep-checkpoints");
    }
    if (optionValue(parsed.options, "evidence-age-days")) {
      options.evidenceAgeDays = countOption(parsed.options["evidence-age-days"], "--evidence-age-days");
    }
    if (booleanOption(parsed.options.write, "--write")) {
      const result = applyCompactPlan(root, options);
      process.stdout.write(`${formatCompactPlan(result.plan, true)}\n`);
      if (result.archiveDir) {
        process.stdout.write(`Archived into ${result.archiveDir}\n`);
      }
      return;
    }
    process.stdout.write(`${formatCompactPlan(buildCompactPlan(root, options), false)}\n`);
    return;
  }

  throw new Error("ledger command supports `status` and `compact`");
}

function releaseCommand(cwd: string, rest: string[]): void {
  const subcommand = rest[0];

  if (isHelpRequest(subcommand)) {
    process.stdout.write(`${commandHelpText("release")}\n`);
    return;
  }

  if (subcommand === "preflight") {
    const report = buildReleasePreflightReport(cwd);
    process.stdout.write(`${report.text}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  throw new Error("release command supports `preflight`");
}

function sourceStatusFilters(options: Record<string, ArgValue>): SourceStatusKind[] {
  const filters: SourceStatusKind[] = [];
  if (options.changed) {
    filters.push("changed");
  }
  if (options.missing) {
    filters.push("missing");
  }
  return filters;
}

function evidenceCommand(root: string, rest: string[]): void {
  const subcommand = rest[0];
  const args = rest.slice(1);
  if (subcommand !== "add") {
    throw new Error("evidence command supports only `add` in v0");
  }

  const parsed = parseArgs(args);
  const event = addEvidence(root, {
    kind: stringOption(parsed.options.kind) || "note",
    file: stringOption(parsed.options.file),
    content: stringOption(parsed.options.content) || parsed.positionals.join(" "),
    command: stringOption(parsed.options.command),
    exitCode: optionValue(parsed.options, "exitCode") ? stringOption(parsed.options.exitCode) : null
  });

  process.stdout.write(`Attached evidence ${event.id}\n`);
}

function runCommand(root: string, rest: string[]): void {
  const command = rest.join(" ").trim();
  if (!command) {
    throw new Error("run requires a command");
  }

  const startedAt = new Date().toISOString();
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }

  const exitCode = typeof result.status === "number" ? result.status : 1;
  const content = [
    `Command: ${command}`,
    `Started: ${startedAt}`,
    `Exit code: ${exitCode}`,
    "",
    "## stdout",
    stdout || "(empty)",
    "",
    "## stderr",
    stderr || "(empty)"
  ].join("\n");

  const event = addEvidence(root, {
    kind: "command-output",
    content,
    command,
    exitCode
  });

  process.stdout.write(`\nAttached command evidence ${event.id}\n`);
  process.exitCode = exitCode;
}

function setCommand(root: string, rest: string[]): void {
  const field = rest[0];
  const args = rest.slice(1);
  const parsed = parseArgs(args);
  const text = parsed.positionals.join(" ");

  withPackWriteLock(root, () => {
    const state = readState(root);

    if (field === "goal") {
      state.goal = redactForRoot(root, text);
    } else if (field === "status") {
      state.currentStatus = redactForRoot(root, text);
    } else if (field === "next") {
      state.nextActions = [text, ...toArray(parsed.options.next)]
        .filter(Boolean)
        .map((item) => redactForRoot(root, item));
    } else {
      throw new Error("set supports goal, status, or next");
    }

    writeState(root, state);
  });
  process.stdout.write(`Updated ${field}\n`);
}

function exportPath(root: string, target: string): string {
  const normalized = String(target).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`Invalid export target: ${target}`);
  }
  const fileName = normalized === "chatgpt" ? "chatgpt-handoff.md" : `${normalized}-handoff.md`;
  const filePath = getPackPath(root, "exports", fileName);
  if (!existsSync(path.dirname(filePath))) {
    throw new Error("Agentpack exports directory is missing. Run `agentpack init` again.");
  }
  return filePath;
}

function parseArgs(args: string[]): ParsedArgs {
  const options: Record<string, ArgValue> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item) {
      continue;
    }

    if (item.startsWith("--")) {
      const [rawKey, inlineValue] = item.slice(2).split("=", 2);
      if (!rawKey) {
        continue;
      }
      if (inlineValue !== undefined) {
        addOption(options, rawKey, inlineValue);
      } else {
        const value = args[index + 1];
        if (value && !value.startsWith("-")) {
          index += 1;
          addOption(options, rawKey, value);
        } else {
          addOption(options, rawKey, true);
        }
      }
      continue;
    }

    if (item.startsWith("-") && item.length > 1) {
      const key = item.slice(1);
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        index += 1;
        addOption(options, key, value);
      } else {
        addOption(options, key, true);
      }
      continue;
    }

    positionals.push(item);
  }

  return { options, positionals };
}

function addOption(options: Record<string, ArgValue>, key: string, value: ArgValue): void {
  if (options[key] === undefined) {
    options[key] = value;
    return;
  }

  if (Array.isArray(options[key])) {
    const textValue = stringOption(value);
    if (textValue) {
      options[key].push(textValue);
    }
    return;
  }

  options[key] = [...toArray(options[key]), ...toArray(value)];
}

function toArray(value: ArgValue | undefined): string[] {
  if (value === undefined || value === true || value === false) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function stringOption(value: ArgValue | undefined): string {
  if (value === undefined || value === true || value === false) {
    return "";
  }
  return Array.isArray(value) ? value[0] || "" : value;
}

function optionValue(options: Record<string, ArgValue>, key: string): boolean {
  return options[key] !== undefined;
}

function numberOption(value: ArgValue | undefined): number {
  if (value === undefined || value === true || value === false) {
    return 0;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// For destructive knobs a typo must not silently become 0, the most aggressive setting.
function countOption(value: ArgValue | undefined, flag: string): number {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${flag} requires a non-negative number`);
  }
  return number;
}

function booleanOption(value: ArgValue | undefined, flag: string): boolean {
  if (value === undefined || value === false) {
    return false;
  }
  if (value === true) {
    return true;
  }
  if (typeof value === "string" && (value === "true" || value === "false")) {
    return value === "true";
  }
  throw new Error(`${flag} requires true or false`);
}

function installDryRun(options: Record<string, ArgValue>): boolean {
  const dryRun = booleanOption(options["dry-run"], "--dry-run");
  const write = booleanOption(options.write, "--write");

  if (dryRun && write) {
    throw new Error("install accepts either --dry-run or --write, not both");
  }

  return !write;
}

function budgetOption(options: Record<string, ArgValue>, fallback = 0): number {
  return resolveBudget({
    budget: numberOption(options.budget),
    preset: stringOption(options.preset)
  }, fallback);
}

function taskRiskOption(value: ArgValue | undefined): "low" | "medium" | "high" | "unknown" {
  const risk = stringOption(value);
  if (risk === "unknown" || risk === "low" || risk === "medium" || risk === "high") {
    return risk;
  }
  throw new Error(`Unknown task risk: ${risk || "(empty)"}`);
}

function isRecordType(value: string | undefined): value is "decision" | "dead-end" | "note" {
  return value === "decision" || value === "dead-end" || value === "note";
}

function readPackageVersion(): string {
  // Resolve package.json relative to the compiled CLI file (dist/src/cli/index.js).
  // Works both in the source tree and after `npm install -g`, because the package
  // root is always three levels above this file.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
