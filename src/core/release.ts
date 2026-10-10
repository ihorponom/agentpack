import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getGitInfo } from "./git.js";
import { findPackRoot } from "./store.js";

type ReleaseCheckStatus = "ok" | "warn" | "fail";

interface ReleaseCheck {
  status: ReleaseCheckStatus;
  name: string;
  detail: string;
}

interface ReleasePreflightReport {
  ok: boolean;
  text: string;
}

interface PackageJson {
  name?: string;
  version?: string;
  publishConfig?: {
    access?: string;
    provenance?: boolean;
  };
}

interface PackageLockJson {
  name?: string;
  version?: string;
  packages?: Record<string, { version?: string }>;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function buildReleasePreflightReport(startDir: string): ReleasePreflightReport {
  const checks: ReleaseCheck[] = [];
  const root = findPackRoot(startDir) || startDir;

  checks.push(checkPack(startDir));
  checks.push(checkPackageJson(root));
  checks.push(checkPackageLock(root));
  checks.push(checkGit(root));
  checks.push(checkPublishWorkflow(root));
  checks.push(checkReleasingDocs(root));

  return renderReleasePreflight(checks);
}

function checkPack(startDir: string): ReleaseCheck {
  const root = findPackRoot(startDir);
  return root
    ? { status: "ok", name: "Pack", detail: `.agentpack found at ${path.join(root, ".agentpack")}` }
    : { status: "fail", name: "Pack", detail: "No .agentpack directory found. Run `agentpack init`." };
}

function checkPackageJson(root: string): ReleaseCheck {
  const pkg = readJson<PackageJson>(path.join(root, "package.json"));
  if (!pkg.ok) {
    return { status: "fail", name: "package.json", detail: pkg.error };
  }

  const issues: string[] = [];
  if (pkg.value.name !== "agentpack-cli") {
    issues.push(`expected name agentpack-cli, found ${pkg.value.name || "(missing)"}`);
  }
  if (!pkg.value.version || !SEMVER_PATTERN.test(pkg.value.version)) {
    issues.push(`version is not a plain semver release: ${pkg.value.version || "(missing)"}`);
  }
  if (pkg.value.publishConfig?.access !== "public") {
    issues.push("publishConfig.access should be public");
  }
  if (pkg.value.publishConfig?.provenance !== true) {
    issues.push("publishConfig.provenance should be true");
  }

  return issues.length
    ? { status: "fail", name: "package.json", detail: issues.join("; ") }
    : { status: "ok", name: "package.json", detail: `agentpack-cli@${pkg.value.version}` };
}

function checkPackageLock(root: string): ReleaseCheck {
  const pkg = readJson<PackageJson>(path.join(root, "package.json"));
  const lock = readJson<PackageLockJson>(path.join(root, "package-lock.json"));
  if (!lock.ok) {
    return { status: "fail", name: "package-lock.json", detail: lock.error };
  }
  if (!pkg.ok) {
    return { status: "warn", name: "package-lock.json", detail: "package.json is unreadable; version match not checked" };
  }

  const rootVersion = lock.value.packages?.[""]?.version || lock.value.version;
  if (rootVersion !== pkg.value.version) {
    return {
      status: "fail",
      name: "package-lock.json",
      detail: `lockfile version ${rootVersion || "(missing)"} does not match package.json ${pkg.value.version || "(missing)"}`
    };
  }

  return { status: "ok", name: "package-lock.json", detail: `version matches ${rootVersion}` };
}

function checkGit(root: string): ReleaseCheck {
  const git = getGitInfo(root);
  if (!git.available) {
    return { status: "fail", name: "Git", detail: "not a git repository" };
  }
  if (git.status.trim()) {
    return { status: "fail", name: "Git", detail: "working tree is not clean; commit or park changes before release prep" };
  }
  if (git.branch !== "main") {
    return { status: "warn", name: "Git", detail: `current branch is ${git.branch}; normal releases are cut from main` };
  }
  if (!git.upstream) {
    return { status: "fail", name: "Git", detail: "main has no upstream; push main and set upstream before release prep" };
  }
  if (git.ahead === null || git.behind === null) {
    return { status: "fail", name: "Git", detail: `could not compare main with ${git.upstream}; verify upstream state before release prep` };
  }
  if (git.ahead > 0 && git.behind > 0) {
    return {
      status: "fail",
      name: "Git",
      detail: `main and ${git.upstream} have diverged (${git.ahead} ahead, ${git.behind} behind); reconcile before release prep`
    };
  }
  if (git.ahead > 0) {
    return { status: "fail", name: "Git", detail: `main is ahead of ${git.upstream} by ${git.ahead} commit(s); push reviewed commits before release prep` };
  }
  if (git.behind > 0) {
    return { status: "fail", name: "Git", detail: `main is behind ${git.upstream} by ${git.behind} commit(s); update main before release prep` };
  }
  return { status: "ok", name: "Git", detail: `${git.branch} @ ${git.head || "unknown"}, in sync with ${git.upstream}` };
}

function checkPublishWorkflow(root: string): ReleaseCheck {
  const workflowPath = path.join(root, ".github", "workflows", "publish.yml");
  if (!existsSync(workflowPath)) {
    return { status: "fail", name: "Publish workflow", detail: ".github/workflows/publish.yml is missing" };
  }

  const content = readFileSync(workflowPath, "utf8");
  const issues: string[] = [];
  if (!content.includes("id-token: write")) {
    issues.push("missing id-token: write");
  }
  if (!/release:\s*\n\s+types:\s*\[published\]/m.test(content)) {
    issues.push("does not trigger on release: published");
  }
  if (!content.includes("npm publish --access public")) {
    issues.push("does not publish with npm publish --access public");
  }
  if (/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/.test(content)) {
    issues.push("must not reference NPM_TOKEN or NODE_AUTH_TOKEN when using Trusted Publisher");
  }

  return issues.length
    ? { status: "fail", name: "Publish workflow", detail: issues.join("; ") }
    : { status: "ok", name: "Publish workflow", detail: "Trusted Publisher release workflow is present" };
}

function checkReleasingDocs(root: string): ReleaseCheck {
  const docsPath = path.join(root, "docs", "RELEASING.md");
  if (!existsSync(docsPath)) {
    return { status: "warn", name: "Release docs", detail: "docs/RELEASING.md is missing" };
  }

  const content = readFileSync(docsPath, "utf8");
  const issues: string[] = [];
  if (!content.includes("Pre-flight checklist")) {
    issues.push("pre-flight checklist is not documented");
  }

  return issues.length
    ? { status: "warn", name: "Release docs", detail: issues.join("; ") }
    : { status: "ok", name: "Release docs", detail: "pre-flight checklist is documented" };
}

function renderReleasePreflight(checks: ReleaseCheck[]): ReleasePreflightReport {
  const ok = checks.every((check) => check.status !== "fail");
  const lines = [
    "Agentpack release preflight",
    "",
    ...checks.map((check) => `[${check.status}] ${check.name}: ${check.detail}`),
    "",
    "Before npm version:",
    "- npm test",
    "- agentpack doctor",
    "- npm pack --dry-run",
    "- test install/MCP changes in another repository when relevant",
    "",
    "Release actions are intentionally manual:",
    "- npm version patch --no-git-tag-version",
    "- commit package.json and package-lock.json as a release-prep commit",
    "- push main, tag v<version>, then publish the GitHub Release",
    "",
    ok ? "Result: ready for release-prep checks." : "Result: fix failed checks before release prep."
  ];

  return {
    ok,
    text: lines.join("\n")
  };
}

function readJson<T>(filePath: string): { ok: true; value: T } | { ok: false; error: string } {
  if (!existsSync(filePath)) {
    return { ok: false, error: `${path.basename(filePath)} is missing` };
  }
  try {
    return { ok: true, value: JSON.parse(readFileSync(filePath, "utf8")) as T };
  } catch (error) {
    return {
      ok: false,
      error: `${path.basename(filePath)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
