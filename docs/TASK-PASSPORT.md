# Task Passport

A Task Passport records the objective, constraints, write scope, lifecycle,
verification and next actions of one task. Use it to hand off work between
sessions or clients.

## Model

- A ledger has one current Passport.
- A ledger can keep completed and parked Passports.
- Separate worktrees can have separate ledgers.
- Source cache paths are relative to the pack root.
- Each Passport owns its objective, constraints, write scope, next actions,
  lifecycle events and verification references.
- Source conclusions, decisions, dead ends and the repository event log are
  shared by all tasks.
- Checkpoints and evidence files are also shared. A Passport links to evidence
  by id.
- One Passport can bind additional repositories. They share the lifecycle and
  the verification. Each keeps its own scope and HEAD.

## File Shape

```text
.agentpack/
  config.json
  state.json
  sources.json
  events.jsonl
  checkpoints/
  evidence/
  exports/
  usage/
  cache/
  archive/
  instructions/
  tasks/
    current
    task_2026-10-25T07-56-15-791Z_2c160d_source-cleanup/
      passport.json
      events.jsonl
      checkpoints/   (created, currently empty)
      evidence/      (created, currently empty)
      exports/       (created, currently empty)
      imports/
```

`tasks/current` holds the id of the current task. The task can have any status,
including parked or completed. If the file is missing, `resume` uses legacy
repository state.

A checkpoint records its `taskId` when the current task is active, blocked or
verifying. Older checkpoints, and checkpoints made while the task is parked,
closed or unreadable, have no task id and stay global.

`task handoff` shows the latest checkpoint that is linked to the task. It shows
the summary, time, id and origin task and Git ref. It does not show global
checkpoints, checkpoints of other tasks, or the status and next actions of a
checkpoint. The portable record has a limit of 2 KiB of UTF-8 JSON. A shortened
summary is marked. Compaction keeps the checkpoint metadata that handoff uses.

## Passport Schema

`passport.json` is compact and safe to read by hand.

```json
{
  "schemaVersion": 1,
  "id": "task_2026-10-25T07-56-15-791Z_2c160d_source-cleanup",
  "title": "Add source cache cleanup commands",
  "status": "active",
  "createdAt": "2026-10-25T07:56:15.713Z",
  "updatedAt": "2026-10-25T08:16:39.384Z",
  "closedAt": null,
  "objective": "Let Agentpack remove stale source conclusions safely.",
  "constraints": [
    "Keep the behavior of source add and source status",
    "Do not delete source conclusions without an explicit guard"
  ],
  "branch": "main",
  "baseHead": "ee35e4a",
  "currentHead": "476d090",
  "worktree": "/path/to/repo",
  "writeScope": [
    "src/core/sources.ts",
    "src/cli/index.ts",
    "tests/agentpack.test.ts"
  ],
  "risk": "medium",
  "verification": {
    "status": "unknown",
    "evidence": [],
    "summary": ""
  },
  "nextActions": [
    "Add the source prune command"
  ],
  "tags": [
    "source-cache"
  ]
}
```

All of these fields must exist:

- `schemaVersion`, `id`, `title`, `status`, `objective`, `worktree`
- `createdAt`, `updatedAt`
- `closedAt`, `branch`, `baseHead`, `currentHead` (the value can be `null`)
- `constraints`, `writeScope`, `nextActions`, `tags` (arrays of strings)
- `risk`: `low`, `medium`, `high` or `unknown` (the default)
- `verification`: `status`, `evidence` (array of ids) and `summary`

Two fields are optional:

- `blockedReason`: the reason given to `task block`.
- `repositories`: the additional repositories. It is required, and not empty,
  when `schemaVersion` is 2.

A write scope is a list of repository-relative paths. The path `.` means the
whole repository. A directory such as `api` covers every file under `api/`.

The `baseHead` and `currentHead` of the repository at the pack root are short
commit ids. Additional repositories store full HEADs (40 or 64 hex characters).

### Changes across repositories

Use one ledger for a task that spans several Git checkouts. An additional
repository does not need its own `.agentpack/` directory. The fields `worktree`,
`branch`, `baseHead`, `currentHead` and `writeScope` describe the repository at
the pack root.

Run the commands from the pack root. Repeat `--repository` to bind more
checkouts.

```sh
agentpack task start "Integrate search" --write-scope src/search \
  --repository '{"id":"web","worktree":"../web","writeScope":["src/features/search","tests"]}' \
  --repository '{"id":"infra","worktree":"../infra","writeScope":["environments/staging"]}'

agentpack task update \
  --repository '{"id":"web","worktree":"../web","writeScope":["src/api-client"]}'

agentpack task gate --staged
agentpack task gate --staged --repository web
agentpack task list --scope web:src/features/search
```

Each binding needs:

- `id`: a unique name of 1 to 64 characters that matches
  `[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}`. The name `primary` is reserved.
- `worktree`: the root of an existing Git checkout with at least one commit.
  Linked worktrees work.
- `writeScope`: a list of repository-relative literal prefixes that is not
  empty. The path `.` selects the whole checkout. Globs do not work.

Agentpack rejects these bindings:

- A `worktree` that contains the pack root or is the pack root ("overlaps the
  primary pack root"). A Git repository nested inside the pack root is accepted.
- A path that another binding already uses.
- A scope that leaves its checkout.

Worktree paths resolve from the pack root. Agentpack stores them as canonical
paths.

Create the branch before you bind a checkout. To change bindings, the task must
be active and its verification must be unknown or pending. A repeated update
appends paths to the scope. The branch and base HEAD do not change. A bound
checkout must keep its path and its Git directory. To replace a checkout, start a
new task. You cannot remove a binding.

The task gate treats additional repositories this way:

- `task gate --staged` checks the index of every bound repository.
- `--repository <id>` selects one index. `primary` selects the repository at the
  pack root.
- `--file` paths stay relative to the pack root, or absolute. The selector does
  not change this.
- A staged file follows the most specific scope of its checkout. An update of a
  Git submodule pointer follows the scope of the parent.
- If an additional repository is unavailable or unbound, the gate reports a
  finding. Branch drift gives an advisory.
- A commit inside an additional repository does not run the pre-commit hook of
  the pack root. Add a hook to that repository to gate its commits. See
  [integration setup](INTEGRATIONS.md).

In `task list`, `--scope id:path` selects an additional repository. A path
without `id:` selects scopes of the repository at the pack root.

A final verdict needs each additional repository to be readable and on its
recorded branch. The verdict stores the full HEAD of each one. If you finalize
from non-final verification, `task finalize` takes the same snapshot and has
the same requirement. Park, switch and finalize keep these HEADs. Record
cross-repository checks as shared evidence.

A Passport with additional repositories, and its bundles, use schema v2. Older
Agentpack versions cannot read them. Single-repository data stays schema v1.

Export removes local worktree paths and checkout identities. Import creates a
parked task with unknown verification and unbound repositories. To continue:

1. Switch to the imported task.
2. Bind each id with `task update --repository ...`.
3. Verify the result on the local checkout.

The first local binding uses only the scope that you supply. Later updates
append paths. The retained bundle keeps the original scopes and Git state as
provenance.

## Statuses

| Status | Meaning |
|---|---|
| `active` | Work is in progress. |
| `parked` | Work is set aside. Another task can be current. |
| `blocked` | Work waits for input, a dependency or a risk decision. |
| `verifying` | A final verdict (`passed`, `failed` or `accepted`) is recorded. Code is frozen. |
| `completed` | The task is closed. |
| `abandoned` | Closed. Only Passports from older versions or imported bundles can have it. No current command sets it. |

`completed` and `abandoned` are the closed statuses. A closed Passport stays in
the history. `resume` shows it only when it matches the query.

## State Transitions

`resume` and `load_context` never change a status. Only `task switch` resumes a
parked task.

| Command | From | To |
|---|---|---|
| `task start` | no current task, a parked task, or a completed task | `active` |
| `task park` | any open status | `parked` |
| `task block --reason <text>` | any open status | `blocked` |
| `task switch <id>` | `parked`, verification `unknown` or `pending` | `active` |
| `task switch <id>` | `parked`, final verdict | `verifying` |
| `task verify` with a final verdict | `active`, `blocked` or `verifying` | `verifying` |
| `task verify` with `pending` or `unknown` | `active`, `blocked` or `verifying` | `active` |
| `task finalize` | any open status | `completed` |
| `task close` | any open status | `completed` |

Notes:

- `task verify` (MCP `task_update_verification`) fails on a parked task.
  Switch to the task first.
- A `pending` or `unknown` verdict on a blocked task also clears `blockedReason`.
- `task finalize` needs a final verdict. It accepts `passed`, `failed` or
  `accepted` with `--status`, or uses the verdict that is already recorded.
- `task finalize --status accepted` fails if next actions remain. Add `--force`
  to close the task anyway.
- `task close` closes a task without a verification check. Use it only for
  manual cleanup. MCP has no close tool.

## CLI Shape

```bash
agentpack task start "Fix checkout discount bug" \
  --objective "Make discount totals consistent across cart and checkout" \
  --write-scope src/checkout.ts \
  --write-scope src/cart.ts

agentpack task list [--scope <path>] [--status <status>] [--open] [--all]
agentpack task status [--id <id>] [--full]
agentpack task handoff
agentpack task passport [<id>]
agentpack task switch <id> [--park-current]
agentpack task update --next "Run focused regression tests" --write-scope tests/checkout.test.ts --risk medium
agentpack task update --constraint "Keep the public API" --replace-constraints
agentpack task audit
agentpack task gate [--file <path>] [--staged] [--repository <id>]
agentpack task park
agentpack task block --reason "Waiting for API decision"
agentpack task verify --status passed --evidence evt_... --summary "Focused checks passed"
agentpack task finalize
agentpack task close
```

See [CLI.md](CLI.md) for all options. The MCP tools are `task_start`,
`task_status`, `task_list`, `task_switch`, `task_park`, `task_update`,
`task_update_verification`, `task_finalize`, `task_handoff` and `task_audit`.
Blocking, closing and the full Passport JSON are CLI only.

`resume` and MCP `load_context` read the current Passport. Its status and next
actions are the authority in Current State. If no Passport exists, Current State
uses the legacy repository state. If the current task is closed, `resume` marks
its next actions as historical.

### Normal sequence

Start the task, keep status, scope and next actions current, record verification
with evidence, print a handoff if someone else will continue, and finalize after
the verdict is final.

Keep verification `pending` while you fix problems. Collect intermediate green
checks as evidence and checkpoints. When no edits remain:

1. Commit the in-scope changes.
2. Check that the tree is clean and that hooks changed no files.
3. Record the final verdict in one of two ways:
   - No external wait: run `task finalize --status passed` with the evidence and
     the commit hash. No `verifying` window opens.
   - External wait (review, merge, re-score): run `task verify --status passed`,
     then `task park`. When you switch back, the task stays `verifying`. After
     the result, finalize the task, or run `task verify` to return the
     verification to `pending` before you change code.

A final verdict stores the current HEAD in `currentHead` (the bound HEAD),
moves the task to `verifying` and freezes code changes. Record it only after
the last edit.

To pause work for unrelated work, use `task park`, not `task finalize`. A review
of the current task is verification work. Record its evidence and a checkpoint in
that task. Start a separate review task only for an unrelated objective, a
different authorization boundary, or an independent frozen snapshot.

### Commands

- `task start` fails if the current task is active, blocked or verifying. Park or
  finalize it first. An invalid risk value is an error.
- `task switch --park-current` (MCP `parkCurrent: true`) parks the current task
  and switches in one step. Agentpack checks the target first. It changes both
  Passports, the events and the pointer under the pack lock, and rolls back
  ordinary write failures. It does not recover from a crash. It never finalizes
  work or clears a blocker. A closed task cannot be the target.
- `task status` prints one line and does not scan the source cache. `--full`
  prints the detailed view. `--id <id>` shows another task without a switch,
  with `Bound HEAD:` and `Verification evidence:` (only evidence linked to the
  verdict).
- `task update` appends to list fields and removes duplicates. Omitted fields do
  not change. `--clear-next-actions` replaces the next actions with the `--next`
  items. `--replace-constraints` replaces the constraints and keeps the removed
  ones in the event as `removedConstraints` (the TUI Timeline shows them). An
  empty update or an unknown risk value fails.
- `task verify` with no flags sets `pending`. `task update-verification` is an
  alias. An unchanged repeat call writes nothing.
- `--evidence` ids on `task verify` and `task finalize` must match evidence events
  in the last 4 MiB of `events.jsonl`. One unknown id rejects the whole update
  before anything is written. You can repeat ids that are already linked. Older
  Passport links stay readable.
- `task finalize` prints the bound HEAD and the completed and frozen result. A
  verdict that is already final keeps its bound HEAD. Finalizing from non-final
  verification binds the current HEAD. With `accepted`, use `task park` for
  deferred work instead of `--force`.

After closing, `task finalize` prints advisories. They never block the close.

- Uncommitted changes in the write scope. Commit them, or park the task.
- Next actions that will now read as historical.
- No checkpoint since the task started.
- For each additional repository: unbound or drifted state, and uncommitted
  changes in its scope.
- Missing evidence for the risk (see
  [Advisory verification evidence](#advisory-verification-evidence)).

`task audit` checks continuity: branch, HEAD and worktree drift, missing next
actions or write scope, open verification, a closed current task, changed or
missing source conclusions, and repository warnings. It shows source cache
warnings apart from task warnings. It also lists review candidates from retained
evidence and lifecycle history. They are patterns for a person to judge. They
never block a task. Agentpack does not resolve code conflicts. For parallel
work, park the task before you switch, or use a separate worktree.

## Handoff

`task handoff` (MCP `task_handoff`) prints a compact summary for another chat,
client, worktree or agent. It does not print the Passport JSON.

| Item | Command that shows it |
|---|---|
| Title, status, id, objective, branch, risk | `task handoff` |
| Constraints, write scope, next actions | `task handoff` |
| Verification and linked evidence | `task handoff` |
| Additional repositories | `task handoff` |
| Latest checkpoint of the task | `task handoff` |
| Current HEAD (the live commit), and drift (the bound HEAD only if it differs, as `x -> y`) | `task handoff` |
| Audit summary, and a `Metadata:` line with source cache warnings | `task handoff` |
| Bound HEAD in full | `task status --id <id>` |
| Changed files and source conclusions that changed since you recorded them | `resume`, `load_context` |

The agent or person must state these items in the Passport or a checkpoint,
because Agentpack has no field for them:

- the authorization: which actions are allowed, and which still need approval
- the open findings that nobody has resolved

Limits:

- A matching hash proves only that a file did not change. It does not prove
  that the recorded conclusion is correct.
- Local test results do not authorize a push, a merge or a release.
- Hooks are client-specific. When you continue in another client, check the
  Passport and the live Git state.
- Agentpack does not decide whether code is correct. Evidence still needs human
  or independent review.

## Monorepo Focus Pattern

One ledger can serve a repository with several parts, for example `api/`,
`frontend/`, `cron/` and `service/`. Short tasks carry the folder boundary.

```bash
agentpack task start "API auth fix" --write-scope api
```

A directory write scope covers every file under it. The task gate enforces the
boundary:

- In `warn` mode (the default), the agent gets a warning when an edit leaves
  `api/`.
- With `gateMode: "block"` in `.agentpack/config.json`, the native hooks of
  Claude Code, Codex and Cursor deny the edit.

Start a task when you enter one part. Finalize it when you verify that part.
`task list --all --scope api` shows the tasks that owned `api`. Without `--all`
it shows the open tasks.

A subfolder can also run `agentpack init` and keep its own ledger. Separate
ledgers mean you switch the working directory between them. Use them only when
the parts are independent projects.

## Portable Bundle Contract

A bundle moves reviewed task continuity between local workspaces. It does not
move live `.agentpack/` state or the Git working tree. `bundle import` plans
only, unless you pass `--write`.

A bundle is one UTF-8 JSON file. Name it `*.agentpack-bundle.json`. It is not a
zip file. It cannot contain scripts, binaries, source files or client
configuration.

Single-repository bundle (schema v1):

```json
{
  "kind": "agentpack.task-bundle",
  "schemaVersion": 1,
  "bundleId": "sha256:<canonical-payload-hash>",
  "exportedAt": "2026-06-23T12:00:00.000Z",
  "producer": {
    "name": "agentpack-cli",
    "version": "<installed-version>"
  },
  "origin": {
    "projectName": "example-app",
    "repository": "https://example.invalid/org/example-app",
    "branch": "feature/checkout",
    "head": "abc1234"
  },
  "task": {
    "id": "task_example",
    "title": "Fix checkout totals",
    "objective": "Make totals consistent",
    "constraints": [],
    "writeScope": ["src/checkout.ts"],
    "risk": "medium",
    "tags": [],
    "nextActions": [],
    "originalStatus": "active",
    "originVerification": {
      "status": "passed",
      "summary": "Focused tests passed.",
      "evidence": ["evt_example"]
    }
  },
  "handoffMarkdown": "Task handoff...",
  "sources": [],
  "evidence": []
}
```

`bundleId` is a hash of the canonical payload. The hash leaves out `bundleId`
and `exportedAt`. Two exports have the same id when the task and the Git state
are the same, even when the times differ.

The task payload holds the title, objective, constraints, write scope, risk,
tags, next actions, original status and original verification. Absolute
worktree paths and the `tasks/current` pointer are never exported. The origin
branch, HEAD, task id and verification are provenance only. An import does not
claim that the destination has the same Git state or has verified the task.

The optional `checkpoint` field holds the same bounded metadata as the handoff.
Old bundles without it stay valid. A destination handoff uses the imported
metadata until a valid local checkpoint exists. Re-export keeps the origin task
id and Git ref. `--as-new` changes only the destination task id. Import creates
no checkpoint files or events and changes no state, pointer, next action or
verification. Agentpack skips unreadable or unsafe metadata with a warning.

The repository locator is optional and has no credentials. Export removes user
info, query strings, fragments and nonportable local remote paths. A source entry has the
path, hash, size, time, summary and optional snippet. An evidence entry has the
origin id, kind, redacted command, exit code, content and a content digest.

A bundle contains a redacted compact handoff, the source conclusions that you
select with repeatable source paths (a write scope, including `.`, never selects
sources), and the text or JSON evidence that the Passport verification
references (unless you turn evidence off).

A bundle never contains config, state, current-task pointers, client config,
caches, checkpoint snapshots, Git patches, source file contents, unreferenced
evidence, the repository event stream, decisions or dead ends. Storage cannot
prove which task owns a decision. The markdown export can carry them.

Export redacts every string again. It refuses absolute and parent-traversal
paths, paths inside `.agentpack/` or `.git/`, symlink escapes and existing output
files. Import treats the bundle as untrusted. It checks kind, schema, digest,
paths and field types before it plans a write. The limits are 2 MiB for the
bundle, 100 sources, 50 evidence entries and 256 KiB for each evidence content.
Agentpack does not merge ambiguous retained imports.

`bundle import-plan` is read-only and has an empty write set. It compares the
task id and the bundle digest with the destination. An uninitialized destination
is a create candidate. The command does not create `.agentpack/`.

`bundle import --write` applies the plan in one transaction under the pack write
lock. It never replaces the current task. It creates a parked Passport with
local branch, HEAD and worktree values. Origin metadata stays in the import
record. Local verification starts as `unknown`.

Collision rules:

| Case | Result |
|---|---|
| The task id is new. | Keep the id. Import the task as parked. |
| The same bundle digest was imported before. | Report a no-op. |
| The task id exists with different content. | Refuse. With `--as-new`, remap the task id and all imported references. |
| The evidence id and digest both match. | Reuse the evidence. |
| The evidence id matches but the content differs. | Remap the id and rewrite the origin verification references. |
| A local source file matches the imported hash. | Fill an empty source conclusion. A local conclusion wins. |
| A local source file is missing or has another hash. | Do not write the conclusion. Keep it in the bundle and report a stale-source warning. |

Agentpack keeps the applied bundle at
`.agentpack/tasks/<task-id>/imports/<portable-bundle-id>.bundle.json`. The file
`<portable-bundle-id>.import.json` next to it lists the records that Agentpack
created, reused, skipped and remapped. Apply rolls back synchronous write
failures. There is no general rollback command.

## Migration

Legacy state and events stay readable without a current Passport. Agentpack does
not convert legacy goals or checkpoints into tasks.

## Advisory verification evidence

`task audit` and `task finalize` check that evidence of a `passed` or
`accepted` verdict fits the task risk. The check is advisory. It never judges
the technical conclusion and never blocks a task. It reads only recent
referenced evidence.

The risk `unknown` is the default. With `unknown`, the advisory always asks you
to set the risk to `low`, `medium` or `high`.

A code scope is any write scope that is not under `docs/` and is not a `.md`,
`.mdx`, `.rst` or `.txt` file. This includes the scopes of additional
repositories.

Low risk: write a short note, or keep useful test output. It must say what you
checked, what happened and any limit. It needs no labels and no minimum length.
For a code scope, add a `Reviewed HEAD:` line. The value is the bound HEAD or its
full 40-character form. The advisory flags evidence that is missing, unreadable,
empty, only a HEAD, or generic.

Classify contract-changing work as medium or high risk. Its evidence must use
these fields:

```text
Claim or assumption attacked: <specific claim>
Counterexample or disconfirming check: <specific check>
Observed result: <what happened>
Unresolved findings: none identified after <specific check>
Residual risk: <remaining risk>
```

Each value must have at least 32 characters and 6 words. Values such as
`checked` or `tests passed` fail. One exception: `Unresolved findings: none
identified after <check>` is valid when the check text has at least 12
characters. The evidence must also:

- have the kind `review`, `adversarial-review` or (older) `challenge`
- contain `Review mode: independent read-only`
- contain `Adversarial check type:` with a negative, differential, operational
  or rollback check
- for a code scope, contain the bound `Reviewed HEAD`

The advisory names each missing or malformed field and prints a template.
