import { execFileSync } from "node:child_process";
import path from "node:path";
import type { GitInfo } from "./types.js";

interface GetGitInfoOptions {
  includeDiff?: boolean;
}

function runGit(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trimEnd();
  } catch {
    return "";
  }
}

export function getGitInfo(root: string, options: GetGitInfoOptions = {}): GitInfo {
  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"]);

  if (!topLevel) {
    return {
      available: false,
      branch: null,
      head: null,
      upstream: null,
      ahead: null,
      behind: null,
      aheadCommits: [],
      status: "",
      diffStat: "",
      diff: ""
    };
  }

  const upstream = runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) || null;
  const counts = upstream ? parseAheadBehind(runGit(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`])) : null;
  const aheadCommits = upstream && counts && counts.ahead > 0
    ? runGit(root, ["log", "--oneline", "--no-decorate", "--max-count=5", `${upstream}..HEAD`])
      .split("\n")
      .filter(Boolean)
    : [];

  return {
    available: true,
    topLevel,
    branch: runGit(root, ["branch", "--show-current"]) || "detached",
    head: runGit(root, ["rev-parse", "--short", "HEAD"]),
    upstream,
    ahead: counts?.ahead ?? null,
    behind: counts?.behind ?? null,
    aheadCommits,
    status: runGit(root, ["status", "--short"]),
    diffStat: runGit(root, ["diff", "--shortstat", "--"]),
    diff: options.includeDiff ? runGit(root, ["diff", "--"]) : ""
  };
}

export interface GitBranchState {
  available: boolean;
  branch: string | null;
  head: string | null;
}

// Lightweight read for hot paths such as `task gate`; getGitInfo runs several extra git commands.
export function getGitBranchState(root: string): GitBranchState {
  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    return { available: false, branch: null, head: null };
  }
  return {
    available: true,
    branch: runGit(root, ["branch", "--show-current"]) || "detached",
    head: runGit(root, ["rev-parse", "--short", "HEAD"]) || null
  };
}

export interface StagedEntry {
  path: string;
  gitlink: boolean;
}

/** Strict read for callers that must distinguish failure from an empty index. */
export function readStagedEntries(root: string, topLevel: string): StagedEntry[] {
  // --no-renames exposes both sides of a rename; -z preserves arbitrary file names.
  const raw = execFileSync("git", ["diff", "--cached", "--raw", "--no-renames", "-z", "--"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
  }).split("\0");
  const entries: StagedEntry[] = [];
  for (let i = 0; i < raw.length - 1; i += 2) {
    const modes = raw[i]!.match(/^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\d*$/);
    const gitPath = raw[i + 1];
    if (!modes || !gitPath) throw new Error("Cannot parse staged Git entry");
    const relativePath = path.relative(root, path.resolve(topLevel, gitPath));
    if (relativePath && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath)) {
      entries.push({ path: relativePath, gitlink: modes[1] === "160000" || modes[2] === "160000" });
    }
  }
  return entries;
}

export function listStagedEntries(root: string): StagedEntry[] {
  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    return [];
  }
  try { return readStagedEntries(root, topLevel); } catch { return []; }
}

export function listStagedFiles(root: string): string[] {
  return listStagedEntries(root).map(entry => entry.path);
}

export function listDirtyFiles(root: string): string[] {
  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    return [];
  }
  const records = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    .split("\0");
  const files: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const status = record.slice(0, 2);
    files.push(record.slice(3));
    // In -z porcelain v1, rename and copy records have a second NUL-delimited
    // source path. The first path is the destination we should report.
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }
  return [...new Set(
    files
      .map((gitPath) => path.relative(root, path.resolve(topLevel, gitPath)))
      .filter((relativePath) => relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  )];
}

export function getGitHooksPath(root: string): string | null {
  const hooksPath = runGit(root, ["rev-parse", "--git-path", "hooks"]);
  if (!hooksPath) {
    return null;
  }
  return path.resolve(root, hooksPath);
}

export function getGitRepoBounds(root: string): { topLevel: string; commonDir: string } | null {
  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    return null;
  }
  const commonDir = runGit(root, ["rev-parse", "--git-common-dir"]) || ".git";
  return {
    topLevel: path.resolve(root, topLevel),
    commonDir: path.resolve(root, commonDir)
  };
}

function parseAheadBehind(output: string): { ahead: number; behind: number } | null {
  const [aheadRaw, behindRaw] = output.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadRaw || "", 10);
  const behind = Number.parseInt(behindRaw || "", 10);

  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}
