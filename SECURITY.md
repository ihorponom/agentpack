# Security Policy

Agentpack is a local-first developer tool. It assumes that task state can hold source paths, command output, stack traces, and implementation notes. This data stays on the developer machine.

## Security Commitments

- The runtime package has zero third-party dependencies.
- Agentpack sends no telemetry.
- Normal CLI and MCP operation makes no network calls.
- `agentpack install` downloads and installs nothing.
- The package has no `postinstall` script.
- Agentpack uploads no source and has no hosted sync.
- Agentpack does not copy the whole repository into `.agentpack/`.
- Versions that the release workflow publishes carry npm provenance (see below).
- Installers default to a dry run. They write hooks only with `--write`, so no hook is installed silently.

## npm Supply Chain

- The runtime has zero dependencies.
- Dependency versions are exact, and the lockfile is committed.
- `ignore-scripts=true` applies to installs.
- The build dependencies are `typescript` and `@types/node`.
- A GitHub Actions workflow publishes releases through a Trusted Publisher OIDC binding. No long-lived npm token exists.
- Versions that this workflow publishes carry [npm provenance](https://docs.npmjs.com/generating-provenance-statements).

## Verifying a Release

To verify a downloaded `agentpack-cli` version, run:

```bash
npm audit signatures
```

For versions that the workflow published, the package page on npmjs.com has a **Provenance** tab. It links to the exact commit, workflow run, and build environment of the tarball.

## Maintainer Pre-Publish Checklist

Before a release, maintainers run:

```bash
npm ci
npm audit signatures
npm test
npm pack --dry-run
```

[docs/RELEASING.md](docs/RELEASING.md) describes the full release flow.

## Sensitive Data

Agentpack redacts values that look like secrets. It also redacts the values of configured environment variables. Redaction applies to generated context and to key local records: source conclusions, evidence, checkpoints, replay output, and MCP context responses.

Redaction is best-effort. It does not guarantee that a secret is removed. Know these limits:

- The built-in pattern matches `key: value` and `key=value` text. The key must end with `api_key`, `api-key`, `apikey`, `token`, `secret`, or `password`, directly before `:` or `=`. The match is not case-sensitive. `DATABASE_PASSWORD=...` is caught. `AWS_SECRET_ACCESS_KEY=...` is not, because `secret` is not directly before the separator.
- A redacted value ends at the first space or quote. For `password: "two words"`, only the first word is redacted.
- Agentpack redacts an environment variable value only if two conditions are true. The variable name is in `redactions` in `.agentpack/config.json`, and the variable is set in the environment of the Agentpack process. `agentpack init` seeds `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and `NPM_TOKEN`. Add your own names for each repository, such as `DATABASE_URL` or `SLACK_BOT_TOKEN`.
- Secrets with other key names, multiline secrets (private keys, certificates), and secrets in structured output can pass through.

Treat `.agentpack/` as sensitive project data. Do not paste raw secrets into summaries or evidence. Review exported handoff files and bundles before you share them.

## Data Agentpack Stores or Reads

- **Checkpoints.** A checkpoint stores `git-status.txt` and a redacted git diff in `diff.patch`. The diff is on by default (`includeGitDiff: true`). To stop it, set `"includeGitDiff": false` in `.agentpack/config.json`. The diff can still contain secrets that redaction misses.
- **Usage reports.** `agentpack usage report` and `agentpack usage link` read Claude Code and Codex session transcripts outside the repository. Claude Code transcripts are in `~/.claude/projects/<worktree>` (or under `CLAUDE_CONFIG_DIR`). Codex transcripts are in `~/.codex/sessions` (or under `CODEX_HOME`). The ledger stores links to the sessions that you choose in `.agentpack/usage/<id>.json`.
- **Cursor allow list.** `agentpack install cursor --write` allows the read-only Agentpack MCP tools in `.cursor/cli.json`: `bundle_import_plan`, `bundle_inspect`, `diff`, `load_context`, `release_preflight`, `replay`, `resume`, `source_status`, `task_audit`, `task_handoff`, `task_list`, `task_status`, and `usage_report`. Tools that change state need approval.
- **Claude Desktop config.** `agentpack install claude-desktop --write` merges one entry into the user-global Claude Desktop config. If a config exists, the installer first saves a copy as `claude_desktop_config.json.agentpack-backup` in the same directory. All other installers write only inside the project.

## Local File Permissions

Agentpack creates the ledger with owner-only permissions. Files in `.agentpack/` (state, sources, events, Passports, evidence, checkpoints) and exported bundles use `0600`. Directories use `0700`. Ledgers from older versions keep their original directory permissions. On a shared machine, run `chmod -R go-rwx .agentpack`.

Installers create client files with default permissions (`0644` for files, `0755` for the Git hook):

- `.mcp.json`, `AGENTS.md`, `CLAUDE.md`
- `.codex/`, `.cursor/`
- `.claude/` (`settings.json` and `agents/builder.md`)
- `.git/hooks/pre-commit`

Generated files in `.agentpack/instructions/` also use `0644`. The `0700` directory still limits access to the owner.

The Claude Desktop backup uses `0600`. The config keeps its existing mode. A new config uses `0600`.

## Reporting a Vulnerability

Report security issues privately through GitHub Security Advisories:

<https://github.com/ihorponom/agentpack/security/advisories/new>

The report stays hidden until a fix is ready. The reporter receives credit. Do not open a regular issue for a security problem.
