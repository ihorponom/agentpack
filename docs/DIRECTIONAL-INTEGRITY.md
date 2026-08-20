# Directional Integrity

Directional integrity is Agentpack's primary product metric. A handoff succeeds
when another agent can continue the accepted work without reconstructing chat
history and without silently changing its direction.

Agentpack does not discover defects, choose an architecture, or optimize coding
speed. Execution engines and reviewers own those outcomes. Agentpack owns the
reviewed task state that keeps their work aligned across sessions, clients,
worktrees, machines, and delivery phases.

## Critical Signals

A fresh agent must be able to recover these facts accurately:

1. **Objective** — the concrete outcome currently being pursued.
2. **Constraints** — compatibility, security, product, and process boundaries
   that must remain true.
3. **Development state** — the authoritative pack root or worktree, branch,
   current HEAD, upstream drift, and uncommitted state.
4. **Write scope** — the paths the current implementation phase may modify.
5. **Decisions** — reviewed conclusions that should not be rediscovered or
   casually reversed.
6. **Open findings** — unresolved defects, external waits, and remaining work.
7. **Verification** — the verdict, evidence, and code state to which it applies.
8. **Authorization** — which local or remote mutations are allowed and which
   still require explicit approval.
9. **Next safe action** — the concrete action that advances the current phase
   without violating the other signals.

Risk and Source Cache state are supporting signals. Risk determines how much
verification is proportionate; changed or missing source records tell the next
agent which recorded conclusions may be stale.

## Failure Conditions

Directional integrity fails when a critical signal is absent, ambiguous, or
contradicts the live repository state. Examples include:

- a verification PASS presented as current against a different HEAD without an
  explicit drift warning or code-state binding;
- continuing in the wrong worktree or branch without a visible drift warning;
- losing an unresolved review finding after a context switch;
- treating a local test result as authorization to push, merge, or publish;
- widening write scope or relaxing a constraint without a reviewed decision;
- presenting a closed, parked, or verifying task as editable;
- giving a next action that conflicts with the recorded lifecycle state.

Extra output is not a directional-integrity failure by itself. It becomes a
guardrail problem when repeated summaries, evidence, warnings, or lifecycle
transitions add cost without preserving another required fact.

## Benchmark Contract

`scripts/benchmark-token-overhead.mjs` exercises local repositories and reports
two distinct groups:

- **Directional checks** assert critical handoff facts. Any failure makes the
  benchmark fail.
- **Guardrail checks** bound output or ceremony. They also fail the maintenance
  benchmark, but they are reported separately so a smaller output is never
  mistaken for better continuity.

The representative scenarios cover:

- a tiny status question;
- latest-diff review;
- resumed implementation;
- tight-budget and fresh-agent handoffs;
- a long security-sensitive remediation loop;
- a frozen verdict during an external review wait;
- an exact delivery authorization boundary;
- branch, HEAD, and worktree drift;
- stale Source Cache triage;
- release preparation without release authorization.

These fixtures are deterministic regression tests, not proof of real-world
adoption or time savings.

## Client Surface Limits

Client registrations are not interchangeable presentations of one byte-identical
handoff. CLI and MCP can expose live Task Passport, Git, and Source Cache state;
generated Codex, Claude Code, and Cursor files instead carry the operating
boundaries for the next session, such as lifecycle checks, write scope, final
verification ownership, and authorization. Claude Desktop only receives an MCP
server registration because it has no project-local instruction file.

Native hooks remain defense in depth, not the client-neutral source of truth.
In particular, Cursor does not guarantee model-visible warnings for allowed
edits and its hooks can fail open. Its installer therefore preauthorizes only
read-only Agentpack MCP tools; use MCP context plus the git pre-commit gate when
an enforcement boundary must survive a client change, and enable
`gateMode: "block"` when violations must be denied rather than warned about.

## Real-Task Dogfood Rubric

Before changing lifecycle semantics or adding ceremony diagnostics, sample at
least five representative completed or parked tasks. Include a small fix, a
multi-session implementation, an independent review, an external wait, and a
delivery task. Add more cases when one workflow dominates the result.

For each task, score every critical signal:

| Result | Meaning |
| --- | --- |
| Pass | The handoff states the fact accurately and unambiguously. |
| Partial | The fact can be inferred, but requires extra ledger or Git archaeology. |
| Fail | The fact is absent, stale, contradictory, or unsafe to act on. |
| N/A | The signal genuinely does not apply; explain why. |

Record the command or surface used (`load_context`, `resume`, `task handoff`,
CLI, or MCP), the expected fact, the observed fact, and the evidence used to
judge it. Do not infer counterfactual claims such as "defects prevented" or
"time saved" from a PASS.

A product change is justified only when it improves a repeated Partial or Fail
without regressing another critical signal. Ceremony reductions should compare
observable guardrails such as output size, verification resets, park/switch
cycles, duplicated evidence, and repeated warnings; high activity alone is not
proof of waste.

## Product Boundary

Directional integrity does not expand Agentpack into an architecture adviser,
review agent, workflow engine, backlog manager, role registry, autonomous
approval system, or hosted execution platform. Those systems may consume or
contribute reviewed task state, but the repo-native Task Passport remains the
shared continuity artifact.
