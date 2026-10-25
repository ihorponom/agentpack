# Manual CLI and Fallback

## Default workflow

Use MCP for the default workflow. The generated project instructions tell each MCP client when to load context, record task state and save checkpoints.

Use the CLI to inspect state, troubleshoot MCP, run demos or prepare a manual handoff. A manual handoff also works for web chats without local stdio MCP.

Run `agentpack --version` or `agentpack -v` to print the package version. Run `agentpack --help` to list the main commands.

Put `--help` or `-h` anywhere after a command to print help for that command. The command does not run. `agentpack run` is the exception: it passes every argument to the shell. Help works without a `.agentpack/` directory.

Run `agentpack init` to create the ledger. The command also adds these entries to the Git `info/exclude` file, even before you install a client:

- `.agentpack/`
- `.codex`, `.claude` and `.cursor` (no trailing slash)
- `.mcp.json`
- `AGENTS.md` and `CLAUDE.md`

Git ignores these paths locally. If you plan to commit an untracked `CLAUDE.md` or `AGENTS.md`, it disappears from `git status`. Use `git add -f` to add it. Files that Git already tracks stay tracked. The command leaves `.gitignore` unchanged. Outside Git, `init` succeeds, but `doctor` warns that Git excludes are not available.

Run `agentpack install <target>` to configure a client. The targets are `codex`, `claude`, `claude-desktop`, `cursor` and `git-hooks`. Without `--write`, the command changes no files. `--dry-run` is the default.

- For Claude Desktop, `install claude-desktop --write` saves local recovery files. It merges the server entry into the existing macOS configuration.
- Installers use a lock and check for external changes before an atomic replacement. They do not lock other applications.
- `install git-hooks --write` adds a pre-commit hook. The hook runs `agentpack task gate --staged`.
- The `codex`, `claude` and `cursor` installers include an optional builder. The main agent announces delegated work before it uses the builder. Claude Desktop and git-hooks do not install a builder.

See [integration details](INTEGRATIONS.md#optional-builder) for setup and reinstall rules.

Run `agentpack mcp [--root <path>]` to start the MCP stdio server by hand. MCP clients normally start it for you. The server finds the pack root (the directory that contains `.agentpack/`) in this order:

1. The `--root` option.
2. The `AGENTPACK_ROOT` environment variable.
3. The current working directory.

## Command index

| Command | Purpose |
|---|---|
| `init` | Create the ledger. |
| `install <target> [--dry-run\|--write]` | Generate client configuration. |
| `doctor` | Check setup. |
| `mcp [--root <path>]` | Start the MCP server. |
| `task start\|update\|list\|status\|handoff\|passport\|switch\|audit\|gate\|park\|block\|verify\|finalize\|close` | Manage Passports. |
| `resume`, `export`, `bundle` | Hand off task state. |
| `source`, `evidence`, `record`, `note`, `checkpoint`, `run` | Record state. |
| `ledger status\|compact` | Inspect and slim the ledger. |
| `replay`, `diff`, `status`, `tui` | Inspect state. |
| `usage report\|link\|unlink` | Report local token use. |
| `release preflight` | Check release metadata. |
| `set goal\|status\|next` | Set ledger-level state. |

## Inspect state

```bash
agentpack resume --preset agent --query "MCP install"
agentpack source status
agentpack source status --changed
agentpack source status --missing
agentpack source status --json
agentpack ledger status
agentpack tui
agentpack ledger compact [--write]
agentpack doctor
agentpack replay [--limit <n>]
agentpack diff [from] [to]
agentpack status
agentpack release preflight
```

Run `resume --preset agent` to show the current task and the ledger context. The output includes the goal, status, next actions, Git state, decisions, dead ends, evidence and source cache guidance. An approximate token budget limits the output.

Run `source status` to check the recorded files. The result marks each file as unchanged, changed or missing. The hash comparison checks the file, not the recorded conclusion. Use `git status` to inspect working-tree changes. Use `--changed` or `--missing` to filter the list. Add `--json` for structured output.

If a recorded file changes, read it again. Check the source conclusion before you update its summary:

```bash
agentpack source review src/checkout.ts --summary "Checkout totals still flow through calculateTotals; tax handling moved into normalizeLineItems."
```

`source add` and `source review` take `--summary <text>` and an optional `--snippet <text>`. `source add` fails for a file that changed after its conclusion was recorded. Use `source review` for that file.

Remove source conclusions when their files are deleted or the conclusions are no longer useful:

```bash
agentpack source prune --missing
agentpack source remove docs/old-file.md
```

`source prune --missing` removes the conclusions for deleted files. `source remove <file>` removes one conclusion.

`replay` prints the most recent ledger events. The default limit is 50. `diff` compares two checkpoints. Without ids, it uses recent checkpoint history. `status` prints the raw ledger state as JSON. It is mostly useful for debugging.

Run `ledger status [--json]` to inspect task counts, file sizes, evidence references and source cache status. The command does not change the ledger. The `--json` output always has a `ceremonyDiagnostics` array. The array can be empty. Agentpack skips malformed event lines and reports them in `warnings`. See [Ledger Hygiene](LEDGER-HYGIENE.md) for the full inventory.

Run `tui` to open the read-only Inspector. It shows Tasks, Passport, Timeline, Evidence, Checkpoints, Health and Usage. It does not switch tasks or change ledger files. Without a terminal, it prints a static snapshot and exits. See [TUI.md](TUI.md) for controls and limits.

Run `ledger compact [--write] [--purge] [--keep-checkpoints <n>] [--evidence-age-days <n>]` to show a compaction plan. By default, the plan selects:

- `diff.patch`, `git-status.txt` and `resume.md` from checkpoints older than the newest 30. Every `checkpoint.json` stays.
- Superseded source cache events in `events.jsonl`. The current conclusion for each live path stays. `sources.json` remains the authority.
- Unreferenced evidence files older than 30 days.

Compaction keeps decisions, dead ends, referenced evidence and checkpoint metadata. Timeline and replay stay available.

Without `--write`, the command only shows the plan. Use `--write` to move the selected data into `.agentpack/archive/`. Use `--purge` with `--write` to delete it instead. If staging or an archive move fails, Agentpack restores the original event log and files. The archive destination must be an ordinary directory inside `.agentpack/`. Agentpack rejects symlinked destinations.

Compaction keeps the `events.jsonl` format and records a `ledger-compact` event. If the event log or the checkpoint count grows large, `doctor` suggests compaction.

Run `doctor` to check:

- the ledger setup and local ignore rules
- client configuration, including Claude Desktop servers
- the native Codex and Cursor gates
- Git availability
- source cache status
- ledger size (with a hint to run `ledger compact`)
- the Node runtime version

For gate launchers, `doctor` checks the generated command format, accessible non-empty Node and Agentpack files, package identity, CLI entry point and version. It accepts structurally compatible stable launchers in the `>=1.2.0 <2.0.0` range. It does not run the configured command. A missing, moved, malformed or incompatible launcher produces a warning with a reinstall command.

Changed or missing source conclusions produce warnings. They do not mean that setup failed. Before a release handoff, run `agentpack source status --changed --missing`.

Run `release preflight` to check local release metadata and Trusted Publisher configuration. The report is read-only and includes the manual release commands. It does not push, tag, publish or create GitHub Releases.

## Task Passports

A Task Passport stores task state under `.agentpack/tasks/`. Use these commands to create and inspect a Passport:

```bash
agentpack task start "Fix checkout discount bug" \
  --objective "Make discount totals consistent across cart and checkout" \
  --constraint "Keep the public cart API unchanged" \
  --write-scope src/checkout.ts \
  --write-scope src/cart.ts \
  --next "Add a regression test" \
  --tag checkout
agentpack task update \
  --next "Run focused regression tests" \
  --write-scope tests/checkout.test.ts \
  --risk medium
agentpack task list [--scope <path>] [--status <status>] [--open] [--all]
agentpack task status [--id <id>] [--full]
agentpack task passport [<id>]
agentpack task verify --status passed --evidence <evidence-id> --summary "Focused checks passed"
agentpack task handoff
agentpack task finalize
```

`task start` and `task update` accept these options:

| Option | Meaning |
|---|---|
| `--objective <text>` | The goal of the task. |
| `--constraint <text>` | A rule for the task. Repeat the option for more rules. |
| `--write-scope <path>` | A path the task may change. Repeat the option for more paths. |
| `--repository <json>` | An additional repository. Repeat the option for more repositories. |
| `--next <item>` | A next action. Repeat the option for more actions. |
| `--tag <text>` | A tag. Repeat the option for more tags. |
| `--risk low\|medium\|high\|unknown` | The risk level. `unknown` is the default for `task start`. Other values are rejected. |

Use repository-relative paths for write scopes. `.` selects the repository root. A directory such as `api` includes every file under `api/`.

`task list` shows the scope of each task. Use `task list --scope api` to select tasks whose primary scope overlaps that path. Tasks without a matching scope are not shown. Repeat `--scope` to combine filters with OR. `--scope .` selects every task with a primary write scope. Filters ignore a leading `./` and trailing slashes. Agentpack rejects empty `--scope` values.

On an active task, use `--repository <json>` to include additional repositories without a second ledger:

```sh
agentpack task update \
  --repository '{"id":"web","worktree":"../web","writeScope":["src","tests"]}'
agentpack task list --scope web:src
```

`task start` accepts the same option. Local scope updates append. An unqualified scope filter selects the primary scope. The filter `id:path` selects an additional repository. See [changes across repositories](TASK-PASSPORT.md#changes-across-repositories) for checkout, verification and import rules.

By default, `task list` shows active, parked, blocked and verifying tasks. `--open` selects the same set. The output reports how many closed tasks are hidden. Use `task list --all` to include closed tasks (completed or abandoned). Only Passports from older versions or imported bundles can be abandoned. No current command sets that status.

Use `task list --status <status>` to select statuses. Repeat `--status` to combine statuses with OR. Agentpack rejects unknown values. Do not combine `--open` with `--status`. Do not combine `--all` with either option.

Status and scope filters combine with AND. For example, `task list --open --scope api` selects open tasks that own `api`. Use `--all` or `--status completed` to inspect completed Passports.

Use this task workflow:

1. Run `task start` to declare the work.
2. Run `task status` to inspect the current task.
3. Run `task update` to keep the objective, scope, risk and next actions current.
4. Keep verification pending while edits continue.
5. Record intermediate check results as evidence or checkpoints.
6. When edits end, record the final verdict. It binds the current HEAD.
7. Run `task handoff` to prepare a summary for another session or client.
8. Run `task finalize` to complete the verified task.

`task status` prints one state line. Use `task status --full` for details. Use `task status --id <id>` to inspect another Passport. It does not switch tasks or change ledger files. The report includes the objective, constraints, next actions, blocked reason, verification, bound HEAD and diagnostics. It labels the actual current task separately.

Run `task passport` to print the current `passport.json`. Run `task passport <id>` to print another Passport.

`task update` appends list values. Use `--clear-next-actions` to replace the next actions with the `--next` items. Without `--next`, the flag clears the list. Use `--replace-constraints` to replace the constraints. The task history keeps the removed constraints. Group related changes in one `task update` call.

Task mutation commands print the lifecycle state, verification status and first next action on one line. Run `task status` when you need more detail.

`task handoff` includes the latest task-linked checkpoint when one exists.

### Lifecycle commands

| Command | Result |
|---|---|
| `task park` | Parks the current task. Use it to defer unfinished work. It keeps the work for later. |
| `task block <reason>` | Blocks the current task and records the reason. `--reason <text>` also works. |
| `task close` | Marks the task completed without the verification check that `finalize` enforces. |
| `task finalize [--status passed\|failed\|accepted] [--evidence <id>] [--summary <text>] [--force]` | Completes a verified task. It refuses unknown or pending verification. `--status accepted` also refuses a task with next actions left. Use `--force` only if you accept the task as complete and keep those actions as history. |
| `task switch <id> [--park-current]` | Selects another open Passport. Pending or unknown verification resumes as `active`. A final verdict resumes as `verifying` and keeps its bound HEAD. |

If the current task is active, blocked or verifying, park or complete it before you start unrelated work. `task start` does not replace these tasks.

`task finalize` prints advisories: uncommitted in-scope changes, remaining next actions, missing checkpoints and incomplete verification evidence. The advisories do not block finalization.

`task switch --park-current` parks a different current open task and selects the target. The flag takes no value. The command validates the target first. It keeps verification states and bound HEADs. If a write fails, the command rolls back. Without the flag, park or finalize the current open task before you switch. Return verification to pending before more edits.

`task update-verification` is a compatibility alias for `task verify`. Repeating an identical `task verify` update adds no task event.

New `--evidence` ids on `task verify` and `task finalize` must match evidence events in the bounded recent event-log window. An unknown id rejects the command before any Passport or event change. The error names missing id-shaped values and counts other invalid values. Ids that are already linked stay valid after their events leave the window. Older Passport links stay readable.

A final `task verify` result names the bound HEAD and freezes code changes. Pending verification keeps the task active. `task finalize` reports the bound HEAD and the completed state. It keeps an existing final-verdict binding. If verification was not final, direct finalization binds the current HEAD.

If a current Passport exists, `resume` and MCP `load_context` use its status and next actions in Current State. They put the Passport before the ledger context. Without a current Passport, they use the ledger-level status and next actions from `set`. Both commands build the same resume. Use one command for each query and budget.

Use `agentpack task --help` for the task command list.

### Audit

Run `task audit [--json]` to check task continuity. It reports branch and HEAD drift, missing next actions, open verification, anomalies in completed tasks, stale source conclusions and incomplete verification evidence.

For low-risk work, provide a readable note or useful test output. State the check, the result and the relevant limits. No labels or minimum length are required. Empty, unreadable, generic or HEAD-only evidence produces an advisory.

For code scopes, include a `Reviewed HEAD` that matches the bound HEAD or its full 40-character form. For medium and high risk, provide an independent read-only review and a named negative, differential, operational or rollback check. Classify contract changes as medium or high risk.

After risk calibration, the audit finds missing or malformed labels in the best incomplete evidence item. It includes a template. These checks assess evidence structure, not technical correctness. They do not block task actions. Metadata warnings appear separately. The `ceremonyDiagnostics` field lists a bounded set of review candidates. It does not report lifecycle violations or savings.

### Task gate

`task gate [--file <path> ...] [--staged] [--repository <id>] [--json]` checks task lifecycle, scope and branch drift. It does not read the event log. `task audit` reports HEAD drift.

The `gateMode` value in `.agentpack/config.json` sets the result:

| `gateMode` | Result |
|---|---|
| `off` | Checks are disabled. |
| `warn` (default) | The gate prints findings and exits 0. |
| `block` | The gate exits 2 when it finds a violation. |

An unknown `gateMode` value falls back to `warn` and adds a finding. An unreadable configuration file forces `block` mode. An unreadable Passport or an unknown hook payload is a violation. Branch drift stays advisory.

Without a ledger, the gate exits 0. It prints nothing, except that `--json` prints `{"mode":"off",...}`.

`--staged` checks the staged files of the pack root and of every additional repository. `--repository <id>` checks one repository. `primary` selects the pack root checkout. Explicit file paths are relative to the pack root or absolute. A staged file in a nested additional repository follows the scope of that repository. A staged submodule pointer update follows the scope of the parent repository. External hooks must call the selected ledger explicitly.

`--client claude|codex|cursor` reads native hook JSON from stdin. Claude and Codex receive deny or additional-context output. Cursor receives deny in `block` mode and a silent allow in `warn` mode. The Codex adapter checks every `apply_patch` add, update, delete and move path.

A path outside the primary scope and all declared additional repositories produces an advisory `outside-root` finding. Lifecycle and branch or scope advisories are suppressed when the check covers only other repositories and no file in the pack root. Invocations without paths keep those checks. A task without a primary scope gets a `no-write-scope` advisory when primary scope checking applies.

Scopes use literal path prefixes. For additional repositories, the gate checks lexical and physical paths, including symlink aliases. It does not detect case-only aliases on case-insensitive filesystems. The gate is a task guardrail, not a filesystem security boundary.

### Checkpoint context in handoffs and bundles

Checkpoint context in `task handoff` and in bundles has one redacted summary, a timestamp, an id and the origin task and Git ref. The serialized record is limited to 2 KiB, with explicit truncation. A local linked checkpoint takes precedence over imported bundle context. Global checkpoints, checkpoint snapshots and ledger-level status and next actions are not included.

Import keeps the historical context. It does not create a local checkpoint and does not change local task verification. A bundle without a checkpoint field is valid. See the [portable bundle contract](TASK-PASSPORT.md#portable-bundle-contract) for provenance and compatibility details.

## Record durable state

Record the decisions, findings and evidence that the next session needs. Use these commands:

```bash
agentpack record decision "Use project-local MCP config instead of editing global config automatically"
agentpack record dead-end "GUI apps may not inherit shell PATH for MCP launchers." --reason "Cursor and Claude Desktop can start outside the login shell"
agentpack source add src/integrations/install.ts --summary "Install flow writes project-local client config and generated agent instructions."
agentpack evidence add --kind test-output --file test.log
agentpack checkpoint -m "MCP install tested" --status "Ready for docs polish" --next "Update integration docs"
```

`record decision|dead-end|note <text>` accepts `--reason <text>`, `--file <path>` and `--evidence <id>`. Repeat `--file` and `--evidence` for more values. `note <text>` and `record note <text>` both record a lightweight note.

`evidence add` accepts `--kind <type>` (default `note`), `--file <path>`, `--content <text>`, `--command <text>` and `--exitCode <code>`. The command prints the new evidence id. Use that id with `--evidence`:

```bash
agentpack evidence add --kind test-output --content "npm test: 42 passed"
```

`checkpoint` accepts `-m <summary>`, `--status <text>` and `--next <item>`. When a current Passport exists, the checkpoint links to that task.

Use `agentpack run "npm test"` to run a command from the pack root. It prints the output and attaches stdout, stderr and the exit code as evidence. The command exits with the exit code of the shell command.

Use `set` for ledger-level state that applies when no Passport is current:

```bash
agentpack set goal "Ship the checkout fix"
agentpack set status "Waiting for review"
agentpack set next "Merge the fix"
```

## Web-chat handoff

If MCP is not available, export a markdown handoff. Paste the result into the next chat:

```bash
agentpack export --to markdown --preset chat --query "MCP install"
```

Agentpack lowercases the export name. The name must start with a letter or a number. It can contain letters, numbers, `.`, `_` and `-`. Agentpack rejects filesystem paths. The command writes `.agentpack/exports/<name>-handoff.md`. For example, `--to chatgpt` writes `chatgpt-handoff.md`. Without `--to`, the name is `markdown`.

Use MCP and `resume --preset agent` for clients with local MCP access. Use markdown export for clients without that access.

## Structured bundles

Use a bundle to move one task between workspaces:

```bash
agentpack bundle export --task current --output checkout.agentpack-bundle.json \
  --source src/checkout.ts
agentpack bundle inspect checkout.agentpack-bundle.json [--json]
agentpack bundle import-plan checkout.agentpack-bundle.json [--as-new] [--json]
agentpack bundle import checkout.agentpack-bundle.json [--write] [--as-new] [--json]
```

`bundle export` writes one redacted, deterministic JSON file. The file contains a portable Passport, a handoff, the selected source conclusions and the referenced text and JSON evidence. It is separate from the markdown `export` command.

These options apply to `bundle export`:

| Option | Meaning |
|---|---|
| `--task current\|<id>` | The task to export. The default is `current`. A current task or an explicit id is required. |
| `--output <file>` or `-o <file>` | The output file. |
| `--source <path>` | A source conclusion to include. Repeat the option for more files. |
| `--no-evidence` | Leave out the evidence. |

Select a new repository-relative output file outside `.agentpack/` and `.git/`. Export rejects existing files. It also rejects paths that leave the repository through parent directories or symlinked directories.

`bundle inspect` validates and summarizes a bundle. It does not need an initialized ledger.

`bundle import-plan` validates the bundle. It compares the task id and the retained bundle digest with the destination. The result is create, idempotent or conflict. The command is read-only and works before `agentpack init`. The JSON output has an empty write set.

By default, `bundle import` also returns a read-only plan. If the destination ledger exists, use `--write` to apply the plan. The imported task starts parked with local verification `unknown`. The current-task pointer does not change. A task id conflict rejects the import unless you pass `--as-new`. Importing the same bundle again changes nothing.

Import holds one ledger lock and rolls back write failures. It reuses evidence with a matching id and digest. A collision gets a new id. Import adds a source conclusion only if the file hash in the destination matches. Existing local conclusions take precedence. Missing or changed files are reported and skipped. The retained bundle and the import manifest record the created, reused, remapped and skipped records.

See [TASK-PASSPORT.md](TASK-PASSPORT.md#portable-bundle-contract) for the bundle schema, inclusion rules, security boundaries and collision behavior.

## Budgets

Use `--preset` or `--budget` to limit the approximate token estimate of `resume` and `export`. The estimate does not exceed the selected budget.

| Preset | Tokens | Use |
|---|---|---|
| `quick` | 1200 | Quick context |
| `chat` | 4000 | Compact manual handoff |
| `agent` | 8000 | Deeper coding-agent handoff |
| `deep` | 16000 | Large debugging session or review |

`--budget <tokens>` overrides `--preset`. Without either option, `resume` has no limit and `export` uses 4000. An unknown preset name is ignored without an error. The same defaults then apply.

Use `--query` to filter the source cache locally. Matching source conclusions keep their full summaries and snippets. Other conclusions appear as compact path, status, topic and guidance entries. Changed or missing files keep warning entries. Inspect them with `agentpack source status --changed --missing`.

If no source conclusion matches the query, all conclusions appear as compact entries. Run again without `--query` to see the full source cache.

## Local usage reports

A usage report shows the token use of Claude Code and Codex sessions. It reads local session files (`~/.claude` and `~/.codex` by default) or files that you name. It sends nothing over the network. A task report and a direct report write no files. Only `usage link` and `usage unlink` write, and they write only `.agentpack/usage/<task-id>.json`.

### By task

```bash
agentpack usage report                      # current task
agentpack usage report <task-id>            # any Passport (or --task <task-id>)
agentpack usage link <task-id>              # list candidate sessions
agentpack usage link <task-id> --pick 1,3   # or session ids
```

The task id defaults to the current Passport. Select a task with a positional `task_...` id or with `--task <id>`. The word `current` works only as `--task current`. `usage report current` fails.

A session is traced when its own Agentpack tool output starts the task, switches to it or shows it as current in `load_context` or `resume`. Prose and quoted history do not establish a trace. Agentpack includes traced sessions and their subagents automatically. This includes Codex child threads.

Link other sessions once for each task. Links are stored in `.agentpack/usage/<task-id>.json`. Reading a report changes no files. You cannot unlink traced sessions.

A task report counts the requests made while that Passport was current. Lifecycle events set the periods. `task start` or `task switch` begins a period. `task park`, `task close` or `task finalize` ends it. Older tasks without lifecycle events use their creation and closure times.

Agentpack splits shared sessions by time, so per-task totals do not overlap. A subagent session belongs entirely to the task that was current when the subagent started. Requests without timestamps are left out of the attribution and counted as omissions.

If no sessions are traced or linked, `usage report` lists candidates. `usage link` always lists them. Candidates are Claude Code transcripts, their subagents and Codex rollouts from the task worktree. Each candidate has usage attributed to the task. The list shows a stable session id, the `[traced]` status and the number of requests attributed to the task.

Untraced candidates add no usage until you link them with `--pick`. The report warns how many candidates are not linked. `--pick` accepts list numbers or session ids. Use ids in scripts because list numbers can change between calls.

`--json` output has a `kind` field. These shapes exist:

- `task-usage-candidates`: `taskId`, `linked`, `intervals` (`from`, and `to` or null while current), `searched`, `warnings`, `candidates` (`number`, `id`, `client`, `file`, `subagent`, `started`, `requests`, `taskRequests`, `traced`, `linked`)
- `task-usage-report`: `version`, `taskId`, `manifest` (`path`, `sha256`), `coverage`, `requests`, `totals`, `agentpackOverhead`, `agentpackOverheadBeforeActivation`, `slices` (`phase`, `report`; traced sessions use phase `traced`), `billedUsd` (always null), `warnings`. For `--task`, `manifest` describes the effective selection of linked and traced sessions.
- `task-usage-link`: `taskId`, `linked` (file names), `report`
- `task-usage-unlink`: `taskId`, `removed`, `remaining`

Discovery reads `$CLAUDE_CONFIG_DIR` (default `~/.claude`) and `$CODEX_HOME` (default `~/.codex`). It parses sessions updated after the task started. It checks at most 200 sessions for each client. For Codex, it checks day directories within the last 120 days of the task. It warns when a limit applies. It skips unreadable sessions and files larger than 64 MiB, with warnings. Text output shortens the home directory to `~`. `--json` keeps absolute paths.

```bash
agentpack usage link --task <task-id> --client claude --file /path/to/session.jsonl --turns 4: --phase review
agentpack usage link --task <task-id> --coverage declared-complete --note "Main and review sessions"
agentpack usage unlink --task <task-id> --file <session-id or path>
```

Use `--client` and `--file` to link one session file. Use `--turns` to narrow its selection within the task periods. Linking the same file again replaces its selection. Use `--phase` to label the linked file. The default phase is `main`.

Coverage starts as `partial`. After you link or trace sessions, use `--coverage` with `--note` to declare coverage.

Agentpack validates each link against the combined report before it saves the link. It rejects files without applicable usage. This includes files from the wrong client, files that are not transcripts and files with no requests while the task was current. A request that appears in several files counts once and produces a warning. Explicit `--manifest` files reject overlapping selections. The Usage view in `agentpack tui` shows the same report or candidate list.

### Direct sources

```bash
agentpack usage report --client codex --file /path/to/rollout.jsonl --task "Fix retries"
agentpack usage report --client claude --file /path/to/session.jsonl --json
agentpack usage report --client codex --file /path/to/rollout.jsonl --by-turn
agentpack usage report --client codex --file /path/to/rollout.jsonl --turns 4:5 --by-turn
agentpack usage report --client codex --file /path/to/session.jsonl \
  --from 2026-10-02T09:00:00Z --to 2026-10-02T10:00:00Z
```

Direct reports work without `agentpack init`. They read only the local JSONL files that you supply, up to 64 MiB each. They print aggregate usage and provenance. They write no files and no ledger records. Repeat `--file` for more files from the same client, including child sessions. With `--client` and `--file`, `--task` is only a label. It does not activate or change a Passport.

Direct reports and each task slice include an `agentpackOverhead` JSON object. Its fields are `calls`, the estimated `responseTokens`, `rereadTokensUpperBound`, `outputTokensUpperBound`, `unattributedResponses` and `byTool` rows with the same per-tool counts and estimates.

### How attribution works

Agentpack recognizes calls to the `agentpack` server and to servers that the installer names `agentpack-<repo-name>`. It excludes other MCP servers. It estimates response tokens as the visible transcript characters divided by four, rounded up. The reread upper bound multiplies each response estimate by the later selected requests in that file. Compaction or truncation can reduce the actual rereads. The output upper bound counts model output once for each request with observed Agentpack calls. It includes other output from those requests.

For Codex code-mode, completed nested MCP events identify calls, including dynamic calls. Printed result text adds to the response size. Unprinted or very short results do not. Agentpack does not count direct-call completion events again. A nested event must match exactly one open wrapper. Otherwise, Agentpack leaves it out of the call count and adds one to `unattributedResponses`.

Without nested events, Agentpack uses identifiable result blocks. Source expressions alone do not prove execution. Repeated prints add to the response size. Identical calls or transformed results can stay ambiguous. Unresolved wrappers add to `unattributedResponses`. When `functions.exec` also runs shell commands, Agentpack can still measure separate Agentpack results. It uses output signatures and tool names. Shell output that imitates a result can stay ambiguous. An empty JSON list does not identify its source.

These fields contain no transcript content. They do not measure tool schemas, exact tokenizer usage, cache billing or money. Task reports add the estimates from the selected sources. The coverage limits of the sources still apply.

Task reports also include `agentpackOverheadBeforeActivation` with the same shape. It uses the same session files. Its calls and response tokens cover the period before the task became current, when no task was current. This includes the activating `task_start` or `task_switch` call and orientation calls such as `load_context`. Calls made while another task was current stay with that task.

Its reread bound includes earlier Agentpack responses over the selected requests of this task. Those responses can come from the gap before activation or from the period of another task. The reread of each request belongs to the task that owns the request. Tools carried in from earlier responses appear in `byTool` with zero calls.

This field is separate from `agentpackOverhead` and from the totals. Subagent sessions do not have it. If Agentpack cannot read the periods of another task, the field is zero and the report warns.

### Turns, filters and formats

Use `--by-turn` to add turn rows for each session file. Each row has the start time, request count, token categories, completion and the duration when available.

Use `--turns N`, `--turns N:` or `--turns N:M` to select an inclusive range. `N:` continues to the last turn. Turn selection needs exactly one session file. A turn is a user interaction, not one model request or an inferred work phase.

Codex uses client start and complete records for turn boundaries. Claude uses recorded user-message boundaries and excludes tool results and metadata. Agentpack reports missing boundaries. Incomplete Codex turns have no duration. For Claude, completion and duration stay unknown.

Durations include tools and waits. Timestamp filters hide the duration when they select only part of a turn. Turn selection also hides session cost estimates.

Connected agents can use the read-only `usage_report` MCP tool. It accepts `client`, `files`, `byTurn`, `turns`, `from`, `to`, `task` and `json`. With `client` and `files`, `task` is only a label. The CLI and MCP share the same calculations and formatting.

Agentpack reads Codex `token_usage_record` entries and Claude Code assistant messages with usage counters. A repeated request or message identifier counts once. Conflicting counters reject the report. For Claude content-block snapshots, Agentpack keeps the highest output count for each message.

Agentpack does not add Codex cumulative counters again. It checks unbounded source totals against the final available thread counter, including reasoning. Without reasoning counters, the full comparison is not available. Counter resets and incomplete sources produce mismatch reports. Reports show the counts of malformed or invalid records. They do not copy the contents.

Input includes cache read and write. Reasoning, when present, is part of output. The report keeps these categories and groups requests by model. Missing reasoning counters stay unknown.

Use timestamps with an explicit timezone for `--from` and `--to`. `--from` is inclusive. `--to` is exclusive. The filters use the timestamps of usage records. If you supply a boundary, Agentpack leaves out records without usable timestamps and counts them. These timestamps select requests. They do not measure continuous execution-time billing.

When pricing is known, Claude `cost-state` snapshots appear as separate client-session estimates for each file. They can cover more work than the visible message counters. Do not add up estimates from overlapping sessions. Time filters hide these estimates because cumulative cost cannot be assigned to the selected range. Actual charges stay unknown. The report does not guess model rates and does not ask for them.

Supply every file that the selected work boundary needs. A transcript alone does not prove task coverage or completion. Direct reports do not discover child sessions or other clients. The supported clients are Codex and Claude Code. Usage reports need no account connection, no background collection and no telemetry.

```bash
agentpack usage report --manifest .agentpack/usage/task-example.json --by-turn
```

Use `--manifest` to report the exact selections in a manifest without Passport attribution. Use `--task` to apply the current periods of the task to its linked manifest. Do not combine `--manifest` with `--client`, `--file`, `--task`, `--from`, `--to` or `--turns`. It accepts `--json` and `--by-turn`.

A manifest is an explicit local file that maps a task to session files:

```json
{
  "version": 1,
  "taskId": "task_example",
  "coverage": { "status": "partial", "note": "Main session only; separate reviews excluded" },
  "sources": [
    { "client": "codex", "file": "/absolute/path/to/rollout.jsonl", "turns": "4:5", "phase": "implementation" },
    { "client": "claude", "file": "/absolute/path/to/review.jsonl", "phase": "review" }
  ]
}
```

Each entry selects one file. Use the optional `turns` value `N`, `N:` or `N:M` for an inclusive range. Without `turns`, Agentpack selects the whole file. Relative paths resolve from the manifest directory. Use separate entries for disjoint ranges or phases. Agentpack rejects requests that repeat across entries, including copied exports.

A manifest accepts up to 32 selections and 1 MiB. Each session file has a 64 MiB limit. File hashes identify the bytes that Agentpack read. Reports exclude transcript content and request identities.

Declare coverage as `partial` or `declared-complete` and add an explanatory note. The declaration does not prove completeness, task completion or quality. Manifest reports do not infer boundaries from Passport dates. Only candidate discovery in `usage link` uses those dates as suggestions. `--manifest` does not read or change the Passport. Session cost estimates stay separate. Agentpack does not add them up as task cost.
