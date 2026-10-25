# MCP

`agentpack mcp` starts a local stdio MCP server. It is the main runtime surface
for connected coding agents.

The transport uses newline-delimited JSON-RPC over stdin and stdout. The MCP
client starts Agentpack as a subprocess. Agentpack writes only protocol messages
to stdout. See [Model Context Protocol transports](https://modelcontextprotocol.io/docs/concepts/transports).

## Protocol Compatibility

One process accepts both MCP protocol eras:

- Legacy clients send `initialize` and receive the `2025-06-18` response shape.
- MCP `2026-07-28` clients call `server/discover`, or send a request with the
  protocol version and client capabilities in `params._meta`. Modern responses
  include `resultType: "complete"` and identify Agentpack in
  `io.modelcontextprotocol/serverInfo`.
- Modern results of `server/discover`, `tools/list`, `prompts/list`,
  `resources/list`, `resources/templates/list` and `resources/read` carry
  `ttlMs: 0` and `cacheScope: "private"`. Legacy responses do not have them.
- A modern request for an unsupported version gets error `-32022` with the
  requested and supported versions. Missing modern metadata gets `-32602`.
- A modern `initialize` request and a modern unknown method get `-32601`. A
  legacy unknown method gets `-32000` ("Unsupported MCP method").

Each tool call is self-contained at the MCP layer. Durable task state stays in
`.agentpack/`. Agentpack does not map Task Passports to the MCP Tasks extension.
The server has no remote HTTP transport and no hosted sync.

## Errors

| Case | Result |
|---|---|
| Malformed JSON | Error `-32700`. |
| Invalid request, including a top-level `null` | Error `-32600`. |
| `params` or `arguments` is not an object | Error `-32602`, before the tool runs. |
| A tool fails | JSON-RPC error `-32000` with the message. |
| `record_decision` or `record_dead_end` with a missing, non-string or blank `text` | Tool result with `isError: true`. The ledger does not change. |

The process stays available after an error. A tool with no parameters accepts a
missing `arguments` field. The CLI `record` commands also reject blank text.
Agentpack redacts secret-like values in stored text.

See [JSON-RPC errors](https://www.jsonrpc.org/specification#error_object) and
[MCP tool errors](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling).

## Default Client Loop

The generated instructions for Codex, Claude Code and Cursor tell agents to use
this loop:

1. Call `load_context` with `preset: "quick"` and a focused query.
2. Call `source_status` only when you need a full stale-source check.
3. Record decisions, dead ends, evidence and source conclusions as you work.
4. Keep a review of the current task inside that task.
5. Call `checkpoint` after meaningful progress.
6. Call `task_handoff` before you switch chats, clients, worktrees or agents.
7. Call `task_finalize` when a Task Passport is verified and complete.
8. Call `task_park` when you pause a task only to start unrelated work.

For a small task, attach one aggregated evidence item and save one checkpoint.
Do not repeat `source_status` when a recent `load_context`, `task_audit` or status
check answered the question. Call `record_source` only when the durable
conclusion changed.

The CLI has the same operations. See [CLI.md](CLI.md).

## Tools

The server has 27 tools.

| Group | Tools |
|---|---|
| Context | `load_context`, `resume`, `diff`, `replay`, `checkpoint` |
| Records | `record_decision`, `record_dead_end`, `attach_evidence`, `record_source`, `source_status` |
| Task | `task_start`, `task_status`, `task_list`, `task_switch`, `task_park`, `task_update`, `task_update_verification`, `task_finalize`, `task_handoff`, `task_audit` |
| Bundle | `bundle_export`, `bundle_inspect`, `bundle_import_plan`, `bundle_import` |
| Usage | `usage_report`, `usage_link` |
| Release | `release_preflight` |

### Parameters

All parameters are optional, unless the table marks them required.

| Tool | Parameters |
|---|---|
| `load_context`, `resume` | `query`, `budget` (default 4000), `preset` |
| `checkpoint` | `summary`, `status`, `nextActions` |
| `diff` | `from`, `to` (default: the previous and the latest checkpoint) |
| `replay` | `limit` (default 30) |
| `record_decision` | `text` (required), `files`, `evidence` |
| `record_dead_end` | `text` (required), `reason`, `files` |
| `attach_evidence` | `kind`, `content` or `path`, `command`, `exitCode` |
| `record_source` | `path` (required), `summary`, `snippet` |
| `source_status` | `changed`, `missing`, `json` |
| `task_start` | `title` (required), `objective`, `constraints`, `writeScope`, `repositories`, `nextActions`, `tags`, `risk` |
| `task_update` | `objective`, `constraints`, `writeScope`, `repositories`, `nextActions`, `tags`, `risk`, `clearNextActions`, `replaceConstraints` |
| `task_update_verification` | `status`, `evidence`, `summary` |
| `task_finalize` | `status`, `evidence`, `summary`, `force` |
| `task_status` | `id`, `full` |
| `task_list` | `open`, `all`, `status`, `scope`, `compact`, `limit`, `json` |
| `task_switch` | `id` (required), `parkCurrent` |
| `task_audit` | `json` |
| `bundle_export` | `outputPath` (required), `taskId`, `sources`, `includeEvidence` |
| `bundle_inspect` | `path` (required), `json` |
| `bundle_import_plan` | `path` (required), `asNew`, `json` |
| `bundle_import` | `path` (required), `write`, `asNew`, `json` |
| `usage_report` | `task`, `manifest`, `client`, `files`, `from`, `to`, `byTurn`, `turns`, `json` |
| `usage_link` | `task`, `pick`, `client`, `file`, `turns`, `phase`, `coverage`, `note`, `remove`, `json` |

`task_park`, `task_handoff` and `release_preflight` take no parameters.
`task_update_verification` accepts the `status` values `unknown`, `pending`,
`passed`, `failed` and `accepted`. `task_finalize` accepts `passed`, `failed` and
`accepted`. `risk` accepts `unknown`, `low`, `medium` and `high`.

### Tool Safety Annotations

Every tool has standard MCP `annotations`. A client can use them before it asks
for approval.

- Read-only tools set `readOnlyHint: true`. They are context, status, audit,
  planning, handoff, release preflight, diff and replay tools.
- Append-only tools set `readOnlyHint: false` and `destructiveHint: false`.
  Examples are decisions, evidence, task start, bundle export and bundle import.
- Tools that replace a pointer, a lifecycle state, a checkpoint state, a
  verification, a source conclusion or the linked usage sources set
  `destructiveHint: true`.
- Every write tool sets `idempotentHint: false`. The hint is conservative. For
  example, an identical repeat of `task_update_verification` writes nothing.
- Every tool sets `openWorldHint: false`. The server uses the local pack and
  local client transcripts. It does not contact external services.

The annotations are hints. They do not authorize or sandbox anything. The client
must apply its own approval policy. A write tool stays a write tool even when
one call only plans a change, for example `bundle_import` without `write: true`.

### Context tools

`load_context` and `resume` return the same resume for the same input. Call one
of them, and read again only when the query or the budget must change. The
presets are `quick`, `chat`, `agent` and `deep`. An unknown preset is an error.

When you pass `query`, Agentpack filters the source cache locally:

- Matching source conclusions keep their full summary and snippet.
- Other conclusions show as compact stubs with path, status, topic and guidance.
- A changed or missing stub is a warning, not a trusted conclusion. Call
  `source_status` for details.
- If nothing matches, all conclusions show as stubs. Call again without `query`
  to see them in full.

If a current Passport exists, its status and next actions are the authority in
Current State. Without one, Agentpack uses the legacy repository status and next
actions.

`load_context`, `resume` and `task_status` append a `Gate Warnings` section when
the task gate has findings. This is the client-neutral warning layer of the task
gate. A client needs no hook support to see it. The findings are:

- no current task
- a task that is parked, blocked, verifying or closed
- branch drift, also of an additional repository
- `config-unreadable`
- `invalid-gate-mode`
- `passport-unreadable`, including an additional repository that is unavailable

In `block` mode, `passport-unreadable` blocks. `config-unreadable` always
blocks. The checks and the enforcement modes are in `agentpack task gate`. See
[CLI.md](CLI.md).

Repeated `task_status` calls with no arguments on one connection shorten only an
unchanged branch-drift advisory. They show a reminder that points to the `Drift`
line. The first warning is always full. Context loads always show full
warnings. A change of task, branch, mode or finding, a successful write tool,
initialization or a new connection restores the full text. The server keeps one
fingerprint in memory and writes nothing to the ledger. Lifecycle findings and
hook diagnostics are always complete.

`source_status` accepts `changed`, `missing` and `json`. Pass `{ "changed": true }`
or `{ "missing": true }`, or both, to list only stale source conclusions. This
is the MCP form of `agentpack source status --changed --missing`.

`checkpoint` saves a checkpoint with the Git state and the pack-level status and
next actions. It records the current task id when the task is active, blocked or
verifying.

### Resource and prompts

The resource `agentpack://resume/latest` returns the resume as `text/markdown`
with the default budget of 4000. `resources/read` returns this resume for any
URI. `resources/templates/list` returns an empty list.

| Prompt | Description |
|---|---|
| `agentpack_resume` | Resume work from Agentpack context. |
| `agentpack_checkpoint` | Checkpoint meaningful progress into Agentpack. |

`prompts/get` returns one short instruction for both prompts: load context before
work, and record decisions, dead ends, source conclusions and evidence as you
work.

### Task tools

`task_audit` checks the current Passport for continuity risks:

- a missing or unreadable Passport, or a closed current task
- missing next actions or write scope
- open verification
- branch, HEAD or worktree drift
- repository warnings for additional repositories
- source cache metadata drift
- the advisory about verification evidence that fits the risk

It also shows review candidates. They never block or change state. Pass
`{ "json": true }` for structured output.

`task_handoff` returns the compact handoff of the current Passport. It includes
the latest checkpoint of the task when one exists. That checkpoint is a redacted
summary with time, id and origin task and Git ref, limited to 2 KiB of UTF-8
JSON. `bundle_export` carries it in the optional `checkpoint` field. Global
checkpoints, patches and pack-level checkpoint status are never included. See
[the handoff contract](TASK-PASSPORT.md#handoff).

`task_start` creates a current Passport. It does not replace an active, blocked
or verifying task. Call `task_park` or `task_finalize` first. `close` is a CLI
command only.

`repositories` on `task_start` and `task_update` binds additional repositories:

```json
{
  "repositories": [
    { "id": "web", "worktree": "../web", "writeScope": ["src/features/search"] }
  ]
}
```

Each binding needs `id`, `worktree` and a `writeScope` that is not empty.
Agentpack records the checkout identity, the branch and the full HEAD. An update
needs an active task with unknown or pending verification. An existing scope
appends. The pack root is the implicit `primary` repository. Schema v2 applies
to Passports and bundles that have additional repositories. For the rules, see
[Changes across repositories](TASK-PASSPORT.md#changes-across-repositories).

`task_status` with no arguments returns one compact line. `full: true` returns
the detailed view of the current task. `id: "task_..."` returns a read-only view
of another Passport. It does not switch, park or write anything. The view shows
the objective, constraints, all next actions, the blocked reason, the
verification, the bound HEAD and diagnostics of that task. It labels the
inspected task and the current task separately. Gate warnings always describe the
current task. Agentpack rejects an invalid, missing, corrupt or escaping id. The
tool does not scan the source cache. Use `task_audit` for that.

`task_park` sets the current Passport to `parked`. The verification stays as it
is. Use `task_switch` to resume the task.

`task_list` lists open Passports (active, parked, blocked and verifying) as text
or JSON. A `*` marks the current task. The text tells how many closed tasks are
hidden.

- `all: true` includes closed tasks (`completed` and `abandoned`). It cannot combine with
  `open: true` or `status`.
- `open: true` is the default. It cannot combine with `status`. `open: false`
  removes the restriction.
- `status` is one value or a non-empty array (OR). `scope` is one prefix or a
  non-empty array (OR). The two filters combine with AND.
- A path without a prefix matches primary scopes. `id:path` matches an additional
  repository.
- `compact: true` removes branch and scope from the text. In JSON it removes
  white space and keeps every field. JSON is always an array.
- `limit` is an integer from 1 to 1000. Agentpack applies it after the filters,
  newest first. There is no default limit. The result metadata
  `io.agentpack/taskListPage` has `matched`, `returned` and `omitted`. This is
  not cursor pagination.
- Agentpack skips unreadable Passports and reports warnings in
  `io.agentpack/taskListWarnings`.

`task_switch` makes another open task current. A parked task with unknown or
pending verification resumes as `active`. A parked task with a final verdict
resumes as `verifying`, and code stays frozen until verification returns to
`pending`. A closed task cannot be the target. Without `parkCurrent`, you must
park or finalize an active, blocked or verifying current task first. With
`parkCurrent: true`, the call checks the target, then parks the current task and
switches in one transaction. A switch to the current id parks nothing. Agentpack
keeps the verification and the bound HEAD. It rolls back ordinary write failures
but does not recover from a crash.

`task close` and the full Passport JSON (`agentpack task passport`) have no MCP
tool. `task close` skips the verification check, so only a person should run it.

`task_update` changes the current Passport without a status change.

- List fields append and remove duplicates. `repositories` upsert by id. Omitted
  fields stay.
- `clearNextActions: true` replaces the next actions with `nextActions`, or
  empties them.
- `replaceConstraints: true` replaces the constraints. The removed ones stay in
  the task-update event as `removedConstraints`.
- An empty update or an unknown risk fails.

Put related fields in one `task_update`. Task write tools return one line with
the status, the verification and the first next action. The stored Passport is
complete. Call `task_status` only when you need more detail.

`task_update_verification` sets the verification of the current Passport. Call
it after `attach_evidence`.

- Keep `pending` while you fix problems. Save intermediate checks as evidence or
  checkpoints.
- A final verdict moves the task to `verifying`. The result shows the bound HEAD
  and the freeze.
- `pending` or `unknown` moves the task to `active`. On a blocked task it also
  clears `blockedReason`.
- The call fails on a parked task. Use `task_switch` first.
- An identical repeat call changes nothing and adds no event.

New `evidence` ids on `task_update_verification` and `task_finalize` must match
evidence events in the recent event log. One unknown id rejects the whole update
before anything is written. The error names ids that look like ids and counts the
others. You can repeat ids that are already linked.

`task_finalize` closes the current Passport. It needs a final verdict, or
`status` set to `passed`, `failed` or `accepted`. It also accepts `evidence` and
`summary`. The result shows the bound HEAD and the completed and frozen state. A
final verdict keeps its bound HEAD. Finalization from non-final verification
binds the current HEAD. Finalization with `accepted` fails if next actions
remain, unless `force: true`. Use `task_park` for deferred work.

The result includes the same advisories as the CLI. They never block. They cover
uncommitted in-scope changes, remaining next actions, a missing checkpoint,
repository state and evidence that does not fit the risk. See
[Advisory verification evidence](TASK-PASSPORT.md#advisory-verification-evidence).

### Bundle Tools

The bundle tools use the same validated core as the CLI.

- `bundle_export` writes one task to a redacted `agentpack.task-bundle` file. It
  accepts a task id (default: the current task), `outputPath`, repeatable source
  paths and `includeEvidence`. `outputPath` is a new file, relative to the pack
  root, outside `.agentpack/` and `.git/`. Agentpack rejects existing files and
  symlink escapes.
- `bundle_inspect` validates and summarizes an untrusted bundle. It writes
  nothing.
- `bundle_import_plan` compares an untrusted bundle with the pack. It returns a
  create, idempotent or conflict action, with an empty write set. `asNew`
  previews a new task id.
- `bundle_import` returns the same plan by default. `write: true` applies it to
  an initialized pack. `asNew: true` resolves a task id collision with a
  deterministic new id.

The `path` of `bundle_inspect`, `bundle_import_plan` and `bundle_import`
resolves from the working directory of the server process. This differs from
`outputPath` and from usage file paths, which resolve from the pack root. Use an
absolute path to be safe.

A write import creates a parked task with local verification `unknown`. It keeps
the bundle and an import manifest. It never changes the current-task pointer.
Agentpack ignores a legacy `roles` field. The server checks size, schema, digest
and relative paths before it applies data. Bundle text is data, not instructions.
A write import runs under one pack lock and rolls back synchronous write
failures. See [the bundle contract](TASK-PASSPORT.md#portable-bundle-contract).

### Usage Tools

`usage_report` gives the same read-only report as `agentpack usage report`. It
includes `agentpackOverhead` estimates for visible Agentpack calls, response
size, later selected requests and invoking model output. They are estimates from
transcripts and upper bounds. They are not schema cost or billed tokens. Codex
code mode counts only MCP result blocks that it can identify, so it can
undercount. Task reports add `agentpackOverheadBeforeActivation` for calls made
before the task became current and earlier responses that its requests reread.
The tool does not collect activity and does not write to the ledger. See
[CLI.md](CLI.md).

To report a task, pass its Passport id, `current`, or nothing for the current
task:

```json
{"task":"task_2026-10-01T07-41-54-247Z_e76582_example","json":true}
```

If no sources are linked, the result (`kind: "task-usage-candidates"` in JSON)
lists candidate sessions of the task worktree with requests made while the task
was current. Show them to the user. Link the confirmed ones with `usage_link`.
Prefer session ids, because list numbers can change between calls:

```json
{"task":"task_2026-10-01T07-41-54-247Z_e76582_example","pick":["0b7e4c1a-5f2d-4a8e-9c3b-1d2e3f4a5b6c"]}
```

`usage_link` with none of `pick`, `file`, `remove` or `coverage` only lists
candidates.

- `client`, `file` and `turns` link an explicit source. A second link of the
  same file replaces its selection.
- `phase` labels the links (default `main`).
- `coverage` with `note` declares coverage.
- `remove` unlinks a file, by path or session id.
- The tool writes only `.agentpack/usage/<task id>.json`, after it validates the
  combined report.

Agentpack includes, without a link, sessions whose own Agentpack output started,
switched to or loaded the task, and their subagents (also Codex guardian
threads). You cannot remove them. Requests that resumed or forked sessions
repeat count once. A report counts only requests made while the task was
current. A subagent session counts whole for the task that was current when it
started. Linking rules and discovery locations are in [CLI.md](CLI.md).

For a direct report, give local JSONL sources:

```json
{"client":"codex","files":["/absolute/path/to/rollout.jsonl"],"byTurn":true,"turns":"4:5","json":true}
```

- `client` is `codex` or `claude` (Claude Code).
- `files` is a non-empty array. Relative paths resolve from the pack root. With
  `files`, `task` is only a label.
- `from` and `to` set an inclusive start and an exclusive end (ISO times).
- `byTurn` adds turn rows for each source. `turns` selects `N`, `N:` or `N:M` in
  exactly one file.
- The report discloses missing boundaries and incomplete turns. Claude user
  messages set boundaries, not completion or duration.
- The report has no phase inference and no transcript content. `json` returns
  aggregate JSON as tool text.
- Client cost snapshots are estimates of the source session. A time or turn
  selection hides them. Agentpack guesses no rates and claims no verified charge.

For an explicit task mapping, pass a manifest:

```json
{"manifest":".agentpack/usage/task-example.json","byTurn":true,"json":true}
```

`manifest` excludes `client`, `files`, `task`, `from`, `to` and `turns`. Its path
resolves from the pack root. Source paths resolve from its directory. The report
has totals and one report for each phase and source slice. The manifest schema
and the coverage limits are in [CLI.md](CLI.md).

### Release tool

`release_preflight` prints the read-only report of `agentpack release preflight`.
It checks local release metadata and Trusted Publisher wiring. It prints the
manual release-prep commands. It does not push, tag, publish or create GitHub
Releases.

## Smoke Test

An MCP client starts `agentpack mcp` in normal use. For development, run:

```bash
npm run mcp:smoke
```

The command creates a temporary workspace, starts `agentpack mcp`, sends
JSON-RPC messages over stdio and removes the workspace. The script is
`scripts/mcp-smoke.mjs`. It checks:

- modern `server/discover`, with the version, `resultType`, server name and
  cache policy
- modern `tools/list`, `prompts/list`, `resources/list`,
  `resources/templates/list` and `resources/read`, with the cache policy
- legacy `initialize` and `tools/list`, which have no modern fields
- the preset list of `load_context` and `resume`, and the error for an unknown
  preset
- `usage_report` on a sample transcript, which does not change state
- a task flow: `record_decision`, `record_source`, `source_status`, `task_audit`,
  `release_preflight`, `task_status`, `task_start`, `task_park`, `task_list`
  (text, JSON, compact and limit), `task_switch`, `task_handoff`,
  `attach_evidence`, `task_update`, `task_update_verification`,
  `task_finalize` and `resume`
- `task_status` with an id, which changes no ledger bytes
- `bundle_export`, `bundle_inspect`, `bundle_import_plan` and `bundle_import`
  (default read-only plan)

`npm test` runs the same JSON-RPC flow in memory.

## Client Setup

Run the install in dry-run mode first:

```bash
agentpack install codex
agentpack install claude
agentpack install claude-desktop
agentpack install cursor
```

Apply the plan after you review it:

```bash
agentpack install codex --write
agentpack install claude --write
agentpack install claude-desktop --write
agentpack install cursor --write
```

See [INTEGRATIONS.md](INTEGRATIONS.md) for the files of each target and the
macOS global merge of `install claude-desktop --write`.

A stdio MCP client keeps the server process alive. After you change Agentpack
and run `npm run build`, restart the MCP client to load the new `dist/` files.

The server finds the pack root from `--root`, then `AGENTPACK_ROOT`, then the
working directory. If `load_context` reports the wrong pack root, look for a
global client config with a fixed `--root` or `cwd`. Project-local configs for
Codex and Claude Code start `agentpack mcp`, so the server uses the `.agentpack/`
of the repository. Global clients such as Claude Desktop have no project
directory. Set an explicit `--root` and a matching `AGENTPACK_ROOT` for them.

Do not use one MCP server name in both a global and a project-local config. The
installers use `agentpack` for the Agentpack repository and
`agentpack-<repo-name>` for other repositories. A project-local server such as
`agentpack-example-app` then does not hide a global `agentpack` server.

## Security Notes

- Without `--root` or `AGENTPACK_ROOT`, the server walks up from the start
  directory to the nearest `.agentpack/`.
- The server makes no network calls.
- The server writes task state to local files only.
- The server writes only protocol messages to stdout.
- Most tools read and write only the pack root. Three exceptions exist:
  - Tools that use additional repositories run Git in those checkouts.
  - `usage_report` and `usage_link` read client transcripts outside the
    repository. The default places are `~/.claude/projects` and
    `~/.codex/sessions`. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` change them. They
    also read any JSONL or manifest path that you pass.
  - `bundle_inspect`, `bundle_import_plan` and `bundle_import` read the file at
    the `path` that you give.
