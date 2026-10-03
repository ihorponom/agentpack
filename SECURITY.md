# Security Policy

Agentpack is designed as a local-first developer tool. The default threat model assumes task state may contain source paths, command output, stack traces, and implementation notes that should stay on the developer machine.

## Security Commitments

- No telemetry.
- No network calls in normal CLI or MCP operation.
- No dependency install or download during `agentpack install`.
- No `postinstall` script.
- No shell hooks installed silently.
- No source upload or hosted sync.
- No full repository copy in `.agentpack/` by default.
- Runtime package has zero third-party dependencies.

## npm Supply Chain

The project uses a conservative npm setup:

- zero runtime dependencies
- exact dependency versions
- committed lockfile
- `ignore-scripts=true` for installs
- TypeScript compiler is the only build dependency
- the release workflow publishes from GitHub Actions via a Trusted Publisher OIDC binding
- versions published by that workflow ship with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) — no long-lived npm tokens are stored anywhere

## Verifying a release

To verify a downloaded version of `agentpack-cli`:

```bash
npm audit signatures
```

For workflow-published versions, the npmjs.com page for the package also shows a **Provenance** tab linking back to the exact commit, workflow run, and build environment that produced the tarball.

## Maintainer pre-publish checklist

Before cutting a new release, maintainers should run:

```bash
npm ci
npm audit signatures
npm test
npm pack --dry-run
```

The full release flow is documented in [docs/RELEASING.md](docs/RELEASING.md).

## Sensitive Data

Agentpack redacts common secret-looking values and configured environment variable values from generated context and key local records such as source summaries, evidence, checkpoints, replay output, and MCP context responses.

Redaction is best-effort, not a guarantee. Know its limits:

- The built-in pattern catches `key: value`-style assignments whose key ends with `api_key`, `api-key`, `apikey`, `token`, `secret`, or `password` right before the `:` or `=` separator (case-insensitive). `DATABASE_PASSWORD=...` is caught; `AWS_SECRET_ACCESS_KEY=...` is not, because `secret` is not immediately followed by the separator.
- Environment variable values are redacted only for the names listed in `config.json` `redactions`. `agentpack init` seeds `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and `NPM_TOKEN`; add your own names (for example `DATABASE_URL`, `SLACK_BOT_TOKEN`, cloud provider keys) per repo.
- Secrets with other key names, multiline secrets (private keys, certificates), and secrets embedded in structured output can pass through unredacted.

Users should treat `.agentpack/` as project-sensitive data, avoid pasting raw secrets into summaries or evidence, and review exported handoff files and bundles before sharing them.

## Local File Permissions

Files written inside `.agentpack/` (state, sources, events, task passports, evidence, checkpoints) and exported bundles are created with owner-only permissions (`0600` for files, `0700` for directories). Ledgers initialized by older versions keep their original directory permissions; on shared machines, tighten them with `chmod -R go-rwx .agentpack` if needed. Generated client integration files (`.mcp.json`, `AGENTS.md`, `CLAUDE.md`, `.cursor/`, `.codex/`) are project configuration and keep default permissions.

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories:

<https://github.com/ihorponom/agentpack/security/advisories/new>

This keeps the report hidden until a fix is ready and gives credit to the reporter. Do not open a regular issue for security problems.
