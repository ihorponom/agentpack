# Manual CLI and Fallback

## Default workflow

Use MCP for the default workflow. Generated project instructions tell supported
clients when to load context, record task state and save checkpoints.

Use the CLI to inspect state, troubleshoot MCP, run demos or prepare a manual
handoff. Manual handoffs also support web chats without local stdio MCP.

Run `agentpack <command> --help` to see command-specific help. Help works without
a `.agentpack/` directory and does not execute the command.

Run `agentpack init` to create a local ledger. In a Git repository, this command
adds local Agentpack paths to `info/exclude`. It leaves `.gitignore` unchanged.
Outside Git, initialization succeeds, but `doctor` warns that Git excludes
are unavailable.

Run `agentpack install <target>` to configure a client. For Claude Desktop,
`agentpack install claude-desktop --write` saves local recovery files and merges
the server entry into the existing macOS configuration. Installers use a lock
and check for external changes before atomic replacement. They do not lock
other applications. Without `--write`, installation changes no files.

The `codex`, `claude`, and `cursor` installers include an optional builder.
The agent announces delegated work before using it. Installers preserve existing
Claude/Cursor builders. Codex updates only its managed block. Claude Desktop
and git-hooks do not install builders. See
[integration details](INTEGRATIONS.md#optional-builder) for setup and reinstall rules.

## Inspect State

```bash
agentpack resume --preset agent --query "MCP install"
agentpack source status
agentpack source status --changed
agentpack source status --missing
agentpack ledger status
agentpack tui
agentpack ledger compact [--write]
agentpack doctor
agentpack replay
agentpack diff
agentpack release preflight
```

Run `resume --preset agent` to inspect the current task and ledger context.
The output includes the goal, status, next actions, Git state, decisions, dead
ends, evidence and source-cache guidance. An approximate token budget limits
the output.

Run `source status` to check recorded files. The result marks each file as
unchanged, changed or missing. Hash comparison checks the file, not the recorded
conclusion. Use `git status` to inspect working-tree changes. Use `--changed`
or `--missing` to filter source records.

If a recorded file changes, read it again. Check the recorded conclusion before
you update its summary:

```bash
agentpack source review src/checkout.ts --summary "Checkout totals still flow through calculateTotals; tax handling moved into normalizeLineItems."
```

Remove source records when their files are deleted or their conclusions are
no longer useful:

```bash
agentpack source prune --missing
agentpack source remove docs/old-file.md
```

Use `source prune --missing` to remove records for deleted files. Use
`source remove <file>` to remove one selected record.

Run `ledger status [--json]` to inspect task counts, file sizes, evidence
references and source-cache status. The command does not change the ledger.
The optional `ceremonyDiagnostics` output lists patterns for review. Malformed
event lines are skipped and reported in `warnings`.

Run `tui` to open the read-only Inspector. It shows Tasks, Passport, Timeline,
Evidence, Checkpoints, Health and Usage. It does not switch tasks or change
ledger files. Without a TTY, it prints a snapshot and exits. The initial
inventory has size limits. Timeline and Evidence load on demand. For a full
ledger inventory, use `ledger status`. See [TUI.md](TUI.md) for controls and limits.

Run `ledger compact [--write] [--purge] [--keep-checkpoints <n>] [--evidence-age-days <n>]`
to inspect a compaction plan. By default, the plan selects:

- `diff.patch`, `git-status.txt` and `resume.md` from checkpoints older than
  the newest 30. It keeps every `checkpoint.json`.
- Superseded source-cache events in `events.jsonl`. It keeps the current
  conclusion for each live path. `sources.json` remains authoritative.
- Unreferenced evidence files older than 30 days.

Compaction preserves decisions, dead ends, referenced evidence and checkpoint
metadata. Timeline and replay remain available.

Use `--write` to move selected data into `.agentpack/archive/`. Use `--purge`
to delete it instead. If staging or an archive move fails, Agentpack restores
the original event log and files. Archive destinations must be ordinary
directories inside `.agentpack/`. Symlinked destinations are rejected.

Compaction preserves the `events.jsonl` format and records a `ledger-compact`
event. If the event log or checkpoint count grows large, `doctor` suggests
compaction.

Run `doctor` to check ledger setup, client configuration, native Codex/Cursor
gates, Git availability and source-cache status.

For gate launchers, `doctor` checks the generated command format, accessible
non-empty Node/Agentpack files, package identity, CLI entrypoint and version.
It accepts structurally compatible stable launchers in the `>=1.2.0 <2.0.0`
range. It does not execute the configured command. Missing, moved, malformed
or incompatible launchers produce a warning with a reinstall command.

Changed or missing source records produce warnings. They do not indicate
setup failure. Before a release handoff, inspect them with
`agentpack source status --changed --missing`.

Run `release preflight` to check local release metadata and Trusted Publisher
configuration. The read-only report includes manual release commands. It does
not push, tag, publish or create GitHub Releases.

## Task Passports

Task Passports store task state under `.agentpack/tasks/`. Use these commands
to create and inspect a Passport:

```bash
agentpack task start "Fix checkout discount bug" \
  --objective "Make discount totals consistent across cart and checkout" \
  --write-scope src/checkout.ts \
  --write-scope src/cart.ts
agentpack task update \
  --next "Run focused regression tests" \
  --write-scope tests/checkout.test.ts \
  --risk medium
agentpack task list [--scope <path>] [--status <status>] [--open] [--all]
agentpack task status [--id <id>] [--full]
agentpack task verify --status passed --evidence evt_... --summary "Focused checks passed"
agentpack task handoff
agentpack task finalize
```

Use repository-relative paths for write scopes. `.` selects the repository
root. A directory such as `api` includes every file under `api/`.

`task list` shows each task's scope. Use `task list --scope api` to select
tasks whose primary scope overlaps that path. Tasks without a matching scope
are excluded. Repeat `--scope` to combine filters with OR. `--scope .` selects
every task with a primary write scope. Filters ignore leading `./` and trailing
slashes. Empty `--scope` values are rejected.

On an active task, use repeatable `--repository <json>` arguments to include
additional checkouts without creating another ledger:

```sh
agentpack task update \
  --repository '{"id":"web","worktree":"../web","writeScope":["src","tests"]}'
agentpack task list --scope web:src
```

The same argument is available on `task start`. Local scope updates append;
the first local binding after import uses only its supplied scope. Unqualified
scope filters select primary; `id:path` selects an additional checkout. See
[repository bindings](TASK-PASSPORT.md#changes-across-repositories) for checkout,
verification and import rules.

By default, `task list` shows active, parked, blocked and verifying tasks.
`--open` selects the same set. The output reports how many closed tasks are
hidden. Use `task list --all` to include completed and abandoned tasks.

Use `task list --status <status>` to select statuses. Repeat `--status` to
combine statuses with OR. Unknown values are rejected. Do not combine `--open`
with `--status`, or `--all` with either option.

Status and scope filters combine with AND. For example,
`task list --open --scope api` selects open tasks that own `api`. Use `--all`
or `--status completed` to inspect closed Passports.

Use this task workflow:

1. Run `task start` to declare the work.
2. Run `task status` to inspect the current task.
3. Use `task update` to keep the objective, scope, risk and next actions current.
4. Keep `task verify` pending while edits continue.
5. Record intermediate check results as evidence or checkpoints.
6. When edits end, record the final verification result and its bound HEAD.
7. Run `task handoff` to prepare a summary for another session or client.
8. Run `task finalize` to close the verified task.

Use `task status --id <id>` to inspect another Passport without switching tasks
or changing ledger files. The report includes its objective, constraints, next
actions, blocked reason, verification, bound HEAD and diagnostics. It labels
the actual current task separately.

List options on `task update` append values. Use `--clear-next-actions` to
replace next actions with the supplied `--next` items. Without `--next`, it
clears the list. Use `--replace-constraints` to replace constraints. The task
history retains removed constraints.

`task handoff` includes the latest task-linked checkpoint when available.
`task finalize` reports uncommitted in-scope changes, remaining next actions,
missing checkpoints and incomplete verification evidence. These advisories
do not block finalization.

When work is deferred so another task can become current, use `task park`
instead of `task finalize`. Parking preserves unfinished work; finalization
closes a verified task.

Use `agentpack task --help` for the task-focused command list.

If the current task is active, blocked or verifying, park or close it before
you start unrelated work. `task start` does not replace these tasks. Invalid
risk values are rejected.

Run `task audit [--json]` to check task continuity. It reports branch/HEAD
drift, missing next actions, open verification, closed-task anomalies, stale
source records and incomplete verification evidence.

For low-risk work, provide a readable note or useful test output. State the
check, result and relevant limits. No labels or minimum length are required.
Empty, unreadable, generic or HEAD-only evidence produces an advisory.

For code scopes, include a `Reviewed HEAD` that matches the Passport-bound SHA
or its full 40-character form. For medium/high risk, provide independent
read-only review and a named negative, differential, operational or rollback
check. Classify contract changes as medium/high risk.

After risk calibration, the audit identifies missing or malformed labels in
the best incomplete evidence item. It includes a template. These checks assess
evidence structure, not technical correctness. They do not block task actions.
Metadata warnings appear separately. The `ceremonyDiagnostics` field lists
bounded review candidates; it does not report lifecycle violations or savings.

`task gate [--file <path> ...] [--staged] [--repository <id>] [--json]`
checks task lifecycle, scope and branch drift without reading the event log.
`gateMode` in `.agentpack/config.json` controls the result: `warn` (default)
prints findings and exits 0; `block` exits 2 on violations; `off` disables checks.
Branch drift remains advisory. Without a ledger, the gate exits 0 silently.
HEAD drift is reported by `task audit`.

`--staged` checks all bound indexes. `--repository <id>` selects one index;
`primary` selects the ledger checkout. Explicit file paths remain relative to
the ledger root or absolute. Ordinary staged paths follow nested binding scopes;
Git-link pointer updates use the parent scope. External hooks must invoke the
selected ledger explicitly.

`--client claude|codex|cursor` reads native hook JSON from stdin. Claude and Codex
receive deny or additional-context output; Cursor receives deny in block mode
or silent allow in warn mode. The Codex adapter checks every `apply_patch` add,
update, delete and move path.

Unreadable configuration blocks checks. An unreadable Passport or unrecognized
hook payload is a violation; unknown gate modes fall back to `warn`. Paths outside
primary and all declared bindings produce an advisory `outside-root` finding.
Lifecycle and branch/scope advisories are suppressed for untouched ledgers;
invocations without paths retain those checks. A task without a primary scope
gets a `no-write-scope` advisory when primary scope checking applies.

Scopes use literal path prefixes. Additional bindings check lexical and physical
paths, including symlink aliases. Case-only aliases on case-insensitive filesystems
are not detected. The gate is a task guardrail, not a filesystem security boundary.

Checkpoint context in `task handoff` and bundles contains one redacted summary,
timestamp, id and origin task/Git ref, limited to a 2 KiB serialized record with
explicit truncation. A local linked checkpoint takes precedence over imported
bundle context. Global checkpoints, checkpoint snapshots, and ledger-level
status/next actions are excluded. Import retains historical context without
creating a local checkpoint or changing local task verification. Bundles with
no checkpoint field remain valid. See [Task Passport](TASK-PASSPORT.md#portable-bundle-contract)
for bundle provenance and compatibility details.

`task status` prints one state line. Use `task status --full` for details.
Use `task status --id <id>` for read-only inspection of a selected Passport.
Task updates return lifecycle state, verification status and the first next
action on one line. Request status again when you need more detail or a fresh
check. Group related changes in one `task update` call.

Run `task passport` to print the current `passport.json`. Run `task switch <id>`
to select another open Passport. Pending or unknown verification resumes as
`active`. A final verdict resumes as `verifying` and retains its frozen HEAD.
Return verification to pending before further edits.

Use `task block --reason <text>`, `task park` or `task close` to change lifecycle
state explicitly. `task update-verification` is a compatibility alias for
`task verify`.

Use `task switch <id> --park-current` to park a different current open task
and select the target. The command validates the target before changes. It
preserves verification states and frozen HEADs. Ordinary transaction write
failures roll back. The flag takes no value. Without it, park or finalize the
current open task before switching.

If unfinished work remains, use `task park`. `task finalize --status accepted`
rejects tasks with remaining next actions. Use `--force` only when you accept
the task as complete and retain those actions as history.

Repeating an identical `task verify` update adds no task event.

New `--evidence` IDs on `task verify` and `task finalize` must match recorded
evidence events in the bounded recent event-log window. An unknown ID rejects
the command before any Passport or event change. Errors name missing ID-shaped
values and count other invalid values. Already linked IDs remain valid after
their events leave that window. Older Passport links remain readable.

A final `task verify` result names the bound HEAD and freezes code changes.
Pending verification keeps the task active. `task finalize` reports the bound
HEAD and completed state. It preserves an existing final-verdict binding.
If verification was non-final, direct finalization binds the live HEAD.

If a current Passport exists, `resume` and MCP `load_context` use its status
and next actions in Current State. They include the Passport before the
ledger context. Without a current Passport, they use legacy ledger-level
status and next actions. Both commands build the same resume. Use one command
for each query and budget.

## Record Durable State

Record decisions, findings and evidence needed to continue the task. Use these
commands for durable state:

```bash
agentpack record decision "Use project-local MCP config instead of editing global config automatically"
agentpack record dead-end "GUI apps may not inherit shell PATH for MCP launchers." --reason "Cursor and Claude Desktop can start outside the login shell"
agentpack source add src/integrations/install.ts --summary "Install flow writes project-local client config and generated agent instructions."
agentpack evidence add --kind test-output --file test.log
agentpack checkpoint -m "MCP install tested" --status "Ready for docs polish" --next "Update integration docs"
```

Use `agentpack run "npm test"` to run the command and capture its output as evidence.

## Web-Chat Handoff

If MCP is unavailable, export a markdown handoff. Paste the result into the
next chat:

```bash
agentpack export --to markdown --preset chat --query "MCP install"
```

Use a local export name with letters, numbers, `.`, `_` or `-`. Filesystem
paths are not accepted. Output stays under `.agentpack/exports/`.

Use MCP and `resume --preset agent` for clients with local MCP access. Use
markdown export for clients without that access.

## Structured Bundles

Use a structured bundle to move one task between workspaces:

```bash
agentpack bundle export --task current --output checkout.agentpack-bundle.json \
  --source src/checkout.ts
agentpack bundle inspect checkout.agentpack-bundle.json [--json]
agentpack bundle import-plan checkout.agentpack-bundle.json [--as-new] [--json]
agentpack bundle import checkout.agentpack-bundle.json [--write] [--as-new] [--json]
```

`bundle export` writes one redacted, deterministic JSON file. It contains a
portable Passport, handoff, selected source conclusions and referenced text/JSON
evidence. Markdown `export` remains a separate command.

Select a new repository-relative output file outside `.agentpack/` and `.git/`.
Export rejects existing files and paths that escape through parent traversal
or symlinked directories.

`bundle inspect` validates and summarizes a bundle without requiring an
initialized ledger.

`bundle import-plan` validates the bundle. It compares the task id and retained
bundle digest with the destination. The result is create, idempotent or
conflict. The command is read-only and works before `agentpack init`. JSON
output includes an empty write set.

By default, `bundle import` also returns a read-only plan. If the destination
ledger is initialized, use `--write` to apply the validated plan. The imported
task starts parked with local verification `unknown`. The current-task pointer
does not change. Task-id conflicts reject the import unless you pass `--as-new`.
Repeated imports of the same bundle are idempotent.

Import holds one ledger lock and rolls back write failures. It reuses evidence
with matching id and digest. Collisions receive new ids. A source conclusion
is added only if the destination file hash matches. Existing local conclusions
take precedence. Missing or changed files are reported and skipped. The
retained bundle and import manifest record created, reused, remapped and
skipped records.

See [TASK-PASSPORT.md](TASK-PASSPORT.md) for the bundle schema, inclusion rules,
security boundaries, and collision behavior.

## Budgets

Use `--budget` to limit the approximate local token estimate. The estimate
does not exceed the selected budget. Presets are:

- `1200`: quick context
- `4000`: compact manual handoff
- `8000`: deeper coding-agent handoff
- `16000`: large debugging session or review

Use `--query` to filter Source Cache locally. Matching sources retain full
summaries and snippets. Other sources appear as compact path/status/topic/
guidance entries. Changed or missing files retain warning entries. Inspect
them with `agentpack source status --changed --missing`.

If no source matches, all recorded sources appear as compact entries. To see
the full Source Cache, rerun without `--query`.

## Local Usage Reports

### By task

```bash
agentpack usage report                      # current task
agentpack usage report <task-id>            # any Task Passport (or --task <task-id>)
agentpack usage link <task-id>              # list candidate sessions
agentpack usage link <task-id> --pick 1,3   # or session ids
```

The task id defaults to the current Passport. Use `current`, a positional id
or `--task` to select a task explicitly.

A session is traced when its own Agentpack tool output starts the task,
switches to it or identifies it as current in `load_context`/`resume`. Prose
and quoted history do not establish a trace. Traced sessions and their
subagents, including Codex child threads, are included automatically.

Link other sessions once per task. Links are stored in
`.agentpack/usage/<task-id>.json`. Reading a report changes no files. Traced
sessions cannot be unlinked.

A task report counts requests made while that Passport was current. Lifecycle
events define the periods: `task start` or `task switch` begins a period;
`task park`, `task close` or `task finalize` ends it. Older tasks without
lifecycle events use creation and closure times.

Shared sessions are split by time. Per-task totals do not overlap. A subagent's
whole session belongs to the task current at its start. Requests without
timestamps are omitted from attribution and counted as omissions.

If no sessions are traced or linked, `usage report` lists candidates.
`usage link` always lists them. Candidates are Claude Code transcripts, their
subagents and Codex rollouts from the task worktree. Each has usage attributed
to the task. The list shows a stable session id, `[traced]` status and
the number of requests attributed to the task.

Untraced candidates do not contribute usage until you link them with `--pick`.
The report warns how many remain unlinked. `--pick` accepts list numbers or
session ids. Use ids in scripts because list numbers can change between calls.
`--json` output includes `kind`. The supported shapes are:

- `task-usage-candidates`: `taskId`, `linked`, `intervals` (`from`, `to` or
  null while current), `searched`, `warnings`, `candidates` (`number`, `id`,
  `client`, `file`, `subagent`, `started`, `requests`, `taskRequests`,
  `traced`, `linked`)
- `task-usage-report`: `version`, `taskId`, `manifest` (`path`, `sha256`),
  `coverage`, `requests`, `totals`, `agentpackOverhead`,
  `agentpackOverheadBeforeActivation`, `slices` (`phase`, `report`; traced
  sessions use phase `traced`), `billedUsd` (always null), `warnings`. For
  `--task`, `manifest` describes the effective selection of linked plus
  traced sessions.
- `task-usage-link`: `taskId`, `linked` (file names), `report`;
  `task-usage-unlink`: `taskId`, `removed`, `remaining`

Discovery reads `$CLAUDE_CONFIG_DIR` (default `~/.claude`) and `$CODEX_HOME`
(default `~/.codex`). It parses sessions updated after the task started. It
checks at most 200 sessions per client and Codex day directories within the
last 120 days of the task. It warns when a limit applies. Unreadable sessions
and files larger than 64 MiB are skipped with warnings. Text output shortens
the home directory to `~`. `--json` retains absolute paths.

```bash
agentpack usage link --task <task-id> --client claude --file /path/to/session.jsonl --turns 4: --phase review
agentpack usage link --task <task-id> --coverage declared-complete --note "Main and review sessions"
agentpack usage unlink --task <task-id> --file <session-id or path>
```

Use `--client`/`--file` to link one source. Use `--turns` to narrow its selection
within the task's periods. Linking the same file again replaces its selection.
Use `--phase` to label linked sources. The default phase is `main`.

Coverage starts as `partial`. After sources are linked or traced, use
`--coverage` with `--note` to declare coverage.

Each link is validated against the combined report before it is saved. Sources
without applicable usage are rejected. This includes wrong-client files,
non-transcripts and sources with no requests while the task was current.
Requests repeated across sources count once and produce a warning. Explicit
`--manifest` files reject overlapping selections. The Usage tab in
`agentpack tui` shows the same report or candidate list.

### Direct sources

```bash
agentpack usage report --client codex --file /path/to/rollout.jsonl --task "Fix retries"
agentpack usage report --client claude --file /path/to/session.jsonl --json
agentpack usage report --client codex --file /path/to/rollout.jsonl --by-turn
agentpack usage report --client codex --file /path/to/rollout.jsonl --turns 4:5 --by-turn
agentpack usage report --client codex --file /path/to/session.jsonl \
  --from 2026-10-02T09:00:00Z --to 2026-10-02T10:00:00Z
```

Direct reports work without `agentpack init`. They read only the supplied
local JSONL files, up to 64 MiB each. They print aggregate usage and provenance
without writing files or ledger records. Repeat `--file` for more sources from
the same client, including child sessions. The task label is descriptive. It
does not activate or modify a Passport.

Direct reports and each task slice include additive `agentpackOverhead` JSON:
`calls`, estimated `responseTokens`, `rereadTokensUpperBound`,
`outputTokensUpperBound`, `unattributedResponses`, and `byTool` rows with the
same per-tool counts and estimates.

Calls are recognized for `agentpack` and installer-generated
`agentpack-<repo-name>` servers. Other MCP servers are excluded. Response tokens
are estimated from visible transcript characters divided by four, rounded up.
The reread upper bound multiplies each response estimate by later selected
requests in that source. Compaction or truncation can reduce actual rereads.
The output upper bound counts model output once per request with observed
Agentpack calls. It includes other output from those requests.

For Codex code-mode, completed nested MCP events identify calls, including
dynamic invocations. Printed result text contributes to response size.
Unprinted or very short results do not. Direct-call completion events are not
counted again. A nested event must match exactly one open wrapper. Otherwise,
it is excluded from the call count and increments `unattributedResponses`.

Without nested events, attribution uses identifiable result blocks. Source
expressions alone do not prove execution. Repeated prints contribute to
response size. Identical calls or transformed results can remain ambiguous.
Unresolved wrappers increment `unattributedResponses`. Separate Agentpack
results can be measured when `functions.exec` also runs shell commands.
Attribution uses output signatures and tool names. Shell output that mimics a
result can remain ambiguous. An empty JSON list does not identify its source.

These fields contain no transcript content. They do not measure tool schemas,
exact tokenizer usage, cache billing or money. Task reports sum estimates from
selected sources. Source coverage limits still apply.

Task reports also include `agentpackOverheadBeforeActivation` with the same
shape. It uses the same source files. Its calls and response tokens cover the
preceding period when no task was current. This includes the activating `task_start` or `task_switch` call
and orientation calls such as `load_context`. Calls made while another task
was current remain attributed to that task.

Its reread bound includes earlier Agentpack responses over this task's selected
requests. Those responses can come from the preceding gap or another task's
period. Each request's reread belongs to the task that owns the request.
Carried-in tools appear in `byTool` with zero calls.

This field is separate from `agentpackOverhead` and the totals. It is omitted
for subagent sessions. If another task's periods cannot be read, the field is
zero and the report warns.

Use `--by-turn` to add source-local turn rows. Each row includes start time,
request count, token categories, completion and available duration.

Use `--turns N`, `--turns N:` or `--turns N:M` to select an inclusive range.
`N:` continues to the last turn. Turn selection requires exactly one source
file. A turn represents a user interaction, not one model request or an
inferred work phase.

Codex uses client start/complete records for turn boundaries. Claude uses
recorded user-message boundaries and excludes tool results and metadata.
Missing boundaries are reported. Incomplete Codex turns have no duration.
Claude completion and duration remain unknown.

Durations include tools and waits. Timestamp filters suppress duration when
they select only part of a turn. Turn selection also suppresses session
monetary estimates.

Connected agents can use the read-only `usage_report` MCP tool. It accepts
`client`, `files`, `byTurn`, `turns`, `from`, `to`, `task` and `json`. With
`client`/`files`, `task` is only a descriptive label. CLI and MCP share the same
calculations and formatting.

Supported records are Codex `token_usage_record` and Claude Code assistant
messages with usage counters. Repeated request/message identifiers count once.
Conflicting counters reject the report. Claude content-block snapshots retain
the highest output count for each message.

Codex cumulative counters are not added again. Unbounded source totals are
checked against the final available thread counter, including reasoning.
Without reasoning counters, the full comparison is unavailable. Counter
resets and incomplete sources produce mismatch reports. Reports show counts
of malformed or invalid records without copying their contents.

Input includes cache read/write. Reasoning, when present, is part of output.
The report preserves these categories and groups requests by model. Missing
reasoning counters remain unknown.

Use timestamps with an explicit timezone for `--from` and `--to`. `--from`
is inclusive; `--to` is exclusive. Filters use usage-record timestamps. If a
boundary is supplied, records without usable timestamps are omitted and counted.
These timestamps select requests. They do not measure continuous execution-time
billing.

When pricing is known, Claude `cost-state` snapshots appear as separate
client-session estimates for each source. They can cover more work than visible
message counters. Do not sum estimates from overlapping sessions. Time filters
suppress these estimates because cumulative cost cannot be assigned to the
selected range. Actual charges remain unknown. The report does not guess model
rates or request them from the user.

Supply every source needed for the selected work boundary. A transcript alone
does not prove task coverage or completion. Direct reports do not discover
child sessions or other clients. Supported clients are Codex and Claude Code.
No account connections, background collection or telemetry are required.

```bash
agentpack usage report --manifest .agentpack/usage/task-example.json --by-turn
```

Use `--manifest` to report the exact selections in a manifest without Passport
attribution. Use `--task` to apply the task's current periods to its linked
manifest. Do not combine `--manifest` with `--client`, `--file`, `--task`,
`--from`, `--to` or `--turns`. It accepts `--json` and `--by-turn`.

Task mapping uses an explicit local manifest:

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

Each source selects one file. Use optional `N`, `N:` or `N:M` turns for an
inclusive range. Without `turns`, the whole source is selected. Relative source
paths resolve from the manifest directory. Use separate entries for disjoint
ranges or phases. Repeated requests across entries are rejected, including
copied exports.

A manifest accepts up to 32 selections and 1 MiB. Each source has a 64 MiB
limit. Source hashes identify the bytes read. Reports exclude transcript
content and request identities.

Declare coverage as `partial` or `declared-complete` and provide an explanatory
note. The declaration does not prove completeness, task completion or quality.
Manifest reports do not infer boundaries from Passport dates. Only
`usage link` candidate discovery uses those dates as suggestions. `--manifest`
does not read or modify the Passport. Session monetary estimates remain
separate and are not summed as task cost.
