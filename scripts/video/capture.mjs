import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DISPLAY_ROOT = "~/shop-api";

export async function captureSession(cliPath) {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "agentpack-video-")));
  const scrub = (text) => text.split(workspace).join(DISPLAY_ROOT);
  const env = { ...process.env, HOME: workspace, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", args, { cwd: workspace, stdio: "pipe", env });
  const cli = (...args) => scrub(execFileSync(process.execPath, [cliPath, ...args], { cwd: workspace, encoding: "utf8", env }).trim());
  const sessions = [];

  try {
    git("init", "-q");
    git("config", "user.email", "dev@example.com");
    git("config", "user.name", "Dev");
    mkdirSync(path.join(workspace, "src"));
    mkdirSync(path.join(workspace, "tests"));
    writeFileSync(path.join(workspace, "tests", "checkout.test.ts"), "// checkout test placeholder\n");
    writeFileSync(path.join(workspace, "src", "checkout.ts"), "export const total = (items: number[]) => items.reduce((a, b) => a + b, 0);\n");
    git("add", "-A");
    git("commit", "-qm", "Initial commit");

    const init = cli("init");
    const install = cli("install", "claude", "--write").split("\n")[0];

    const first = await mcpSession(cliPath, workspace, env);
    sessions.push(first);
    const calls = [
      ["task_start", {
        title: "Fix flaky checkout test",
        objective: "Make the checkout test pass reliably.",
        writeScope: ["src", "tests"],
        risk: "low",
        nextActions: ["Inject a fake clock in the checkout test"]
      }],
      ["record_decision", {
        text: "Use a fixed clock in the checkout test instead of real timers.",
        files: ["tests/checkout.test.ts"]
      }],
      ["record_dead_end", {
        text: "Increasing the test timeout to 30 seconds.",
        reason: "It hides the race instead of fixing it",
        files: ["tests/checkout.test.ts"]
      }],
      ["checkpoint", {
        summary: "Race traced to real timers. Fixed clock is the plan.",
        status: "Ready to apply the fixed clock",
        nextActions: ["Inject a fake clock in the checkout test"]
      }]
    ];
    const recorded = [];
    for (const [name, args] of calls) {
      recorded.push({ name, args, result: scrub(await first.callTool(name, args)) });
    }
    await first.close();

    const second = await mcpSession(cliPath, workspace, env);
    sessions.push(second);
    const loadArgs = { preset: "quick", query: "flaky checkout test" };
    const loaded = scrub(await second.callTool("load_context", loadArgs));
    await second.close();

    return { init, install, recorded, load: { args: loadArgs, result: loaded } };
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function mcpSession(cliPath, workspace, env) {
  const child = spawn(process.execPath, [cliPath, "mcp", "--root", workspace], { stdio: ["pipe", "pipe", "pipe"], env });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines.filter((l) => l.trim())) {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 10000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  await request("initialize", {});
  return {
    async callTool(name, args) {
      const response = await request("tools/call", { name, arguments: args });
      return response.result.content[0].text;
    },
    close() {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      child.kill();
      return new Promise((resolve) => child.once("exit", resolve));
    }
  };
}
