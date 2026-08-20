# Directional-Integrity and Token Benchmarks

Agentpack should preserve the direction of reviewed work and earn the context it
asks an agent to spend. These benchmarks first assert critical directional
integrity and then measure whether the output carrying it adds ritual overhead.

See [DIRECTIONAL-INTEGRITY.md](DIRECTIONAL-INTEGRITY.md) for the product metric,
critical signals, failure conditions, and real-task dogfood rubric.

Token counts are diagnostic, not the product goal. A larger output can be the
right tradeoff when it preserves must-have handoff facts such as the accepted
task, local commits ahead of upstream, release cadence, risk, next actions, and
verification. A smaller output is bad if it forces a fresh agent into ledger
archaeology.

This is a repo-maintenance benchmark, not an installed `agentpack` command. Run
it from a checkout of this repo:

```bash
npm run build
node scripts/benchmark-token-overhead.mjs
```

Optional flags:

```bash
node scripts/benchmark-token-overhead.mjs --json
node scripts/benchmark-token-overhead.mjs --keep-fixtures
```

The script creates temporary repositories, initializes Agentpack, records
representative task/source/evidence state, and compares Agentpack-assisted
outputs against direct git/file inspection baselines.

## Scenarios

- Tiny question: `agentpack task status` versus `git status --short --branch`.
- Latest-diff review: quick resume with a review query versus status plus diff.
- Resumed implementation: chat-budget resume versus status plus relevant file reads.
- Tight-budget context: a small explicit resume budget that should preserve
  current state, upstream drift, and local commits while omitting optional
  ledger sections honestly.
- Fresh-agent context: a budgeted resume that checks whether a new agent can
  recover the accepted task, local commits, release cadence, risk, next action,
  and verification without replaying the ledger.
- Long remediation handoff: a security-sensitive fix loop that must retain its
  objective, constraints, exact development state, open finding, pending
  verification, and remote-authorization boundary.
- External-review wait: a parked task whose commit-bound verdict remains frozen
  while the next safe action waits on an independent result.
- Delivery authorization: an exact normal-push/draft-PR permission that must not
  become force-push, merge, comment, tag, or publish authority.
- Development-state drift: branch, HEAD, and worktree mismatches that must be
  visible before another agent continues.
- Stale Source Cache triage: `source status --changed --missing` versus status plus diff.
- Release-prep handoff: `task handoff` versus status, recent log, and release files.

These are deliberately small and local. They are meant to catch direction and
regressions before optimizing, not to model every real project.

## Metrics

The benchmark reports:

- Agentpack: plain text produced by the Agentpack command.
- MCP total: the same text inside a modeled JSON-RPC `tools/call` response.
- MCP overhead: protocol wrapper only, excluding Agentpack's text body.
- Direct: the likely git/file output an agent would inspect without Agentpack.
- AP-direct and MCP-direct: positive values are token overhead; negative values
  mean the Agentpack path was shorter than the direct baseline.
- Section breakdown: Markdown resume outputs are split by `##` section so growth
  can be attributed to buckets such as Source Cache, Evidence, or Current Task
  Passport.
- Directional-integrity checks: scenario-specific must-have handoff facts,
  grouped by signal. These checks fail the benchmark when required context
  disappears, even if token counts look small.
- Guardrail checks: output budgets or future ceremony bounds, reported
  separately from directional integrity.

Token counts use Agentpack's existing rough estimate:

```text
ceil(characters / 4)
```

That keeps the benchmark dependency-free and aligned with resume budget logic.
Use it for relative comparison, not exact model billing.

## Reading Results

Good overhead is context that preserves direction: task objective, constraints,
exact development state, write scope, decisions, open findings, verification,
authorization, next safe action, risk, and stale-source guidance.

Bad overhead is repeated ceremony: duplicated summaries, unchanged source dumps,
large timelines, evidence previews that do not answer the scenario, or protocol
metadata that dominates tiny calls.

If a scenario grows, decide which bucket changed before optimizing:

- MCP wrapper growth points to tool response shape or excessive envelope use.
- Source Cache growth points to query filtering, stale-source warning stubs, or
  summary caps.
- Evidence growth points to preview limits or evidence selection.
- Resume growth points to required section budgets and omitted/truncated
  metadata.

Use explicit budgets as a contract: if a scenario asks for 900 estimated tokens,
the reported usage should not exceed 900. Use very small budgets as stress
tests for priority behavior, not as a target for normal handoffs.

Prefer one narrow improvement at a time, then rerun the benchmark and a focused
test or smoke check. Optimize for useful context per token rather than raw token
minimization.

The synthetic fixtures are regression coverage, not an adoption study. Before
changing lifecycle semantics, also score at least five representative real tasks
with the rubric in `DIRECTIONAL-INTEGRITY.md` and retain the evidence for every
Partial or Fail.
