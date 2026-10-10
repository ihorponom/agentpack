# Task Continuity

An Agentpack handoff is useful when the next session can continue the accepted
work without reconstructing the previous chat or guessing which repository
state was reviewed. Agentpack stores task state; code history stays in Git.

## What a handoff should preserve

1. **Objective and constraints** — the outcome and boundaries of the work.
2. **Development state** — the pack root, worktree, branch, HEAD, upstream
   drift, and uncommitted changes.
3. **Write scope** — the files or directories the current phase may change.
4. **Decisions and open findings** — conclusions to carry forward and issues
   that remain unresolved.
5. **Verification** — the result, supporting evidence, and code state it covers.
6. **Authorization** — which actions are permitted and which still need approval.
7. **Next action** — a concrete step that fits the task's lifecycle state.

Source Cache records also show when a file has changed since a conclusion was
recorded. An unchanged hash confirms only that the file content is the same;
it does not prove the conclusion was correct.

## Limits

A prior verification result can become stale after a code change. Agentpack
shows the task's recorded HEAD and live Git state so the next session can
notice the difference. Local test results do not authorize a push, merge, or
release.

CLI and MCP can report live task, Git, and Source Cache state. Generated
Codex, Claude Code, and Cursor instructions provide workflow guidance for
clients that read project files. Claude Desktop receives an MCP registration;
it does not read project instruction files automatically.

Native client hooks and the Git pre-commit gate can warn about edits outside
the active task's scope. Set `gateMode` to `block` when the supported hooks
should deny violations. Hooks remain client-specific, so check the Task
Passport and live Git state when continuing work in a different client.

Agentpack does not review architecture or decide whether code is correct.
Verification evidence still needs human or independent review appropriate to
the change. The Task Passport records that result for the next session.
