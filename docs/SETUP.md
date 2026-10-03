# Development Setup

Agentpack is a TypeScript/Node project with a conservative npm setup. The npm package name is `agentpack-cli`; the installed command is `agentpack`.

## Requirements

- Node.js 22 LTS recommended
- npm 10+

The runtime package has zero third-party dependencies. Development uses TypeScript and Node type definitions only.

## macOS Setup With fnm

```bash
brew install fnm
fnm install 22
fnm default 22
```

Add this to `~/.zshrc`:

```bash
eval "$(fnm env --use-on-cd --shell zsh)"
```

Restart the terminal, then verify:

```bash
node --version
npm --version
```

## Install Dependencies

```bash
npm ci --ignore-scripts
```

The repo also includes `.npmrc` with:

```text
ignore-scripts=true
save-exact=true
package-lock=true
```

## Run Checks

```bash
npm test
npm run smoke
```

## Publishing Security Notes

The release workflow uses npm Trusted Publishing through GitHub Actions OIDC
and includes provenance. See [RELEASING.md](RELEASING.md) for the release flow.
