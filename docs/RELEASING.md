# Releasing Agentpack

Agentpack publishes to npm as `agentpack-cli` from GitHub Actions, signed with
npm provenance via a Trusted Publisher. No `NPM_TOKEN` is stored in the repo.

## Trusted Publisher setup

- npmjs.com → package `agentpack-cli` → Settings → Trusted Publisher:
  - Repository: `ihorponom/agentpack`
  - Workflow: `publish.yml`
  - Environment: *(empty)*
- `.github/workflows/publish.yml` requests `id-token: write` so it can present
  a short-lived OIDC token that npm verifies against the Trusted Publisher
  binding.
- The publish workflow uses Node 24 so the bundled npm is new enough for
  Trusted Publishing without upgrading npm while npm is running.
- `publishConfig.provenance: true` in `package.json` makes workflow publishes
  include the provenance attestation.

## Cutting a release

Release discipline:

- A normal push to `main` never publishes to npm.
- Keep feature/docs commits separate from the version bump.
- Make the version bump as its own release-prep commit after the feature branch
  has been reviewed and pushed.
- Re-run pre-flight after the version bump, because the package metadata and
  tarball have changed.
- For small patch releases, write concise notes in the GitHub Release.
- After a release is published, new commits on `main` are next-release
  candidates. Do not describe unreleased commands or behavior as available in
  the already-published npm version.

```bash
# 1. After feature/code commits are reviewed and pushed, create a separate release-prep commit for the version bump.
#    Re-run full preflight after the version bump because package metadata and the tarball changed.
#    Docs-only commits after a verified release do not require full preflight; review the diff and run lightweight checks such as `git diff --check`.

npm version patch --no-git-tag-version
VERSION="$(node -p "require('./package.json').version")"

git add package.json package-lock.json
git commit -m "chore(release): prepare ${VERSION}"

# 2. Push the release-prep commit.
git push origin main

# 3. Create and push the tag.
git tag "v${VERSION}"
git push origin "v${VERSION}"

# 4. Create a GitHub Release for that tag. The publish workflow fires on
#    release: published.
gh release create "v${VERSION}" \
  --title "v${VERSION}" \
  --generate-notes
```

That's it. The workflow will:

1. Check out the tag.
2. Install dependencies with `npm ci`.
3. Build (`npm run build`).
4. Run tests (`npm test`).
5. Verify `package.json` version matches the release tag.
6. Publish with `npm publish --access public`.
7. In a separate, retryable job, synchronize `server.json` to that package
   version and publish MCP Registry metadata through GitHub OIDC.

Watch the run at <https://github.com/ihorponom/agentpack/actions>. When it
finishes, npm shows the green `Provenance` badge on the package page.

## Manual fallback

If the npm publish job fails before npm has accepted the version, re-run from
the Actions tab:

1. GitHub → Actions → "Publish to npm" → Run workflow.
2. Pick the tag (or `main`) and choose `dry-run: true` first to verify.
3. Re-run with `dry-run: false`.

Registry publication retries known npm version-propagation 404 errors up to
five times, with delays of 15, 30, 60, 120, and 240 seconds. Authentication,
schema, and other errors fail immediately.

If the separate `Publish MCP Registry metadata` job fails after npm succeeds,
do **not** start the workflow again: npm versions are immutable. In Actions,
use **Re-run failed jobs** to retry only that Registry job. The Registry is
metadata for the already-published package, so its recovery is independent of
the npm release.

## Pre-flight checklist

Before `npm version`:

- `agentpack release preflight` reports no failed checks.
- `npm test` is green locally.
- `agentpack doctor` reports no errors. For release-like handoff, source-cache
  health should show zero changed or missing records; review any source-cache
  warnings with `agentpack source status --changed --missing`.
- `npm pack --dry-run` shows the expected set of files and a reasonable
  tarball size.
- README and docs reflect the version about to ship.
- `package.json` `mcpName` and `server.json` name match, and the release
  workflow can publish the Registry metadata separately from npm.
- Changes to install flows, MCP launchers, or generated client config are
  tested in at least one other repository before release. Verify generated
  snippets point at stable package entrypoints, not transient shell shims.
- Command-specific help is checked from the built or packed CLI, especially
  `agentpack resume --help`, so help flags do not accidentally execute the
  command or require an initialized pack.
- Handoff clarity is checked with a clean installed package flow: `init`,
  `doctor`, Task Passport lifecycle, `resume`, and `install codex --dry-run`.
  Closed-task resume output should label remaining task next actions as
  historical, not active work.
- Do not cut a release while basic install, doctor, MCP startup, or resume flows
  are suspect. Prefer fixing and shipping one follow-up patch over rushing
  multiple releases that churn the same core workflow.
- Never bump `SCHEMA_VERSION` in `src/core/store.ts` without shipping a
  passport/state migration in the same release: `validateTaskPassport` hard-fails
  on any schemaVersion mismatch, and the gate then fails closed for every
  existing pack on the old schema.

## Rollback

`npm unpublish agentpack-cli@<version>` is allowed only within 72 hours of
publish, and only if no other package depends on it. Prefer publishing a
new patch version with the fix.

Deprecation (recommended when a version has a bug but unpublish is closed):

```bash
npm deprecate agentpack-cli@<version> "Use <newer-version>: <reason>"
```
