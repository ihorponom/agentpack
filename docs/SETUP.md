# Development Setup

Agentpack is a TypeScript and Node.js project with a conservative npm setup. The npm package is `agentpack-cli`. The installed command is `agentpack`.

## Requirements

- Node.js 20 or later (`engines` in `package.json`)
- Node.js 22 LTS for development (recommended)
- npm 10 or later

CI tests Node 20 and Node 22. The release workflow uses Node 24.

The runtime package has zero third-party dependencies. Development uses only TypeScript and the Node type definitions.

## macOS Setup With fnm

1. Install fnm and Node 22:

   ```bash
   brew install fnm
   fnm install 22
   fnm default 22
   ```

2. Add this line to `~/.zshrc`:

   ```bash
   eval "$(fnm env --use-on-cd --shell zsh)"
   ```

3. Restart the terminal.
4. Check the versions:

   ```bash
   node --version
   npm --version
   ```

## Install Dependencies

```bash
npm ci --ignore-scripts
```

The repository has an `.npmrc` file:

```text
audit=true
fund=false
ignore-scripts=true
package-lock=true
save-exact=true
```

## Run Checks

```bash
npm test
npm run smoke
npm run mcp:smoke
```

- `npm test` builds the project and runs the test suite.
- `npm run smoke` builds the project and runs `agentpack --help`.
- `npm run mcp:smoke` builds the project and starts the MCP server in a smoke test.

## Publishing

The release workflow uses npm Trusted Publishing through GitHub Actions OIDC. Releases include provenance. [RELEASING.md](RELEASING.md) describes the release flow.
