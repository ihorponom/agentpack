# Releasing Agentpack

This page is the maintainer runbook. Agentpack publishes to npm as `agentpack-cli` from GitHub Actions. npm provenance signs each version through a Trusted Publisher. The repository stores no `NPM_TOKEN`.

## Workflows

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `ci.yml` | Push and pull request to `main` | On Node 20 and Node 22: `npm ci`, build, `npm test`, `npm run mcp:smoke`, `npm pack --dry-run --ignore-scripts`. |
| `publish.yml` | A published GitHub Release, or a manual run | Builds, tests, publishes to npm, then publishes MCP Registry metadata. |
| `mirror-codeberg.yml` | Push to `main`, push of a `v*` tag, or a manual run | Pushes `main` and tags to the Codeberg mirror. |

## Trusted Publisher Setup

In npmjs.com, open the package `agentpack-cli`. Go to Settings, then Trusted Publisher. Set these values:

- Repository: `ihorponom/agentpack`
- Workflow: `publish.yml`
- Environment: empty

Other settings:

- `publish.yml` requests `id-token: write`. This lets it present a short-lived OIDC token that npm checks against the Trusted Publisher.
- `publish.yml` uses Node 24. Its bundled npm is new enough for Trusted Publishing.
- `publishConfig.provenance: true` in `package.json` adds the provenance attestation to workflow publishes.

## Release Rules

- A normal push to `main` never publishes to npm.
- Keep feature and docs commits separate from the version bump.
- Make the version bump its own release commit, after the feature branch is reviewed and pushed.
- Name the release commit `Prepare release X.Y.Z`.
- Run the pre-flight checklist again after the version bump. The package metadata and the tarball change. `agentpack release preflight` passes only after you commit and push the bump.
- Docs-only commits after a verified release do not need the full pre-flight. Review the diff and run light checks such as `git diff --check`.
- After a release, new commits on `main` belong to the next release. Do not describe them as available in the published npm version.

## Cutting a Release

1. Make the release commit.

   ```bash
   npm version patch --no-git-tag-version
   VERSION="$(node -p "require('./package.json').version")"
   git add package.json package-lock.json
   git commit -m "Prepare release ${VERSION}"
   ```

2. Push the release commit.

   ```bash
   git push origin main
   ```

3. Run `agentpack release preflight` again. It needs a clean, pushed `main`. Fix any failed check before you continue.

4. Create and push the tag.

   ```bash
   git tag "v${VERSION}"
   git push origin "v${VERSION}"
   ```

5. Create the GitHub Release. The publish workflow starts when the Release is published.

   ```bash
   gh release create "v${VERSION}" \
     --title "v${VERSION}" \
     --generate-notes
   ```

6. Edit the release notes on GitHub. `--generate-notes` gives a draft. Keep the final notes short. Recent releases list the changes as a few bullet points.

The `publish` job then does these steps:

1. Check out the tag.
2. Install dependencies with `npm ci`.
3. Build with `npm run build`.
4. Run the tests with `npm test`.
5. Check that the `package.json` version matches the release tag. This step runs only for a Release event.
6. Publish with `npm publish --access public`.

The `Publish MCP Registry metadata` job runs after `publish` succeeds. It is a separate job, so you can retry it alone.

1. It installs `mcp-publisher` from the latest GitHub release. The version is not pinned.
2. It sets the `version` fields in `server.json` to the `package.json` version.
3. It logs in with GitHub OIDC and publishes the metadata.

The committed `server.json` keeps an old version (1.6.0) on purpose. Only the workflow changes it.

The `Publish MCP Registry metadata` job retries only one failure. The Registry returns a 400 response that wraps a 404 message, because npm has not yet shown the new version. The job retries up to five times, after 15, 30, 60, 120, and 240 seconds. It stops at once on authentication, schema, or other errors.

Watch the run at <https://github.com/ihorponom/agentpack/actions>. When the run ends, the npm package page shows the `Provenance` badge.

## Manual Run

Use a manual run only if the npm publish job failed before npm accepted the version.

Do not use a manual run to publish a new version. A manual run skips the tag and version check. It publishes the version in `package.json` at the selected ref.

1. Open GitHub, then Actions, then "Publish to npm", then Run workflow.
2. Select the tag of the version that failed. Select `main` only if `package.json` on `main` has that same version. Set `dry-run` to `true`. Start the run.
3. Check that the run succeeds. A dry run runs `npm publish --dry-run`. It skips the Registry job.
4. Run the workflow again with `dry-run` set to `false`.

If the `Publish MCP Registry metadata` job fails after npm succeeds, do not start the workflow again. npm versions are immutable. In Actions, select **Re-run failed jobs**. This retries only the Registry job. The Registry holds metadata for a package that is already published, so this recovery does not touch the npm release.

## Pre-flight checklist

Complete these checks before `npm version`:

- `agentpack release preflight` reports no failed checks. It does not check `mcpName` or `server.json`.
- `npm test` passes locally.
- `agentpack doctor` reports no errors. Source cache health shows no changed or missing source conclusions. To review warnings, run `agentpack source status --changed --missing`.
- `npm pack --dry-run` shows the expected files and a reasonable tarball size.
- README and docs match the version that you will ship.
- `package.json` `mcpName` and the name in `server.json` match.
- You tested changes to install flows, MCP launchers, or generated client config in at least one other repository. Generated snippets point to stable package entry files, not to temporary shell shims.
- Command help works from the built or packed CLI. Run `agentpack resume --help`. Help must not run the command or need an initialized ledger.
- A clean installed package passes the handoff flow: `init`, `doctor`, the Task Passport lifecycle, `resume`, and `install codex --dry-run`. Resume output for a closed task labels its next actions as historical.

Do not release while the basic install, doctor, MCP startup, or resume flows are suspect. Prefer one follow-up patch over several rushed releases that change the same core workflow.

Do not change `SCHEMA_VERSION` in `src/core/store.ts` without a Passport and state migration in the same release. `validateTaskPassport` accepts only `schemaVersion` 1 (the current `SCHEMA_VERSION`) and 2. Version 2 is for Passports with additional repositories. Any other value fails validation. Task commands fail for that Passport. The task gate reports `passport-unreadable`, and it blocks only in block mode.

## Rollback

`npm unpublish agentpack-cli@<version>` works only within 72 hours of publish. It also needs that no other package depends on the version. Prefer a new patch version with the fix.

If a version has a bug and unpublish is closed, deprecate it:

```bash
npm deprecate agentpack-cli@<version> "Use <newer-version>: <reason>"
```
