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

Use a Task Passport to define the objective, constraints, write scope, and
next actions. Inspect its lifecycle and branch before continuing an existing
task. Keep verification pending while changes are still being made; attach
evidence before recording a final result. Park unfinished work when switching
to another task, and finalize completed work.

See [Task Passport](TASK-PASSPORT.md) for lifecycle and verification behavior,
and [Optional Builder](INTEGRATIONS.md#optional-builder) for builder setup.
The recording tools below preserve reusable conclusions and verification
output for later inspection:

```text
record_source(path, summary)
record_decision(text, files, evidence)
record_dead_end(text, reason, files)
attach_evidence(kind, content, command, exitCode)
```

Good source summaries are conclusions, not file descriptions:

```text
src/integrations/install.ts: installs preview changes by default. With --write, codex, claude, and cursor update project files; claude-desktop also merges an entry into the user config on macOS.
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

- Could a fresh session recover the objective, constraints, and next action?
- Were stale source conclusions and changed task boundaries visible?
- Did recorded decisions and dead ends prevent repeated mistakes?
- Did evidence make the verification result understandable?
- Did the checkpoint provide useful context for continuing the work?

If the answer is no, improve the tool contract or the project instructions before adding larger features.
