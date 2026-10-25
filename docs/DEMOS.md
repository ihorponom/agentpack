# Agentpack Demo Outlines

Use these short demos to show durable task continuity. Agentpack does not save chat history. The repository keeps enough task state for the next agent or session to continue without a new investigation.

The GIF shows the CLI flow in one take. A session records task state. The session ends. `agentpack resume` brings the task back.

![CLI demo: task state is recorded during session 1, and a fresh session restores it with agentpack resume](../assets/demo-cli.gif)

In the normal MCP workflow, the generated project instructions tell the agent when to load context, record durable state and save checkpoints. The CLI commands below do the same by hand. Use them for demos, for web-chat fallback, or to tell an agent exactly what to record before a large change.

Run each demo in a fresh Git repository with at least one commit.

## New workspace, same task state

Situation: a developer clones the repository on another machine. `agentpack init` excludes `.agentpack/` from Git, so the clone has no ledger. A bundle carries the task across.

1. In the original repository, initialize the ledger and start a Task Passport:

```bash
agentpack init
agentpack task start "Refactor auth middleware" \
  --objective "Replace the duplicate request guard with the existing auth middleware" \
  --constraint "Keep the session cookie format unchanged" \
  --write-scope src \
  --next "Update route tests"
```

2. Record a source conclusion and a checkpoint:

```bash
agentpack source add src/auth.ts --summary "Auth middleware validates session cookies and attaches user context before route handlers."
agentpack checkpoint -m "Auth refactor context captured" --status "Ready to continue in a fresh clone" --next "Update route tests"
```

3. Export the task to a bundle file:

```bash
agentpack bundle export --task current --output auth.agentpack-bundle.json --source src/auth.ts
```

4. Clone the repository. Copy the bundle file into the clone.
5. In the clone, create a ledger and import the bundle:

```bash
agentpack init
agentpack bundle import auth.agentpack-bundle.json --write
```

6. Select the imported task. The import leaves it parked. Then read the handoff:

```bash
ID=$(agentpack task list | awk 'NR==1{print $2}')
agentpack task switch "$ID"
agentpack resume --preset agent --query "auth"
agentpack task handoff
```

Expected result: the clone shows the Passport with its objective, constraint, write scope and next action. It shows the source conclusion for `src/auth.ts`. `task handoff` shows the latest task checkpoint. The bundle carries the Passport, the source conclusions that you select with `--source` (without it, none), its evidence and the latest task checkpoint. It does not carry ledger-level decisions or dead ends. A source conclusion imports only if the file in the clone has the same hash.

## Compact or new session resume

Situation: a long coding session is compacted, disconnected or restarted.

1. In the first session, start a Task Passport and record only durable state. The connected agent can do this through MCP.

```bash
agentpack task start "Add Claude Desktop installer" \
  --objective "Keep global client writes explicit" \
  --constraint "Only claude-desktop --write may update the Desktop user config" \
  --write-scope src/integrations \
  --next "Update the Claude Desktop snippet"
agentpack record decision "Keep global client writes explicit; only claude-desktop --write may update the Desktop user config."
agentpack record dead-end "Relying on GUI apps to inherit shell PATH is unreliable for MCP launchers."
agentpack checkpoint -m "Installer behavior decided" --status "Need Desktop docs and tests" --next "Update the Claude Desktop snippet"
```

2. Start a new chat or agent session in the same repository.
3. Ask the agent to load Agentpack context first, or run:

```bash
agentpack resume --preset agent --query "Desktop installer"
agentpack source status
```

Expected result: the new session gets the Passport (objective, constraint, write scope, status and next action), the decision and the dead end. It gets them within a compact budget. Less rediscovery also lowers token use. Continuity is the main value.

## Monorepo focus with scoped tasks

Situation: one repository holds several parts (`api/`, `frontend/`, `cron/`, `service/`). Each task must stay in one part. One ledger serves the pack root (the directory that contains `.agentpack/`). Short Passports carry the folder boundary.

1. Initialize once. Install the client surface with its native task gate:

```bash
agentpack init
agentpack install claude --write   # or codex | cursor
```

2. When work enters one part, start a scoped task. The connected agent can do this through MCP.

```bash
agentpack task start "Fix token expiry in API" \
  --objective "Refresh tokens expire early due to TTL in seconds vs ms" \
  --write-scope api \
  --risk low \
  --next "Fix TTL conversion and cover it with a focused test"
```

3. Check the boundary by hand:

```bash
agentpack task gate --file api/auth/token.ts        # inside the scope: silent
agentpack task gate --file frontend/utils/token.ts  # outside: warning
```

The installed native gate checks the paths that supported edit tools report: Claude Code `Edit|Write|MultiEdit|NotebookEdit`, Codex `apply_patch` and Cursor `Write|Delete`. Codex hooks must also be reviewed and trusted in the client.

In the default `warn` mode, Claude Code and Codex receive warning feedback. Cursor allows the action silently. With `gateMode: "block"`, enabled hooks deny supported edits that break the task boundary. The hooks are not a filesystem sandbox. Shell commands, other tools and edits outside the hooked client can bypass them.

4. Finish the slice. Capture a real evidence id. Put the full HEAD on its own `Reviewed HEAD` line, because the scope is code.

```bash
EVID=$(agentpack evidence add --kind test-output --content "Focused API token tests: 3 passed, 0 failed. The TTL conversion is correct. Not covered: refresh flow end to end.
Reviewed HEAD: $(git rev-parse HEAD)" | awk '{print $3}')
agentpack task verify --status passed --evidence "$EVID" --summary "API token tests pass"
agentpack task update --clear-next-actions
agentpack checkpoint -m "Token expiry fixed" --status "Verified"
agentpack task finalize
```

5. Start the next scoped task when work moves to another part:

```bash
agentpack task start "Dedupe token utils" --write-scope frontend
agentpack task list --all
```

Expected result: `task finalize` completes the first task with no advisories. `task list --all` shows the owning scope of each task, including completed tasks. Plain `task list` shows only open work. The gate checks the boundary for supported edit tools. The ledger stays whole, and the context of each task stays small.

## Handoff continuity smoke

Situation: before a release, check that an installed Agentpack package can create a handoff. A fresh agent must understand it from repository state alone.

1. In a clean scratch repository, install Agentpack from the tarball or the published package. Then initialize the repository:

```bash
agentpack --version
agentpack resume --help
agentpack init
agentpack doctor
```

2. Create `README.md` if it does not exist, and commit it. Record a source conclusion. Start a Passport with an objective, a constraint, a write scope, a risk level and a next action:

```bash
agentpack source add README.md --summary "README describes the scratch task and what the next agent should verify."
agentpack task start "Check handoff clarity" \
  --objective "Confirm a fresh agent can understand the task from resume output alone" \
  --constraint "Do not rely on chat-only context" \
  --write-scope README.md \
  --risk low \
  --next "Inspect resume output as the next agent handoff"
```

3. Inspect the handoff:

```bash
agentpack task status
agentpack task audit
agentpack resume --preset chat --query "scratch task"
agentpack install codex --dry-run
```

`task audit` warns that verification is unknown. This is expected before step 4.

4. Record the result and finalize the task:

```bash
EVID=$(agentpack evidence add --kind test-output --content "Resume showed the task objective, constraint, write scope, source conclusion, verification state, and next action." | awk '{print $3}')
agentpack task verify --status passed --evidence "$EVID" --summary "Fresh-agent handoff is understandable from Agentpack state alone."
agentpack task update --clear-next-actions
agentpack checkpoint -m "Handoff smoke done" --status "Verified"
agentpack task finalize
agentpack resume --preset chat --query "scratch task"
```

Expected result: `task finalize` prints no advisories. The final resume shows the completed Passport, the source conclusion for `README.md`, the verification evidence and the checkpoint. Next actions of a completed task appear as historical, not as active work.

## Multi-client repository setup

Situation: a developer wants the same task state in more than one coding-agent client.

1. Initialize the repository once:

```bash
agentpack init
```

2. Install only the client surfaces that you need. Each install adds generated instructions that MCP-connected agents follow.

```bash
agentpack install codex --write
agentpack install claude --write
agentpack install cursor --write
agentpack install claude-desktop --write
```

3. On macOS, the Claude Desktop installer merges the repository entry into the Desktop configuration. This happens only if `~/Library/Application Support/Claude` exists. If it does not, the installer tells you to start Claude Desktop once and run the command again. Use the generated snippet only as a recovery fallback. Restart Claude Desktop.
4. Check the setup:

```bash
agentpack doctor
```

Expected result: `init` creates the ledger once. Each `install` command configures one client. `doctor` shows which repository-specific MCP server key points at the current pack root. If Claude Desktop lists several Agentpack servers, use the server and tool group whose key matches this repository.
