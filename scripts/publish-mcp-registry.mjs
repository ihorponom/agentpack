import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

export const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 240_000];

export function isNpmPropagationError(output, packages) {
  const match = output.match(/server returned status 400:\s*(\{[^\n]*\})/u);
  if (!match) return false;
  try {
    const response = JSON.parse(match[1]);
    return response.status === 400 && Array.isArray(response.errors) && response.errors.length > 0
      && response.errors.every(error => typeof error.message === "string" && packages.some(pkg =>
        error.message.startsWith(`registry validation failed for package `)
        && error.message.includes(`NPM package '${pkg.identifier}' exists, but version '${pkg.version}' was not found (status: 404).`)));
  } catch {
    return false;
  }
}

export async function publishWithRetry(packages, {
  run = () => spawnSync("./mcp-publisher", ["publish"], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024
  }),
  sleep = wait,
  stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text)
} = {}) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const result = run();
    stdout(result.stdout || "");
    stderr(result.stderr || "");
    if (result.error || result.signal) {
      stderr(`Registry publisher did not complete: ${result.error?.message || result.signal}\n`);
      return 1;
    }
    if (result.status === 0) return 0;
    const status = Number.isInteger(result.status) && result.status > 0 && result.status < 256 ? result.status : 1;
    if (!isNpmPropagationError(`${result.stdout || ""}\n${result.stderr || ""}`, packages)) return status;
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      stderr("npm propagation retry limit reached; retry only the Registry job after the version is visible.\n");
      return status;
    }
    stderr(`npm version is not yet visible to the Registry; retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${delay / 1000}s.\n`);
    await sleep(delay);
  }
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = JSON.parse(readFileSync("server.json", "utf8"));
    const packages = server.packages.filter(pkg => pkg.registryType === "npm"
      && typeof pkg.identifier === "string" && typeof pkg.version === "string");
    if (!packages.length) throw new Error("No npm package/version configured in server.json");
    process.exitCode = await publishWithRetry(packages);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
