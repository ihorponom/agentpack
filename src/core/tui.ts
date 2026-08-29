import { closeSync, existsSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveRegularFileWithin } from "./hash.js";
import { redactForRoot } from "./redaction.js";
import { getPackPath } from "./store.js";
import { readPassport } from "./tasks.js";
import type { AgentpackEvent, TaskPassport } from "./types.js";

const PREVIEW_BYTES = 12_000;
const MAX_GLOBAL_EVENT_BYTES = 16_000_000;
const MAX_TASK_EVENT_BYTES = 2_000_000;
const MAX_GLOBAL_EVENTS = 50_000;
const MAX_TASK_EVENTS = 5_000;
const MAX_TASKS = 2_000;
const MAX_DIRECTORY_ENTRIES = 8_000;
const MAX_PASSPORT_BYTES = 128_000;
const MAX_TOTAL_PASSPORT_BYTES = 32_000_000;
const MAX_CURRENT_TASK_BYTES = 512;
const MAX_CHECKPOINTS = 5_000;
const MAX_EVIDENCE_PER_TASK = 32;
const MAX_PREVIEW_LINES = 160;
const MAX_SECTION_ITEMS = 100;
const MAX_WARNINGS = 100;
const MAX_RENDER_LINE = 320;
const STATIC_TASKS = 40;
const PAGE_ROWS = 24;

export interface TuiEvidence {
  id: string;
  ts: string;
  kind: string;
  path: string;
  command: string;
  exitCode: number | null;
  preview: string;
  warning?: string;
}

export interface TuiTask { passport: TaskPassport; current: boolean }
export interface TuiTaskDetails { timeline: AgentpackEvent[]; evidence: TuiEvidence[]; warnings: string[] }
interface EventLogRead { events: AgentpackEvent[]; evidenceById: Map<string, AgentpackEvent> }
export interface TuiHealth { taskCount: number; eventCount: number; evidenceEventCount: number; eventBytes: number; checkpointCount: number }
export interface TuiModel {
  root: string;
  tasks: TuiTask[];
  checkpoints: string[];
  warnings: string[];
  health: TuiHealth;
  evidenceById: Map<string, AgentpackEvent>;
}
export interface TuiNavigation { selected: number; view: number; offset: number; query: string; searching: boolean }
export interface TuiRuntime {
  stdin: Pick<NodeJS.ReadStream, "isTTY" | "setRawMode" | "resume" | "pause" | "on" | "off" | "once">;
  stdout: Pick<NodeJS.WriteStream, "isTTY" | "write" | "on" | "off" | "once">;
  signals: Pick<NodeJS.Process, "on" | "off" | "once">;
}

/** Removes terminal escape/control injection while retaining readable line structure. */
export function sanitizeTerminalText(value: unknown): string {
  return String(value ?? "")
    .replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?|[()][^\x1b]*)/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (character) => character === "\n" || character === "\t" ? character : "")
    .replace(/\r/g, "");
}

export function buildTuiModel(root: string): TuiModel {
  const warnings: string[] = [];
  const current = readCurrentTaskId(root, warnings);
  const globalEventPath = getPackPath(root, "events.jsonl");
  const global = readEventLog(root, globalEventPath, MAX_GLOBAL_EVENT_BYTES, MAX_GLOBAL_EVENTS, warnings, "global events", true);
  const evidenceById = global.evidenceById;
  const tasks = readTaskInventory(root, current, warnings);
  const checkpoints = listBoundedDirectories(getPackPath(root, "checkpoints"), MAX_CHECKPOINTS, warnings, "checkpoints");
  return {
    root,
    tasks,
    checkpoints,
    warnings,
    evidenceById,
    health: {
      taskCount: tasks.length,
      eventCount: global.events.length,
      evidenceEventCount: evidenceById.size,
      eventBytes: safeFileSize(globalEventPath),
      checkpointCount: checkpoints.length,
    },
  };
}

/** Loads only the selected task's bounded timeline and linked evidence previews. */
export function loadTuiTaskDetails(model: TuiModel, task: TuiTask): TuiTaskDetails {
  const warnings: string[] = [];
  const timelinePath = getPackPath(model.root, "tasks", task.passport.id, "events.jsonl");
  const timeline = readEventLog(model.root, timelinePath, MAX_TASK_EVENT_BYTES, MAX_TASK_EVENTS, warnings, `task ${task.passport.id} events`).events;
  const ids = task.passport.verification.evidence;
  if (ids.length > MAX_EVIDENCE_PER_TASK) {
    pushWarning(warnings, `Evidence previews capped at ${MAX_EVIDENCE_PER_TASK} of ${ids.length}.`);
  }
  const evidence = ids.slice(-MAX_EVIDENCE_PER_TASK).map((id) => previewEvidence(model.root, id, model.evidenceById.get(id)));
  return { timeline, evidence, warnings };
}

export function renderTuiSnapshot(model: TuiModel, query = ""): string {
  const tasks = visibleTasks(model, query);
  const lines = [
    "Agentpack Inspector (read-only)",
    `Tasks: ${tasks.length}/${model.tasks.length} | Events: ${model.health.eventCount} | Checkpoints: ${model.health.checkpointCount}`,
    "",
    ...tasks.slice(0, STATIC_TASKS).map((task) => taskListLine(task, false, true)),
    ...(model.warnings.length ? ["", "Warnings:", ...model.warnings.slice(0, 8).map((warning) => `- ${warning}`)] : []),
    ...(tasks.length > STATIC_TASKS ? [`… ${tasks.length - STATIC_TASKS} more task(s) omitted from static snapshot.`] : []),
    "",
    "Run in a terminal for navigation: j/k arrows, Enter, Tab, /, Esc, q.",
  ];
  return lines.map(displayLine).join("\n");
}

export function startTui(root: string): void {
  const model = buildTuiModel(root);
  runTuiSession(model, { stdin: process.stdin, stdout: process.stdout, signals: process });
}

export function runTuiSession(model: TuiModel, runtime: TuiRuntime): () => void {
  if (!runtime.stdin.isTTY || !runtime.stdout.isTTY) {
    runtime.stdout.write(`${renderTuiSnapshot(model)}\n`);
    return () => undefined;
  }
  let navigation: TuiNavigation = { selected: 0, view: 0, offset: 0, query: "", searching: false };
  let restored = false;
  let cachedDetails: { taskId: string; value: TuiTaskDetails } | undefined;
  const visible = () => visibleTasks(model, navigation.query);
  const detailFor = (task: TuiTask): TuiTaskDetails => {
    if (cachedDetails?.taskId === task.passport.id) return cachedDetails.value;
    const loaded = loadTuiTaskDetails(model, task);
    cachedDetails = { taskId: task.passport.id, value: loaded };
    return loaded;
  };
  const draw = () => {
    const tasks = visible();
    navigation.selected = Math.max(0, Math.min(navigation.selected, Math.max(0, tasks.length - 1)));
    if (navigation.view === 0) navigation.offset = visibleOffset(navigation.selected, navigation.offset);
    const task = tasks[navigation.selected];
    const labels = ["Tasks", "Passport", "Timeline", "Evidence", "Checkpoints", "Health"];
    let body: string[];
    if (navigation.view === 0) {
      body = tasks.length ? tasks.map((item, index) => taskListLine(item, index === navigation.selected, false)) : ["No matching task."];
    } else if (navigation.view === 4) {
      body = ["Global repository checkpoints (the current schema has no task-to-checkpoint link):", ...(model.checkpoints.length ? model.checkpoints : ["No checkpoints."])];
    } else if (navigation.view === 5) {
      body = healthLines(model);
    } else if (!task) {
      body = ["No matching task."];
    } else if (navigation.view === 1) {
      body = passportLines(task);
    } else if (navigation.view === 2) {
      const loaded = detailFor(task);
      body = [...(loaded.timeline.length ? loaded.timeline.map(eventLine) : ["No task timeline events."]), ...loaded.warnings.map((warning) => `[warning] ${warning}`)];
    } else {
      const loaded = detailFor(task);
      body = loaded.evidence.length ? loaded.evidence.flatMap(evidenceLines) : ["No verification evidence linked."];
      body.push(...loaded.warnings.map((warning) => `[warning] ${warning}`));
    }
    navigation.offset = Math.min(navigation.offset, Math.max(0, body.length - PAGE_ROWS));
    const page = body.slice(navigation.offset, navigation.offset + PAGE_ROWS).map(displayLine);
    const header = labels.map((label, index) => index === navigation.view ? `[${label}]` : label).join("  ");
    const selected = task ? `Selected: ${task.passport.id} (${task.current ? "current" : "historical"})` : "";
    const footer = navigation.searching ? `/${navigation.query}` : "j/k move/scroll · Enter drill · Tab view · / search · Esc back · q quit";
    const screen = [
      "\x1b[H\x1b[2JAgentpack Inspector — READ ONLY",
      header,
      ...(navigation.query ? [`Filter: ${navigation.query}`] : []),
      "",
      ...page,
      "",
      ...(selected ? [selected] : []),
      footer,
    ].map((line, index) => index === 0 ? line : displayLine(line)).join("\n");
    runtime.stdout.write(screen);
  };
  const onData = (data: Buffer | string) => {
    try {
      for (const key of parseTuiKeys(data)) {
        if (key === "\u0003" || (!navigation.searching && key === "q")) { restore(); return; }
        navigation = reduceTuiNavigation(navigation, key, visible().length);
      }
      draw();
    } catch {
      restore();
    }
  };
  const onEnd = () => restore();
  const onInputError = () => restore();
  const onOutputError = () => restore();
  const restore = () => {
    if (restored) return;
    restored = true;
    try { runtime.stdin.off("data", onData); } catch { /* cleanup is best effort */ }
    try { runtime.stdin.off("end", onEnd); } catch { /* cleanup is best effort */ }
    try { runtime.stdin.off("error", onInputError); } catch { /* cleanup is best effort */ }
    try { runtime.signals.off("SIGINT", restore); } catch { /* cleanup is best effort */ }
    try { runtime.signals.off("SIGTERM", restore); } catch { /* cleanup is best effort */ }
    try { runtime.stdin.setRawMode?.(false); } catch { /* cleanup is best effort */ }
    try { runtime.stdin.pause(); } catch { /* cleanup is best effort */ }
    try { runtime.stdout.write("\x1b[?25h\x1b[?1049l"); } catch { /* stream is already unavailable */ }
    try { runtime.stdout.off("error", onOutputError); } catch { /* cleanup is best effort */ }
  };
  runtime.signals.once("SIGINT", restore);
  runtime.signals.once("SIGTERM", restore);
  runtime.stdin.once("end", onEnd);
  runtime.stdin.once("error", onInputError);
  runtime.stdout.once("error", onOutputError);
  try {
    runtime.stdout.write("\x1b[?1049h\x1b[?25l");
    runtime.stdin.setRawMode?.(true);
    runtime.stdin.resume();
    runtime.stdin.on("data", onData);
    draw();
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}

export function reduceTuiNavigation(state: TuiNavigation, key: string, taskCount: number): TuiNavigation {
  const next = { ...state };
  if (next.searching) {
    if (key === "\r") next.searching = false;
    else if (key === "\u001b") { next.searching = false; next.query = ""; }
    else if (key === "\u007f") next.query = next.query.slice(0, -1);
    else if (/^[^\x00-\x1f\x7f]+$/.test(key)) next.query += key;
    next.selected = 0;
    next.offset = 0;
    return next;
  }
  if (key === "/") next.searching = true;
  else if (key === "j" || key === "\u001b[B") {
    if (next.view === 0) {
      next.selected = Math.min(Math.max(0, taskCount - 1), next.selected + 1);
      next.offset = visibleOffset(next.selected, next.offset);
    } else next.offset += 1;
  } else if (key === "k" || key === "\u001b[A") {
    if (next.view === 0) {
      next.selected = Math.max(0, next.selected - 1);
      next.offset = visibleOffset(next.selected, next.offset);
    } else next.offset = Math.max(0, next.offset - 1);
  } else if (key === "\t") {
    next.view = (next.view + 1) % 6;
    next.offset = 0;
  } else if (key === "\r") {
    next.view = Math.min(next.view + 1, 5);
    next.offset = 0;
  } else if (key === "\u001b" || key === "\u007f") {
    next.view = Math.max(0, next.view - 1);
    next.offset = 0;
  }
  if (next.view === 0) next.offset = visibleOffset(next.selected, next.offset);
  return next;
}

export function parseTuiKeys(data: Buffer | string): string[] {
  const text = data.toString("utf8");
  const keys: string[] = [];
  for (let index = 0; index < text.length;) {
    const escape = text.slice(index, index + 3);
    if (escape === "\u001b[A" || escape === "\u001b[B") { keys.push(escape); index += 3; continue; }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const key = String.fromCodePoint(codePoint);
    keys.push(key);
    index += key.length;
  }
  return keys;
}

function readTaskInventory(root: string, current: string, warnings: string[]): TuiTask[] {
  const taskRoot = getPackPath(root, "tasks");
  const names = listDirectoryCandidates(taskRoot, warnings, "tasks");
  if (current && !names.includes(current)) names.unshift(current);
  const tasks: TuiTask[] = [];
  const candidates: Array<{ name: string; bytes: number; mtimeMs: number }> = [];
  let totalBytes = 0;
  for (const name of names) {
    if (!/^task_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { pushWarning(warnings, `Skipped invalid task directory ${displayLine(name)}.`); continue; }
    try {
      const file = resolveRegularFileWithin(root, path.relative(root, getPackPath(root, "tasks", name, "passport.json")), "TUI passport path");
      const stat = statSync(file);
      const bytes = stat.size;
      if (bytes > MAX_PASSPORT_BYTES) { pushWarning(warnings, `Skipped oversized passport ${name}.`); continue; }
      candidates.push({ name, bytes, mtimeMs: stat.mtimeMs });
    } catch (error) {
      pushWarning(warnings, `Unreadable task ${name}: ${message(error)}`);
    }
  }
  candidates.sort((a, b) => {
    if (a.name === current) return -1;
    if (b.name === current) return 1;
    return b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);
  });
  let byteCapWarned = false;
  for (const { name, bytes } of candidates) {
    if (tasks.length >= MAX_TASKS) { pushWarning(warnings, `tasks inventory capped at ${MAX_TASKS}.`); break; }
    if (totalBytes + bytes > MAX_TOTAL_PASSPORT_BYTES) {
      if (!byteCapWarned) pushWarning(warnings, `Passport inventory capped at ${MAX_TOTAL_PASSPORT_BYTES} bytes.`);
      byteCapWarned = true;
      continue;
    }
    try {
      const passport = readPassport(root, name);
      tasks.push({ passport, current: current === name });
      totalBytes += bytes;
    } catch (error) {
      pushWarning(warnings, `Unreadable task ${name}: ${message(error)}`);
    }
  }
  return tasks.sort((a, b) => b.passport.updatedAt.localeCompare(a.passport.updatedAt) || a.passport.id.localeCompare(b.passport.id));
}

function readCurrentTaskId(root: string, warnings: string[]): string {
  const file = getPackPath(root, "tasks", "current");
  if (!existsSync(file)) return "";
  try {
    const safe = resolveRegularFileWithin(root, path.relative(root, file), "TUI current task path");
    return readBoundedText(safe, MAX_CURRENT_TASK_BYTES).trim();
  } catch (error) {
    pushWarning(warnings, `Cannot read current task pointer: ${message(error)}`);
    return "";
  }
}

function readEventLog(root: string, file: string, maxBytes: number, maxEvents: number, warnings: string[], label: string, collectEvidence = false): EventLogRead {
  const evidenceById = new Map<string, AgentpackEvent>();
  const ambiguousEvidenceIds = new Set<string>();
  if (!existsSync(file)) return { events: [], evidenceById };
  try {
    const safe = resolveRegularFileWithin(root, path.relative(root, file), `TUI ${label} path`);
    const text = readBoundedText(safe, maxBytes);
    const lines = text.split("\n");
    const events: AgentpackEvent[] = [];
    let validEvents = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index] ?? "";
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!isAgentpackEvent(value)) { pushWarning(warnings, `Skipped malformed ${label} line ${index + 1}.`); continue; }
        validEvents += 1;
        if (events.length < maxEvents) events.push(value);
        if (collectEvidence && value.type === "evidence") {
          if (evidenceById.has(value.id) || ambiguousEvidenceIds.has(value.id)) {
            evidenceById.delete(value.id);
            if (!ambiguousEvidenceIds.has(value.id)) pushWarning(warnings, `Duplicate evidence event id ${value.id}; linked preview omitted.`);
            ambiguousEvidenceIds.add(value.id);
          } else evidenceById.set(value.id, value);
        }
      } catch {
        pushWarning(warnings, `Skipped malformed ${label} line ${index + 1}.`);
      }
    }
    if (validEvents > maxEvents) pushWarning(warnings, `${label} capped at newest ${maxEvents} events.`);
    return { events: events.reverse(), evidenceById };
  } catch (error) {
    pushWarning(warnings, `Cannot read ${label}: ${message(error)}`);
    return { events: [], evidenceById };
  }
}

function previewEvidence(root: string, id: string, event: AgentpackEvent | undefined): TuiEvidence {
  if (!event || typeof event.path !== "string") {
    return { id, ts: "", kind: "missing", path: "", command: "", exitCode: null, preview: "", warning: "Evidence event is missing, malformed, or ambiguous." };
  }
  const relative = event.path;
  const base = getPackPath(root, "evidence");
  const common = {
    id,
    ts: String(event.ts || ""),
    kind: String(event.kind || "evidence"),
    path: relative,
    command: typeof event.command === "string" ? event.command : "",
    exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
  };
  if (!relative.startsWith("evidence/") || relative.includes("\0")) return { ...common, preview: "", warning: "Unsafe evidence path omitted." };
  try {
    const candidate = path.resolve(getPackPath(root), relative);
    const realBase = realpathSync(base);
    if (!candidate.startsWith(`${path.resolve(base)}${path.sep}`)) throw new Error("unsafe evidence path");
    const safe = resolveRegularFileWithin(getPackPath(root), relative, "TUI evidence path");
    if (!realpathSync(safe).startsWith(`${realBase}${path.sep}`) || !statSync(safe).isFile()) throw new Error("unsafe evidence path");
    return { ...common, preview: sanitizeTerminalText(redactForRoot(root, readPreview(safe))) };
  } catch {
    return { ...common, command: "", preview: "", warning: "Unsafe or unreadable evidence omitted." };
  }
}

function readPreview(file: string): string {
  const descriptor = openSync(file, "r");
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("not a regular file");
    const length = Math.min(stat.size, PREVIEW_BYTES);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return `${buffer.subarray(0, offset).toString("utf8")}${stat.size > PREVIEW_BYTES ? "\n[preview truncated]" : ""}`;
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedText(file: string, maxBytes: number): string {
  const descriptor = openSync(file, "r");
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > maxBytes) throw new Error(`exceeds ${maxBytes} byte read limit`);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function listBoundedDirectories(directory: string, limit: number, warnings: string[], label: string): string[] {
  const result = listDirectoryCandidates(directory, warnings, label).sort().reverse();
  if (result.length > limit) pushWarning(warnings, `${label} inventory capped at ${limit}.`);
  return result.slice(0, limit);
}

function listDirectoryCandidates(directory: string, warnings: string[], label: string): string[] {
  if (!existsSync(directory)) return [];
  try {
    const rootStat = lstatSync(directory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) { pushWarning(warnings, `Unsafe ${label} directory omitted.`); return []; }
    const result: string[] = [];
    const dir = opendirSync(directory);
    let seen = 0;
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        seen += 1;
        if (seen > MAX_DIRECTORY_ENTRIES) { pushWarning(warnings, `${label} directory scan capped at ${MAX_DIRECTORY_ENTRIES} entries.`); break; }
        if (entry.isDirectory() && !entry.isSymbolicLink()) result.push(entry.name);
      }
    } finally {
      dir.closeSync();
    }
    return result.sort();
  } catch (error) {
    pushWarning(warnings, `Cannot list ${label}: ${message(error)}`);
    return [];
  }
}

function visibleTasks(model: TuiModel, query: string): TuiTask[] {
  const normalized = query.trim().toLowerCase();
  return model.tasks.filter(({ passport }) => !normalized || `${passport.id} ${passport.title} ${passport.status}`.toLowerCase().includes(normalized));
}

function taskListLine(task: TuiTask, selected: boolean, alwaysShowId: boolean): string {
  return `${selected ? ">" : " "}${task.current ? "*" : " "} [${task.passport.status}] ${selected || alwaysShowId ? `(${task.passport.id}) ` : ""}${task.passport.title}`;
}

function passportLines(task: TuiTask): string[] {
  const passport = task.passport;
  return [
    `${passport.title} (${passport.status})`,
    `Task: ${task.current ? "current" : "historical"}`,
    `Objective: ${passport.objective}`,
    `Worktree: ${passport.worktree}`,
    `Branch: ${passport.branch || "—"}`,
    `Base HEAD: ${passport.baseHead || "—"}`,
    `Current HEAD: ${passport.currentHead || "—"}`,
    `Created/updated/closed: ${passport.createdAt} / ${passport.updatedAt} / ${passport.closedAt || "—"}`,
    `Risk: ${passport.risk}`,
    `Blocked reason: ${passport.blockedReason || "—"}`,
    `Tags: ${passport.tags.join(", ") || "—"}`,
    `Scope: ${passport.writeScope.join(", ") || "—"}`,
    `Verification: ${passport.verification.status} — ${passport.verification.summary}`,
    `Evidence IDs: ${passport.verification.evidence.join(", ") || "—"}`,
    "",
    ...sectionLines("Constraints / authorization boundaries:", passport.constraints),
    "",
    ...sectionLines("Next actions:", passport.nextActions),
  ];
}

function sectionLines(title: string, items: string[]): string[] {
  const shown = items.slice(0, MAX_SECTION_ITEMS);
  return [title, ...(shown.length ? shown.map((item) => `- ${item}`) : ["—"]), ...(items.length > shown.length ? [`… ${items.length - shown.length} more omitted.`] : [])];
}

function evidenceLines(evidence: TuiEvidence): string[] {
  return [
    `[${evidence.kind}] ${evidence.id}`,
    `Recorded: ${evidence.ts || "unknown"} · Exit: ${evidence.exitCode ?? "—"}`,
    `Path: ${evidence.path || "—"}`,
    ...(evidence.command ? [`Command: ${evidence.command}`] : []),
    ...(evidence.warning ? [evidence.warning] : previewLines(evidence.preview)),
    "",
  ];
}

function previewLines(preview: string): string[] {
  if (!preview) return ["(empty)"];
  const lines = sanitizeTerminalText(preview).split("\n");
  return [...lines.slice(0, MAX_PREVIEW_LINES), ...(lines.length > MAX_PREVIEW_LINES ? [`… ${lines.length - MAX_PREVIEW_LINES} preview lines omitted.`] : [])];
}

function eventLine(event: AgentpackEvent): string {
  return `${event.ts || "unknown time"} [${event.type || "unknown"}] ${String(event.text || event.summary || event.status || event.checkpointId || "")}`;
}

function healthLines(model: TuiModel): string[] {
  const h = model.health;
  return [
    `Bounded TUI inventory: ${h.taskCount} tasks`,
    `Global events read: ${h.eventCount} (${h.eventBytes} bytes)`,
    `Evidence events indexed: ${h.evidenceEventCount}`,
    `Global checkpoints: ${h.checkpointCount}`,
    "For exhaustive ledger hygiene, run: agentpack ledger status",
    ...model.warnings.map((warning) => `[warning] ${warning}`),
  ];
}

function visibleOffset(selected: number, offset: number): number {
  if (selected < offset) return selected;
  if (selected >= offset + PAGE_ROWS) return selected - PAGE_ROWS + 1;
  return Math.max(0, offset);
}

function displayLine(value: unknown): string {
  const normalized = sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
  return normalized.length > MAX_RENDER_LINE ? `${normalized.slice(0, MAX_RENDER_LINE - 1)}…` : normalized;
}

function isAgentpackEvent(value: unknown): value is AgentpackEvent {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && typeof (value as { type?: unknown }).type === "string");
}

function pushWarning(warnings: string[], warning: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push(warning);
}

function safeFileSize(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
