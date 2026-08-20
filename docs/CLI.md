# Manual CLI and Fallback

Agentpack's default workflow is MCP-connected: generated project instructions guide Codex, Claude Code, Cursor, and other MCP clients to load context, record durable task state, and checkpoint progress while they work.

Use the CLI directly when you want to inspect state yourself, debug an MCP setup, run a demo, or create a manual handoff for a web chat that cannot connect to local stdio MCP.

Use `agentpack <command> --help` for command-specific help. These help screens do not require an initialized `.agentpack/` directory and do not execute the command.

`agentpack init` only initializes the repo-local ledger. Client integration
remains explicit through `agentpack install <target>`. In particular,
`agentpack install claude-desktop --write` writes its local recovery files and
merges the repo-specific server entry into the existing macOS Claude Desktop
config. Agentpack installers serialize through a lock and check external drift
immediately before atomic replacement; this is optimistic conflict detection,
not a lock on actively rewriting third-party processes. The dry-run form does
not change either local or global files.

## Inspect State

```bash
agentpack resume --preset agent --query "MCP install"
agentpack source status
agentpack source status --changed
agentpack source status --missing
agentpack ledger status
agentpack ledger compact [--write]
agentpack doctor
agentpack replay
agentpack diff
agentpack release preflight
```

`resume --preset agent` shows the current goal, status, next actions, git state, durable decisions, dead ends, evidence, and source-cache guidance under a rough context budget.

`source status` tells you which recorded source conclusions are still valid and which files need to be reopened. It compares current file content to the hash recorded with the source conclusion; it is not a replacement for `git status`. Use `--changed` or `--missing` to focus triage on stale records.

Changed source records require semantic review, not hash-only refresh. After reopening a changed file and confirming the durable conclusion, update the record with a fresh summary:

```bash
agentpack source review src/checkout.ts --summary "Checkout totals still flow through calculateTotals; tax handling moved into normalizeLineItems."
```

To clean up stale source-cache entries after files are deleted or conclusions are no longer useful:

```bash
agentpack source prune --missing
agentpack source remove docs/old-file.md
```

`source prune --missing` only removes records whose files no longer exist. `source remove <file>` removes one explicit source record.

`ledger status [--json]` prints a read-only hygiene inventory: task counts, event/evidence/checkpoint/export sizes, referenced evidence counts, and source-cache status counts. It does not delete, compact, archive, or refresh anything. When conservative observable patterns merit human attention, its additive `ceremonyDiagnostics` output lists bounded review candidates; malformed retained event lines are skipped individually and reported in `warnings`.

`ledger compact [--write] [--purge] [--keep-checkpoints <n>] [--evidence-age-days <n>]` keeps the ledger from growing unbounded. It slims checkpoints beyond the newest 30 (their `diff.patch`, `git-status.txt`, and `resume.md` move out; `checkpoint.json` always stays, so the timeline and replay are unaffected), moves superseded source-cache events out of `events.jsonl` (the current conclusion per live path stays; `sources.json` remains authoritative), and moves unreferenced evidence files older than 30 days. Decisions, dead ends, referenced evidence, and checkpoint metadata are never touched — that is the durable memory. Dry-run by default; `--write` moves data into `.agentpack/archive/` where it stays inspectable; `--purge` deletes instead of archiving. Applied compaction is transactional: if staging or an archive move fails, Agentpack restores the original event log and files. Archive paths must remain ordinary directories inside `.agentpack/`; symlinked archive destinations are rejected. The `events.jsonl` format does not change, and each successful compaction is itself recorded as a `ledger-compact` event. `doctor` suggests compaction when `events.jsonl` or the checkpoint count grows large.

`doctor` checks pack setup, local integration config (including native Codex and Cursor task gates), git availability, and source-cache health. It warns when an MCP integration exists but its native gate is missing or still points at an older Node/Agentpack launcher. Changed or missing source records are warnings, not setup failures; use `agentpack source status --changed --missing` to review details before a release-like handoff.

`release preflight` prints a read-only release-prep report and checklist for
this repo. It checks local release metadata and Trusted Publisher wiring, then
prints the manual release-prep commands. It does not push, tag, publish, or
create GitHub Releases.

## Task Passports

Task Passport support is the first step toward task-scoped handoffs. The current CLI can create and inspect a local passport under `.agentpack/tasks/`:

```bash
agentpack task start "Fix checkout discount bug" \
  --objective "Make discount totals consistent across cart and checkout" \
  --write-scope src/checkout.ts \
  --write-scope src/cart.ts
agentpack task update \
  --next "Run focused regression tests" \
  --write-scope tests/checkout.test.ts \
  --risk medium
agentpack task list [--scope <path>] [--status <status>] [--open]
agentpack task status
agentpack task verify --status passed --evidence evt_... --summary "Focused checks passed"
agentpack task handoff
agentpack task finalize
```

Write scopes are repo-relative paths. `.` means the repository root. A directory entry such as `api` covers every file under `api/`, so a scope can pin a task to one part of the project without enumerating files. `task list` shows each task's scope so short scoped tasks are easy to tell apart, and `task list --scope api` filters the list to tasks whose scope overlaps that path; tasks without a write scope are omitted from filtered output. Repeating `--scope` unions the filters, `--scope .` matches every scoped task, and leading `./` or trailing slashes are normalized on both sides; an empty `--scope` value is rejected.

`task list --open` hides closed history and shows only active, parked, blocked, and verifying tasks. `task list --status <status>` filters to specific statuses; repeating `--status` unions them, unknown values are rejected, and `--open` cannot be combined with `--status`. Status filters combine with `--scope` as AND, so `task list --open --scope api` means open tasks that own `api`. The default output still lists everything: closed passports remain inspectable history.

The common workflow is:

1. `task start` declares the work.
2. `task status` gives a quick current-task view.
3. `task update` keeps objective, scope, risk, or next actions current. List flags append; `--clear-next-actions` replaces the next actions with the provided `--next` items (or empties the list) when the plan went stale.
4. Keep `task verify` pending through the active fix loop; aggregate intermediate checks as evidence/checkpoints, then record a final result and its bound HEAD only when edits end.
5. `task handoff` prints the compact summary for another chat, client, worktree, or agent.
6. `task finalize` closes the task after verification is final. It prints advisories when hygiene gaps remain — uncommitted changes inside the write scope, remaining next actions, or no checkpoint since the task started; advisories never block.

When work is deferred so another task can become current, use `task park`
instead of `task finalize`. Finalization is the end-of-task ritual; parking is
the pause-and-switch ritual.

Use `agentpack task --help` for the task-focused command list.

`task start` refuses to replace an active, blocked, or verifying current task; park or close the current task first when starting unrelated work. Invalid risk values are rejected instead of being treated as unknown.

`task audit [--json]` checks the current passport for branch/head drift, missing next actions, open verification, closed-task anomalies, and source-cache metadata drift. Metadata warnings are shown separately so they do not look like action-required task failures. Its additive `ceremonyDiagnostics` field only reports bounded review candidates, never lifecycle violations or claimed savings.

`task gate [--file <path> ...] [--staged] [--json]` is the fast pre-edit/pre-commit check: it reads only the current passport and light git state, then reports lifecycle violations (no active task; task parked, blocked, verifying, or closed), files outside the declared write scope, and branch drift. It never reads the event log. Behavior follows `gateMode` in `.agentpack/config.json`: `warn` (default) prints findings and exits 0, `block` exits 2 on violations (branch drift stays advisory), `off` disables the gate. Without `.agentpack/`, `task gate` exits 0 silently so hooks are safe to install in any repo. `--staged` checks the files staged in git. `--client claude|codex|cursor` reads the matching native pre-tool hook payload from stdin and returns that client's hook JSON: Claude and Codex receive a deny or additional-context response; Cursor receives `permission: "deny"` in block mode and a silent `permission: "allow"` in warn mode because Cursor only guarantees agent feedback for denied actions. The Codex adapter checks every path named by an `apply_patch` add, update, delete, or move directive. Head drift is intentionally left to `task audit` because every commit moves HEAD during normal work.

The gate fails closed where it matters: an unreadable `config.json` blocks instead of throwing a skippable hook error, an unreadable current passport is a violation (exit 2 in block mode), an unrecognized native hook payload produces `hook-input-unreadable` instead of silently skipping path checks, and an unknown `gateMode` value falls back to `warn` with an `invalid-gate-mode` finding instead of silently disabling checks. Paths outside the repository are not judged by this pack's gate but are reported with an advisory `outside-root` finding rather than skipped silently; when every checked path is outside the repository, or a `--staged` run stages nothing under this pack root, lifecycle findings are skipped too, and so are the `no-write-scope` and `branch-drift` advisories — the gate protects repo code, not the whole filesystem, and an untouched pack should not get spammed on every unrelated commit in a multi-pack repo. Invocations with no paths keep lifecycle checks and advisories (they back the MCP gate-warnings layer). In block mode, a task without a write scope gets an advisory `no-write-scope` finding, because scope enforcement is opt-in per task. Scope matching is lexical and byte-literal, the same as git paths: the gate does not resolve symlinks and does not detect case-only aliasing on case-insensitive filesystems. It is a guardrail against agent drift, not a filesystem security boundary.

`task passport` prints the current `passport.json`. `task switch <id>` points the worktree at another open passport: pending or unknown verification resumes as `active`, while a final verdict resumes as `verifying` and remains frozen with its bound HEAD until verification returns to pending. `task block --reason <text>`, `task park`, and `task close` remain available for explicit lifecycle control. `task update-verification` remains available as a compatibility alias for `task verify`.

`task finalize --status accepted` refuses to close a task that still has next
actions, because that usually means the task should be parked instead. Pass
`--force` only when those remaining next actions are intentionally historical
and the task is genuinely accepted as-is.

Repeated identical verification updates are treated as no-ops, so retrying the same `task verify` command does not add duplicate task events.

Final `task verify` output names the bound HEAD and explains that code is frozen until finalization or an explicit return to pending. Pending output says the task remains active for fixes and intermediate checks. `task finalize` reports the bound HEAD and completed/frozen consequence; it preserves an existing final-verdict binding, while direct finalization from non-final verification binds the live HEAD.

When a current passport exists, `resume` and MCP `load_context` treat its status
and next actions as authoritative in Current State, then include the full
passport before the broader repo-level ledger. Without a current passport,
Current State preserves the legacy repo-level status and next-action fallback.

## Record Durable State

Use these commands sparingly. Agentpack is not an activity logger; record the context a future agent would actually need.

```bash
agentpack record decision "Use project-local MCP config instead of editing global config automatically"
agentpack record dead-end "GUI apps may not inherit shell PATH for MCP launchers." --reason "Cursor and Claude Desktop can start outside the login shell"
agentpack source add src/integrations/install.ts --summary "Install flow writes project-local client config and generated agent instructions."
agentpack evidence add --kind test-output --file test.log
agentpack checkpoint -m "MCP install tested" --status "Ready for docs polish" --next "Update integration docs"
```

For command output, `agentpack run "npm test"` can capture useful evidence while also running the command.

## Web-Chat Handoff

When MCP is unavailable, export a compact markdown handoff and paste it into the next chat:

```bash
agentpack export --to markdown --preset chat --query "MCP install"
```

The export target is a simple local name (letters, numbers, `.`, `_`, or `-`), not a filesystem path. Output always stays under `.agentpack/exports/`.

For the normal coding-agent workflow, prefer MCP and `resume --preset agent`. Markdown export is a fallback for clients that cannot read local MCP tools.

## Structured Bundles

Structured task bundles are an explicit portability surface for moving one task
between workspaces:

```bash
agentpack bundle export --task current --output checkout.agentpack-bundle.json \
  --source src/checkout.ts
agentpack bundle inspect checkout.agentpack-bundle.json [--json]
agentpack bundle import-plan checkout.agentpack-bundle.json [--as-new] [--json]
agentpack bundle import checkout.agentpack-bundle.json [--write] [--as-new] [--json]
```

`bundle export` writes one redacted, deterministic JSON file containing a
portable passport snapshot, compact handoff, explicitly selected source
conclusions, and referenced text/JSON evidence. The existing markdown `export`
command remains unchanged. The output must be a new repo-relative file outside
`.agentpack/` and `.git/`; export refuses existing files and paths that escape
through parent traversal or symlinked directories.

`bundle inspect` validates and summarizes a bundle without requiring an
initialized pack.

`bundle import-plan` validates the same untrusted bundle, compares its task id
and retained bundle digest with the destination workspace, and reports a
create, idempotent, or conflict outcome. It is read-only, also works before
`agentpack init`, and returns an explicit empty write set in JSON mode.

`bundle import` has the same read-only behavior by default. An explicit
`--write` applies the validated plan to an initialized destination pack. The
imported task is parked, local verification starts as `unknown`, and the
current-task pointer is left unchanged. Task-id conflicts fail closed unless
`--as-new` is passed; repeated imports of the same bundle are idempotent.

Apply runs under one pack lock with rollback on write failure. Imported
evidence is reused by id and digest or remapped on collision. Source
conclusions are added only when the destination file hash matches; existing
local conclusions win, while missing or changed files are reported and
skipped. The retained bundle and sibling import manifest record every created,
reused, remapped, or skipped record.

See [TASK-PASSPORT.md](TASK-PASSPORT.md) for the bundle schema, inclusion rules,
security boundaries, and collision behavior.

## Budgets

`--budget` is a hard ceiling for Agentpack's approximate local token estimate. The presets are:

- `1200`: quick status ping
- `4000`: compact manual handoff
- `8000`: deeper coding-agent handoff
- `16000`: large debugging session or review

`--query` locally filters Source Cache: matched sources keep full summaries/snippets, and query-unrelated sources stay visible as compact path/status/topic/guidance stubs. Changed or missing query-unrelated records are warning stubs, not trusted conclusions; run `agentpack source status --changed --missing` for full stale details. If nothing matches, Agentpack keeps compact stubs for all recorded sources and tells you to rerun without `--query` when the full Source Cache is needed.
