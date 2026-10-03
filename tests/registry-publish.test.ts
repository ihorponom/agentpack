import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../../scripts/publish-mcp-registry.mjs", import.meta.url));
const { isNpmPropagationError, publishWithRetry, RETRY_DELAYS_MS } = await import(pathToFileURL(helper).href);
const packages = [{ identifier: "agentpack-cli", version: "1.7.0" }];
const missing = "registry validation failed for package 0 (agentpack-cli): NPM package 'agentpack-cli' exists, but version '1.7.0' was not found (status: 404). A newly published release can take a moment to appear on the registry.";
const failure = (messages: string[]) => `Error: publish failed: server returned status 400: ${JSON.stringify({ status: 400, errors: messages.map(message => ({ message })) })}\n`;

function publisher(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentpack-registry-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "mcp-publisher");
  writeFileSync(file, "#!/usr/bin/env node\nprocess.stdout.write('publisher output\\n'); process.stderr.write(process.env.FIXTURE_ERROR || ''); process.exit(Number(process.env.FIXTURE_EXIT || 0));\n");
  chmodSync(file, 0o700);
  return { dir, file };
}

test("Registry propagation classifier requires only configured npm version 404 errors", () => {
  assert.equal(isNpmPropagationError(failure([missing]), packages), true);
  for (const output of ["HTTP 404", "unauthorized", failure(["invalid schema"]), failure([missing, "unauthorized"]),
    failure([missing.replace("1.7.0", "1.6.8")]), failure([missing.replaceAll("agentpack-cli", "other-package")]),
    "server returned status 400: {invalid}"]) {
    assert.equal(isNpmPropagationError(output, packages), false, output);
  }
});

test("Registry retry runs publish subprocesses, preserves output and stops after success", async t => {
  const { file } = publisher(t);
  const delays: number[] = [];
  const output: string[] = [];
  let calls = 0;
  const status = await publishWithRetry(packages, {
    run: () => spawnSync(process.execPath, [file, "publish"], { encoding: "utf8", env: {
      ...process.env, FIXTURE_EXIT: ++calls < 3 ? "1" : "0", FIXTURE_ERROR: calls < 3 ? failure([missing]) : ""
    } }),
    sleep: async (delay: number) => { delays.push(delay); },
    stdout: (text: string) => output.push(text), stderr: (text: string) => output.push(text)
  });
  assert.equal(status, 0);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [15_000, 30_000]);
  assert.equal(output.join("").match(/publisher output/g)?.length, 3);
  assert.match(output.join(""), /retry 1\/5/);
});

test("Registry retries are bounded and preserve exhausted subprocess status", async t => {
  const { file } = publisher(t);
  const delays: number[] = [];
  let calls = 0;
  let output = "";
  const status = await publishWithRetry(packages, {
    run: () => { calls++; return spawnSync(process.execPath, [file], { encoding: "utf8", env: {
      ...process.env, FIXTURE_EXIT: "7", FIXTURE_ERROR: failure([missing])
    } }); },
    sleep: async (delay: number) => { delays.push(delay); }, stdout: () => {}, stderr: (text: string) => { output += text; }
  });
  assert.equal(status, 7);
  assert.equal(calls, 6);
  assert.deepEqual(delays, RETRY_DELAYS_MS);
  assert.equal(delays.reduce((a, b) => a + b, 0), 465_000);
  assert.match(output, /retry limit reached/);
});

test("Registry permanent, spawn and timeout failures are not retried", async () => {
  for (const result of [
    { status: 7, stderr: failure(["unauthorized"]) },
    spawnSync("/nonexistent-agentpack-publisher", ["publish"], { encoding: "utf8" }),
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { encoding: "utf8", timeout: 20 })
  ]) {
    let calls = 0;
    const status = await publishWithRetry(packages, { run: () => { calls++; return result; },
      sleep: () => assert.fail("Permanent failures must not sleep"), stdout: () => {}, stderr: () => {} });
    assert.equal(status, result.status === 7 ? 7 : 1);
    assert.equal(calls, 1);
  }
});

test("Registry helper CLI reads synchronized server metadata and invokes the publisher", { skip: process.platform === "win32" }, t => {
  const { dir } = publisher(t);
  writeFileSync(path.join(dir, "server.json"), JSON.stringify({ packages: [{ registryType: "npm", ...packages[0] }] }));
  const result = spawnSync(process.execPath, [helper], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /publisher output/);
  writeFileSync(path.join(dir, "server.json"), JSON.stringify({ packages: [] }));
  const invalid = spawnSync(process.execPath, [helper], { cwd: dir, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /No npm package\/version/);
  assert.doesNotMatch(invalid.stdout, /publisher output/);
});
