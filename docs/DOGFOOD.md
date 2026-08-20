# Dogfood Workflow

Dogfooding means using Agentpack to develop Agentpack itself. The goal is to prove the workflow in real coding sessions before adding more features.

## Start A Session

Load focused quick context first:

```text
load_context(preset: "quick", query: "<current task terms>")
```

Use `agent` instead of `quick` when the task needs more history.

## Local Tarball Workspace

Use `.agentpack-dogfood/` as the repo-local scratch area for testing packed
builds without publishing to npm. The directory is ignored by git. Put the
actual test project under `.agentpack-dogfood/workspace/`; running `npm init`
directly inside the hidden parent directory gives npm an invalid package name.

Typical flow:

```bash
mkdir -p .agentpack-dogfood/workspace
npm_config_cache=/private/tmp/agentpack-npm-cache npm pack --pack-destination .agentpack-dogfood
cd .agentpack-dogfood/workspace
npm init -y
git init
npm_config_cache=/private/tmp/agentpack-npm-cache npm install ../agentpack-cli-*.tgz
./node_modules/.bin/agentpack --version
./node_modules/.bin/agentpack init
./node_modules/.bin/agentpack doctor
```

## During Work

Record only durable context. Agentpack is not an activity logger, and it should not log every thought, file read, or edit.

Default cadence:

- At task start, load Agentpack context.
- Before implementation, confirm the current Task Passport is the right active task for this phase and branch.
- If the current task is verifying, blocked, closed, or has unexplained branch/head drift, resolve that lifecycle state before editing code.
- Treat review requests as verification for the current task when they match its active/verifying scope; use a separate review task only for an unrelated objective, materially different authorization boundary, or a review that needs its own frozen snapshot.
- Call source status only when you need a full stale-source check beyond the loaded context.
- During normal coding, keep working locally; record only durable decisions, dead ends, source conclusions, and evidence.
- Sequence state-changing Agentpack calls; do not run them in parallel with audit, status, or checkpoint calls.
- Keep verification pending during a coherent fix loop; record aggregated intermediate evidence and checkpoints, then record a final verdict only after edits end.
- Use full safe mode for risky or release-like changes: record important findings as they happen and run the full verification loop.
- Park deferred work before switching to an unrelated task. Do not use accepted
  finalization as a pause; finalization means the task is complete or
  intentionally accepted as-is.

This keeps Agentpack useful without turning every micro-step into ledger traffic. The intended default cost is one context load near the start and one durable save near the end.

```text
record_source(path, summary)
record_decision(text, files, evidence)
record_dead_end(text, reason, files)
attach_evidence(kind, content, command, exitCode)
```

Good source summaries are conclusions, not file descriptions:

```text
src/integrations/install.ts: install uses a dry-run plan by default and writes only project-local files with --write.
```

Good dead ends prevent repeated work:

```text
Do not put a project-specific --root or cwd in the global ~/.codex/config.toml Agentpack entry; use repo-local .codex/config.toml so each repo resolves its own .agentpack state.
```

## End A Meaningful Step

Checkpoint when the repo reaches a coherent state:

```text
checkpoint(
  summary: "Safe MCP install flow is implemented and tested.",
  status: "Codex MCP setup can be dogfooded in this repo.",
  nextActions: ["Run through the handoff demo with a fresh session."]
)
```

Git still owns code history. Agentpack owns task memory.

## What To Watch

While dogfooding, look for friction:

- Did the agent call `load_context` early enough without repeating status checks unnecessarily?
- Were unchanged sources avoided when recorded conclusions were enough?
- Did `record_source` capture only reusable source conclusions instead of one event per changed file?
- Were state-changing Agentpack calls sequenced so audits read the latest state?
- Were decisions and dead ends recorded at useful moments?
- Was evidence too noisy or too thin?
- Was the checkpoint useful to the next session?

If the answer is no, improve the tool contract or the project instructions before adding larger features.
