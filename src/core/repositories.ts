import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { normalizePath } from "./hash.js";
import type { RepositoryIdentity, TaskRepository } from "./types.js";

export interface RepositoryInput {
  id: string;
  worktree: string;
  writeScope: string[];
}

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Resolve existing ancestors too, so new files below a symlink cannot escape a scope. */
export function physicalPath(target: string): string {
  let ancestor = path.resolve(target);
  const suffix: string[] = [];
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve path: ${target}`);
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(realpathSync(ancestor), ...suffix);
}

export function repositoryGit(worktree: string, expected?: RepositoryIdentity): { branch: string; head: string; identity: RepositoryIdentity } {
  const git = (args: string[]): string => execFileSync("git", args, {
    cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const canonical = realpathSync(worktree);
  if (canonical !== path.resolve(worktree)) throw new Error(`Repository worktree no longer resolves to its bound path: ${worktree}`);
  if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== canonical) {
    throw new Error(`Repository worktree must be a Git checkout root: ${worktree}`);
  }
  const gitDir = realpathSync(git(["rev-parse", "--absolute-git-dir"]));
  const metadata = statSync(gitDir, { bigint: true });
  const identity: RepositoryIdentity = {
    gitDir, device: String(metadata.dev), inode: String(metadata.ino), createdNs: String(metadata.birthtimeNs)
  };
  if (expected && (Object.keys(identity) as Array<keyof RepositoryIdentity>).some(key => identity[key] !== expected[key])) {
    throw new Error(`Repository checkout identity changed; the bound checkout was replaced: ${worktree}`);
  }
  const head = git(["rev-parse", "--verify", "HEAD"]);
  return { branch: git(["branch", "--show-current"]) || "detached", head, identity };
}

function validId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) && id !== "primary";
}

function validScope(scope: unknown): scope is string[] {
  return Array.isArray(scope) && scope.length > 0 && scope.every(item =>
    typeof item === "string" && item.length > 0 && !item.includes("\\") && !item.includes("\0") &&
    !path.posix.isAbsolute(item) && !/^[A-Za-z]:/.test(item) &&
    !item.split("/").includes("..") && normalizePath(path.posix.normalize(item)) === item
  );
}

function validIdentity(value: unknown): value is RepositoryIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.gitDir === "string" && path.isAbsolute(identity.gitDir) &&
    [identity.device, identity.inode, identity.createdNs].every(item => typeof item === "string" && /^\d+$/.test(item));
}

/** Validate binding metadata without accessing imported filesystem paths. */
export function validRepositories(value: unknown, portable = false): value is TaskRepository[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  const paths = new Set<string>();
  return value.every(repo => {
    if (!repo || typeof repo !== "object" || Array.isArray(repo)) return false;
    const r = repo as Record<string, unknown>;
    if (!validId(r.id) || ids.has(r.id) || !validScope(r.writeScope) ||
        !(r.branch === null || typeof r.branch === "string") ||
        ![r.baseHead, r.currentHead].every(head => head === null || (typeof head === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))) ||
        !(r.worktree === null || (!portable && typeof r.worktree === "string" && path.isAbsolute(r.worktree))) ||
        !(r.worktree === null ? r.identity === null : validIdentity(r.identity)) ||
        (typeof r.worktree === "string" && paths.has(r.worktree))) return false;
    ids.add(r.id);
    if (typeof r.worktree === "string") paths.add(r.worktree);
    return true;
  });
}

/** Validate CLI JSON entries and MCP binding objects. */
export function parseRepositoryInputs(value: unknown): RepositoryInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("repositories requires an array");
  const ids = new Set<string>();
  return value.map(raw => {
    const repo = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
    if (!repo || typeof repo !== "object" || Array.isArray(repo)) throw new Error("Invalid repository binding");
    const r = repo as Record<string, unknown>;
    if (Object.keys(r).some(key => !["id", "worktree", "writeScope"].includes(key)) ||
        !validId(r.id) || ids.has(r.id) || typeof r.worktree !== "string" || !r.worktree.trim() ||
        !Array.isArray(r.writeScope) || r.writeScope.length === 0 || !r.writeScope.every(item => typeof item === "string")) {
      throw new Error("Repository binding requires a unique id (other than primary), worktree and non-empty writeScope");
    }
    ids.add(r.id);
    return { id: r.id, worktree: r.worktree, writeScope: r.writeScope as string[] };
  });
}

/** Bind by id; append scopes only for existing local bindings. */
export function bindRepositories(root: string, existing: TaskRepository[], incoming: RepositoryInput[]): TaskRepository[] {
  const result = existing.map(repo => ({ ...repo, writeScope: [...repo.writeScope] }));
  for (const input of parseRepositoryInputs(incoming)) {
    const worktree = realpathSync(path.resolve(root, input.worktree));
    if (isWithin(worktree, realpathSync(root))) throw new Error(`Repository ${input.id} overlaps the primary pack root`);
    const old = result.find(repo => repo.id === input.id);
    if (old?.worktree && old.worktree !== worktree) throw new Error(`Repository ${input.id} is already bound to another worktree`);
    const git = repositoryGit(worktree, old?.identity || undefined);
    const writeScope = [...new Set(input.writeScope.map(item => {
      const absolute = path.resolve(worktree, item);
      if (!isWithin(worktree, absolute) || !isWithin(worktree, physicalPath(absolute))) {
        throw new Error(`Repository ${input.id} write scope escapes its worktree: ${item}`);
      }
      return normalizePath(path.relative(worktree, absolute) || ".");
    }))];
    if (!validScope(writeScope)) throw new Error(`Invalid write scope for repository ${input.id}`);
    if (result.some(repo => repo.id !== input.id && repo.worktree === worktree)) throw new Error(`Duplicate repository worktree: ${worktree}`);
    if (old) {
      // Imported scopes remain provenance until explicit local binding.
      old.writeScope = old.worktree ? [...new Set([...old.writeScope, ...writeScope])] : writeScope;
      if (!old.worktree) Object.assign(old, { worktree, identity: git.identity, branch: git.branch, baseHead: git.head, currentHead: git.head });
    } else result.push({ id: input.id, worktree, identity: git.identity, branch: git.branch, baseHead: git.head, currentHead: git.head, writeScope });
  }
  return result;
}

export function snapshotRepositories(repositories: TaskRepository[]): TaskRepository[] {
  return repositories.map(repo => {
    if (!repo.worktree) throw new Error(`Repository ${repo.id} is unbound; bind it before recording a final verdict`);
    const git = repositoryGit(repo.worktree, repo.identity!);
    if (repo.branch !== git.branch) throw new Error(`Repository ${repo.id} branch drift: expected ${repo.branch}, found ${git.branch}`);
    return { ...repo, currentHead: git.head };
  });
}

export function repositoryWarnings(repositories: TaskRepository[]): string[] {
  return repositories.flatMap(repo => {
    if (!repo.worktree) return [`Repository ${repo.id} is unbound; explicitly bind its local worktree before editing or verification.`];
    try {
      const git = repositoryGit(repo.worktree, repo.identity!);
      return [
        ...(git.branch !== repo.branch ? [`Repository ${repo.id} branch drift: ${repo.branch} -> ${git.branch}.`] : []),
        ...(git.head !== repo.currentHead ? [`Repository ${repo.id} HEAD drift: ${repo.currentHead} -> ${git.head}.`] : [])
      ];
    } catch { return [`Repository ${repo.id} is unavailable or its checkout identity changed.`]; }
  });
}

export function formatRepositories(repositories: TaskRepository[] = []): string[] {
  if (!repositories.length) return [];
  return ["Additional repositories:", ...repositories.map(repo =>
    `- ${repo.id}: ${repo.worktree || "(unbound)"}; Branch: ${repo.branch || "unknown"}; Bound HEAD: ${repo.currentHead || "unknown"}; Scope: ${repo.writeScope.join(", ")}`
  ), ...repositoryWarnings(repositories).map(warning => `- [warn] ${warning}`)];
}
