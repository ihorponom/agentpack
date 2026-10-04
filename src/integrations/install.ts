import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGitHooksPath, getGitRepoBounds } from "../core/git.js";
import { getPackPath, readJson } from "../core/store.js";

const INSTALL_TARGETS = ["codex", "claude", "claude-desktop", "cursor", "git-hooks"] as const;
const GATE_HOOK_MARKER = "# agentpack:gate";
const GATE_ROOT_MARKER = "# agentpack:root-base64 ";
const CLAUDE_GATE_MARKER = "task gate --client claude";
const CODEX_GATE_MARKER = "task gate --client codex";
const CURSOR_GATE_MARKER = "task gate --client cursor";
const CODEX_BUILDER_START_MARKER = "# agentpack:builder:start";
const CODEX_BUILDER_END_MARKER = "# agentpack:builder:end";
const CURSOR_READ_ONLY_MCP_TOOLS = [
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
  "task_status",
  "usage_report"
] as const;

export function formatClientGateCommand(
  execPath: string,
  entrypoint: string,
  client: "claude" | "codex" | "cursor",
  platform: "posix" | "win32"
): string {
  const quote = platform === "win32" ? windowsCommandQuote : shellQuote;
  return `${quote(execPath)} ${quote(entrypoint)} task gate --client ${client}`;
}

function clientGateCommand(client: "claude" | "codex" | "cursor"): string {
  return formatClientGateCommand(
    process.execPath,
    agentpackEntrypoint(),
    client,
    process.platform === "win32" ? "win32" : "posix"
  );
}

function codexGateCommand(platform: "posix" | "win32"): string {
  return formatClientGateCommand(process.execPath, agentpackEntrypoint(), "codex", platform);
}

function collaborationModesSection(): string {
  return `Collaboration modes:
- treat named modes as explicit collaboration preferences; follow the active mode until the user switches mode, asks for work that clearly implies another mode, the task ends, or safety requires a pause
- design mode: do not write code; analyze the task, architecture, options, risks, and verification plan
- implementation mode: implement the agreed direction in small, reviewable steps
- review mode: review the current diff or proposal for bugs, regressions, missing tests, and design risks
- teach mode: explain TypeScript, architecture, or code through the concrete files and changes at hand
- checkpoint mode: summarize what was decided, what changed, why, verification status, and next actions`;
}

const INSTRUCTIONS = `# Agentpack

Use Agentpack as the task-state ledger, not an activity log. Read-only questions do not need a new task.

Safety and coding:
- preserve current behavior, compatibility, security, and rollback options; make small, reviewable changes and verify them proportionately
- check changed code for consistency with the repository's established patterns and all affected contracts or parallel interfaces, and for maintainability: clear structure, minimal unnecessary complexity, and focused tests for behavior likely to regress. Any intentional deviation or added complexity must be explicit, justified, and covered by verification
- read relevant code first; follow local patterns; avoid unrelated refactors, dependency churn, unsafe shell execution, weakened validation, or secret logging
- inspect the diff before staging; use small imperative commits and exclude unrelated changes, AI attribution, and AI/agent-style branch prefixes

${collaborationModesSection()}

Task workflow:
- start with \`load_context\` (\`preset: "quick"\` and a focused query); use \`source_status\` only for a needed stale-source check
- before editing, confirm the active Task Passport's objective, constraints, worktree, branch/HEAD, lifecycle, and write scope. Stop for unexplained drift or a verifying, blocked, closed, or parked task
- declare a write scope by default; keep one active task per coherent phase. Park deferred work; do not turn a review task into implementation. A review of the current task stays in it; create another Passport only for a different objective or authorization boundary, or an independent frozen-snapshot review
- record only material decisions, durable source conclusions, unresolved findings, dead ends, meaningful evidence, and checkpoints. Reuse one relevant evidence item instead of duplicating it; a matching hash proves only that a file is unchanged, not that its recorded conclusion is true
- at a meaningful pause or handoff, checkpoint the summary, current status, and next actions; sequence state-changing Agentpack calls and do not repeat fresh status checks
- keep verification pending through fixes. A final verdict binds the reviewed HEAD and freezes edits
- checks do not grant remote authority: never infer permission to push, merge, publish, message, or otherwise mutate external state

Read \`.agentpack/instructions/verification.md\` before a final verdict, external review, or release. It contains the detailed verification policy and evidence templates.`;

const VERIFICATION_INSTRUCTIONS = `# Agentpack verification policy

Read this before recording a final verdict, requesting or handling external review, or preparing a release.

Verification order:
- keep verification pending throughout the active fix loop; aggregate intermediate green checks as evidence/checkpoints, then when no edits remain commit the in-scope changes and confirm the commit changed nothing (clean tree, hooks silent) before recording the final verdict
- no external wait: end with one \`task_finalize\` call carrying the final status, evidence, and commit hash, so no verifying window opens
- adversarial verification is advisory, not a semantic judgment: for low risk, attach a short readable note or useful test output that says what was checked, what happened, and any relevant limit. It does not need prescribed labels or a minimum length; empty, head-only, unreadable, or wholly generic evidence is still not useful. For code scopes, include the exact \`Reviewed HEAD:\` bound in the Passport
- classify contract-changing work as medium/high risk; for medium/high risk, use review-like evidence with \`Claim or assumption attacked:\`, \`Counterexample or disconfirming check:\`, \`Observed result:\`, \`Unresolved findings:\`, and \`Residual risk:\`, plus \`Review mode: independent read-only\` and \`Adversarial check type:\` naming a negative, differential, operational, or rollback check. Record the exact \`Reviewed HEAD:\` when code is in scope
- external wait (review, PR merge, re-score): record \`passed\` via \`task_update_verification\`, then \`task_park\`; switching back keeps the task verifying while that final verdict is frozen, so finalize after the external result or set verification to pending before making changes
- a recorded final verdict binds the reviewed HEAD, moves the task to verifying, and freezes code changes; do not use a passed-to-pending reset for normal iteration because the final verdict belongs only after edits end
- keep next actions current: clear or replace a stale plan (\`task update --clear-next-actions\`) before finalizing, so closed passports read as history, not as open work
- if a task still has next actions and must pause for unrelated work, park it instead of using \`task_finalize\`/\`task finalize --status accepted\`; force accepted finalization only when the remaining next actions are intentionally historical
- do not finalize a task just to free the current slot; finalization means verification is passed, failed, or explicitly accepted as complete

Evidence cadence:
- call \`record_source\` only when you have a durable conclusion about an important file; avoid repeated records for the same file unless the conclusion changed
- call \`record_decision\` for durable technical/product decisions, not every preference
- call \`record_dead_end\` when an approach failed and should not be repeated
- call \`attach_evidence\` for meaningful verification, review findings, or command output worth preserving
- do not record every file read, mode switch, minor diff check, or routine command
- do not call \`record_source\` for every changed file just to make an audit warning disappear; prefer a checkpoint summary for batch changes and refresh source records only when the durable conclusion changed
- for small tasks, prefer one aggregated verification evidence and one checkpoint; add source records only for important implementation files with reusable conclusions
- link that evidence from \`task_update_verification\`, or from \`task_finalize\` when finalize performs the verification update
- mention commit hashes in checkpoint/finalize summaries instead of attaching separate commit evidence
- attach separate commit, tag, workflow, or publish evidence only when that output is itself part of the verification contract
- sequence state-changing Agentpack calls; do not run them in parallel with audit/status/checkpoint calls

After meaningful progress, call \`checkpoint\` with summary, current status, and next actions.`;

function builderGuidance(builderPath: string): string {
  return `Optional builder:
- A builder is available at \`${builderPath}\`; using it is not required. Keep small tasks inline.
- Use it when the user explicitly requests it or current instructions permit delegation. Respect requests to work without subagents.
- Before delegating, briefly announce what the builder will do and why. Follow the existing permissions; do not ask again for already authorized work.
- Give the builder the objective, constraints, write scope, acceptance criteria, and narrow verification command; use one writer per slice.
- The coordinator keeps decisions, Agentpack records, final verification, commits, and release actions.`;
}

function codexInstructions(): string {
  return `${INSTRUCTIONS.trimEnd()}\n\n${builderGuidance(".codex/agents/builder.toml")}\n`;
}

function claudeInstructions(): string {
  return `${INSTRUCTIONS.trimEnd()}\n\n${builderGuidance(".claude/agents/builder.md")}\n`;
}

type InstallTarget = typeof INSTALL_TARGETS[number];

interface InstallOptions {
  dryRun?: boolean;
  claudeDesktopConfigPath?: string;
  beforeClaudeDesktopConfigWrite?: () => void;
}

interface InstallFile {
  filePath: string;
  description: string;
  content: string;
  executable?: boolean;
}

interface InstallPlan {
  target: InstallTarget;
  files: InstallFile[];
  notes: string[];
}

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

interface DesktopConfigSnapshot {
  content: string | null;
  identity?: readonly [bigint, bigint, bigint, bigint, bigint];
  mode: number;
}

export function installIntegration(root: string, targetValue: string, options: InstallOptions = {}): string {
  const target = parseTarget(targetValue);
  const dryRun = options.dryRun !== false;
  const plan = buildInstallPlan(root, target);
  validateInstallPlan(root, plan);
  const statuses = plan.files.map((file) => ({
    file,
    status: fileStatus(file.filePath, file.content)
  }));

  let desktopResult: string | undefined;
  if (!dryRun) {
    applyPlan(root, plan);
    if (target === "claude-desktop") {
      try {
        desktopResult = mergeClaudeDesktopConfig(
          root,
          options.claudeDesktopConfigPath,
          options.beforeClaudeDesktopConfigWrite
        );
      } catch (error) {
        throw new Error(`Claude Desktop recovery files were installed, but global config merge failed: ${String(error)}`);
      }
    }
  }

  const localResult = formatInstallResult(root, plan, statuses, dryRun);
  return desktopResult ? `${localResult}\n\n${desktopResult}` : localResult;
}

function buildInstallPlan(root: string, target: InstallTarget): InstallPlan {
  const serverName = mcpServerName(root);

  if (target === "codex") {
    const codexSnippetPath = getPackPath(root, "instructions", "codex-mcp.example.toml");
    const codexBuilder = codexBuilderAgentPlan(root, serverName);
    return {
      target,
      files: [
        writeFilePlan(root, ".agentpack/instructions/codex.md", "Write Codex-specific Agentpack workflow instructions.", codexInstructions()),
        writeFilePlan(root, ".agentpack/instructions/verification.md", "Write detailed Agentpack verification instructions.", VERIFICATION_INSTRUCTIONS),
        managedBlockPlan(root, "AGENTS.md", "Add or update the Agentpack block in AGENTS.md.", codexInstructions()),
        tomlTablePlan(root, ".codex/config.toml", "Add the Agentpack MCP server to project-local Codex config.", `mcp_servers.${serverName}`, codexMcpTomlTable(serverName), "mcp_servers.agentpack"),
        codexBuilder.file,
        codexHooksMergePlan(root),
        writeFilePlan(root, ".agentpack/instructions/codex-mcp.example.toml", "Write a Codex MCP config snippet for manual review.", codexTomlSnippet(serverName))
      ],
      notes: [
        "No global Codex config is modified.",
        `Codex should use the project-local .codex/config.toml entry named ${serverName} for this repo.`,
        codexBuilder.managed
          ? "The project builder uses gpt-5.6-terra at medium reasoning by default, sees only Agentpack load_context, and preserves user-owned config outside its managed block."
          : "An existing unmarked .codex/agents/builder.toml was left untouched.",
        "The project PreToolUse hook runs `agentpack task gate` before apply_patch edits; Codex requires the hook definition to be reviewed and trusted before it runs.",
        "Remove any old ~/.codex/config.toml agentpack server that hard-codes --root or cwd to another project.",
        `For manual review, see ${relativePath(root, codexSnippetPath)}.`
      ]
    };
  }

  if (target === "claude") {
    const builder = preservedOrNewBuilderPlan(root, ".claude/agents/builder.md", "Write the builder subagent definition for Claude Code.", claudeBuilderAgent(serverName));
    return {
      target,
      files: [
        writeFilePlan(root, ".agentpack/instructions/claude.md", "Write Claude-specific Agentpack workflow instructions.", claudeInstructions()),
        writeFilePlan(root, ".agentpack/instructions/verification.md", "Write detailed Agentpack verification instructions.", VERIFICATION_INSTRUCTIONS),
        managedBlockPlan(root, "CLAUDE.md", "Add or update the Agentpack block in CLAUDE.md.", claudeInstructions()),
        jsonMergePlan(root, ".mcp.json", "Add the Agentpack MCP server to project .mcp.json.", serverName, claudeMcpServer()),
        builder,
        claudeHooksMergePlan(root)
      ],
      notes: [
        "Only project-local files are modified.",
        `The Claude Code MCP server key is ${serverName} to avoid cross-repo name collisions.`,
        "Claude Code prompts before using project-scoped MCP servers from .mcp.json.",
        "The Claude builder is available for optional use; existing builder files are preserved.",
        "The PreToolUse hook runs `agentpack task gate` before file edits; it warns by default and blocks only when gateMode is \"block\" in .agentpack/config.json.",
        "The hook launches the gate through the current Node executable and Agentpack entrypoint, not the shell PATH; re-run this install after switching Node versions."
      ]
    };
  }

  if (target === "git-hooks") {
    const hooksPath = getGitHooksPath(root);
    if (!hooksPath) {
      throw new Error("install git-hooks requires a git repository");
    }
    const preCommitPath = path.join(hooksPath, "pre-commit");
    const snippetRelativePath = ".agentpack/instructions/pre-commit-gate.example.sh";
    const files = [
      writeFilePlan(root, snippetRelativePath, "Write the gate pre-commit snippet for manual review.", preCommitGateScript([root]))
    ];
    const notes = [
      "The pre-commit hook runs `agentpack task gate --staged` on the staged files.",
      "Warn mode (default) prints findings and allows the commit; \"gateMode\": \"block\" in .agentpack/config.json makes violations fail the commit.",
      "The hook is skipped silently when the agentpack binary is not on PATH."
    ];
    const bounds = getGitRepoBounds(root);
    const insideRepo = bounds && (isWithin(bounds.topLevel, hooksPath) || isWithin(bounds.commonDir, hooksPath));
    if (!insideRepo) {
      notes.push(`Git hooks path ${hooksPath} is outside this repository (custom core.hooksPath); not writing there. Append the gate call manually from ${snippetRelativePath}.`);
      return { target, files, notes };
    }
    const existing = existsSync(preCommitPath) ? readFileSync(preCommitPath, "utf8") : "";
    if (!existing || existing.includes(GATE_HOOK_MARKER)) {
      const roots = [...new Set([...parseGateHookRoots(existing), root])];
      if (roots.length > 1) {
        notes.push(`The hook gates ${roots.length} packs in this repository: ${[...roots].sort().join(", ")}.`);
      } else if (bounds && bounds.topLevel !== root) {
        notes.push(`The hook runs the gate for the Agentpack pack at ${root}; installing from another pack in this repository adds it to the same hook.`);
      }
      files.push({
        filePath: preCommitPath,
        description: "Install the Agentpack gate pre-commit hook.",
        content: preCommitGateScript(roots),
        executable: true
      });
    } else {
      notes.push(`Existing pre-commit hook detected and left untouched. Append the gate call manually from ${snippetRelativePath}.`);
    }
    return { target, files, notes };
  }

  if (target === "claude-desktop") {
    const desktopSnippetPath = getPackPath(root, "instructions", "claude-desktop-mcp.example.json");
    return {
      target,
      files: [
        writeFilePlan(
          root,
          ".agentpack/instructions/claude-desktop.md",
          "Write Claude Desktop-specific Agentpack setup notes.",
          claudeDesktopInstructions(root, desktopSnippetPath, serverName)
        ),
        writeFilePlan(
          root,
          ".agentpack/instructions/claude-desktop-mcp.example.json",
          "Write a Claude Desktop MCP config snippet for manual review.",
          claudeDesktopJsonSnippet(root, serverName)
        )
      ],
      notes: [
        "Dry-run changes nothing; --write also merges this repo's entry into the macOS Claude Desktop config when its directory exists.",
        "Claude Desktop does not read project .mcp.json or CLAUDE.md.",
        `The generated Claude Desktop server key for this repo is ${serverName}.`,
        `The generated snippet at ${relativePath(root, desktopSnippetPath)} remains the recovery fallback.`
      ]
    };
  }

  return {
    target,
    files: [
      ignorePatternPlan(root, ".cursor", "Keep project-local Cursor integration files out of git."),
      writeFilePlan(root, ".agentpack/instructions/cursor.md", "Write Cursor-specific Agentpack workflow instructions.", cursorInstructions()),
      writeFilePlan(root, ".agentpack/instructions/verification.md", "Write detailed Agentpack verification instructions.", VERIFICATION_INSTRUCTIONS),
      writeFilePlan(root, ".cursor/rules/agentpack.mdc", "Write a Cursor project rule for Agentpack.", cursorInstructions()),
      preservedOrNewBuilderPlan(root, ".cursor/agents/builder.md", "Write the builder subagent definition for Cursor.", cursorBuilderAgent(serverName)),
      jsonMergePlan(root, ".cursor/mcp.json", "Add the Agentpack MCP server to Cursor project MCP config.", serverName, cursorMcpServer()),
      cursorCliPermissionsPlan(root, serverName),
      cursorHooksMergePlan(root)
    ],
    notes: [
      "Only project-local files are modified.",
      "Cursor reads project-specific MCP servers from .cursor/mcp.json when this folder is opened as the workspace.",
      "The Cursor builder is available for optional use, inherits the parent model, and preserves existing builder files.",
      "Cursor CLI permissions allow only Agentpack's read-only MCP tools without prompting; write-capable Agentpack tools still require approval.",
      "The project preToolUse hook runs `agentpack task gate` before Write and Delete tools; warn mode allows silently, while block mode denies violations with feedback.",
      "After writing the config, reload the Cursor window, open MCP Servers, and enable the Agentpack server if it is toggled off.",
      "The Cursor MCP entry uses an absolute Node launcher so Cursor does not depend on your shell/fnm/nvm PATH."
    ]
  };
}

function applyPlan(root: string, plan: InstallPlan): void {
  const writes: Array<{ filePath: string; previous: string | null }> = [];
  const createdDirectories: Array<{ deepest: string; shallowest: string }> = [];

  try {
    for (const file of plan.files) {
      validateInstallPath(root, file.filePath);
      const directory = path.dirname(file.filePath);
      const firstCreated = mkdirSync(directory, { recursive: true });
      if (firstCreated) {
        createdDirectories.push({ deepest: directory, shallowest: firstCreated });
      }
      const previous = existsSync(file.filePath) ? readFileSync(file.filePath, "utf8") : null;
      if (previous === file.content) {
        if (file.executable) {
          chmodSync(file.filePath, 0o755);
        }
        continue;
      }
      writes.push({ filePath: file.filePath, previous });
      writeFileSync(file.filePath, file.content, "utf8");
      if (file.executable) {
        chmodSync(file.filePath, 0o755);
      }
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const write of [...writes].reverse()) {
      try {
        const current = existsSync(write.filePath) ? readFileSync(write.filePath, "utf8") : null;
        if (current === write.previous) {
          continue;
        }
        if (write.previous === null) {
          unlinkSync(write.filePath);
        } else {
          writeFileSync(write.filePath, write.previous, "utf8");
        }
      } catch {
        rollbackFailed = true;
      }
    }
    for (const created of [...createdDirectories].reverse()) {
      removeEmptyDirectoryChain(created.deepest, created.shallowest);
    }
    if (rollbackFailed) {
      throw new Error(`Install failed and rollback was incomplete; review the files listed in the plan. Original error: ${String(error)}`);
    }
    throw new Error(`Install failed; already-written files were rolled back. Original error: ${String(error)}`);
  }
}

function removeEmptyDirectoryChain(deepest: string, shallowest: string): void {
  let current = deepest;
  while (true) {
    try {
      rmdirSync(current);
    } catch {
      // Directory is missing or holds pre-existing/user files; leave it intact.
      return;
    }
    if (current === shallowest) {
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function formatInstallResult(root: string, plan: InstallPlan, statuses: Array<{ file: InstallFile; status: string }>, dryRun: boolean): string {
  const lines = [
    dryRun
      ? `Agentpack ${plan.target} install plan (dry run)`
      : `Installed Agentpack ${plan.target} integration`,
    dryRun ? "No files were changed." : "Files written:",
    "",
    ...statuses.map(({ file, status }) => `- ${status.toUpperCase()} ${relativePath(root, file.filePath)}: ${file.description}`),
    "",
    "Notes:",
    ...plan.notes.map((note) => `- ${note}`)
  ];

  if (dryRun) {
    lines.push("", "To apply:", `  agentpack install ${plan.target} --write`);
  }

  return lines.join("\n");
}

function writeFilePlan(root: string, relativeFilePath: string, description: string, content: string): InstallFile {
  return {
    filePath: path.join(root, relativeFilePath),
    description,
    content: ensureTrailingNewline(content)
  };
}

function ignorePatternPlan(root: string, pattern: string, description: string): InstallFile {
  const filePath = path.join(root, ".gitignore");
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const normalized = pattern.replace(/\/$/, "");
  const present = existing.split(/\r?\n/).some((line) => line.trim().replace(/\/$/, "") === normalized);
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  return {
    filePath,
    description,
    content: present ? existing : `${existing}${prefix}${pattern}\n`
  };
}

function managedBlockPlan(root: string, relativeFilePath: string, description: string, block: string): InstallFile {
  const filePath = path.join(root, relativeFilePath);
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  return {
    filePath,
    description,
    content: upsertManagedBlock(existing, block)
  };
}

function jsonMergePlan(root: string, relativeFilePath: string, description: string, serverName: string, server: Record<string, unknown>): InstallFile {
  const filePath = path.join(root, relativeFilePath);
  const existing = readJson<McpConfig>(filePath, {});
  const mcpServers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
  const nextMcpServers = {
    ...mcpServers,
    [serverName]: server
  };

  if (serverName !== "agentpack" && JSON.stringify(mcpServers.agentpack) === JSON.stringify(server)) {
    delete nextMcpServers.agentpack;
  }

  const next = {
    ...existing,
    mcpServers: nextMcpServers
  };

  return {
    filePath,
    description,
    content: `${JSON.stringify(next, null, 2)}\n`
  };
}

function tomlTablePlan(root: string, relativeFilePath: string, description: string, tableName: string, tableBody: string, legacyTableName?: string): InstallFile {
  const filePath = path.join(root, relativeFilePath);
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const withoutLegacy = legacyTableName && legacyTableName !== tableName
    ? removeTomlTable(existing, legacyTableName)
    : existing;
  return {
    filePath,
    description,
    content: upsertTomlTable(withoutLegacy, tableName, tableBody)
  };
}

function upsertManagedBlock(existing: string, block: string): string {
  const marker = "<!-- agentpack:start -->";
  const endMarker = "<!-- agentpack:end -->";
  const wrapped = `${marker}\n${block.trim()}\n${endMarker}\n`;

  if (existing.includes(marker)) {
    return existing.replace(new RegExp(`${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`), wrapped);
  }

  return `${existing.trimEnd()}\n\n${wrapped}`.trimStart();
}

function upsertTomlTable(existing: string, tableName: string, tableBody: string): string {
  const tableHeader = `[${tableName}]`;
  const lines = existing.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === tableHeader);
  const bodyLines = tableBody.trimEnd().split("\n");

  if (start === -1) {
    const prefix = existing.trimEnd();
    return ensureTrailingNewline(prefix ? `${prefix}\n\n${tableBody}` : tableBody);
  }

  let end = start + 1;
  const nestedPrefix = `[${tableName}.`;
  while (end < lines.length) {
    const trimmed = (lines[end] || "").trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]") && !trimmed.startsWith(nestedPrefix)) {
      break;
    }
    end += 1;
  }

  lines.splice(start, end - start, ...bodyLines);
  return ensureTrailingNewline(lines.join("\n").trimEnd());
}

function removeTomlTable(existing: string, tableName: string): string {
  const tableHeader = `[${tableName}]`;
  const lines = existing.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === tableHeader);

  if (start === -1) {
    return existing;
  }

  let end = start + 1;
  const nestedPrefix = `[${tableName}.`;
  while (end < lines.length) {
    const trimmed = (lines[end] || "").trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]") && !trimmed.startsWith(nestedPrefix)) {
      break;
    }
    end += 1;
  }

  lines.splice(start, end - start);
  return ensureTrailingNewline(lines.join("\n").trimEnd());
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function preCommitGateScript(roots: string[]): string {
  // git runs hooks from the repository top level; packs may live in subdirectories,
  // and one repository can hold several packs — the hook gates each listed pack.
  const gateLines = [...roots].sort().flatMap((root) => [
    `  ${GATE_ROOT_MARKER}${Buffer.from(root, "utf8").toString("base64")}`,
    `  run_gate ${shellQuote(root)} ${shellQuote(gateRootLabel(root))}`
  ]);
  return [
    "#!/bin/sh",
    GATE_HOOK_MARKER,
    "# Agentpack task gate: checks staged files against the current Task Passport of each listed pack.",
    "# Warn mode prints findings and allows the commit; block mode fails the commit with exit code 2.",
    "overall=0",
    "run_gate() {",
    "  if [ -d \"$1\" ]; then",
    "    gate_output=$(cd \"$1\" && agentpack task gate --staged 2>&1)",
    "    gate_status=$?",
    "    if [ -n \"$gate_output\" ]; then",
    "      printf '%s\\n' \"Agentpack gate [$2]\" \"$gate_output\"",
    "    fi",
    "    if [ \"$gate_status\" -eq 2 ]; then",
    "      overall=2",
    "    elif [ \"$gate_status\" -ne 0 ]; then",
    "      echo \"Agentpack gate [$2]: task gate exited with $gate_status; commit allowed (gate skipped)\"",
    "    fi",
    "  fi",
    "}",
    "if command -v agentpack >/dev/null 2>&1; then",
    ...gateLines,
    "else",
    "  # Deliberate fail-open for machines without agentpack; say so at the actual commit moment.",
    "  echo \"agentpack not on PATH; Agentpack task gate skipped\"",
    "fi",
    "exit $overall",
    ""
  ].join("\n");
}

function gateRootLabel(root: string): string {
  const topLevel = getGitRepoBounds(root)?.topLevel;
  const relative = topLevel ? path.relative(topLevel, root) : path.basename(root);
  return relative || ".";
}

function validateInstallPlan(root: string, plan: InstallPlan): void {
  for (const file of plan.files) {
    validateInstallPath(root, file.filePath);
  }
}

function validateInstallPath(root: string, filePath: string): void {
  const bounds = getGitRepoBounds(root);
  const bases = [root, bounds?.topLevel, bounds?.commonDir]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => right.length - left.length);
  const absolutePath = path.resolve(filePath);
  const base = bases.find((candidate) => isWithin(candidate, absolutePath));
  if (!base) {
    throw new Error(`Install path escapes the repository: ${filePath}`);
  }

  const relative = path.relative(base, absolutePath);
  let current = base;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry) {
      break;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Install path contains a symbolic link: ${filePath}`);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function windowsCommandQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function parseGateHookRoots(script: string): string[] {
  const roots: string[] = [];
  for (const line of script.split("\n")) {
    const encoded = line.trim().startsWith(GATE_ROOT_MARKER)
      ? line.trim().slice(GATE_ROOT_MARKER.length)
      : "";
    if (encoded) {
      try {
        roots.push(Buffer.from(encoded, "base64").toString("utf8"));
        continue;
      } catch {
        // Fall through to the legacy quoted-line parser.
      }
    }
    const match = line.match(/^\s*run_gate "(.+)"\s*$/);
    if (match?.[1]) {
      roots.push(match[1]);
    }
  }
  return roots;
}

function claudeHooksMergePlan(root: string): InstallFile {
  const filePath = path.join(root, ".claude", "settings.json");
  const existing = readJson<Record<string, unknown>>(filePath, {});
  const hooks = isRecord(existing.hooks) ? { ...existing.hooks } : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];

  const withoutGate = preToolUse.filter((entry) => !JSON.stringify(entry).includes(CLAUDE_GATE_MARKER));
  withoutGate.push({
    matcher: "Edit|Write|MultiEdit|NotebookEdit",
    hooks: [{ type: "command", command: clientGateCommand("claude") }]
  });

  const next = {
    ...existing,
    hooks: { ...hooks, PreToolUse: withoutGate }
  };

  return {
    filePath,
    description: "Add the Agentpack gate PreToolUse hook to project Claude Code settings.",
    content: `${JSON.stringify(next, null, 2)}\n`
  };
}

function codexHooksMergePlan(root: string): InstallFile {
  const filePath = path.join(root, ".codex", "hooks.json");
  const existing = readJson<Record<string, unknown>>(filePath, {});
  const hooks = isRecord(existing.hooks) ? { ...existing.hooks } : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
  const withoutGate = preToolUse.filter((entry) => !JSON.stringify(entry).includes(CODEX_GATE_MARKER));
  withoutGate.push({
    matcher: "^apply_patch$",
    hooks: [{
      type: "command",
      command: codexGateCommand("posix"),
      commandWindows: codexGateCommand("win32"),
      statusMessage: "Checking Agentpack task scope"
    }]
  });

  return {
    filePath,
    description: "Add the Agentpack gate PreToolUse hook to project Codex config.",
    content: `${JSON.stringify({ ...existing, hooks: { ...hooks, PreToolUse: withoutGate } }, null, 2)}\n`
  };
}

function cursorHooksMergePlan(root: string): InstallFile {
  const filePath = path.join(root, ".cursor", "hooks.json");
  const existing = readJson<Record<string, unknown>>(filePath, {});
  const hooks = isRecord(existing.hooks) ? { ...existing.hooks } : {};
  const preToolUse = Array.isArray(hooks.preToolUse) ? [...hooks.preToolUse] : [];
  const withoutGate = preToolUse.filter((entry) => !JSON.stringify(entry).includes(CURSOR_GATE_MARKER));
  withoutGate.push({
    command: clientGateCommand("cursor"),
    matcher: "Write|Delete"
  });

  return {
    filePath,
    description: "Add the Agentpack gate preToolUse hook to project Cursor config.",
    content: `${JSON.stringify({ ...existing, version: existing.version || 1, hooks: { ...hooks, preToolUse: withoutGate } }, null, 2)}\n`
  };
}

function codexTomlSnippet(serverName: string): string {
  return [
    "# Add this to the repo's .codex/config.toml after reviewing it.",
    "# Do not put a project-specific --root or cwd in ~/.codex/config.toml.",
    "# A hard-coded global root makes Agentpack read the wrong repo.",
    codexMcpTomlTable(serverName),
    ""
  ].join("\n");
}

function codexMcpTomlTable(serverName: string): string {
  return [
    `[mcp_servers.${serverName}]`,
    "command = \"agentpack\"",
    "args = [\"mcp\"]",
    "startup_timeout_sec = 10",
    "tool_timeout_sec = 60",
    ""
  ].join("\n");
}

function codexBuilderAgentPlan(root: string, serverName: string): { file: InstallFile; managed: boolean } {
  const filePath = path.join(root, ".codex", "agents", "builder.toml");
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const hasStart = existing.includes(CODEX_BUILDER_START_MARKER);
  const hasEnd = existing.includes(CODEX_BUILDER_END_MARKER);

  if (existing && (!hasStart || !hasEnd)) {
    return {
      managed: false,
      file: {
        filePath,
        description: "Preserve the existing user-owned Codex builder agent.",
        content: existing
      }
    };
  }

  const managedBlock = `${CODEX_BUILDER_START_MARKER}\n${codexBuilderManagedBlock(serverName).trim()}\n${CODEX_BUILDER_END_MARKER}\n`;
  const content = hasStart && hasEnd
    ? existing.replace(
      new RegExp(`${escapeRegExp(CODEX_BUILDER_START_MARKER)}[\\s\\S]*?${escapeRegExp(CODEX_BUILDER_END_MARKER)}\\n?`),
      managedBlock
    )
    : `${codexBuilderRuntimeDefaults()}\n\n${managedBlock}`;

  return {
    managed: true,
    file: {
      filePath,
      description: "Write the efficient scoped builder custom agent for Codex.",
      content: ensureTrailingNewline(content)
    }
  };
}

function preservedOrNewBuilderPlan(root: string, relativeFilePath: string, description: string, content: string): InstallFile {
  const filePath = path.join(root, relativeFilePath);
  validateInstallPath(root, filePath);
  if (existsSync(filePath)) {
    return { filePath, description: `Preserve the existing builder agent (${description}).`, content: readFileSync(filePath, "utf8") };
  }
  return writeFilePlan(root, relativeFilePath, description, content);
}

function codexBuilderRuntimeDefaults(): string {
  return `# Runtime tuning is user-owned and preserved across Agentpack reinstalls.
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"`;
}

function codexBuilderManagedBlock(serverName: string): string {
  return `name = "builder"
description = "Implementation agent for one bounded, coordinator-defined coding slice. Invoke when the user requests it or current instructions permit delegation and the slice benefits; announce its use and keep small tasks with the coordinator."
developer_instructions = """
You are the builder for one scoped implementation slice. The coordinator owns requirements, architecture, the Task Passport lifecycle, durable Agentpack records, final verification, commits, and release actions.

At the start:
1. Call mcp__${serverName}__load_context with preset \"quick\" and a query focused on the brief.
2. Confirm from that resume that the active Task Passport, lifecycle, and write scope match the brief. If they do not, stop without editing.
3. Treat the coordinator brief as the acceptance contract. Read only the code and recorded context needed for this slice.

While working:
- Edit only inside the declared write scope. Treat any Agentpack gate warning or denial as a stop signal, never something to work around.
- Follow existing project patterns, keep the diff narrow, and avoid dependency or formatting churn.
- Prefer targeted searches and the narrowest meaningful test first. Run broader checks only when the brief or risk requires them.
- Work through one implementation-and-verification loop. If the same check fails twice, or the slice needs an architectural, security, scope, or product decision, stop and escalate to the coordinator.
- Do not call Agentpack state-changing tools, commit, push, publish, or start unrelated work.

Return a concise handoff: files changed and why, verification commands and results, deviations or blockers, and candidate durable conclusions for the coordinator. Do not dump routine logs or restate the full loaded context.
"""

[mcp_servers.${serverName}]
command = "agentpack"
args = ["mcp"]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled_tools = ["load_context"]

[mcp_servers.${serverName}.tools.load_context]
approval_mode = "approve"`;
}

function claudeMcpServer(): Record<string, unknown> {
  return {
    type: "stdio",
    command: "agentpack",
    args: ["mcp"]
  };
}

function claudeBuilderAgent(serverName: string, modelLine = "model: sonnet"): string {
  return `---
name: builder
description: Implementation subagent for scoped coding slices in this repo. Invoke when the user requests it or current instructions permit delegation and the slice benefits; announce its use and keep small tasks with the coordinator. Provide the active Task Passport objective, constraints, and write scope. Works only inside the declared write scope and reports back; it does not write Agentpack records.
${modelLine}
---

You are the builder subagent for this repo. You implement one scoped slice of the active Task Passport and report back. The coordinator owns the task lifecycle and all Agentpack records.

At the start of every invocation:
1. Call mcp__${serverName}__load_context with preset "quick" and a query focused on the brief you were given.
2. Confirm the active Task Passport matches the brief. If it does not, or the task is verifying, blocked, or closed, stop and report the mismatch instead of editing.

While working:
- Edit only inside the write scope declared in the brief or the Task Passport. The task gate hook flags out-of-scope edits — it warns by default and blocks when gateMode is "block" in .agentpack/config.json; treat any gate warning or block as a signal to stop and report, not something to work around.
- Read the relevant code before changing it; follow existing project patterns and helper APIs.
- Keep changes small, focused, and reviewable; no unrelated refactors, formatting churn, or dependency changes.
- Run the narrowest meaningful verification (focused tests, typecheck, smoke run) before reporting.

Do not:
- call Agentpack state-changing tools (checkpoint, record_source, record_decision, record_dead_end, attach_evidence, task_update, task_update_verification, task_start, task_park, task_switch, task_finalize) — recording is the coordinator's job, on coordinator-confirmed facts only
- commit or push unless the brief explicitly says to
- widen scope, add features, or fix things outside the brief

If verification fails twice on the same slice, or you are stalled, stop and report what you tried and why it failed; the coordinator escalates to a stronger model instead of looping you.

Your final message is the handoff. Report: what changed (files plus a summary), how it was verified (commands and results), any deviations from the brief, and durable conclusions worth recording, clearly labeled as candidate facts for the coordinator.`;
}

function cursorBuilderAgent(serverName: string): string {
  return claudeBuilderAgent(serverName, "model: inherit");
}

function claudeDesktopMcpServer(root: string): Record<string, unknown> {
  return {
    command: process.execPath,
    args: [agentpackEntrypoint(), "mcp", "--root", root],
    env: {
      AGENTPACK_ROOT: root
    }
  };
}

export function mergeClaudeDesktopConfig(root: string, configPath?: string, beforeWrite?: () => void): string {
  const home = process.env.HOME && path.isAbsolute(process.env.HOME) ? process.env.HOME : homedir();
  const targetPath = configPath ? path.resolve(configPath) : (process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : undefined);
  if (!targetPath) {
    return `Claude Desktop config: skipped automatic merge on ${process.platform}; use the generated recovery snippet.`;
  }

  const directory = path.dirname(targetPath);
  const directoryStat = lstatIfPresent(directory);
  if (!directoryStat) {
    return `Claude Desktop config: skipped because ${directory} does not exist; start Claude Desktop once and rerun the installer.`;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`config directory must be an ordinary directory: ${directory}`);
  }
  assertSafeDesktopPath(targetPath, "config");
  assertSafeDesktopPath(`${targetPath}.agentpack-backup`, "backup");
  assertSafeDesktopPath(`${targetPath}.agentpack.lock`, "lock");

  const lockPath = `${targetPath}.agentpack.lock`;
  const lockToken = `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`;
  try {
    writeFileSync(lockPath, lockToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`registration lock already exists at ${lockPath}; confirm no installer is running, then inspect and remove that exact lock manually`);
    }
    throw error;
  }
  const lockStat = lstatSync(lockPath);

  let result: string | undefined;
  let mergeError: unknown;
  try {
    result = mergeClaudeDesktopConfigLocked(realpathSync(root), targetPath, beforeWrite);
  } catch (error) {
    mergeError = error;
  }

  let cleanupError: unknown;
  try {
    const currentLockStat = lstatSync(lockPath);
    if (readFileSync(lockPath, "utf8") !== lockToken
      || currentLockStat.dev !== lockStat.dev
      || currentLockStat.ino !== lockStat.ino) {
      throw new Error("lock ownership changed; replacement lock was left untouched");
    }
    unlinkSync(lockPath);
  } catch (error) {
    cleanupError = error;
  }

  if (mergeError !== undefined) {
    throw new Error(`${String(mergeError)}${cleanupError === undefined ? "" : `; lock cleanup also failed: ${String(cleanupError)}`}`);
  }
  if (!result) {
    throw new Error("Claude Desktop config merge ended without a result");
  }
  return cleanupError === undefined
    ? result
    : `${result}\nWARNING: config merge completed, but lock cleanup failed at ${lockPath}: ${String(cleanupError)}`;
}

function mergeClaudeDesktopConfigLocked(root: string, configPath: string, beforeWrite?: () => void): string {
  const snapshot = readDesktopConfigSnapshot(configPath);
  const existing = snapshot.content;
  const parsed = existing === null ? {} : parseDesktopConfig(existing, configPath);
  const servers = parsed.mcpServers === undefined
    ? {}
    : requireJsonObject(parsed.mcpServers, `${configPath} mcpServers`);
  const serverName = mcpServerName(root);
  const current = servers[serverName];
  const desired = claudeDesktopMcpServer(root);

  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(desired) && !isGeneratedDesktopEntry(current, root)) {
    throw new Error(`server key ${serverName} already contains an entry Agentpack does not own; config was not changed`);
  }
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(desired)) {
    return `Claude Desktop config: ${serverName} is already up to date in ${configPath}.`;
  }

  const next = `${JSON.stringify({
    ...parsed,
    mcpServers: { ...servers, [serverName]: desired }
  }, null, 2)}\n`;
  if (existing !== null) {
    writeAtomic(`${configPath}.agentpack-backup`, existing, 0o600);
  }

  writeAtomic(configPath, next, snapshot.mode || 0o600, () => {
    beforeWrite?.();
    assertDesktopConfigUnchanged(configPath, snapshot);
  });
  return existing === null
    ? `Claude Desktop config: added ${serverName} to ${configPath}. Restart Claude Desktop to load it.`
    : `Claude Desktop config: updated ${serverName} in ${configPath}; backup: ${configPath}.agentpack-backup. Restart Claude Desktop to load it.`;
}

function parseDesktopConfig(content: string, configPath: string): Record<string, unknown> {
  try {
    return requireJsonObject(JSON.parse(content), `Claude Desktop config at ${configPath}`);
  } catch (error) {
    throw new Error(`invalid Claude Desktop config; config was not changed: ${String(error)}`);
  }
}

function requireJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function isGeneratedDesktopEntry(value: unknown, root: string): boolean {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "args,command,env") {
    return false;
  }
  const args = Array.isArray(value.args) && value.args.every((item) => typeof item === "string") ? value.args : [];
  const env = isRecord(value.env) ? value.env : {};
  return typeof value.command === "string"
    && path.isAbsolute(value.command)
    && path.basename(value.command).toLowerCase() === path.basename(process.execPath).toLowerCase()
    && args.length === 4
    && path.isAbsolute(args[0] || "")
    && path.basename(args[0] || "") === "agentpack.js"
    && args[1] === "mcp"
    && args[2] === "--root"
    && Object.keys(env).join(",") === "AGENTPACK_ROOT"
    && typeof env.AGENTPACK_ROOT === "string"
    && sameRealPath(args[3] || "", root)
    && sameRealPath(env.AGENTPACK_ROOT, root);
}

function sameRealPath(candidate: string, root: string): boolean {
  try {
    return realpathSync(candidate) === root;
  } catch {
    return false;
  }
}

function assertSafeDesktopPath(filePath: string, label: string): void {
  const stat = lstatIfPresent(filePath);
  if (stat?.isSymbolicLink() || (label === "config" && stat && !stat.isFile())) {
    throw new Error(`Claude Desktop ${label} must be an ordinary file, not a symlink: ${filePath}`);
  }
}

function lstatIfPresent(filePath: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function readDesktopConfigSnapshot(configPath: string): DesktopConfigSnapshot {
  assertSafeDesktopPath(configPath, "config");
  if (!lstatIfPresent(configPath)) {
    return { content: null, mode: 0o600 };
  }
  const before = lstatSync(configPath, { bigint: true });
  const content = readFileSync(configPath, "utf8");
  const after = lstatSync(configPath, { bigint: true });
  const identity = (stat: typeof before) => [
    stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs
  ] as const;
  const afterIdentity = identity(after);
  if (!sameDesktopIdentity(identity(before), afterIdentity)) {
    throw new Error(`config changed while being read at ${configPath}; config was not changed`);
  }
  return { content, identity: afterIdentity, mode: Number(after.mode & 0o777n) };
}

function assertDesktopConfigUnchanged(configPath: string, snapshot: DesktopConfigSnapshot): void {
  const current = readDesktopConfigSnapshot(configPath);
  if (current.content !== snapshot.content
    || !sameDesktopIdentity(current.identity, snapshot.identity)) {
    throw new Error(`config changed concurrently at ${configPath}; config was not replaced`);
  }
}

function sameDesktopIdentity(left: DesktopConfigSnapshot["identity"], right: DesktopConfigSnapshot["identity"]): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.every((value, index) => value === right[index]);
}

function writeAtomic(filePath: string, content: string, mode: number, beforeRename?: () => void): void {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let tempCreated = false;
  try {
    writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx", mode });
    tempCreated = true;
    beforeRename?.();
    renameSync(tempPath, filePath);
  } catch (error) {
    if (tempCreated) {
      try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    }
    throw error;
  }
}

function claudeDesktopJsonSnippet(root: string, serverName: string): string {
  return JSON.stringify({
    mcpServers: {
      [serverName]: claudeDesktopMcpServer(root)
    }
  }, null, 2);
}

function claudeDesktopInstructions(root: string, snippetPath: string, serverName: string): string {
  return [
    "# Agentpack for Claude Desktop",
    "",
    "Claude Desktop does not read project-local `.mcp.json` or `CLAUDE.md`.",
    "Use Claude Code's `.mcp.json` for Claude Code only.",
    "",
    `Generated server key for this repo: \`${serverName}\`.`,
    "If Claude Desktop has several Agentpack servers, use the server/tool group with this repo-specific key for this repo.",
    "",
    "On macOS, `agentpack install claude-desktop --write` atomically merges this entry into the existing Desktop config.",
    "Agentpack uses a lock plus optimistic conflict detection; unrelated processes actively rewriting the config are not locked.",
    "The generated JSON remains the dry-run and recovery fallback. Do not copy the generated snippet over the Desktop config file.",
    "",
    "macOS config path:",
    "",
    "```text",
    "~/Library/Application Support/Claude/claude_desktop_config.json",
    "```",
    "",
    "Generated snippet:",
    "",
    "```text",
    relativePath(root, snippetPath),
    "```",
    "",
    "Install and verify:",
    "",
    "```bash",
    "agentpack install claude-desktop --write",
    "cat .agentpack/instructions/claude-desktop-mcp.example.json",
    "```",
    "",
    "The installer preserves existing settings and servers, writes a sibling backup before replacement, and fails closed on malformed JSON, symlinks, collisions, or a concurrent Agentpack install.",
    "If the Claude application directory is missing, start Desktop once and rerun. Non-macOS installs keep the snippet as the reported fallback.",
    "",
    "After editing the Claude Desktop config, restart Claude Desktop.",
    "",
    "The generated snippet launches Agentpack through the current Node executable and Agentpack entrypoint, rather than relying on `agentpack` being available in Claude Desktop's GUI `PATH`.",
    "If Claude Desktop reports that the MCP server disconnected or cannot start, rerun `agentpack install claude-desktop --write`, inspect the result, then restart Claude Desktop.",
    "Keep both the `--root` argument and `AGENTPACK_ROOT` env value pointed at the project whose `.agentpack/` state you want Claude Desktop to use.",
    `When switching this Claude Desktop server to another repo, update both \`mcpServers.${serverName}.args\` \`--root\` and \`mcpServers.${serverName}.env.AGENTPACK_ROOT\`, then restart Claude Desktop.`
  ].join("\n");
}

function cursorInstructions(): string {
  return [
    INSTRUCTIONS.trimEnd(),
    "",
    builderGuidance(".cursor/agents/builder.md"),
    "",
    "Cursor-specific notes:",
    "- Project MCP only applies when Cursor opens this folder as the workspace root.",
    "- After `agentpack install cursor --write`, reload the Cursor window so `.cursor/mcp.json` is re-read.",
    "- In Cursor, open MCP Servers and enable the `agentpack` server if it appears toggled off.",
    "- `.cursor/cli.json` explicitly allows only read-only Agentpack MCP tools; state-changing tools still follow Cursor's approval policy.",
    "- If Agentpack MCP tools are not visible in Cursor, run `agentpack doctor` and check Cursor's MCP/server logs.",
    "- If MCP is unavailable, use the CLI equivalents: `agentpack resume --preset agent`, `agentpack source status`, and `agentpack checkpoint ...`."
  ].join("\n");
}

function cursorMcpServer(): Record<string, unknown> {
  return {
    type: "stdio",
    command: process.execPath,
    args: [agentpackEntrypoint(), "mcp", "--root", "${workspaceFolder}"]
  };
}

function cursorCliPermissionsPlan(root: string, serverName: string): InstallFile {
  const filePath = path.join(root, ".cursor", "cli.json");
  const existing = readJson<Record<string, unknown>>(filePath, {});
  const permissions = isRecord(existing.permissions) ? { ...existing.permissions } : {};
  const existingAllow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
  const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : [];
  const readOnlyAllow = CURSOR_READ_ONLY_MCP_TOOLS.map((tool) => `Mcp(${serverName}:${tool})`);
  const allow = [...existingAllow];

  for (const entry of readOnlyAllow) {
    if (!allow.includes(entry)) {
      allow.push(entry);
    }
  }

  return {
    filePath,
    description: "Allow only read-only Agentpack MCP tools in project Cursor CLI config.",
    content: `${JSON.stringify({ ...existing, permissions: { ...permissions, allow, deny } }, null, 2)}\n`
  };
}

function agentpackEntrypoint(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agentpack.js");
}

function mcpServerName(root: string): string {
  const projectName = path.basename(root);
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!slug || slug === "agentpack") {
    return "agentpack";
  }

  return `agentpack-${slug}`;
}

function parseTarget(target: string): InstallTarget {
  if (INSTALL_TARGETS.includes(target as InstallTarget)) {
    return target as InstallTarget;
  }
  throw new Error(`Unknown install target: ${target}`);
}

function fileStatus(filePath: string, content: string): string {
  if (!existsSync(filePath)) {
    return "create";
  }
  return readFileSync(filePath, "utf8") === content ? "unchanged" : "update";
}

function relativePath(root: string, filePath: string): string {
  return path.relative(root, filePath) || ".";
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
