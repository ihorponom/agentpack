import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getGitRepoBounds } from "./git.js";
import { createId } from "./ids.js";
import type { AgentpackEvent, AgentpackState, SourcesFile } from "./types.js";

export const PACK_DIR = ".agentpack";
// Bumping this without shipping a passport/state migration in the same release
// bricks every existing pack: validateTaskPassport hard-fails on any schemaVersion
// mismatch, and the gate then fails closed on the unreadable passport.
export const SCHEMA_VERSION = 1;
// Ledger content can carry command output and code snippets; keep it owner-only on multi-user machines.
export const PACK_FILE_MODE = 0o600;
export const PACK_DIR_MODE = 0o700;
export const AGENTPACK_IGNORE_PATTERNS = [
  `${PACK_DIR}/`,
  ".codex",
  ".claude",
  ".cursor",
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md"
];

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 5 * 60_000;
const heldLocks = new Set<string>();
const sleepBuffer = new SharedArrayBuffer(4);
const sleepArray = new Int32Array(sleepBuffer);

export function findPackRoot(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(current, PACK_DIR))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function requirePackRoot(startDir: string): string {
  const root = findPackRoot(startDir);
  if (!root) {
    throw new Error("No .agentpack directory found. Run `agentpack init` first.");
  }
  return root;
}

export function initPack(root: string): string {
  const packPath = path.join(root, PACK_DIR);
  const now = new Date().toISOString();

  mkdirSync(packPath, { recursive: true, mode: PACK_DIR_MODE });
  for (const dir of ["checkpoints", "evidence", "instructions", "exports", "cache"]) {
    mkdirSync(path.join(packPath, dir), { recursive: true, mode: PACK_DIR_MODE });
  }

  writeJsonIfMissing(path.join(packPath, "config.json"), {
    schemaVersion: SCHEMA_VERSION,
    projectName: path.basename(root),
    redactions: [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "NPM_TOKEN"
    ],
    defaultBudget: 4000,
    includeGitDiff: true
  });

  writeJsonIfMissing(path.join(packPath, "state.json"), {
    schemaVersion: SCHEMA_VERSION,
    goal: null,
    currentStatus: "Initialized Agentpack.",
    nextActions: [],
    currentCheckpoint: null,
    createdAt: now,
    updatedAt: now
  });

  writeJsonIfMissing(path.join(packPath, "sources.json"), {
    schemaVersion: SCHEMA_VERSION,
    sources: []
  });

  if (!existsSync(path.join(packPath, "events.jsonl"))) {
    writeFileSync(path.join(packPath, "events.jsonl"), "", { encoding: "utf8", mode: PACK_FILE_MODE });
  }

  ensurePackIgnored(root);

  return packPath;
}

export function ensurePackIgnored(root: string): void {
  const excludePath = getGitExcludePath(root);
  if (!excludePath) {
    return;
  }
  for (const filePath of [path.dirname(excludePath), excludePath]) {
    if (lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Git exclude path contains a symbolic link: ${filePath}`);
    }
  }
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const updated = appendIgnorePatterns(existing, AGENTPACK_IGNORE_PATTERNS);
  if (updated !== existing) {
    mkdirSync(path.dirname(excludePath), { recursive: true });
    writeFileSync(excludePath, updated, "utf8");
  }
}

export function getGitExcludePath(root: string): string | null {
  const bounds = getGitRepoBounds(root);
  return bounds ? path.join(bounds.commonDir, "info", "exclude") : null;
}

export function appendIgnorePatterns(existing: string, patterns: readonly string[]): string {
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  const missing = patterns.filter((pattern) => !hasIgnorePattern(lines, pattern));
  if (!missing.length) {
    return existing;
  }
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  return `${existing}${prefix}${missing.join("\n")}\n`;
}

export function hasIgnorePattern(lines: readonly string[], pattern: string): boolean {
  const normalized = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  return lines.some((line) => {
    const normalizedLine = line.endsWith("/") ? line.slice(0, -1) : line;
    return normalizedLine === normalized;
  });
}

export function getPackPath(root: string, ...parts: string[]): string {
  return path.join(root, PACK_DIR, ...parts);
}

export function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export function writeJson(filePath: string, value: unknown): void {
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonIfMissing(filePath: string, value: unknown): void {
  if (!existsSync(filePath)) {
    writeJson(filePath, value);
  }
}

export function readState(root: string): AgentpackState {
  const state = readJson<AgentpackState | null>(getPackPath(root, "state.json"), null);
  if (!state) {
    throw new Error("Agentpack state.json is missing. Run `agentpack init` again.");
  }
  return state;
}

export function writeState(root: string, state: AgentpackState): void {
  withPackWriteLock(root, () => {
    writeJson(getPackPath(root, "state.json"), {
      ...state,
      updatedAt: new Date().toISOString()
    });
  });
}

export function readSources(root: string): SourcesFile {
  return readJson<SourcesFile>(getPackPath(root, "sources.json"), { schemaVersion: SCHEMA_VERSION, sources: [] });
}

export function writeSources(root: string, sources: SourcesFile): void {
  withPackWriteLock(root, () => {
    writeJson(getPackPath(root, "sources.json"), sources);
  });
}

export function appendEvent(root: string, type: string, payload: Record<string, unknown> = {}): AgentpackEvent {
  const event = {
    id: createId("evt"),
    ts: new Date().toISOString(),
    type,
    ...payload
  };

  withPackWriteLock(root, () => {
    writeFileSync(getPackPath(root, "events.jsonl"), `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: PACK_FILE_MODE
    });
  });

  return event;
}

export function readEvents(root: string): AgentpackEvent[] {
  const content = readFileSync(getPackPath(root, "events.jsonl"), "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentpackEvent);
}

export function listCheckpoints(root: string): string[] {
  const checkpointsPath = getPackPath(root, "checkpoints");
  if (!existsSync(checkpointsPath)) {
    return [];
  }

  return readdirSync(checkpointsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function withPackWriteLock<T>(root: string, fn: () => T): T {
  const lockPath = getPackPath(root, ".lock");

  if (heldLocks.has(lockPath)) {
    return fn();
  }

  acquireLock(lockPath);
  heldLocks.add(lockPath);

  try {
    return fn();
  } finally {
    heldLocks.delete(lockPath);
    releaseLock(lockPath);
  }
}

export interface PackTransactionFile {
  relativePath: string;
  content: string;
  mode: "create" | "replace";
}

export function writePackTransaction(root: string, files: PackTransactionFile[]): void {
  withPackWriteLock(root, () => {
    const packRoot = getPackPath(root);
    const transactionRoot = getPackPath(root, "cache", `.transaction-${createId("import")}`);
    const stagedFiles: Array<PackTransactionFile & { stagedPath: string; targetPath: string }> = [];
    const seenPaths = new Set<string>();
    let preserveTransaction = false;

    try {
      assertPackTransactionDirectoryChain(packRoot, path.join(transactionRoot, "staged"));
      for (const file of files) {
        const relativePath = normalizePackTransactionPath(file.relativePath);
        if (seenPaths.has(relativePath)) {
          throw new Error(`Duplicate pack transaction path: ${relativePath}`);
        }
        seenPaths.add(relativePath);
        const stagedPath = path.join(transactionRoot, "staged", String(stagedFiles.length));
        const targetPath = getPackPath(root, relativePath);
        assertPackTransactionDirectoryChain(packRoot, path.dirname(targetPath));
        mkdirSync(path.dirname(stagedPath), { recursive: true, mode: PACK_DIR_MODE });
        writeFileSync(stagedPath, file.content, { encoding: "utf8", mode: PACK_FILE_MODE });
        stagedFiles.push({ ...file, relativePath, stagedPath, targetPath });
      }

      const backups: Array<{ targetPath: string; backupPath: string }> = [];
      const installed: string[] = [];
      const createdDirectories: string[] = [];
      try {
        for (const [index, file] of stagedFiles.entries()) {
          if (!existsSync(file.targetPath)) {
            continue;
          }
          if (file.mode === "create") {
            throw new Error(`Pack transaction refuses to overwrite existing file: ${file.relativePath}`);
          }
          const backupPath = path.join(transactionRoot, "backup", String(index));
          mkdirSync(path.dirname(backupPath), { recursive: true, mode: PACK_DIR_MODE });
          renameSync(file.targetPath, backupPath);
          backups.push({ targetPath: file.targetPath, backupPath });
        }

        for (const file of stagedFiles) {
          ensureTransactionDirectory(path.dirname(file.targetPath), packRoot, createdDirectories);
          renameSync(file.stagedPath, file.targetPath);
          installed.push(file.targetPath);
        }
      } catch (error) {
        let rollbackFailed = false;
        for (const installedPath of [...installed].reverse()) {
          try {
            unlinkSync(installedPath);
          } catch {
            rollbackFailed = true;
          }
        }
        for (const backup of [...backups].reverse()) {
          try {
            renameSync(backup.backupPath, backup.targetPath);
          } catch {
            rollbackFailed = true;
          }
        }
        for (const directory of [...createdDirectories].reverse()) {
          try {
            rmdirSync(directory);
          } catch {
            // Directory may contain restored/pre-existing state; leave it intact.
          }
        }
        if (rollbackFailed) {
          preserveTransaction = true;
          throw new Error(`Pack transaction failed and rollback was incomplete; recovery files remain at ${transactionRoot}. Original error: ${String(error)}`);
        }
        throw error;
      }
    } finally {
      if (!preserveTransaction) {
        rmSync(transactionRoot, { recursive: true, force: true });
      }
    }
  });
}

function assertPackTransactionDirectoryChain(packRoot: string, directory: string): void {
  const relative = path.relative(packRoot, directory);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Pack transaction directory escapes .agentpack: ${directory}`);
  }
  const directories = [packRoot];
  let current = packRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  for (const candidate of directories) {
    if (!existsSync(candidate)) {
      break;
    }
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`Pack transaction refuses a symbolic-link directory: ${candidate}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Pack transaction requires a directory: ${candidate}`);
    }
  }
}

function normalizePackTransactionPath(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new Error(`Invalid pack transaction path: ${relativePath || "(empty)"}`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Invalid pack transaction path: ${relativePath}`);
  }
  return normalized;
}

function ensureTransactionDirectory(directory: string, packRoot: string, createdDirectories: string[]): void {
  if (existsSync(directory)) {
    return;
  }
  const parent = path.dirname(directory);
  if (parent !== directory && parent !== path.dirname(packRoot)) {
    ensureTransactionDirectory(parent, packRoot, createdDirectories);
  }
  mkdirSync(directory, { mode: PACK_DIR_MODE });
  createdDirectories.push(directory);
}

function writeTextFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );

  try {
    writeFileSync(tempPath, content, { encoding: "utf8", mode: PACK_FILE_MODE });
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

function acquireLock(lockPath: string): void {
  const startedAt = Date.now();

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      return;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") {
        throw error;
      }

      removeStaleLock(lockPath);

      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Agentpack state lock: ${lockPath}`);
      }

      sleepSync(25);
    }
  }
}

function releaseLock(lockPath: string): void {
  rmSync(lockPath, { recursive: true, force: true });
}

function removeStaleLock(lockPath: string): void {
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs > STALE_LOCK_MS) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(sleepArray, 0, 0, ms);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
