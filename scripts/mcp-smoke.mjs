#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "src", "agentpack.js");
const workspace = mkdtempSync(path.join(tmpdir(), "agentpack-mcp-smoke-"));

let server;

try {
  writeFileSync(path.join(workspace, "index.js"), "console.log('agentpack mcp smoke')\n", "utf8");
  runCli(["init"]);
  runCli(["set", "goal", "Exercise Agentpack MCP smoke flow."]);

  server = spawn(process.execPath, [cliPath, "mcp", "--root", workspace], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const client = createJsonRpcClient(server);

  const modernMeta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "agentpack-smoke", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
  const discover = await client.request("server/discover", { _meta: modernMeta });
  assertIncludes(discover.result?.supportedVersions || [], "2026-07-28", "server/discover advertises MCP 2026-07-28");
  assertEqual(discover.result?.resultType, "complete", "server/discover returns a modern complete result");
  assertEqual(discover.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "agentpack", "modern responses identify the Agentpack server");
  assertModernCachePolicy(discover, "server/discover");

  const modernToolsResponse = await client.request("tools/list", { _meta: modernMeta });
  assertEqual(modernToolsResponse.result?.resultType, "complete", "modern tools/list returns a complete result");
  assertIncludes(modernToolsResponse.result?.tools?.map((tool) => tool.name) || [], "load_context", "modern tools/list exposes Agentpack tools");
  assertModernCachePolicy(modernToolsResponse, "tools/list");

  const modernPromptsResponse = await client.request("prompts/list", { _meta: modernMeta });
  assertModernCachePolicy(modernPromptsResponse, "prompts/list");

  const modernResourcesResponse = await client.request("resources/list", { _meta: modernMeta });
  assertModernCachePolicy(modernResourcesResponse, "resources/list");

  const modernResourceTemplatesResponse = await client.request("resources/templates/list", { _meta: modernMeta });
  assertEqual(modernResourceTemplatesResponse.result?.resourceTemplates?.length, 0, "resources/templates/list returns no resource templates");
  assertModernCachePolicy(modernResourceTemplatesResponse, "resources/templates/list");

  const modernResourceResponse = await client.request("resources/read", {
    _meta: modernMeta,
    uri: "agentpack://resume/latest"
  });
  assertModernCachePolicy(modernResourceResponse, "resources/read");

  const initialize = await client.request("initialize", {});
  assertEqual(initialize.result?.serverInfo?.name, "agentpack", "initialize returned the Agentpack server name");
  assertEqual(initialize.result?.resultType, undefined, "legacy initialize response stays unchanged");

  const toolsResponse = await client.request("tools/list", {});
  assertEqual(toolsResponse.result?.ttlMs, undefined, "legacy tools/list omits ttlMs");
  assertEqual(toolsResponse.result?.cacheScope, undefined, "legacy tools/list omits cacheScope");
  const toolNames = toolsResponse.result?.tools?.map((tool) => tool.name).sort() || [];
  for (const expected of ["bundle_export", "bundle_import", "bundle_import_plan", "bundle_inspect", "load_context", "record_decision", "record_source", "release_preflight", "resume", "source_status", "task_audit", "task_finalize", "task_handoff", "task_list", "task_park", "task_start", "task_status", "task_switch", "task_update", "task_update_verification"]) {
    assertIncludes(toolNames, expected, `tools/list includes ${expected}`);
  }
  for (const name of ["load_context", "resume"]) {
    const tool = toolsResponse.result?.tools?.find((candidate) => candidate.name === name);
    const presets = tool?.inputSchema?.properties?.preset?.enum || [];
    assertEqual(presets.length, 4, `${name} exposes four budget presets`);
    for (const preset of ["quick", "chat", "agent", "deep"]) {
      assertIncludes(presets, preset, `${name} exposes the ${preset} preset`);
    }
  }

  let invalidPresetError = "";
  try {
    await client.request("tools/call", {
      name: "load_context",
      arguments: { preset: "small" }
    });
  } catch (error) {
    invalidPresetError = String(error?.message || error);
  }
  assertMatch(invalidPresetError, /Unknown budget preset: small/, "load_context rejects unknown presets");

  await client.request("tools/call", {
    name: "record_decision",
    arguments: {
      text: "MCP smoke can record decisions.",
      files: ["index.js"]
    }
  });

  await client.request("tools/call", {
    name: "record_source",
    arguments: {
      path: "index.js",
      summary: "Temporary smoke source inspected through MCP."
    }
  });

  const sourceStatus = await client.request("tools/call", {
    name: "source_status",
    arguments: {}
  });
  assertMatch(sourceStatus.result?.content?.[0]?.text || "", /UNCHANGED index\.js/, "source_status reports unchanged source");

  const initialAudit = await client.request("tools/call", {
    name: "task_audit",
    arguments: {}
  });
  assertMatch(initialAudit.result?.content?.[0]?.text || "", /No current task passport/, "task_audit reports missing task before start");

  const releasePreflight = await client.request("tools/call", {
    name: "release_preflight",
    arguments: {}
  });
  assertMatch(releasePreflight.result?.content?.[0]?.text || "", /Agentpack release preflight/, "release_preflight returns the release report");

  const initialTaskStatus = await client.request("tools/call", {
    name: "task_status",
    arguments: {}
  });
  assertMatch(initialTaskStatus.result?.content?.[0]?.text || "", /No current task passport/, "task_status reports missing task before start");

  const parkableTaskStart = await client.request("tools/call", {
    name: "task_start",
    arguments: {
      title: "MCP smoke parked task",
      nextActions: ["Resume after smoke"]
    }
  });
  assertMatch(parkableTaskStart.result?.content?.[0]?.text || "", /Started task task_/, "task_start creates a task that can be parked");

  const taskPark = await client.request("tools/call", {
    name: "task_park",
    arguments: {}
  });
  assertMatch(taskPark.result?.content?.[0]?.text || "", /Parked task task_/, "task_park parks the current passport");

  const taskStart = await client.request("tools/call", {
    name: "task_start",
    arguments: {
      title: "MCP smoke verification",
      writeScope: ["index.js"],
      nextActions: ["Complete smoke verification"]
    }
  });
  assertMatch(taskStart.result?.content?.[0]?.text || "", /Started task task_/, "task_start creates the current passport");

  const activeTaskStatus = await client.request("tools/call", {
    name: "task_status",
    arguments: {}
  });
  assertMatch(activeTaskStatus.result?.content?.[0]?.text || "", /MCP smoke verification \[active\]/, "task_status reports the active task");

  const taskList = await client.request("tools/call", {
    name: "task_list",
    arguments: {}
  });
  const taskListText = taskList.result?.content?.[0]?.text || "";
  assertMatch(taskListText, /- task_.* \[parked\] MCP smoke parked task/, "task_list shows the parked task");
  assertMatch(taskListText, /\* task_.* \[active\] MCP smoke verification/, "task_list marks the current task");

  const taskListJson = await client.request("tools/call", {
    name: "task_list",
    arguments: { json: true }
  });
  const taskListEntries = JSON.parse(taskListJson.result?.content?.[0]?.text || "null");
  assertEqual(Array.isArray(taskListEntries), true, "task_list json preserves the array contract");
  assertEqual(taskListEntries.length, 2, "task_list json returns both smoke tasks");

  const parkedTaskId = taskListText.match(/- (task_\S+) \[parked\]/)?.[1] || "";
  const activeTaskId = taskListText.match(/\* (task_\S+) \[active\]/)?.[1] || "";
  await client.request("tools/call", {
    name: "task_park",
    arguments: {}
  });
  const taskSwitch = await client.request("tools/call", {
    name: "task_switch",
    arguments: { id: parkedTaskId }
  });
  assertMatch(taskSwitch.result?.content?.[0]?.text || "", /Switched to task task_.* \(active\)\./, "task_switch resumes the parked task");

  await client.request("tools/call", {
    name: "task_park",
    arguments: {}
  });
  const switchBack = await client.request("tools/call", {
    name: "task_switch",
    arguments: { id: activeTaskId }
  });
  assertMatch(switchBack.result?.content?.[0]?.text || "", /Switched to task task_.* \(active\)\./, "task_switch returns to the active task");

  const taskHandoff = await client.request("tools/call", {
    name: "task_handoff",
    arguments: {}
  });
  assertMatch(taskHandoff.result?.content?.[0]?.text || "", /MCP smoke verification \[active\]/, "task_handoff reports the active task");

  const evidence = await client.request("tools/call", {
    name: "attach_evidence",
    arguments: {
      kind: "test-output",
      content: "MCP smoke verification passed."
    }
  });
  const evidenceText = evidence.result?.content?.[0]?.text || "";
  const evidenceId = evidenceText.match(/Attached evidence ([^.]+)\./)?.[1] || "";
  assertMatch(evidenceId, /^evt_/, "attach_evidence returns an evidence event id");

  const taskVerify = await client.request("tools/call", {
    name: "task_update_verification",
    arguments: {
      status: "passed",
      evidence: [evidenceId],
      summary: "MCP smoke verification passed."
    }
  });
  assertMatch(taskVerify.result?.content?.[0]?.text || "", /Updated verification for task .* \(passed\)/, "task_update_verification marks verification as passed");

  const bundlePath = path.join(workspace, "mcp-smoke.agentpack-bundle.json");
  const bundleExport = await client.request("tools/call", {
    name: "bundle_export",
    arguments: {
      outputPath: "mcp-smoke.agentpack-bundle.json",
      sources: ["index.js"]
    }
  });
  assertMatch(bundleExport.result?.content?.[0]?.text || "", /Exported bundle sha256:/, "bundle_export writes a structured bundle");

  const bundleInspect = await client.request("tools/call", {
    name: "bundle_inspect",
    arguments: {
      path: bundlePath
    }
  });
  assertMatch(bundleInspect.result?.content?.[0]?.text || "", /Status: valid \(valid digest\)/, "bundle_inspect validates the structured bundle");

  const bundleImportPlan = await client.request("tools/call", {
    name: "bundle_import_plan",
    arguments: {
      path: bundlePath
    }
  });
  assertMatch(bundleImportPlan.result?.content?.[0]?.text || "", /Mode: read-only \(no pack writes\)/, "bundle_import_plan stays read-only");
  assertMatch(bundleImportPlan.result?.content?.[0]?.text || "", /Outcome: conflict/, "bundle_import_plan detects the existing task id");

  const bundleImport = await client.request("tools/call", {
    name: "bundle_import",
    arguments: {
      path: bundlePath,
      json: true
    }
  });
  const bundleImportJson = JSON.parse(bundleImport.result?.content?.[0]?.text || "{}");
  assertEqual(bundleImportJson.readOnly, true, "bundle_import defaults to a read-only plan");
  assertEqual(bundleImportJson.action?.outcome, "conflict", "bundle_import default plan detects the existing task id");

  const taskUpdate = await client.request("tools/call", {
    name: "task_update",
    arguments: {
      nextActions: ["Inspect updated MCP smoke passport"],
      writeScope: ["."],
      risk: "medium"
    }
  });
  assertMatch(taskUpdate.result?.content?.[0]?.text || "", /Updated task .*/, "task_update updates the current passport");

  const taskFinalize = await client.request("tools/call", {
    name: "task_finalize",
    arguments: {}
  });
  assertMatch(taskFinalize.result?.content?.[0]?.text || "", /Finalized task .* \(passed\)/, "task_finalize closes a verified task");

  const resume = await client.request("tools/call", {
    name: "resume",
    arguments: {
      preset: "quick"
    }
  });
  const resumeText = resume.result?.content?.[0]?.text || "";
  assertMatch(resumeText, /Exercise Agentpack MCP smoke flow/, "resume contains the smoke goal");
  assertMatch(resumeText, /MCP smoke can record decisions/, "resume contains the MCP decision");

  console.log("MCP server OK");
  console.log(`Tools: ${toolNames.join(", ")}`);
  console.log("Flow: modern cacheable methods -> legacy initialize -> tools/list -> record_decision -> record_source -> source_status -> task_audit -> release_preflight -> task_status -> task_start -> task_park -> task_start -> task_list -> task_switch -> task_handoff -> task_update_verification -> bundle_export -> bundle_inspect -> bundle_import_plan -> bundle_import (read-only default) -> task_update -> task_finalize -> resume");
} catch (error) {
  console.error("MCP smoke failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (server) {
    await stopServer(server);
  }
  rmSync(workspace, { recursive: true, force: true });
}

function runCli(args) {
  execFileSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    stdio: "pipe"
  });
}

function createJsonRpcClient(child) {
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.on("exit", (code, signal) => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(new Error(`MCP server exited before response ${id}; code=${code}, signal=${signal}, stderr=${stderr.trim()}`));
    }
  });

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;

      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for MCP response ${id}; stderr=${stderr.trim()}`));
        }, 2000);

        pending.set(id, {
          resolve(message) {
            clearTimeout(timer);
            if (message.error) {
              reject(new Error(`${method} failed: ${message.error.message}`));
              return;
            }
            resolve(message);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return promise;
    }
  };
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };

    child.once("exit", finish);
    child.kill();
    setTimeout(finish, 500).unref();
  });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertModernCachePolicy(response, method) {
  assertEqual(response.result?.resultType, "complete", `modern ${method} returns a complete result`);
  assertEqual(response.result?.ttlMs, 0, `modern ${method} uses a conservative cache TTL`);
  assertEqual(response.result?.cacheScope, "private", `modern ${method} uses a private cache scope`);
}

function assertIncludes(values, expected, message) {
  if (!values.includes(expected)) {
    throw new Error(`${message}: missing ${expected}`);
  }
}

function assertMatch(value, pattern, message) {
  if (!pattern.test(value)) {
    throw new Error(`${message}: ${pattern} did not match`);
  }
}
