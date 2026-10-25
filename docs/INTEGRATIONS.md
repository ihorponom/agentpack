# Integrations

Agentpack connects to MCP clients through local project files, the CLI, and MCP. Installers do not write hidden global configuration, except the explicit `claude-desktop --write` merge.

## Client Matrix

| Client | Instruction file | MCP config | Native task gate | Status |
| --- | --- | --- | --- | --- |
| Codex | `AGENTS.md` | Project `.codex/config.toml`. Review snippet: `.agentpack/instructions/codex-mcp.example.toml`. | `.codex/hooks.json` `PreToolUse` | Tested |
| Claude Code | `CLAUDE.md` | Project `.mcp.json` | `.claude/settings.json` `PreToolUse` | Tested |
| Claude Desktop | None | User-global macOS config, merged by `agentpack install claude-desktop --write`. Recovery snippet in `.agentpack/instructions/`. | None | Tested |
| Cursor | `.cursor/rules/agentpack.mdc` | Project `.cursor/mcp.json` | `.cursor/hooks.json` `preToolUse` | Tested |
| Git (any client) | None | None | `.git/hooks/pre-commit`, from `agentpack install git-hooks --write` | Tested |
| Web chats | Markdown handoff | No local stdio MCP. Use `agentpack export`. | None | Manual fallback |

All MCP clients use the same `agentpack mcp` server. Only the location of instructions and MCP configuration differs. Web chats receive pasted Markdown handoffs. They are not a primary integration.

Generated files are local developer setup. Keep these paths out of origin, unless your team chooses to version its own agent policy:

- `.agentpack/`
- `.codex`
- `.claude`
- `.cursor`
- `.mcp.json`
- `AGENTS.md`
- `CLAUDE.md`

In a Git repository, `agentpack init` adds these patterns to Git's `info/exclude`. It does not change `.gitignore`. Outside Git, `init` adds no ignore rules, and `agentpack doctor` reports that local Git excludes are not available.

The directory that contains `.agentpack/` is the pack root. One pack root holds one ledger.

## Where Files Live

| File | Created by | Purpose |
| --- | --- | --- |
| `AGENTS.md` | `install codex` | Project instructions for Codex. |
| `.codex/config.toml` | `install codex` | Project MCP entry for Codex. |
| `.codex/hooks.json` | `install codex` | Codex task gate hook. |
| `.codex/agents/builder.toml` | `install codex` | Codex builder. |
| `CLAUDE.md` | `install claude` | Project instructions for Claude Code. |
| `.mcp.json` | `install claude` | Project MCP entry for Claude Code. |
| `.claude/settings.json` | `install claude` | Claude Code task gate hook. |
| `.claude/agents/builder.md` | `install claude` | Claude Code builder. |
| `.cursor/rules/agentpack.mdc` | `install cursor` | Project rule for Cursor. |
| `.cursor/mcp.json` | `install cursor` | Project MCP entry for Cursor. |
| `.cursor/hooks.json` | `install cursor` | Cursor task gate hook. |
| `.cursor/cli.json` | `install cursor` | Allow entries for read-only Agentpack tools in Cursor CLI. |
| `.cursor/agents/builder.md` | `install cursor` | Cursor builder. |
| `.git/hooks/pre-commit` | `install git-hooks` | Git pre-commit gate. |
| `.agentpack/instructions/codex.md` | `install codex` | Codex workflow notes. |
| `.agentpack/instructions/claude.md` | `install claude` | Claude Code workflow notes. |
| `.agentpack/instructions/cursor.md` | `install cursor` | Cursor workflow notes. |
| `.agentpack/instructions/claude-desktop.md` | `install claude-desktop` | Claude Desktop setup notes. |
| `.agentpack/instructions/verification.md` | `install codex`, `claude`, `cursor` | Detailed verification guidance. |
| `.agentpack/instructions/codex-mcp.example.toml` | `install codex` | Codex config snippet for review. |
| `.agentpack/instructions/claude-desktop-mcp.example.json` | `install claude-desktop` | Claude Desktop config snippet for review. |
| `.agentpack/instructions/pre-commit-gate.example.sh` | `install git-hooks` | Pre-commit snippet for manual merge. |

Each installer creates only its own files. `agentpack install claude --write` does not create the Codex files. If a file is missing, run the matching `agentpack install <target> --write`.

## Safe Install Flow

1. Run `agentpack init` once in the repository. It creates `.agentpack/` and, in Git, the exclude rules. The rules also cover linked worktrees, through the shared Git directory.
2. Preview each client you want. `install` shows the files it would create or update, and the command that applies the plan. It changes nothing and creates no instruction directories.
3. Run the same command with `--write` to apply the plan.

Preview:

```bash
agentpack install codex
agentpack install claude
agentpack install claude-desktop
agentpack install cursor
```

Apply:

```bash
agentpack install codex --write
agentpack install claude --write
agentpack install claude-desktop --write
agentpack install cursor --write
```

`--dry-run` forces a preview explicitly:

```bash
agentpack install claude --dry-run
```

The installer rejects symlinked destinations before it writes anything. It writes project files and `.agentpack/instructions/*`. One command is an exception: `agentpack install claude-desktop --write` merges one entry into the user-global Claude Desktop config. No other installer edits global client configuration.

Run `agentpack doctor` after the install. Restart the client if it does not read the new MCP config.

### Server Names

Each repository gets its own MCP server name. This prevents collisions when several repositories are open in one client.

- Agentpack takes the name from the base name of the pack root directory.
- It converts the name to lowercase and replaces unsupported characters with `-`.
- The key is `agentpack-<slug>`. Example: `agentpack-example-app`.
- A directory named `agentpack` gets the short key `agentpack`.

Two linked worktrees in directories with different names get different keys.

### How Clients Start Agentpack

| Entry | Starts Agentpack with |
| --- | --- |
| Claude Code `.mcp.json` | `agentpack` from `PATH` |
| Codex `.codex/config.toml` | `agentpack` from `PATH` |
| Cursor `.cursor/mcp.json` | Absolute Node path and Agentpack entry file |
| Claude Desktop config | Absolute Node path and Agentpack entry file |
| All client hooks (Codex, Claude Code, Cursor) | Absolute Node path and Agentpack entry file |
| Git `pre-commit` hook | `agentpack` from `PATH` |

Claude Code, Codex, and the Git hook need a global install of `agentpack`. The other entries pin the Node and Agentpack paths that ran the installer. If you switch Node versions (fnm or nvm) or reinstall Agentpack, rerun the installer. `agentpack doctor` checks the Cursor MCP entry, the Claude Desktop entry, and the Codex and Cursor hooks. It checks that the pinned files exist. It does not run them.

### Optional Builder

Codex, Claude Code, and Cursor each get a builder. The builder is a subagent for delegated implementation work. The main agent can use it when you ask or when your instructions allow delegation. The main agent first says what it will hand off and why.

Small tasks stay with the main agent. The main agent also keeps decisions, ledger records, final verification, and delivery.

If a builder file exists, reinstalling keeps it:

- Claude Code and Cursor: the whole existing file stays unchanged.
- Codex: the installer updates its marked managed block and keeps all settings outside the block. It does not touch a builder file without markers.

Review existing builder files after an upgrade to pick up template changes.

For a final verdict, an external review, or a release, the main instructions point to `.agentpack/instructions/verification.md`.

## Codex

```bash
agentpack install codex --write
```

This writes:

- `AGENTS.md`
- `.codex/config.toml`
- `.codex/hooks.json`
- `.codex/agents/builder.toml`
- `.agentpack/instructions/codex.md`
- `.agentpack/instructions/verification.md`
- `.agentpack/instructions/codex-mcp.example.toml`

Agentpack does not edit `~/.codex/config.toml`. The project entry in `.codex/config.toml` looks like this:

```toml
[mcp_servers.agentpack-example-app]
command = "agentpack"
args = ["mcp"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

Do not keep an old global `~/.codex/config.toml` entry that has `args = ["mcp", "--root", "/some/project"]` or `cwd = "/some/project"`. That entry makes every Codex session use the ledger of the old project. If Codex shows the wrong pack root, remove the stale global `mcp_servers.agentpack` block. Keep the project `.codex/config.toml`. Then restart or reconnect the MCP server.

### Codex builder

`.codex/agents/builder.toml` is an optional builder for bounded implementation slices. It uses `gpt-5.6-terra` with medium reasoning by default. Use it for one coherent slice that spans several files. Run more than one builder only if their write scopes do not overlap.

The main agent gives the builder a brief with these items:

- the active Task Passport objective
- constraints
- write scope
- acceptance criteria
- one narrow verification command

The builder can use only the Agentpack MCP tool `load_context`. The quick resume already holds the lifecycle and write scope. The builder config approves that one read-only tool, so non-interactive runs do not cancel it. All other Agentpack tools are not available to the builder. The main agent writes all ledger records.

The generated instructions tell the builder to stop in two cases. The first is a repeated verification failure. The second is a slice that needs a product, architecture, security, or scope decision.

Settings before `# agentpack:builder:start` belong to you. Examples are `model`, `model_reasoning_effort`, and `sandbox_mode`. Reinstalling refreshes the managed role and instructions. It keeps your settings. Delete the model lines to inherit the subagent or parent defaults.

Generated instructions keep one Passport for one coherent phase. Use a second Passport only in these cases:

- The objective is unrelated.
- The authorization boundary is materially different.
- An independent review needs a frozen snapshot.

The builder keeps verification pending while it fixes problems. Intermediate green checks are evidence or checkpoints. The main agent records the final verdict after all edits end.

### Codex hook

The `.codex/hooks.json` merge adds one `PreToolUse` hook on `apply_patch`. It has a separate `commandWindows` launcher for Windows. Codex sends the patch text to the hook. The hook checks every added, updated, deleted, and moved path against the current Passport.

- In block mode, the hook returns a deny decision.
- In warn mode, the hook adds context that the model can read.

Existing hooks stay. Reinstalling replaces the Agentpack entry and does not duplicate it.

Codex runs a project hook only after you trust it. After the install, open `/hooks` and approve the Agentpack definition. Codex documents `PreToolUse` as a guardrail, not as full enforcement. Keep the Git pre-commit gate if you need enforcement at commit time.

Official references: [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), and [Codex hooks](https://learn.chatgpt.com/docs/hooks).

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
- `.agentpack/instructions/verification.md`

`.mcp.json` is project-scoped. Claude Code asks before it uses a project-scoped server. The server key is repository-specific (for example `agentpack-example-app`), so it does not replace a global `agentpack` server.

The `.claude/settings.json` merge adds one `PreToolUse` hook on the tools `Edit|Write|MultiEdit|NotebookEdit`. The hook runs `task gate --client claude` before each file edit.

- In warn mode (default), Claude Code receives the finding as additional context and can correct itself.
- In block mode, Claude Code denies the edit and shows the reason.

Existing settings and hooks stay. Reinstalling does not duplicate the hook. It upgrades older hook entries that used `PATH`.

`.claude/agents/builder.md` is the Claude Code builder. The main agent starts it with a brief (objective, constraints, write scope). The builder works only inside the write scope, verifies its slice, and reports back. It does not write ledger records. The file uses `model: sonnet`. Cursor has its own builder file, so Claude model aliases do not reach Cursor.

You own the builder file after the installer creates it. You can change the model alias or the instructions. Reinstalling keeps the whole file.

Official references: [Claude Code MCP](https://code.claude.com/docs/en/mcp) and [Claude Code hooks](https://code.claude.com/docs/en/hooks).

## Claude Desktop

```bash
agentpack install claude-desktop --write
```

This writes:

- `.agentpack/instructions/claude-desktop.md`
- `.agentpack/instructions/claude-desktop-mcp.example.json`
- one repository-specific entry in the macOS config `~/Library/Application Support/Claude/claude_desktop_config.json`, if the parent directory exists

Claude Desktop does not read this repository's `.mcp.json` or `CLAUDE.md`. The installer:

- keeps all existing top-level settings and MCP servers
- saves an existing config as `claude_desktop_config.json.agentpack-backup`
- refuses malformed JSON, symlinks, conflicting server ownership, and an existing install lock
- never restarts Claude Desktop

Installers use a lock and check the file content and identity just before an atomic replace. This detects conflicts. It does not stop another process that rewrites the config at the same time. Do not run the installer during such a rewrite.

Do not copy the generated snippet over the whole Desktop config. That deletes your other settings. Use the snippet to review a dry run or to recover.

If the Claude application directory does not exist, start Claude Desktop once and rerun the installer. On other platforms, the installer leaves the global config unchanged and reports that the snippet is the fallback.

After a successful merge, restart Claude Desktop.

Claude Desktop has no project config. Use the repository-specific server key from the snippet to find the right server. To point one server at another repository, change both its `--root` value and `AGENTPACK_ROOT`. Then restart Claude Desktop.

One Desktop server entry points to one ledger. For one task across several checkouts, use [additional repositories](TASK-PASSPORT.md#changes-across-repositories). To use separate ledgers, add one `mcpServers` entry for each. Give each entry a distinct name and `AGENTPACK_ROOT`. Tool names can then appear more than once in the client.

Official references: [MCP local server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers) and [Anthropic Desktop Extensions](https://www.anthropic.com/research/desktop-extensions).

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
- `.agentpack/instructions/verification.md`

The MCP entry uses `${workspaceFolder}` as the root, so it holds no project path. It does hold the absolute Node and Agentpack paths. The key is `agentpack-<slug>` (see [Server Names](#server-names)). The entry starts Agentpack through an absolute Node path, so it does not need `agentpack` in the Cursor GUI `PATH`.

The Cursor builder file uses `model: inherit`. It takes the model of the parent session. Reinstalling keeps an existing file. It does not change `.claude/agents/builder.md`.

Cursor CLI does not always use MCP tool annotations to decide if a headless call needs approval. The installer therefore merges `Mcp(<server>:<tool>)` allow entries into `.cursor/cli.json` for Agentpack's read-only tools only. The read-only tools are `bundle_import_plan`, `bundle_inspect`, `diff`, `load_context`, `release_preflight`, `replay`, `resume`, `source_status`, `task_audit`, `task_handoff`, `task_list`, `task_status`, and `usage_report`. Tools that change state, such as `record_decision`, `checkpoint`, and `task_finalize`, are not on the list. They follow the normal Cursor approval policy. Existing settings, allow entries, and deny entries stay. Agentpack does not use `--approve-mcps`.

The `.cursor/hooks.json` merge adds one `preToolUse` hook for `Write|Delete`.

- In block mode, the hook returns `permission: "deny"` with feedback.
- In warn mode, the hook returns a silent `permission: "allow"`. Cursor guarantees `agent_message` feedback only for denied actions.

Existing hooks and settings stay. Repeated installs give the same result.

Cursor hooks can fail open. MCP warnings and the Git pre-commit gate add checks. `agentpack init` and `agentpack install cursor --write` add `.cursor` to Git's `info/exclude`.

After the install:

1. Open the repository folder as the Cursor workspace. Empty-window sessions do not load `.cursor/mcp.json`.
2. Reload the Cursor window.
3. Open the MCP Servers menu.
4. Enable the Agentpack server if it is off.

If the Agentpack tools do not appear, run `agentpack doctor` and read the `Cursor MCP` check:

```bash
agentpack doctor
```

While you debug the connection, use the CLI equivalents:

```bash
agentpack resume --preset agent
agentpack source status
agentpack checkpoint -m "<summary>" --status "<status>" --next "<next action>"
```

Official references: [Cursor MCP](https://cursor.com/docs/mcp) and [Cursor hooks](https://cursor.com/docs/hooks).

## Task Gate

The task gate checks an edit or a commit against the current Passport. Client hooks, the Git pre-commit hook, and `agentpack task gate` all use it. Set the mode with `gateMode` in `.agentpack/config.json`.

| `gateMode` | Behavior |
| --- | --- |
| `off` | The gate reports nothing and allows everything. |
| `warn` (default) | The gate reports findings and allows the action. |
| `block` | The gate denies lifecycle and write scope violations. Branch drift stays a warning. |

- In warn mode, the Cursor hook allows the edit silently. Cursor shows no warning to the user.
- An unknown `gateMode` value falls back to `warn`. The gate adds a finding on every run.
- If `.agentpack/config.json` is unreadable, the gate blocks. It does not skip the check.
- In block mode, a Passport with no write scope cannot enforce a file scope. The gate adds a warning. Set a scope with `agentpack task update --write-scope <path>`.

Client hooks for Codex, Claude Code, and Cursor are always installed by `agentpack install <client> --write`. Only the Git pre-commit hook needs `agentpack install git-hooks --write`.

MCP is the client-neutral warning layer. `load_context` and `task_status` add a `Gate Warnings` section when the current Passport has lifecycle or drift findings. This works without any hook.

### Tasks With Additional Repositories

A Passport can bind additional repositories. See [changes across repositories](TASK-PASSPORT.md#changes-across-repositories).

- `agentpack task gate --staged` checks the staged files of the pack root and of all additional repositories.
- `agentpack task gate --staged --repository <id>` checks one repository.
- The pre-commit hook of the pack root runs only for commits in the pack root. A commit inside an additional repository does not run it.

To check a commit in an additional repository, run `agentpack task gate --staged --repository <id>` from the pack root before you commit.

## Git Hooks

```bash
agentpack install git-hooks --write
```

This installs a `pre-commit` hook. The hook runs `agentpack task gate --staged` on the staged files. It works the same for Codex, Claude Code, Cursor, and human commits.

- In warn mode, the hook prints findings and the commit continues.
- In block mode, lifecycle and write scope violations fail the commit with exit code 2.
- If `agentpack` is not on `PATH`, the hook prints `agentpack not on PATH; Agentpack task gate skipped` and the commit continues.
- `task gate` exits 0 without output in repositories that have no `.agentpack/`.
- The hook fails the commit only on exit code 2. After any other gate error, it prints a notice and the commit continues.

Every run of `install git-hooks --write` also writes `.agentpack/instructions/pre-commit-gate.example.sh`.

If another `pre-commit` hook exists, the installer leaves it unchanged. Merge the example snippet by hand. If `core.hooksPath` points outside the repository, the installer does not write there. It writes only the snippet.

A pack root can be a subdirectory of the repository. The hook goes into the hooks directory of the repository. It changes into the pack root before it runs the gate.

A repository can have several pack roots. They share one hook that gates each pack root in turn.

- Running the installer from another pack root adds it to the list.
- A pack root whose directory is gone is skipped.
- Output that is not clean starts with a label, such as `Agentpack gate [services/ledger]`. Clean pack roots stay silent.
- The commit fails if any pack root blocks.

With `--staged`, the gate enforces lifecycle only for a pack root that owns at least one staged file. A pack root that the commit does not touch never blocks it. An unreadable `.agentpack/config.json` still blocks for every listed pack root.

## Verify

Run the diagnostic check:

```bash
agentpack doctor
```

Contributors who work in a clone of this repository can also run the MCP smoke test:

```bash
npm run mcp:smoke
```
