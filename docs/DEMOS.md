# Agentpack Demo Outlines

Use these as short demos for the durable task continuity story. The point is not that Agentpack saves chat history; the point is that the repo keeps enough task state for the next agent or session to continue without rediscovering everything.

The CLI flavor of the continuity story in one take — an agent's session state is recorded, the session dies, `agentpack resume` brings the task back:

![CLI demo: task state is recorded during session 1, and a fresh session restores it with agentpack resume](../assets/demo-cli.gif)

In the normal MCP-connected workflow, this is hybrid: generated project instructions tell the agent when to load context, record durable state, and checkpoint progress. The CLI commands below are the manual equivalent, useful for demos, web-chat fallback, or telling an agent exactly what to do before a large refactor.

## New Workspace, Same Task State

Scenario: a developer continues the same task after opening the repo from a different workspace path, a copied sandbox, or a restored backup. The old chat or IDE context is gone, but the repo-local task state is still available.

1. In a sample repo, run these commands manually, or ask the connected agent to record this durable state:

```bash
agentpack init
agentpack record decision "Use the existing auth middleware instead of adding a second request guard."
agentpack source add src/auth.ts --summary "Auth middleware validates session cookies and attaches user context before route handlers."
agentpack checkpoint -m "Auth refactor context captured" --status "Ready to continue in a fresh workspace" --next "Update route tests"
```

2. Open the repo from a different workspace path or copied sandbox. For this local demo, copy the folder including `.agentpack/`; for a fresh git clone today, use `agentpack export` as a manual handoff instead.
3. Start a new Claude Code, Cursor, or Codex session in that workspace.
4. Start the new session with:

```bash
agentpack resume --preset agent --query "auth refactor"
agentpack source status
```

Expected takeaway: the new workspace/session can recover the task goal, source conclusions, and next action without reopening the old chat. Agentpack is preserving reviewed task state, not relying on the client remembering a folder name.

## Compact Or New Session Resume

Scenario: a long coding session gets compacted, disconnected, or restarted.

1. During the first session, record only durable state manually or let the connected agent do it through MCP:

```bash
agentpack record decision "Keep global client writes explicit; only claude-desktop --write may update the Desktop user config."
agentpack record dead-end "Relying on GUI apps to inherit shell PATH is unreliable for MCP launchers."
agentpack checkpoint -m "Installer behavior decided" --status "Need Desktop docs and tests" --next "Update Claude Desktop snippet"
```

2. Start a new chat or agent session in the same repo.
3. Ask the agent to begin by loading Agentpack context, or run:

```bash
agentpack resume --preset agent --query "Desktop installer"
agentpack source status
```

Expected takeaway: the new session gets the goal, status, decisions, dead ends, source-cache guidance, and next action under a compact budget. Lower token usage is a side effect of less rediscovery; the main value is continuity.

## Monorepo Focus With Scoped Tasks

Scenario: one repo holds several parts (`api/`, `frontend/`, `cron/`, `service/`), and each work slice should keep the agent inside one part. One ledger serves the pack root; short Task Passports carry the folder boundary.

1. Initialize once and install the client surface with its native task gate:

```bash
agentpack init
agentpack install claude --write   # or codex | cursor
```

2. When work enters one part of the project, start a short scoped task manually, or let the connected agent do it through MCP:

```bash
agentpack task start "Fix token expiry in API" \
  --objective "Refresh tokens expire early due to TTL in seconds vs ms" \
  --write-scope api \
  --next "Fix TTL conversion and cover it with a focused test"
```

3. Work normally. The native pre-tool gate checks every edit against the scope before it happens; simulate the boundary manually with:

```bash
agentpack task gate --file api/auth/token.ts        # inside the scope: silent
agentpack task gate --file frontend/utils/token.ts  # outside: warning
```

In the default `warn` mode the finding lands in the agent's context as feedback it can act on; with `gateMode: "block"` in `.agentpack/config.json`, the native Claude Code, Codex, and Cursor hooks deny the edit outright.

4. Finish the slice, then start the next scoped task when the work moves to another part:

```bash
agentpack task verify --status passed --evidence evt_... --summary "API token tests pass"
agentpack task finalize
agentpack task start "Dedupe token utils" --write-scope frontend
agentpack task list
```

Expected takeaway: `task list` shows which part each short task owned via its scope, and the gate keeps a session focused on one folder — enforcement, not convention. The ledger stays whole, and per-task context stays small instead of accumulating the entire monorepo.

## Handoff Continuity Smoke

Scenario: before a release, verify that an installed Agentpack package can create
a handoff that a fresh agent can understand from repo-local task state alone.

1. In a clean scratch repo, install Agentpack from the current tarball or the
   published package, then initialize the repo:

```bash
agentpack --version
agentpack resume --help
agentpack init
agentpack doctor
```

2. Create a tiny source file, record the durable source conclusion, and start a
   Task Passport with a concrete objective, constraint, write scope, and next
   action:

```bash
agentpack source add README.md --summary "README describes the scratch task and what the next agent should verify."
agentpack task start "Check handoff clarity" \
  --objective "Confirm a fresh agent can understand the task from resume output alone" \
  --constraint "Do not rely on chat-only context" \
  --write-scope README.md \
  --next "Inspect resume output as the next agent handoff"
```

3. Inspect the handoff:

```bash
agentpack task status
agentpack task audit
agentpack resume --preset chat --query "handoff clarity"
agentpack install codex --dry-run
```

4. Record the result and finalize the task:

```bash
agentpack evidence add --kind dogfood --content "Resume exposed the task objective, constraint, write scope, source conclusion, verification state, and next action."
agentpack task verify --status passed --evidence evt_... --summary "Fresh-agent handoff is understandable from Agentpack state alone."
agentpack task finalize
agentpack resume --preset quick --query "handoff clarity"
```

Expected takeaway: the fresh-agent handoff should show the current Task
Passport, source-cache conclusion, verification state, and evidence without
requiring old chat context. If the task is closed, any remaining task next
actions should be clearly labeled as historical rather than active work.

## Multi-Client Repo Setup

Scenario: a developer wants the same repo task state available in more than one coding-agent client.

1. Initialize the repo once:

```bash
agentpack init
```

2. Install only the client surfaces needed for this repo. After this, MCP-connected agents can use Agentpack through their generated instructions:

```bash
agentpack install codex --write
agentpack install claude --write
agentpack install cursor --write
agentpack install claude-desktop --write
```

3. On macOS, the Claude Desktop installer reports and merges the repo-specific
   entry automatically. Review the generated snippet only as a recovery
   fallback, then restart Claude Desktop.
4. Verify the setup:

```bash
agentpack doctor
```

Expected takeaway: `init` creates the repo ledger once, each `install` command configures one client, and `doctor` shows which repo-specific MCP server key points at the current pack root. If Claude Desktop lists several Agentpack servers, use the server/tool group whose key matches this repo.
