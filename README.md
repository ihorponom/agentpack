# Agentpack

[![npm version](https://img.shields.io/npm/v/agentpack-cli)](https://www.npmjs.com/package/agentpack-cli)
[![CI](https://github.com/ihorponom/agentpack/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ihorponom/agentpack/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/agentpack-cli)](https://www.npmjs.com/package/agentpack-cli)
[![license](https://img.shields.io/npm/l/agentpack-cli)](LICENSE)
[![agentpack MCP server](https://glama.ai/mcp/servers/ihorponom/agentpack/badges/score.svg)](https://glama.ai/mcp/servers/ihorponom/agentpack)

Repo-native task continuity for AI coding agents.

> Agent memory remembers how you work. Agentpack remembers where the task stands.

Every session ends the same way: the context window gets compacted, the chat closes, the task waits until tomorrow. The next session starts without the task. It re-reads files, rediscovers decisions, and retries approaches that already failed.

Agentpack keeps a small, reviewable task ledger in `.agentpack/` inside your repo. Connected agents record durable state as they work: the goal, decisions, dead ends, verification evidence, and checkpoints. The next session loads it back and continues. That next session can be the same agent after compaction, a different client, or you returning next week.

![How Agentpack works: an agent records task state into .agentpack/ in the repo, and any next session, whether the same agent, another client, or later, continues from it](assets/continuity.svg)

Here it is live. In session 1, Claude Code investigates a flaky test and records what it learns through the Agentpack MCP tools. In session 2, the next day with an empty context, the agent loads the task state and picks up where the first session stopped, without re-investigating:

![Live demo: a Claude Code session records its findings through Agentpack MCP tools, and a fresh session the next day continues from the recorded task state](assets/demo.gif)

Prefer to try it by hand? The same flow driven from the CLI is in [docs/DEMOS.md](docs/DEMOS.md).

- **Local-first.** Plain files in your repo. No cloud, no telemetry, no network calls.
- **Agent-oriented.** A local MCP server plus generated project instructions (`AGENTS.md`, `CLAUDE.md`, Cursor rules) tell agents when to load and record state.
- **Human-friendly.** The same state is available through the CLI for inspection, debugging, and manual handoff.

## How is this different from agent memory?

Claude Code memory, Codex memories, and `CLAUDE.md` or `AGENTS.md` remember how to work: your preferences, project conventions, and facts that stay true. Agentpack records where the work is: the current task's goal, constraints, decisions, dead ends, next actions, and whether the result was verified.

| | Agent memory | Agentpack |
|---|---|---|
| Holds | Preferences, conventions, long-lived facts | The state of a specific task |
| Lives in | One client's profile or account | `.agentpack/` in the repo, local by default, portable with task bundles |
| Read by | That client only | Any MCP client: Claude Code, Codex, Cursor, Claude Desktop |
| Shape | Free-form notes recalled by relevance | A Task Passport with lifecycle, write scope, and verification bound to a commit |
| Staleness | Not tied to file changes | Source conclusions carry file hashes, so changed files are flagged |

Use both: memory for how you like to work, Agentpack for what the task needs next.

## Quick start

Requires Node.js >= 20.

```bash
npm install -g agentpack-cli

cd path/to/your/repo
agentpack init                     # once per repo
agentpack install claude --write   # per client: codex | claude | cursor | claude-desktop
```

Restart or reconnect the coding-agent client. From then on the agent loads Agentpack context at session start, records decisions and evidence while working, and checkpoints meaningful progress.

Run `agentpack doctor` to verify the setup, and `agentpack resume --preset agent --query "<topic>"` to see the task state yourself.

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for client-by-client setup, including what each installer writes and why.

## How it works

1. At session start, the agent loads compact Agentpack context: the current Task Passport, recent checkpoints, decisions, and reviewed conclusions about source files.
2. While working, it records what is worth keeping: decisions, approaches that failed, and verification evidence. Conclusions about files are stored with file hashes, so a later session can tell when a file has changed since. A matching hash means the file is unchanged, not that the conclusion is right.
3. At a natural stopping point, it creates a checkpoint with status, next actions, and git state.
4. The next session, in any MCP-connected agent, continues from that state instead of rebuilding it from chat history.

Each task gets a **Task Passport**: its goal, status, constraints, write scope, next actions, and verification. Tasks can be started, parked, switched, and finalized, which makes handoffs explicit.

An optional **task gate** warns when edits fall outside the active task. It uses native Claude Code, Codex, and Cursor hooks plus a pre-commit hook. It only warns by default; set `"gateMode": "block"` in `.agentpack/config.json` to stop such edits (see [docs/CLI.md](docs/CLI.md)).

Resume output stays within a rough token budget, so agents get the useful state back, not the whole history.

Codex, Claude Code, and Cursor installs also include an optional builder subagent for larger implementation work. The main agent says what it will hand off before using it; small tasks stay with the main agent.

## When it helps

- The context window is compacted mid-task and the next turn needs the state back.
- You start a fresh chat on an ongoing task.
- You switch between Claude Code, Cursor, Codex, or another MCP client.
- You return to a refactor or bugfix days later.
- Another agent continues from your checkpoint.
- You work across parts of a monorepo (`api/`, `frontend/`, `cron/`) with short scoped tasks, and the task gate keeps the agent inside the folder the current task owns.

Agentpack calls use some tokens too. The payoff is that the next session gets compact task state instead of re-reading unchanged files and re-explaining old decisions.

## Security posture

- Zero runtime dependencies, exact dev dependencies, committed lockfile, `ignore-scripts=true`.
- No telemetry and no network calls during normal CLI or MCP operation.
- Best-effort redaction of secret-looking values in stored context and handoff output.
- Releases are published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) (Trusted Publisher, no long-lived tokens); verify with `npm audit signatures`.

See [SECURITY.md](SECURITY.md) for the full policy.

## Documentation

- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): safe setup for Codex, Claude Code, Cursor, Claude Desktop, and git hooks
- [docs/CLI.md](docs/CLI.md): full CLI reference, budgets, and manual fallback workflows
- [docs/MCP.md](docs/MCP.md): the MCP server contract and tool list
- [docs/TASK-PASSPORT.md](docs/TASK-PASSPORT.md): task lifecycle, handoffs, and portable bundles
- [docs/DEMOS.md](docs/DEMOS.md): compact continuity demos you can run yourself
- [docs/VISION.md](docs/VISION.md): the strategic north star

## Contributing / local development

Clone the repo and use Node 20+:

```bash
npm ci --ignore-scripts
npm test
npm run mcp:smoke
node dist/src/agentpack.js --help
```

This repo uses Agentpack on itself through MCP. [docs/DOGFOOD.md](docs/DOGFOOD.md) describes the working protocol, [docs/SETUP.md](docs/SETUP.md) the full setup, and [docs/RELEASING.md](docs/RELEASING.md) the release process.

---

Mirror: [Codeberg](https://codeberg.org/ihorponom/agentpack). Issues, releases, and npm provenance stay on GitHub.
