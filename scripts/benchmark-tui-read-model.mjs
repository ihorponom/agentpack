#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initPack } from "../dist/src/core/store.js";
import { startTask, parkCurrentTask } from "../dist/src/core/tasks.js";
import { buildTuiModel } from "../dist/src/core/tui.js";

function measure(root, rounds = 20) {
  buildTuiModel(root);
  const start = process.hrtime.bigint();
  for (let index = 0; index < rounds; index += 1) buildTuiModel(root);
  return Number(process.hrtime.bigint() - start) / rounds / 1e6;
}

const liveRoot = process.cwd();
const fixture = mkdtempSync(path.join(os.tmpdir(), "agentpack-tui-10x-"));
try {
  initPack(fixture);
  // Deterministic scaling fixture: 1,650 passports, roughly 10x the live pack.
  for (let index = 0; index < 1650; index += 1) {
    startTask(fixture, { title: `fixture ${index}`, objective: "TUI bounded read model benchmark", writeScope: ["src/tui.ts"], risk: "low" });
    parkCurrentTask(fixture);
  }
  const live = measure(liveRoot);
  const scaled = measure(fixture);
  console.log(`TUI read model: live ${live.toFixed(1)} ms; deterministic task-count fixture ${scaled.toFixed(1)} ms (1,650 passports; evidence/global-log growth not scaled).`);
} finally { rmSync(fixture, { recursive: true, force: true }); }
