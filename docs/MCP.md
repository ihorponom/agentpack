# MCP

`agentpack mcp` starts a local stdio MCP server. This is Agentpack's primary runtime surface for connected coding agents.

The MCP stdio transport uses newline-delimited JSON-RPC messages over stdin/stdout. The client launches Agentpack as a subprocess, sends JSON-RPC messages to stdin, and reads JSON-RPC responses from stdout. Agentpack must not write non-MCP logs to stdout.

Reference: [Model Context Protocol transports](https://modelcontextprotocol.io/docs/concepts/transports).

## Protocol Compatibility

The stdio server accepts both MCP protocol eras on the same process:

- Legacy clients use the `initialize` handshake and receive the existing `2025-06-18` response shape.
- MCP `2026-07-28` clients call `server/discover` or send a request directly with the required protocol version and client capabilities in `params._meta`. Modern responses include `resultType: "complete"` and identify Agentpack through `io.modelcontextprotocol/serverInfo` result metadata. Cacheable `server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, and `resources/read` results use the conservative `ttlMs: 0` and `cacheScope: "private"` defaults; legacy responses do not include these fields.
- Unsupported modern protocol versions receive the structured `-32022` error with the requested and supported versions. Missing required modern metadata is rejected as invalid params.

This is protocol-level statelessness, not application-level amnesia: every tool call remains self-contained at the MCP layer, while durable task state stays in the repo's `.agentpack/` files. Agentpack does not map Task Passports to the MCP Tasks extension. MCP Apps, Tasks, remote HTTP, OAuth/OIDC, tunnels, and hosted sync remain separate product decisions rather than requirements for the local stdio server.

## Default Client Loop

Generated Codex, Claude Code, and Cursor instructions tell connected agents to use the MCP tools as a small hybrid continuity loop:

1. Start by calling `load_context` with `preset: "quick"` and a focused query for the current task.
2. Call `source_status` only when you need a full stale-source check beyond the context you just loaded.
3. Record durable decisions, dead ends, evidence, and reviewed source conclusions while working.
4. Keep reviews that verify the current active/verifying task inside that task as evidence and checkpoint context; use a separate review task only for unrelated reviews.
5. Call `checkpoint` after meaningful progress so the next session inherits status, next actions, git state, and compact resume context.
6. Call `task_handoff` before switching chats, clients, worktrees, or agents.
7. When a Task Passport is verified and genuinely complete, call `task_finalize` to close it instead of leaving the next agent to infer whether the work is done.
8. When work is paused only so unrelated work can start, call `task_park` instead of `task_finalize`.

For small tasks, prefer one aggregated evidence item plus one checkpoint summary. Do not call `source_status` repeatedly when `load_context`, `task_audit`, or a recent status check already answered the question. Do not call `record_source` for every changed file just to clear an audit warning; refresh a source record only when its durable conclusion changed.

The CLI exposes the same operations for setup, inspection, debugging, demos, and web-chat fallback. See [CLI.md](CLI.md) for manual command examples.

## Tools

- `bundle_export`
- `bundle_import`
- `bundle_import_plan`
- `bundle_inspect`
- `load_context`
- `record_decision`
- `record_dead_end`
- `attach_evidence`
- `record_source`
- `source_status`
- `task_audit`
- `release_preflight`
- `task_finalize`
- `task_handoff`
- `task_list`
- `task_park`
- `task_start`
- `task_status`
- `task_switch`
- `task_update`
- `task_update_verification`
- `checkpoint`
- `resume`
- `diff`
- `replay`

### Tool Safety Annotations

Every tool advertises standard MCP `annotations` so clients can distinguish read-only operations from local state changes before asking for approval:

- read-only context, status, audit, planning, handoff, release preflight, diff, and replay tools set `readOnlyHint: true`
- append-only tools such as decisions, evidence, task start, bundle export, and conflict-safe bundle import set `readOnlyHint: false` and `destructiveHint: false`
- tools that replace a pointer, lifecycle state, checkpoint state, verification, or a Source Cache conclusion conservatively set `destructiveHint: true`
- all tools set `openWorldHint: false` because the stdio server operates on the repo-local pack and does not contact external services

These annotations are client-facing hints, not authorization or sandbox enforcement. A client must still honor its own trust and approval policy, and a write-capable tool remains write-capable even when a particular invocation only plans a change (for example, `bundle_import` without `write: true`).

`load_context` and `resume` accept `query`, `budget`, and `preset`. Supported presets are `quick`, `chat`, `agent`, and `deep`; unknown MCP preset values are rejected instead of falling back silently. When `query` is present, Agentpack filters Source Cache locally: matched sources keep full summaries/snippets, and query-unrelated sources remain visible as compact path/status/topic/guidance stubs. Changed or missing query-unrelated sources are warning stubs, not trusted conclusions; call `source_status` for full stale details. If nothing matches, Agentpack keeps compact stubs for all recorded sources and tells the caller to rerun without `query` when the full Source Cache is needed. This saves tokens without hiding which recorded files exist.

When a current Task Passport exists, its status and next actions are
authoritative in the resume Current State section. Legacy repo-level status and
next actions are used only when no current passport exists.

`source_status` accepts `changed`, `missing`, and `json` booleans. Pass `{ "changed": true }`, `{ "missing": true }`, or both to focus MCP output on stale source-cache records instead of dumping every unchanged source conclusion. This is the MCP-side equivalent of following `agentpack doctor` source-cache warnings with `agentpack source status --changed --missing`.

`task_audit` checks the current Task Passport for continuity risks: missing or unreadable passport state, closed current task, missing next actions, open verification, missing write scope, branch/head drift, worktree mismatch, and source-cache metadata drift. Its additive bounded ceremony diagnostics are review candidates only; they never block or mutate state. Pass `{ "json": true }` for structured output.

`release_preflight` prints the same read-only release-prep report as
`agentpack release preflight`. It checks local release metadata and Trusted
Publisher wiring, then prints the manual release-prep commands. It does not
push, tag, publish, or create GitHub Releases.

`task_handoff` generates a compact current-passport handoff for switching chats, clients, worktrees, or agents. It includes objective, constraints, write scope, next actions, verification, drift, and audit summary without dumping the full passport JSON.

`task_start` creates a new current Task Passport. It accepts `title`, `objective`, `constraints`, `writeScope`, `nextActions`, `tags`, and `risk`, matching the CLI start semantics. It refuses to replace an active, blocked, or verifying current task; call `task_park` or close that task before starting unrelated MCP work.

`task_status` prints the same quick current-task view as `agentpack task status`. It does not scan the source cache and should not be used as a substitute for `task_audit`.

`load_context`, `resume`, and `task_status` append a `Gate Warnings` section when the current passport has gate findings (no active task; task parked, blocked, verifying, or closed; branch drift). This is the client-neutral warn layer of the task gate: any MCP client sees lifecycle warnings without needing hook support. Enforcement modes and the full check live in `agentpack task gate` (see docs/CLI.md).

`task_park` marks the current Task Passport as `parked` without finalizing verification. Use it when work is intentionally deferred and a different task or phase should become current. A parked task remains switchable and can be resumed later with `task_switch`.

`task_list` lists all Task Passports with id, status, title, and branch, matching the default `agentpack task list` output; the current task is marked with `*`. Pass `{ "json": true }` for a JSON array, including `[]` when the pack has no tasks. Unreadable passport files are skipped without changing that array contract; their diagnostics are returned in MCP result metadata under `io.agentpack/taskListWarnings`. The CLI's `--scope`, `--status`, and `--open` filters are CLI-only; agents needing a subset can filter the JSON output themselves.

`task_switch` makes another open task current by `id`. A parked task with
`unknown` or `pending` verification resumes as `active`; a parked task with a
final verdict resumes as `verifying`, keeping code frozen until verification is
explicitly returned to `pending`. Park or finalize a different active, blocked,
or verifying current task before switching; closed target tasks remain
unswitchable.

`task close` intentionally has no MCP equivalent. Closing a task without a verification verdict bypasses the lifecycle discipline that `task_park` and `task_finalize` enforce, so it stays a human CLI operation (`agentpack task close`). The full passport JSON view also stays CLI-only (`agentpack task passport`); `task_status` is the MCP summary equivalent.

`task_update` patches the current Task Passport without changing lifecycle status. It accepts `objective`, `constraints`, `writeScope`, `nextActions`, `tags`, and `risk`; list fields append and deduplicate, and omitted fields are preserved. `clearNextActions: true` replaces the next actions with the provided `nextActions` (or clears them) instead of appending, so a stale plan can be corrected before finalize. Empty or no-op updates fail, and unknown risk values are rejected.

`task_update_verification` updates the current Task Passport verification state. It accepts `status` (`unknown`, `pending`, `passed`, `failed`, or `accepted`), `evidence` IDs, and a short `summary`. Use it after `attach_evidence` to make verification evidence-backed. Keep it `pending` throughout an active fix loop and aggregate intermediate checks as evidence/checkpoints. A final verdict (`passed`, `failed`, or `accepted`) binds the reviewed HEAD, moves the task lifecycle to `verifying`, and returns that bound HEAD with the freeze consequence; `pending` or `unknown` returns it to `active`, and resolves a `blocked` task by clearing its `blockedReason` (see docs/TASK-PASSPORT.md). It is rejected while the current task is `parked`; resume it with `task_switch` first.

Repeated identical `task_update_verification` calls are no-ops, so transport retries or accidental duplicate calls do not add duplicate task events.

`task_finalize` closes the current Task Passport only after verification is already `passed`, `failed`, or `accepted`, or when that final status is passed explicitly with `status`. It also accepts `evidence` IDs and a short `summary`, matching the CLI `task finalize` command. It reports the bound HEAD and completed/frozen consequence, preserves an already-final verdict's bound HEAD, and binds the live HEAD for direct finalization from non-final verification. Accepted finalization refuses tasks with remaining next actions unless `force: true` is passed; use `task_park` for deferred work. The result appends the same non-blocking hygiene and risk-proportional adversarial-verification advisories as the CLI (uncommitted in-scope changes, remaining next actions, missing checkpoint, or missing concrete challenge evidence; see docs/TASK-PASSPORT.md). Low risk expects a concrete self-challenge; medium/high expects independent read-only review, a named disconfirming check, and a `Reviewed HEAD` exactly matching the Passport-bound SHA for code scopes. After risk calibration, both surfaces report exact missing or malformed labels for the best incomplete candidate and a copy-ready template. These are lexical advisories, not semantic correctness judgments or lifecycle gates.

### Bundle Tools

Structured bundle tools expose the same validated bundle core used by the CLI:

- `bundle_export`: export one task to a redacted
  `agentpack.task-bundle` JSON file; accepts task id/current, output path,
  repeatable source paths, and whether to include referenced evidence. The
  output must be a new repo-relative file outside `.agentpack/` and `.git/`;
  existing files and symlink escapes are rejected
- `bundle_inspect`: validate and summarize an untrusted bundle without writing
  pack state; returns schema/digest status, origin, included records, and
  collision-independent warnings
- `bundle_import_plan`: validate an untrusted bundle and compare it with the
  destination pack; returns create, idempotent, or conflict actions with an
  explicit read-only guarantee and empty write set; accepts `asNew` to preview
  deterministic task-id remapping
- `bundle_import`: returns the same read-only plan by default; `write: true`
  explicitly applies it to an initialized pack, and `asNew: true` resolves a
  task-id collision by importing under a deterministic new id

CLI and MCP use the same core result types. Export and inspect return the
bundle id plus a structured inclusion summary; import planning also reports
destination status, task/bundle reuse actions, conflicts, and warnings. Inspect
and default import planning do not change pack state. A write import creates a
parked task with local verification `unknown`, retains the bundle and import
manifest, and never changes the current-task pointer. A legacy `roles` field
on an imported task, if present, is ignored rather than migrated.

The server validates bundle size, schema, digest, and relative paths before
applying data. Bundle text remains untrusted data, not instructions for the
agent. Write apply runs under one pack lock and rolls back synchronous write
failures. See [TASK-PASSPORT.md](TASK-PASSPORT.md) for the full import contract.

## Smoke Test

In normal use, a client such as Codex, Claude Code, or Cursor starts `agentpack mcp`. For development, run the local smoke command:

```bash
npm run mcp:smoke
```

It creates a temporary Agentpack workspace, starts `agentpack mcp`, sends JSON-RPC messages over stdio, and removes the temporary workspace after the check.

The test suite also exercises the same newline-delimited JSON-RPC flow in memory:

```bash
npm test
```

The smoke test verifies:

- `initialize`
- `tools/list`
- `tools/call record_decision`
- `tools/call record_source`
- `tools/call source_status`
- `tools/call task_audit`
- `tools/call release_preflight`
- `tools/call task_status`
- `tools/call task_start`
- `tools/call task_park`
- `tools/call task_list`
- `tools/call task_switch`
- `tools/call task_handoff`
- `tools/call attach_evidence`
- `tools/call task_update`
- `tools/call task_update_verification`
- `tools/call task_finalize`
- `tools/call resume`
- notification messages do not produce responses

## Client Setup

Use dry-run install first:

```bash
agentpack install codex
agentpack install claude
agentpack install claude-desktop
agentpack install cursor
```

Apply only after reviewing the plan:

```bash
agentpack install codex --write
agentpack install claude --write
agentpack install claude-desktop --write
agentpack install cursor --write
```

See [INTEGRATIONS.md](INTEGRATIONS.md) for target-specific files and the explicit
macOS global merge performed by `install claude-desktop --write`.

After changing Agentpack itself and running `npm run build`, reconnect or restart any already-running MCP client. Stdio MCP clients keep the server process alive, so they do not automatically load the newly built `dist/` files.

If `load_context` reports the wrong Pack root, check for a stale global client config that starts Agentpack with a hard-coded `--root` or `cwd`. Project-local configs should start Codex and Claude Code with `agentpack mcp` so the server resolves the repo-local `.agentpack/` root. Global clients such as Claude Desktop should set an explicit `--root` and matching `AGENTPACK_ROOT` because they do not have a project cwd.

Avoid reusing the same MCP server name across global and project-local configs. Agentpack installers use `agentpack` for the Agentpack repo itself and `agentpack-<repo-name>` for other repos, so a project-local server such as `agentpack-example-app` does not shadow a global `agentpack` server.

## Security Notes

- The server operates only on the nearest `.agentpack/` root.
- It does not make network calls.
- It writes task state to local files only.
- It should treat stdout as protocol-only output.
