# Integrations

Agentpack integrates through local project files, CLI, and MCP. It does not write hidden global configuration by default.

## Client Matrix

| Client | Instruction file | MCP config surface | Native task gate | Status |
| --- | --- | --- | --- | --- |
| Codex | `AGENTS.md` plus `.codex/agents/builder.toml` | Project-local `.codex/config.toml`, plus a generated `.agentpack/instructions/codex-mcp.example.toml` review snippet | `.codex/hooks.json` `PreToolUse` | Tested |
| Claude Code | `CLAUDE.md` | Project-local `.mcp.json` in the repo root | `.claude/settings.json` `PreToolUse` | Tested |
| Claude Desktop | None automatically read from the repo | User-local macOS config, merged by `agentpack install claude-desktop --write`; generated snippet is the recovery fallback | None | Tested |
| Cursor | `.cursor/rules/agentpack.mdc` | Project-local `.cursor/mcp.json` | `.cursor/hooks.json` `preToolUse` | Tested |
| Git (any client) | Pre-commit gate hook | None; installs `.git/hooks/pre-commit` via `agentpack install git-hooks --write` | `.git/hooks/pre-commit` | Tested |
| Web chats | Markdown handoff | No local stdio MCP support; use `agentpack export` | None | Manual fallback |

Coding-agent clients use the same `agentpack mcp` server. The difference is where each client expects instructions and MCP configuration to live. Web chats are fallback targets for pasted markdown handoffs; they are not a primary integration surface.

Generated integration files are local developer setup by default. Until Agentpack has an explicit shared/team mode, keep `.agentpack/`, `.codex/`, `.claude/`, `.mcp.json`, `AGENTS.md`, `CLAUDE.md`, and similar client config files out of origin unless a repo deliberately chooses to version its own agent policy.

Generated files under `.agentpack/instructions/` are local helper snippets. They are created only when you run the matching installer, and `agentpack init` adds the Agentpack local-only patterns to `.gitignore` without replacing existing project rules.

## Where Files Live

In a local project setup:

- `CLAUDE.md`: repo-root project instructions for Claude Code.
- `.mcp.json`: repo-root project MCP config for Claude Code.
- `AGENTS.md`: repo-root project instructions for Codex.
- `.codex/config.toml`: repo-local Codex MCP config created by `agentpack install codex --write`.
- `.codex/agents/builder.toml`: optional project-scoped Codex builder optimized for bounded implementation slices.
- `.codex/hooks.json`: repo-local Codex task-gate hook created or merged by `agentpack install codex --write`.
- `.cursor/hooks.json`: repo-local Cursor task-gate hook created or merged by `agentpack install cursor --write`.
- `.cursor/agents/builder.md`: Cursor-specific builder that inherits the parent model, including Auto on Free plans.
- `.cursor/cli.json`: Cursor CLI permissions merged with explicit allow entries for read-only Agentpack MCP tools only.
- `.agentpack/instructions/codex-mcp.example.toml`: local Codex config snippet, created by `agentpack install codex --write`.
- `.agentpack/instructions/claude-desktop-mcp.example.json`: local Claude Desktop config snippet, created by `agentpack install claude-desktop --write`.

If a snippet is missing, run the matching `agentpack install <target> --write`. Running `agentpack install claude --write` does not create Codex or Claude Desktop snippets.

## Safe Install Flow

Run `agentpack init` once per repo to create `.agentpack/` and local ignore rules. Then install the client integrations you actually want to use in that repo. Each `agentpack install <target> --write` command configures one client surface; it does not replace `init`, and installing one client does not create files for the others.

Preview first:

```bash
agentpack install codex
agentpack install claude
agentpack install claude-desktop
agentpack install cursor
```

`install` defaults to side-effect-free dry-run mode. It shows the files Agentpack would create or update and prints the command needed to apply the plan without creating instruction directories. Symlinked destinations are rejected before any write. Pass `--write` to apply the validated plan.

Apply explicitly:

```bash
agentpack install codex --write
agentpack install claude --write
agentpack install claude-desktop --write
agentpack install cursor --write
```

Force preview explicitly:

```bash
agentpack install claude --dry-run
```

Agentpack normally writes project-local files and `.agentpack/instructions/*`.
The explicit exception is `agentpack install claude-desktop --write`, which
reports and merges one repo-specific entry into the macOS user config.
Other installers do not edit global client configuration.

Generated MCP server names are repo-specific to avoid collisions when several repos are open in the same client. The Agentpack repo itself keeps the short name `agentpack`; other repos use `agentpack-<repo-name>`, such as `agentpack-example-app`.

## Codex

```bash
agentpack install codex --write
```

This writes:

- `AGENTS.md`
- `.codex/config.toml`
- `.codex/agents/builder.toml`
- `.codex/hooks.json`
- `.agentpack/instructions/codex.md`
- `.agentpack/instructions/codex-mcp.example.toml`

Agentpack does not edit `~/.codex/config.toml`. The project-local `.codex/config.toml` entry starts MCP with:

```toml
[mcp_servers.agentpack-example-app]
command = "agentpack"
args = ["mcp"]
```

Do not keep an older global `~/.codex/config.toml` entry with `args = ["mcp", "--root", "/some/project"]` or `cwd = "/some/project"`. That makes every Codex session reuse that old repo's `.agentpack/` state even after you run `agentpack init` in a new repo.

If Agentpack still reports the wrong Pack root in Codex, remove the stale global `mcp_servers.agentpack` block, keep the project-local `.codex/config.toml`, then restart or reconnect the MCP server.

`.codex/agents/builder.toml` defines an optional implementation-focused custom agent. Agentpack defaults it to `gpt-5.6-terra` with medium reasoning: the current Codex guidance recommends Terra for faster, lower-cost supporting agents, while the coordinator keeps ambiguous architecture, security-sensitive decisions, final verification, commits, and release actions. The builder is most useful for one coherent slice likely to need more than roughly 10-20 tool calls or several files. Keep small edits in the coordinator, and run multiple builders only when their write scopes do not overlap.

The builder receives a brief containing the active Task Passport objective, constraints, write scope, acceptance criteria, and narrow verification command. Its Agentpack MCP view is restricted to `load_context`; the quick resume already carries lifecycle and write-scope state, so a second status call would only duplicate context. The custom-agent config explicitly approves that one known read-only tool so non-interactive builder runs do not cancel it while every mutable Agentpack tool remains unavailable. Ledger mutation stays with the coordinator. The generated instructions also tell the builder to stop after repeated verification failure or when the slice needs a product, architecture, security, or scope decision instead of looping on a cheaper model.

Generated client instructions keep one Passport for a coherent phase: use another only for an unrelated objective, materially different authorization boundary, or independent review requiring a separate frozen snapshot. Builders keep verification pending while remediating; intermediate green checks are evidence/checkpoints, and the coordinator records the final verdict only after edits end.

Runtime settings before `# agentpack:builder:start` are user-owned. Re-running the installer refreshes the managed role and instructions while preserving changes such as `model`, `model_reasoning_effort`, and `sandbox_mode`, plus configuration outside the managed block. Delete the model lines to inherit the configured subagent or parent defaults. If `.codex/agents/builder.toml` already exists without Agentpack markers, the installer leaves it untouched rather than overwriting a user-defined agent.

The `.codex/hooks.json` merge adds one `PreToolUse` hook on `apply_patch`. It runs the shared gate through the current Node executable and Agentpack entrypoint, with a separate `commandWindows` launcher for Windows. Codex sends the patch text to the adapter, which checks every add, update, delete, and move path against the current Task Passport. Block mode returns a deny decision; warn mode adds model-visible context. Existing hooks are preserved and re-running the installer replaces the Agentpack entry instead of duplicating it.

Codex requires project-local command hooks to be reviewed and trusted before they run. Open `/hooks` after install and approve the Agentpack definition. Codex documents `PreToolUse` as a guardrail rather than a complete enforcement boundary, so keep the git pre-commit gate when commit-time enforcement matters. Because the generated command pins a Node and Agentpack installation, rerun the installer when either referenced path no longer exists. `agentpack doctor` treats another stable Agentpack `>=1.2.0 <2.0.0` launcher as structurally compatible only after non-executing file and package checks; it does not claim to prove runtime startup.

Official references: [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Codex configuration reference](https://developers.openai.com/codex/config-reference), and [Codex hooks](https://developers.openai.com/codex/hooks).

## Claude Code

```bash
agentpack install claude --write
```

This writes:

- `CLAUDE.md`
- `.mcp.json`
- `.claude/settings.json`
- `.claude/agents/builder.md`
- `.agentpack/instructions/claude.md`

The `.mcp.json` file is project-local. Claude Code treats project-scoped MCP config as shareable project config and prompts before using project-scoped servers. Agentpack names the server after the repo, for example `agentpack-example-app`, so it does not shadow a global `agentpack` server.

The `.claude/settings.json` merge adds one PreToolUse hook (`task gate --client claude`, launched through the current Node executable and Agentpack entrypoint rather than the shell `PATH`) on the `Edit|Write|MultiEdit|NotebookEdit` tools. Before each file edit, Claude Code runs the gate against the current Task Passport: in the default `warn` mode a violation is injected as additional context so the agent can self-correct; with `"gateMode": "block"` in `.agentpack/config.json` the edit is denied with the reason. Existing settings keys and hooks are preserved; re-running the installer does not duplicate the hook and upgrades older PATH-based hook entries in place. Because the launcher path pins the Node install, re-run `agentpack install claude --write` after switching Node versions.

`.claude/agents/builder.md` defines an optional builder subagent: a Sonnet-tier implementer the coordinating session invokes explicitly with a brief (task objective, constraints, write scope). It works only inside the declared write scope, verifies its slice, and reports back; recording Agentpack state stays with the coordinator. This keeps large implementation context out of the main session on a cheaper model. Delete the file to opt out. Cursor uses its separate `.cursor/agents/builder.md`, so Claude-specific model aliases do not leak into Cursor.

The builder frontmatter's `model:` line is user-owned. You can keep the generated `model: sonnet` alias or replace it with a full model ID supported by your Claude Code version. Re-running `agentpack install claude --write` preserves that line while refreshing the rest of the generated builder definition, so later template fixes still apply.

`CLAUDE.md` and `.agentpack/instructions/claude.md` also carry a delegation default: as a rough heuristic, slices needing more than 10-20 tool calls or touching several files are a good fit for the builder subagent, while small focused edits stay inline with the coordinator. Codex and Cursor ship equivalent client-specific guidance pointing at their own builder definitions.

Official reference: [Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp) and [hooks reference](https://code.claude.com/docs/en/hooks.md).

## Claude Desktop

```bash
agentpack install claude-desktop --write
```

This writes:

- `.agentpack/instructions/claude-desktop.md`
- `.agentpack/instructions/claude-desktop-mcp.example.json`
- one repo-specific entry in the existing macOS
  `~/Library/Application Support/Claude/claude_desktop_config.json`, when its
  parent directory exists

Claude Desktop does not read this repo's `.mcp.json` or `CLAUDE.md`. The
installer preserves all existing top-level settings and MCP servers, backs up
an existing config to `claude_desktop_config.json.agentpack-backup`, and refuses
malformed JSON, symlinks, conflicting server ownership, or an existing install
lock. It never restarts Claude Desktop.

Agentpack installers serialize through that lock and check content plus file
identity immediately before atomic replacement. This is optimistic conflict
detection: it does not serialize an unrelated process that actively rewrites
the config, so avoid running the installer during such a rewrite.

The generated snippet is still useful for dry-run review and recovery. Do not
copy it over the complete Desktop config; that would delete unrelated settings.
If the Claude application directory does not exist yet, start Desktop once and
rerun the installer. On non-macOS platforms this release leaves the global
config untouched and reports that the snippet is the fallback.

After a successful merge, restart Claude Desktop. The entry uses the current
Node executable and absolute Agentpack entrypoint instead of relying on GUI
`PATH`. Re-run the installer after switching Node or package locations.

Claude Desktop has no project-local repo config. If it lists several Agentpack servers, use the repo-specific server key from the generated snippet for the repo you are working in. If you switch one Claude Desktop server from one repo to another, update both that server's `--root` value and `AGENTPACK_ROOT`, then restart Claude Desktop.

One Claude Desktop server entry points to one Agentpack repo at a time. To expose multiple repos at once, add multiple `mcpServers` entries with different names and different `AGENTPACK_ROOT` values, but expect duplicated Agentpack tool names in the client UI.

For a future low-friction Desktop install, Agentpack should ship a Desktop Extension/MCP bundle instead of asking users to edit JSON manually.

Official references: [MCP local server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers) and [Anthropic Desktop Extensions](https://www.anthropic.com/engineering/desktop-extensions).

## Cursor

```bash
agentpack install cursor --write
```

This writes:

- `.cursor/rules/agentpack.mdc`
- `.cursor/agents/builder.md`
- `.cursor/cli.json`
- `.cursor/mcp.json`
- `.cursor/hooks.json`
- `.agentpack/instructions/cursor.md`

The Cursor MCP config uses `${workspaceFolder}` so it can point Agentpack at the current project root without hard-coding your local filesystem path.
The generated MCP entry launches Agentpack through the current Node executable and Agentpack entrypoint, rather than relying on `agentpack` being available in Cursor's GUI `PATH`.

The Cursor builder uses `model: inherit`. This keeps the parent session's model selection, including Auto on Free plans, instead of interpreting Claude Code's `model: sonnet` alias as a pinned named model. Cursor searches `.cursor/agents/` before its Claude-compatibility directory, so the client-specific builder takes precedence without changing `.claude/agents/builder.md`.

Current Cursor CLI versions do not consistently use standard MCP ToolAnnotations when deciding whether a headless tool call needs approval. The installer therefore merges explicit `Mcp(<server>:<tool>)` allow entries into project-local `.cursor/cli.json` for Agentpack's read-only tools only. Existing settings, allow entries, and deny entries are preserved. State-changing tools such as `record_decision`, `checkpoint`, and `task_finalize` are not allowlisted and continue to follow Cursor's approval policy. Agentpack does not use blanket `--approve-mcps` as an installation default.

The `.cursor/hooks.json` merge adds one `preToolUse` hook for `Write|Delete`. Block mode returns `permission: "deny"` with user and agent feedback. Warn mode returns a silent `permission: "allow"`: Cursor only guarantees `agent_message` feedback when an action is denied, so Agentpack does not claim model-visible warning context on allowed edits. Existing hooks and top-level settings are preserved, and repeated installs are idempotent. Cursor hook failures are fail-open by default, so MCP warnings and the git pre-commit gate remain the reliable client-neutral layers. `agentpack init` and `agentpack install cursor --write` keep `.cursor` local through `.gitignore`; rerun the installer when the pinned Node or Agentpack path no longer exists. `agentpack doctor` treats another stable Agentpack `>=1.2.0 <2.0.0` launcher as structurally compatible only after non-executing file and package checks; it does not claim to prove runtime startup.

After writing the config, open this folder as the Cursor workspace and reload the Cursor window so project MCP is re-read. Then open Cursor's MCP Servers menu and enable `agentpack` if it appears toggled off. Cursor empty-window sessions do not load project `.cursor/mcp.json`.

If Agentpack tools still do not appear in Cursor, run:

```bash
agentpack doctor
```

Look for the `Cursor MCP` check. If Cursor still does not expose Agentpack tools, use the CLI equivalents while debugging Cursor's MCP connection:

```bash
agentpack resume --preset agent
agentpack source status
agentpack checkpoint -m "<summary>" --status "<status>" --next "<next action>"
```

Official references: [Cursor MCP docs](https://docs.cursor.com/context/model-context-protocol) and [Cursor hooks](https://cursor.com/docs/hooks).

## Git Hooks

```bash
agentpack install git-hooks --write
```

This installs a `pre-commit` hook that runs `agentpack task gate --staged` against the files staged for commit. It is the client-neutral enforcement layer: it works the same for Codex, Claude Code, Cursor, and human commits.

- In the default `warn` mode, findings are printed and the commit proceeds.
- With `"gateMode": "block"` in `.agentpack/config.json`, lifecycle and write-scope violations fail the commit (exit code 2); branch drift stays advisory.
- The hook is skipped when `agentpack` is not on `PATH` — the commit proceeds and the hook prints `agentpack not on PATH; Agentpack task gate skipped`, so a silently vanished gate is visible at the actual commit moment. `task gate` itself exits 0 quietly in repos without `.agentpack/`, so the hook never breaks unrelated workflows.
- The hook fails the commit only on gate exit code 2 (block mode). Any other gate error — for example an outdated `agentpack` binary — prints a notice and lets the commit through.

If a foreign `pre-commit` hook already exists, the installer leaves it untouched and writes `.agentpack/instructions/pre-commit-gate.example.sh` for a manual merge instead. If `core.hooksPath` points outside the repository (for example a shared global hooks directory), the installer refuses to write there and only generates the snippet.

Packs that live in a subdirectory of the repository are supported: the hook is installed at the repository's own hooks directory and changes into the pack directory before running the gate. A repository with several packs gets one shared hook that gates each pack — running the installer from another pack adds it to the list, and a pack whose directory disappears is skipped. Non-clean output is introduced by a repo-relative label such as `Agentpack gate [services/ledger]`; clean packs stay silent. The commit is blocked when any gated pack blocks.

Gating is bounded by staged-file ownership: a `--staged` gate run only enforces task lifecycle for packs that own at least one staged file. A pack the commit does not touch — for example an unrelated pack whose current task is closed or parked — never blocks the commit. An unreadable `.agentpack/config.json` still fails closed for every listed pack.

MCP remains the client-neutral warning layer: `load_context` and `task_status` responses append a `Gate Warnings` section whenever the current passport has lifecycle or drift findings, independently of native hook installation.

## Verify

Before connecting an agent client:

```bash
npm run mcp:smoke
```

After installing the integration, restart the client if it does not pick up new MCP config automatically.
