# Vision

## Strategic North Star

Agentpack makes agent continuity native to the repo.

Git stores code state. Agentpack stores reviewed task state.

It is a neutral task passport for coding-agent workspaces: a compact, portable record of decisions, source conclusions, evidence, dead ends, checkpoints, and next actions that survives chat compaction, client switches, worktree handoffs, machines, and branches.

Success is [directional integrity](DIRECTIONAL-INTEGRITY.md): a fresh agent can recover the reviewed objective, constraints, exact development state, decisions, open findings, verification and authorization boundaries, and next safe action without reconstructing chat history.

## Product Bet

As agent UIs evolve from chat boxes into execution workspaces, handoffs will become common: chat to worktree, IDE to background agent, local repo to cloud sandbox, Claude to Codex, Cursor to CI.

Branches and transcripts are not enough. Agents need reviewed task state that is portable, inspectable, and client-neutral.

Codex, Claude Code, Cursor, LangGraph, Temporal, OpenAI Agents SDK, and similar systems can own execution loops, retries, approvals, tool calls, and durable runs. Agentpack should own the neutral repo-scoped continuity layer that those surfaces can share.

## What Agentpack Should Own

- repo-native continuity
- task passports as the handoff artifact
- checkpoints tied to reviewed task state
- source-inspection cache
- dead-end memory
- evidence-linked handoffs
- MCP-first access
- portable bundles between worktrees, machines, and clients
- integration recipes after the local workflow is stable

## Task Passport Model

A Task Passport is the handoff artifact for one coherent unit of agent work. It should capture the objective, constraints, write scope, relevant source conclusions, decisions, dead ends, evidence, verification state, checkpoints, and next actions.

One Passport normally spans a coherent phase, not each iteration. Create another only for an unrelated objective, a materially different authorization boundary, or an independent review that needs a separate frozen snapshot. The five-task directional-integrity baseline had no Fail and no repeated Partial for the same signal/workflow boundary, so it supports clarifying instructions and lifecycle messages rather than redesigning the lifecycle.

See [TASK-PASSPORT.md](TASK-PASSPORT.md) for the target schema and state transitions.

One active Task Passport should own the work in a repo worktree by default. A repo can keep many closed or parked passports over time, but Agentpack should not turn one working directory into a backlog or a multi-task merge engine.

Workstream support should stay modest: separate passports across branches and worktrees, keep parked work visible, and protect handoff boundaries. It should not turn Agentpack into a backlog manager or code conflict resolver.

Multi-role agents can collaborate around one Task Passport without the core tracking their roles as passport metadata. A coordinator agent owns the passport lifecycle; specialized subagents (for example the builder subagent `agentpack install claude` writes to `.claude/agents/builder.md`) work inside the declared write scope and hand results back. Agentpack's contribution is the shared write scope, verification, and evidence the passport already carries, not a role registry.

## Operating Principles

- Execution engines run the work. Agentpack preserves what future agents need to continue it.
- Continuity should be native to the repo, not reconstructed from chat history.
- One Task Passport owns the current work; multiple client-side agents can contribute to it.
- Prefer small, inspectable, local files before hosted sync or hidden databases.
- Prefer portable MCP, CLI, and file surfaces over framework lock-in.
- Record durable context, not every action.

## Scope Boundaries

- Keep the core artifact focused on reviewed task state.
- Keep backlog, issue tracking, and code merge conflict resolution in the tools that already own them.
- Keep execution loops, retries, approvals, tool calls, and durable runs in execution engines.
- Keep the core workflow local-first; hosted sync can remain optional future work.
- Keep deterministic file, hash, and source summaries as the default before adding embeddings or network calls.
