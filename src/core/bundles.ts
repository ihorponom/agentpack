import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, type Stats, writeFileSync } from "node:fs";
import path from "node:path";
import { getGitInfo } from "./git.js";
import { getFileRecord, normalizePath, resolveRegularFileWithin, sha256, sha256File } from "./hash.js";
import { boundTaskCheckpoint, isTaskCheckpoint, MAX_TASK_CHECKPOINT_BYTES, readLocalTaskCheckpoint, type TaskCheckpointContext } from "./checkpoints.js";
import { createId } from "./ids.js";
import { redactForRoot } from "./redaction.js";
import { getPackPath, PACK_FILE_MODE, readEvents, readJson, readSources, SCHEMA_VERSION, withPackWriteLock, writePackTransaction } from "./store.js";
import {
  formatTaskPassportHandoff,
  getCurrentPassport,
  readPassport
} from "./tasks.js";
import type {
  AgentpackConfig,
  AgentpackEvent,
  BundleExportOptions,
  BundleExportResult,
  BundleImportManifest,
  BundleImportOptions,
  BundleImportPlan,
  BundleImportResult,
  BundleInspectResult,
  SourceRecord,
  TaskBundle,
  TaskBundleEvidence,
  TaskBundleOrigin,
  TaskBundleSource,
  TaskPassport
} from "./types.js";

const BUNDLE_KIND = "agentpack.task-bundle";
const BUNDLE_SCHEMA_VERSION = 1;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES = 100;
const MAX_EVIDENCE = 50;
const MAX_EVIDENCE_CONTENT_BYTES = 256 * 1024;

export function readTaskCheckpoint(root: string, taskId: string): TaskCheckpointContext {
  const context = readLocalTaskCheckpoint(root, taskId);
  if (context.checkpoint) return context;
  const directory = getPackPath(root, "tasks", taskId, "imports");
  if (!existsSync(directory)) return context;
  let candidates: string[];
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe directory");
    candidates = readdirSync(directory).filter((name) => /^sha256-[0-9a-f]{64}\.bundle\.json$/.test(name));
  } catch {
    context.warnings.push("Cannot read imported checkpoint: unreadable or unsafe import directory.");
    return context;
  }
  // A task has one retained import. Multiple records are ambiguous provenance.
  if (candidates.length > 1) {
    context.warnings.push("Cannot select imported checkpoint: multiple retained bundles.");
    return context;
  }
  for (const name of candidates) {
    try {
      const bundlePath = resolveRegularFileWithin(root, path.join(directory, name), "retained bundle");
      const { bundle } = readValidatedTaskBundle(bundlePath);
      if (name !== `${bundleStorageId(bundle.bundleId)}.bundle.json`) throw new Error("retained digest mismatch");
      const manifestPath = resolveRegularFileWithin(root, path.join(directory, name.replace(/\.bundle\.json$/, ".import.json")), "import manifest");
      if (lstatSync(manifestPath).size > MAX_BUNDLE_BYTES) throw new Error("oversized import manifest");
      assertRetainedImportManifest(JSON.parse(readFileSync(manifestPath, "utf8")), bundle, taskId);
      if (bundle.checkpoint) {
        return { ...context, checkpoint: boundTaskCheckpoint(root, bundle.checkpoint), imported: true };
      }
    } catch {
      context.warnings.push("Skipped unreadable, unsafe or invalid imported checkpoint provenance.");
    }
  }
  return context;
}

export function exportTaskBundle(root: string, options: BundleExportOptions): BundleExportResult {
  if (!options.outputPath.trim()) {
    throw new Error("bundle export requires --output <file>");
  }

  const passport = options.taskId && options.taskId !== "current"
    ? readPassport(root, options.taskId)
    : getCurrentPassport(root);
  if (!passport) {
    throw new Error("No current task. Run `agentpack task start <title>` first or pass --task <id>.");
  }

  const outputPath = normalizeBundleOutputPath(root, options.outputPath);
  const sourcePaths = normalizeBundleSourcePaths(root, options.sourcePaths || []);
  const sources = selectedSources(root, sourcePaths);
  const evidence = options.includeEvidence === false ? [] : referencedEvidence(root, passport.verification.evidence);
  const git = getGitInfo(root);
  const config = readJson<Partial<AgentpackConfig>>(getPackPath(root, "config.json"), {});
  const origin = bundleOrigin(root, config.projectName || path.basename(root), git.branch, git.head);
  const checkpointContext = readTaskCheckpoint(root, passport.id);
  const handoff = formatTaskPassportHandoff(root, passport, [], checkpointContext);

  const bundleBase = deepRedact(root, {
    kind: BUNDLE_KIND,
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    producer: {
      name: "agentpack-cli",
      version: options.producerVersion || "unknown"
    },
    origin,
    task: {
      id: passport.id,
      title: passport.title,
      objective: passport.objective,
      constraints: passport.constraints,
      writeScope: passport.writeScope,
      risk: passport.risk,
      tags: passport.tags,
      nextActions: passport.nextActions,
      originalStatus: passport.status,
      originVerification: passport.verification
    },
    handoffMarkdown: handoff,
    ...(checkpointContext.checkpoint ? { checkpoint: checkpointContext.checkpoint } : {}),
    sources,
    evidence
  }) as Omit<TaskBundle, "bundleId" | "exportedAt">;

  const bundleId = digestBundlePayload(bundleBase);
  const bundle: TaskBundle = {
    ...bundleBase,
    bundleId,
    exportedAt: new Date().toISOString()
  };
  const content = `${stableStringify(bundle)}\n`;

  if (Buffer.byteLength(content, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error(`Bundle exceeds ${MAX_BUNDLE_BYTES} byte limit.`);
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  try {
    writeFileSync(outputPath, content, { encoding: "utf8", flag: "wx", mode: PACK_FILE_MODE });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing bundle output: ${options.outputPath}`);
    }
    throw error;
  }

  return {
    bundleId,
    outputPath,
    taskId: passport.id,
    sources: bundle.sources.length,
    evidence: bundle.evidence.length,
    bytes: Buffer.byteLength(content, "utf8"),
    ...checkpointMetadata(bundle)
  };
}

export function inspectTaskBundle(filePath: string): BundleInspectResult {
  const { bundle, warnings } = readValidatedTaskBundle(filePath);
  return bundleInspectResult(bundle, warnings);
}

export function planTaskBundleImport(root: string, filePath: string, options: BundleImportOptions = {}): BundleImportPlan {
  const { bundle, warnings } = readValidatedTaskBundle(filePath);
  return planValidatedTaskBundleImport(root, bundle, warnings, options);
}

function planValidatedTaskBundleImport(
  root: string,
  bundle: TaskBundle,
  bundleWarnings: string[],
  options: BundleImportOptions
): BundleImportPlan {
  const bundleSummary = bundleInspectResult(bundle, bundleWarnings);
  const packInitialized = existsSync(getPackPath(root));
  const warnings = [...bundleWarnings];
  const conflicts: BundleImportPlan["conflicts"] = [];
  const retainedImports = packInitialized ? findRetainedImports(root, bundle) : [];
  const validRetainedImports = retainedImports.filter((entry) => entry.valid);
  const invalidRetainedImports = retainedImports.filter((entry) => !entry.valid);
  for (const retained of invalidRetainedImports) {
    conflicts.push({ kind: "destination-state", message: retained.error });
  }
  if (validRetainedImports.length > 1) {
    conflicts.push({
      kind: "destination-state",
      message: `Bundle ${bundle.bundleId} is retained under multiple destination tasks: ${validRetainedImports.map((entry) => entry.taskId).join(", ")}.`
    });
  }

  const retainedImport = validRetainedImports.length === 1 && conflicts.length === 0
    ? validRetainedImports[0]
    : undefined;
  let destinationTaskId = retainedImport?.taskId || bundle.task.id;
  const originTaskExists = packInitialized && existsSync(getPackPath(root, "tasks", bundle.task.id, "passport.json"));
  if (!retainedImport && originTaskExists && options.asNew && conflicts.length === 0) {
    destinationTaskId = nextRemappedTaskId(root, bundle.task.id, bundle.bundleId);
  }
  const passportFile = getPackPath(root, "tasks", destinationTaskId, "passport.json");
  const taskExists = packInitialized && existsSync(passportFile);
  const importedBundleExists = retainedImports.length > 0;
  const taskStatus = taskExists ? readPassport(root, destinationTaskId).status : null;

  let destinationStatus: BundleImportPlan["destination"]["status"];
  let action: BundleImportPlan["action"];
  if (conflicts.length > 0) {
    destinationStatus = "import-conflict";
    action = {
      outcome: "conflict",
      task: "conflict",
      bundle: "blocked"
    };
  } else if (retainedImport && taskExists) {
    destinationStatus = "already-imported";
    action = {
      outcome: "idempotent",
      task: "reuse",
      bundle: "reuse"
    };
  } else if (retainedImport) {
    conflicts.push({
      kind: "destination-state",
      message: `Retained import record exists for ${bundle.bundleId}, but task ${destinationTaskId} is missing.`
    });
    destinationStatus = "orphaned-import";
    action = {
      outcome: "conflict",
      task: "conflict",
      bundle: "blocked"
    };
  } else if (originTaskExists && !options.asNew) {
    conflicts.push({
      kind: "task-id",
      message: `Task ${bundle.task.id} already exists without matching imported bundle ${bundle.bundleId}.`
    });
    destinationStatus = "task-present";
    action = {
      outcome: "conflict",
      task: "conflict",
      bundle: "blocked"
    };
  } else {
    destinationStatus = packInitialized ? "task-missing" : "uninitialized";
    action = {
      outcome: "create",
      task: "create",
      bundle: "retain"
    };
    if (!packInitialized) {
      warnings.push("destination pack is not initialized; a future write import would require agentpack init");
    }
  }
  if (packInitialized && action.outcome === "create") {
    warnings.push(...destinationSourceWarnings(root, bundle));
  }

  return {
    readOnly: true,
    writes: [],
    bundle: bundleSummary,
    destination: {
      status: destinationStatus,
      packInitialized,
      taskExists,
      taskStatus,
      importedBundleExists,
      taskId: destinationTaskId
    },
    action,
    conflicts,
    warnings
  };
}

interface RetainedImportRecord {
  taskId: string;
  bundlePath: string;
  manifestPath: string;
  valid: boolean;
  error: string;
}

function findRetainedImports(root: string, bundle: TaskBundle): RetainedImportRecord[] {
  const tasksPath = getPackPath(root, "tasks");
  if (!existsSync(tasksPath)) {
    return [];
  }

  return readdirSync(tasksPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => bundleStorageIds(bundle.bundleId).flatMap((storageId): RetainedImportRecord[] => {
      const bundlePath = getPackPath(root, "tasks", entry.name, "imports", `${storageId}.bundle.json`);
      if (!existsSync(bundlePath)) {
        return [];
      }
      const manifestPath = getPackPath(root, "tasks", entry.name, "imports", `${storageId}.import.json`);
      try {
        const retained = readValidatedTaskBundle(bundlePath).bundle;
        if (retained.bundleId !== bundle.bundleId || retained.task.id !== bundle.task.id) {
          return [{
            taskId: entry.name,
            bundlePath,
            manifestPath,
            valid: false,
            error: `Retained import record for ${bundle.bundleId} under task ${entry.name} does not match source task ${bundle.task.id}.`
          }];
        }
        const manifest = readJson<unknown>(manifestPath, null);
        assertRetainedImportManifest(manifest, bundle, entry.name);
        return [{ taskId: entry.name, bundlePath, manifestPath, valid: true, error: "" }];
      } catch (error) {
        return [{
          taskId: entry.name,
          bundlePath,
          manifestPath,
          valid: false,
          error: `Retained import record for ${bundle.bundleId} under task ${entry.name} is invalid: ${errorMessage(error)}`
        }];
      }
    }));
}

function bundleStorageIds(bundleId: string): string[] {
  const portable = bundleId.replace(":", "-");
  return portable === bundleId ? [bundleId] : [portable, bundleId];
}

function bundleStorageId(bundleId: string): string {
  return bundleStorageIds(bundleId)[0] || bundleId;
}

function nextRemappedTaskId(root: string, sourceTaskId: string, bundleId: string): string {
  const base = `${sourceTaskId}_import_${bundleId.slice("sha256:".length, "sha256:".length + 12)}`;
  let candidate = base;
  let suffix = 2;
  while (existsSync(getPackPath(root, "tasks", candidate))) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function importTaskBundle(root: string, filePath: string, options: BundleImportOptions = {}): BundleImportResult {
  if (!existsSync(getPackPath(root))) {
    throw new Error("bundle import --write requires an initialized destination pack; run `agentpack init` first");
  }

  return withPackWriteLock(root, () => {
    const { bundle, warnings } = readValidatedTaskBundle(filePath);
    assertBundleSafeForDestination(root, bundle);
    const plan = planValidatedTaskBundleImport(root, bundle, warnings, options);
    if (plan.action.outcome === "conflict") {
      throw new Error(`Bundle import conflict: ${plan.conflicts.map((conflict) => conflict.message).join("; ")}`);
    }

    const taskId = plan.destination.taskId;
    if (!taskId) {
      throw new Error("Bundle import plan did not select a destination task id.");
    }
    if (plan.action.outcome === "idempotent") {
      return existingBundleImportResult(root, bundle, taskId, plan);
    }

    const importedAt = new Date().toISOString();
    const existingEvents = readEvents(root);
    const usedEventIds = new Set(existingEvents.map((event) => event.id));
    const evidenceImport = prepareEvidenceImport(root, bundle, importedAt, existingEvents, usedEventIds);
    const sourceImport = prepareSourceImport(root, bundle, importedAt, usedEventIds);
    const mappedOriginEvidence = bundle.task.originVerification.evidence
      .map((id) => evidenceImport.idMap.get(id))
      .filter((id): id is string => Boolean(id));
    const unresolvedOriginEvidence = bundle.task.originVerification.evidence
      .filter((id) => !evidenceImport.idMap.has(id));
    const git = getGitInfo(root);
    const passport: TaskPassport = {
      schemaVersion: SCHEMA_VERSION,
      id: taskId,
      title: bundle.task.title,
      status: "parked",
      createdAt: importedAt,
      updatedAt: importedAt,
      closedAt: null,
      objective: bundle.task.objective,
      constraints: [...bundle.task.constraints],
      branch: git.branch,
      baseHead: git.head,
      currentHead: git.head,
      worktree: realpathSync(root),
      writeScope: [...bundle.task.writeScope],
      risk: bundle.task.risk,
      verification: {
        status: "unknown",
        evidence: [],
        summary: ""
      },
      nextActions: [...bundle.task.nextActions],
      tags: [...bundle.task.tags]
    };
    const taskImportEvent: AgentpackEvent = {
      id: nextUniqueId("evt", usedEventIds),
      ts: importedAt,
      type: "task-import",
      status: "parked",
      bundleId: bundle.bundleId,
      sourceTaskId: bundle.task.id,
      destinationTaskId: taskId
    };
    const rootImportEvent: AgentpackEvent = {
      id: nextUniqueId("evt", usedEventIds),
      ts: importedAt,
      type: "bundle-import",
      bundleId: bundle.bundleId,
      sourceTaskId: bundle.task.id,
      destinationTaskId: taskId,
      asNew: Boolean(options.asNew && taskId !== bundle.task.id)
    };
    const manifest: BundleImportManifest = {
      schemaVersion: 1,
      bundleId: bundle.bundleId,
      importedAt,
      sourceTaskId: bundle.task.id,
      destinationTaskId: taskId,
      asNew: Boolean(options.asNew && taskId !== bundle.task.id),
      origin: bundle.origin,
      originalStatus: bundle.task.originalStatus,
      originVerification: {
        ...bundle.task.originVerification,
        evidence: mappedOriginEvidence
      },
      unresolvedOriginEvidence,
      task: {
        action: "created",
        remappedFrom: taskId === bundle.task.id ? null : bundle.task.id
      },
      evidence: evidenceImport.records,
      sources: sourceImport.records
    };
    const storageId = bundleStorageId(bundle.bundleId);
    const taskBase = path.join("tasks", taskId);
    const importBase = path.join(taskBase, "imports");
    const manifestRelativePath = path.join(importBase, `${storageId}.import.json`);
    const rootEvents = [
      ...evidenceImport.events,
      ...sourceImport.events,
      rootImportEvent
    ];
    const transactionFiles = [
      { relativePath: path.join(taskBase, "passport.json"), content: jsonText(passport), mode: "create" as const },
      { relativePath: path.join(taskBase, "events.jsonl"), content: `${JSON.stringify(taskImportEvent)}\n`, mode: "create" as const },
      { relativePath: path.join(importBase, `${storageId}.bundle.json`), content: `${stableStringify(bundle)}\n`, mode: "create" as const },
      { relativePath: manifestRelativePath, content: jsonText(manifest), mode: "create" as const },
      ...evidenceImport.files,
      ...(sourceImport.changed
        ? [{ relativePath: "sources.json", content: jsonText(sourceImport.sources), mode: "replace" as const }]
        : []),
      {
        relativePath: "events.jsonl",
        content: appendEventLines(readFileSync(getPackPath(root, "events.jsonl"), "utf8"), rootEvents),
        mode: "replace" as const
      }
    ];

    writePackTransaction(root, transactionFiles);

    return {
      applied: true,
      idempotent: false,
      bundleId: bundle.bundleId,
      taskId,
      manifestPath: normalizePath(path.join(".agentpack", manifestRelativePath)),
      plan,
      manifest
    };
  });
}

function existingBundleImportResult(
  root: string,
  bundle: TaskBundle,
  taskId: string,
  plan: BundleImportPlan
): BundleImportResult {
  const retained = findRetainedImports(root, bundle)
    .find((entry) => entry.valid && entry.taskId === taskId);
  if (!retained || !existsSync(retained.manifestPath)) {
    throw new Error(`Bundle ${bundle.bundleId} is retained for task ${taskId}, but its import manifest is missing.`);
  }
  const manifest = readJson<unknown>(retained.manifestPath, null);
  assertRetainedImportManifest(manifest, bundle, taskId);
  return {
    applied: false,
    idempotent: true,
    bundleId: bundle.bundleId,
    taskId,
    manifestPath: normalizePath(path.relative(root, retained.manifestPath)),
    plan,
    manifest: {
      ...manifest,
      task: { ...manifest.task, action: "reused" }
    }
  };
}

function assertRetainedImportManifest(value: unknown, bundle: TaskBundle, taskId: string): asserts value is BundleImportManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.bundleId !== bundle.bundleId ||
    value.sourceTaskId !== bundle.task.id ||
    value.destinationTaskId !== taskId ||
    typeof value.importedAt !== "string" ||
    typeof value.asNew !== "boolean" ||
    !bundleOriginValue(value.origin) ||
    !taskStatusValue(value.originalStatus) ||
    !isRecord(value.originVerification) ||
    !verificationStatusValue(value.originVerification.status) ||
    !stringArrayValue(value.originVerification.evidence) ||
    typeof value.originVerification.summary !== "string" ||
    !stringArrayValue(value.unresolvedOriginEvidence) ||
    !importManifestTaskValue(value.task) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every(importManifestEvidenceValue) ||
    !Array.isArray(value.sources) ||
    !value.sources.every(importManifestSourceValue)
  ) {
    throw new Error(`Import manifest is missing or invalid for bundle ${bundle.bundleId} and task ${taskId}.`);
  }

  const sourcePaths = new Set<string>();
  for (const source of value.sources) {
    validateRelativeBundlePath(source.path, "import manifest source");
    if (sourcePaths.has(source.path)) {
      throw new Error(`Import manifest contains duplicate source path: ${source.path}`);
    }
    sourcePaths.add(source.path);
  }
  const evidenceIds = new Set<string>();
  const destinationEvidenceIds = new Set<string>();
  for (const evidence of value.evidence) {
    if (evidenceIds.has(evidence.originId)) {
      throw new Error(`Import manifest contains duplicate evidence id: ${evidence.originId}`);
    }
    evidenceIds.add(evidence.originId);
    if (destinationEvidenceIds.has(evidence.destinationId)) {
      throw new Error(`Import manifest contains duplicate destination evidence id: ${evidence.destinationId}`);
    }
    destinationEvidenceIds.add(evidence.destinationId);
  }
}

function importManifestTaskValue(value: unknown): boolean {
  return isRecord(value) &&
    (value.action === "created" || value.action === "reused") &&
    (value.remappedFrom === null || (
      typeof value.remappedFrom === "string" &&
      /^task_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.remappedFrom)
    ));
}

function importManifestEvidenceValue(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.originId === "string" &&
    /^evt_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.originId) &&
    typeof value.destinationId === "string" &&
    /^evt_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.destinationId) &&
    typeof value.contentDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value.contentDigest) &&
    (value.action === "created" || value.action === "reused" || value.action === "remapped");
}

function importManifestSourceValue(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.hash === "string" &&
    /^[0-9a-f]{64}$/.test(value.hash) &&
    typeof value.reason === "string" &&
    (value.action === "created" || value.action === "reused" || value.action === "skipped");
}

interface PreparedEvidenceImport {
  records: BundleImportManifest["evidence"];
  files: Array<{ relativePath: string; content: string; mode: "create" }>;
  events: AgentpackEvent[];
  idMap: Map<string, string>;
}

function prepareEvidenceImport(
  root: string,
  bundle: TaskBundle,
  importedAt: string,
  existingEvents: AgentpackEvent[],
  usedEventIds: Set<string>
): PreparedEvidenceImport {
  const existingById = new Map(existingEvents.map((event) => [event.id, event]));
  const records: BundleImportManifest["evidence"] = [];
  const files: PreparedEvidenceImport["files"] = [];
  const events: AgentpackEvent[] = [];
  const idMap = new Map<string, string>();
  const reservedEvidencePaths = new Set<string>();

  for (const evidence of bundle.evidence) {
    const existing = existingById.get(evidence.originId);
    if (existing && existingEvidenceMatches(root, existing, evidence.contentDigest)) {
      records.push({
        originId: evidence.originId,
        destinationId: evidence.originId,
        contentDigest: evidence.contentDigest,
        action: "reused"
      });
      idMap.set(evidence.originId, evidence.originId);
      continue;
    }

    const destinationId = existing ? nextUniqueId("evt", usedEventIds) : reserveEventId(evidence.originId, usedEventIds);
    const evidenceFileId = nextAvailableEvidenceFileId(root, reservedEvidencePaths);
    const extension = evidence.kind === "json" ? "json" : "txt";
    const evidencePath = path.join("evidence", `${evidenceFileId}.${extension}`);
    const event: AgentpackEvent = {
      id: destinationId,
      ts: importedAt,
      type: "evidence",
      kind: evidence.kind,
      path: evidencePath,
      command: evidence.command,
      exitCode: evidence.exitCode,
      importedFrom: evidence.originId,
      bundleId: bundle.bundleId
    };
    files.push({ relativePath: evidencePath, content: evidence.content, mode: "create" });
    events.push(event);
    records.push({
      originId: evidence.originId,
      destinationId,
      contentDigest: evidence.contentDigest,
      action: existing ? "remapped" : "created"
    });
    idMap.set(evidence.originId, destinationId);
  }

  return { records, files, events, idMap };
}

function existingEvidenceMatches(root: string, event: AgentpackEvent, contentDigest: string): boolean {
  if (event.type !== "evidence" || typeof event.path !== "string") {
    return false;
  }
  try {
    const evidencePath = getPackPath(root, normalizeEvidencePath(event.path));
    if (!existsSync(evidencePath)) {
      return false;
    }
    assertSafeEvidenceFile(root, evidencePath, event.path);
    return `sha256:${sha256(readFileSync(evidencePath))}` === contentDigest;
  } catch {
    return false;
  }
}

function reserveEventId(preferredId: string, usedEventIds: Set<string>): string {
  if (usedEventIds.has(preferredId)) {
    return nextUniqueId("evt", usedEventIds);
  }
  usedEventIds.add(preferredId);
  return preferredId;
}

function nextUniqueId(prefix: string, usedIds: Set<string>): string {
  let id = createId(prefix);
  while (usedIds.has(id)) {
    id = createId(prefix);
  }
  usedIds.add(id);
  return id;
}

function nextAvailableEvidenceFileId(root: string, reservedPaths: Set<string>): string {
  let id = createId("ev");
  while (
    reservedPaths.has(id) ||
    existsSync(getPackPath(root, "evidence", `${id}.txt`)) ||
    existsSync(getPackPath(root, "evidence", `${id}.json`))
  ) {
    id = createId("ev");
  }
  reservedPaths.add(id);
  return id;
}

function destinationSourceWarnings(root: string, bundle: TaskBundle): string[] {
  const localSources = new Map(readSources(root).sources.map((source) => [source.path, source]));
  const warnings: string[] = [];
  for (const source of bundle.sources) {
    const localSource = localSources.get(source.path);
    if (localSource) {
      if (localSource.hash !== source.hash) {
        warnings.push(`source ${source.path} has a different local conclusion; the local record will win`);
      }
      continue;
    }
    const absolutePath = path.join(root, source.path);
    if (!existsSync(absolutePath)) {
      warnings.push(`source ${source.path} is missing locally and will not be added to Source Cache`);
    } else if (sha256File(absolutePath) !== source.hash) {
      warnings.push(`source ${source.path} has a different local hash and will not be added to Source Cache`);
    }
  }
  return warnings;
}

interface PreparedSourceImport {
  records: BundleImportManifest["sources"];
  sources: { schemaVersion: number; sources: SourceRecord[] };
  events: AgentpackEvent[];
  changed: boolean;
}

function prepareSourceImport(
  root: string,
  bundle: TaskBundle,
  importedAt: string,
  usedEventIds: Set<string>
): PreparedSourceImport {
  const sourceState = readSources(root);
  const existingPaths = new Set(sourceState.sources.map((source) => source.path));
  const records: BundleImportManifest["sources"] = [];
  const events: AgentpackEvent[] = [];
  let changed = false;

  for (const source of bundle.sources) {
    if (existingPaths.has(source.path)) {
      records.push({ path: source.path, hash: source.hash, action: "reused", reason: "existing local conclusion wins" });
      continue;
    }
    const absolutePath = path.join(root, source.path);
    if (!existsSync(absolutePath)) {
      records.push({ path: source.path, hash: source.hash, action: "skipped", reason: "local source file is missing" });
      continue;
    }
    if (sha256File(absolutePath) !== source.hash) {
      records.push({ path: source.path, hash: source.hash, action: "skipped", reason: "local source hash does not match imported hash" });
      continue;
    }
    const localRecord = getFileRecord(root, source.path, { summary: source.summary, snippet: source.snippet });
    sourceState.sources.push(localRecord);
    existingPaths.add(source.path);
    changed = true;
    records.push({ path: source.path, hash: source.hash, action: "created", reason: "local source hash matches imported hash" });
    events.push({
      id: nextUniqueId("evt", usedEventIds),
      ts: importedAt,
      type: "source-import",
      path: source.path,
      hash: source.hash,
      summary: source.summary,
      bundleId: bundle.bundleId
    });
  }

  return { records, sources: sourceState, events, changed };
}

function assertBundleSafeForDestination(root: string, bundle: TaskBundle): void {
  const redacted = deepRedact(root, bundle);
  if (stableStringify(redacted) !== stableStringify(bundle)) {
    throw new Error("Bundle contains values that require destination redaction; refusing write import.");
  }
}

function appendEventLines(existing: string, events: AgentpackEvent[]): string {
  if (events.length === 0) {
    return existing;
  }
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  return `${existing}${prefix}${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readValidatedTaskBundle(filePath: string): { bundle: TaskBundle; warnings: string[] } {
  const absolutePath = path.resolve(filePath);
  const stat = statSync(absolutePath);
  if (stat.size > MAX_BUNDLE_BYTES) {
    throw new Error(`Bundle exceeds ${MAX_BUNDLE_BYTES} byte limit.`);
  }

  const raw = readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const bundle = assertBundleShape(parsed);
  const digest = digestBundlePayload(stripBundleEnvelope(bundle));
  if (digest !== bundle.bundleId) {
    throw new Error(`Bundle digest mismatch: expected ${digest}, got ${bundle.bundleId}`);
  }

  const warnings = validateBundleRecords(bundle);
  return { bundle, warnings };
}

function bundleInspectResult(bundle: TaskBundle, warnings: string[]): BundleInspectResult {
  return {
    valid: true,
    bundleId: bundle.bundleId,
    digestStatus: "valid",
    schemaVersion: bundle.schemaVersion,
    producer: bundle.producer,
    origin: bundle.origin,
    task: {
      id: bundle.task.id,
      title: bundle.task.title,
      originalStatus: bundle.task.originalStatus,
      verificationStatus: bundle.task.originVerification.status
    },
    counts: {
      sources: bundle.sources.length,
      evidence: bundle.evidence.length
    },
    warnings,
    ...checkpointMetadata(bundle)
  };
}

function checkpointMetadata(bundle: TaskBundle): Pick<BundleInspectResult, "checkpoint"> {
  if (!bundle.checkpoint) return {};
  return {
    checkpoint: {
      id: bundle.checkpoint.id,
      taskId: bundle.checkpoint.taskId,
      ...(bundle.checkpoint.truncated ? { truncated: true } : {})
    }
  };
}

function formatBundleCheckpoint(result: Pick<BundleInspectResult, "checkpoint">): string[] {
  return result.checkpoint ? [`Checkpoint: ${result.checkpoint.id} (origin task ${result.checkpoint.taskId}${result.checkpoint.truncated ? "; summary truncated" : ""})`] : [];
}

export function formatBundleExportResult(result: BundleExportResult): string {
  return [
    `Exported bundle ${result.bundleId}`,
    `Task: ${result.taskId}`,
    `Path: ${result.outputPath}`,
    `Included: ${result.sources} source(s), ${result.evidence} evidence item(s), ${result.bytes} bytes`,
    ...formatBundleCheckpoint(result)
  ].join("\n");
}

export function formatBundleInspectResult(result: BundleInspectResult): string {
  return [
    `Bundle ${result.bundleId}`,
    `Status: ${result.valid ? "valid" : "invalid"} (${result.digestStatus} digest)`,
    `Task: ${result.task.id} - ${result.task.title}`,
    `Origin: ${result.origin.projectName}${result.origin.branch ? ` @ ${result.origin.branch}` : ""}${result.origin.head ? ` (${result.origin.head})` : ""}`,
    `Original status: ${result.task.originalStatus}`,
    `Verification: ${result.task.verificationStatus}`,
    `Included: ${result.counts.sources} source(s), ${result.counts.evidence} evidence item(s)`,
    ...formatBundleCheckpoint(result),
    result.warnings.length > 0 ? `Warnings: ${result.warnings.join("; ")}` : "Warnings: none"
  ].join("\n");
}

export function formatBundleImportPlan(plan: BundleImportPlan): string {
  return [
    `Bundle import plan ${plan.bundle.bundleId}`,
    "Mode: read-only (no pack writes)",
    `Task: ${plan.bundle.task.id} - ${plan.bundle.task.title}`,
    ...formatBundleCheckpoint(plan.bundle),
    `Destination: ${plan.destination.status}`,
    `Outcome: ${plan.action.outcome}`,
    `Planned: task ${plan.action.task}, bundle ${plan.action.bundle}`,
    plan.conflicts.length > 0
      ? `Conflicts: ${plan.conflicts.map((conflict) => conflict.message).join("; ")}`
      : "Conflicts: none",
    plan.warnings.length > 0 ? `Warnings: ${plan.warnings.join("; ")}` : "Warnings: none"
  ].join("\n");
}

export function formatBundleImportResult(result: BundleImportResult): string {
  const evidenceCounts = countManifestActions(result.manifest.evidence);
  const sourceCounts = countManifestActions(result.manifest.sources);
  const taskStatus = result.idempotent ? result.plan.destination.taskStatus || "parked" : "parked";
  const evidenceLabel = result.idempotent ? "Original import evidence" : "Evidence";
  const sourceLabel = result.idempotent ? "Original import sources" : "Sources";
  return [
    `${result.idempotent ? "Reused" : "Imported"} bundle ${result.bundleId}`,
    `Task: ${result.taskId} [${taskStatus}]`,
    `Applied: ${result.applied ? "yes" : "no (idempotent)"}`,
    `Manifest: ${result.manifestPath}`,
    `${evidenceLabel}: ${evidenceCounts}`,
    `${sourceLabel}: ${sourceCounts}`,
    result.manifest.unresolvedOriginEvidence.length > 0
      ? `Unresolved origin evidence: ${result.manifest.unresolvedOriginEvidence.join(", ")}`
      : "Unresolved origin evidence: none",
    "Current task pointer: unchanged"
  ].join("\n");
}

function countManifestActions(records: Array<{ action: string }>): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.action, (counts.get(record.action) || 0) + 1);
  }
  return counts.size > 0
    ? [...counts.entries()].map(([action, count]) => `${action} ${count}`).join(", ")
    : "none";
}

function normalizeBundleSourcePaths(root: string, sourcePaths: string[]): string[] {
  const normalized = sourcePaths.map((sourcePath) => normalizeBundlePath(root, sourcePath));
  return [...new Set(normalized)].sort();
}

function normalizeBundleOutputPath(root: string, outputPath: string): string {
  if (path.isAbsolute(outputPath)) {
    throw new Error(`Refusing absolute bundle output path: ${outputPath}`);
  }

  const absolutePath = path.resolve(root, outputPath);
  const relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing bundle output path outside project root: ${outputPath}`);
  }
  const normalizedRelativePath = normalizePath(relativePath);
  const topLevelPath = normalizedRelativePath.split("/")[0];
  if (topLevelPath === ".agentpack" || topLevelPath === ".git") {
    throw new Error(`Refusing bundle output path inside ${topLevelPath}: ${outputPath}`);
  }
  assertBundleOutputAncestor(root, path.dirname(absolutePath), outputPath);
  if (pathEntryExists(absolutePath)) {
    throw new Error(`Refusing to overwrite existing bundle output: ${outputPath}`);
  }
  return absolutePath;
}

function assertBundleOutputAncestor(root: string, outputDirectory: string, outputPath: string): void {
  let ancestor = outputDirectory;
  while (!pathEntryExists(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new Error(`Cannot resolve bundle output path: ${outputPath}`);
    }
    ancestor = parent;
  }

  let realRoot: string;
  let realAncestor: string;
  try {
    realRoot = realpathSync(root);
    realAncestor = realpathSync(ancestor);
  } catch {
    throw new Error(`Refusing bundle output path through an unresolved symlink: ${outputPath}`);
  }
  const relativeAncestor = path.relative(realRoot, realAncestor);
  if (relativeAncestor.startsWith("..") || path.isAbsolute(relativeAncestor)) {
    throw new Error(`Refusing bundle output path through a symlink outside project root: ${outputPath}`);
  }
}

function pathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeBundlePath(root: string, inputPath: string): string {
  if (!inputPath.trim()) {
    throw new Error("bundle source paths must not be empty");
  }
  if (path.isAbsolute(inputPath) || /^[A-Za-z]:\//.test(inputPath)) {
    throw new Error(`Refusing absolute bundle source path: ${inputPath}`);
  }

  const absolutePath = path.resolve(root, inputPath);
  const relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing bundle source path outside project root: ${inputPath}`);
  }
  return normalizePath(relativePath);
}

function selectedSources(root: string, sourcePaths: string[]): TaskBundleSource[] {
  if (sourcePaths.length > MAX_SOURCES) {
    throw new Error(`Bundle source count exceeds ${MAX_SOURCES}.`);
  }

  const sourceRecords = new Map(readSources(root).sources.map((source) => [source.path, source]));
  return sourcePaths.map((sourcePath) => {
    const source = sourceRecords.get(sourcePath);
    if (!source) {
      throw new Error(`No recorded source conclusion for ${sourcePath}. Run source add/review first or omit it.`);
    }
    return bundleSource(source);
  });
}

function bundleSource(source: SourceRecord): TaskBundleSource {
  return {
    path: source.path,
    hash: source.hash,
    size: source.size,
    recordedAt: source.recordedAt,
    summary: source.summary,
    snippet: source.snippet
  };
}

function referencedEvidence(root: string, evidenceIds: string[]): TaskBundleEvidence[] {
  const ids = [...new Set(evidenceIds)];
  if (ids.length > MAX_EVIDENCE) {
    throw new Error(`Bundle evidence count exceeds ${MAX_EVIDENCE}.`);
  }
  const events = readEvents(root).filter((event) => event.type === "evidence");
  const byId = new Map(events.map((event) => [event.id, event]));
  return ids.map((id) => {
    const event = byId.get(id);
    if (!event) {
      throw new Error(`Referenced evidence event not found: ${id}`);
    }
    return bundleEvidence(root, event);
  });
}

function bundleEvidence(root: string, event: AgentpackEvent): TaskBundleEvidence {
  const evidencePath = typeof event.path === "string" ? event.path : "";
  const normalizedPath = normalizeEvidencePath(evidencePath);
  const absolutePath = getPackPath(root, normalizedPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Referenced evidence file not found: ${evidencePath}`);
  }

  const stat = assertSafeEvidenceFile(root, absolutePath, evidencePath);
  if (stat.size > MAX_EVIDENCE_CONTENT_BYTES) {
    throw new Error(`Evidence ${event.id} exceeds ${MAX_EVIDENCE_CONTENT_BYTES} byte limit.`);
  }

  const kind = typeof event.kind === "string" ? event.kind : "note";
  const content = readFileSync(absolutePath, "utf8");
  if (kind === "json") {
    JSON.parse(content);
  }

  return {
    originId: event.id,
    kind,
    command: typeof event.command === "string" ? event.command : "",
    exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
    content,
    contentDigest: `sha256:${sha256(content)}`
  };
}

function assertSafeEvidenceFile(root: string, absolutePath: string, displayPath: string): Stats {
  const evidenceRoot = getPackPath(root, "evidence");
  const evidenceRootStat = lstatSync(evidenceRoot);
  if (evidenceRootStat.isSymbolicLink() || !evidenceRootStat.isDirectory()) {
    throw new Error(`Refusing unsafe evidence directory: ${evidenceRoot}`);
  }
  const relativePath = path.relative(evidenceRoot, absolutePath);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing evidence path outside evidence directory: ${displayPath}`);
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  let current = evidenceRoot;
  let finalStat: Stats | null = null;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link evidence path: ${displayPath}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Refusing evidence path through a non-directory: ${displayPath}`);
    }
    finalStat = stat;
  }
  if (!finalStat?.isFile()) {
    throw new Error(`Referenced evidence path is not a regular file: ${displayPath}`);
  }

  const realEvidenceRoot = realpathSync(evidenceRoot);
  const realEvidencePath = realpathSync(absolutePath);
  const realRelativePath = path.relative(realEvidenceRoot, realEvidencePath);
  if (!realRelativePath || realRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(realRelativePath)) {
    throw new Error(`Refusing evidence path outside evidence directory: ${displayPath}`);
  }
  return finalStat;
}

function normalizeEvidencePath(evidencePath: string): string {
  if (!evidencePath || path.isAbsolute(evidencePath)) {
    throw new Error(`Refusing invalid evidence path: ${evidencePath || "(empty)"}`);
  }
  const normalized = normalizePath(path.normalize(evidencePath));
  if (normalized.startsWith("../") || normalized === ".." || !normalized.startsWith("evidence/")) {
    throw new Error(`Refusing evidence path outside evidence directory: ${evidencePath}`);
  }
  return normalized;
}

function bundleOrigin(root: string, projectName: string, branch: string | null, head: string | null): TaskBundleOrigin {
  const repository = sanitizeRepositoryLocator(readOriginUrl(root));
  return repository
    ? { projectName, repository, branch, head }
    : { projectName, branch, head };
}

function readOriginUrl(root: string): string {
  try {
    return execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function sanitizeRepositoryLocator(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.startsWith("file:") || path.isAbsolute(value) || value.startsWith(".")) {
    return undefined;
  }

  const withoutGitPrefix = value.startsWith("git+") ? value.slice(4) : value;
  if (/^https?:\/\//i.test(withoutGitPrefix) || /^ssh:\/\//i.test(withoutGitPrefix)) {
    try {
      const url = new URL(withoutGitPrefix);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return undefined;
    }
  }

  const scpLike = value.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpLike) {
    const host = scpLike[1];
    const rawRepositoryPath = scpLike[2];
    if (!host || !rawRepositoryPath) {
      return undefined;
    }
    const repositoryPath = rawRepositoryPath.split(/[?#]/, 1)[0]?.replace(/^\/+/, "");
    return repositoryPath ? `ssh://${host}/${repositoryPath}` : undefined;
  }

  return undefined;
}

function deepRedact(root: string, value: unknown): unknown {
  if (typeof value === "string") {
    return redactExportString(root, value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(root, item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepRedact(root, item)])
    );
  }
  return value;
}

function redactExportString(root: string, value: string): string {
  const redacted = redactForRoot(root, value);
  return redacted.split(root).join("[REDACTED:WORKTREE]");
}

function assertBundleShape(value: unknown): TaskBundle {
  if (!isRecord(value)) {
    throw new Error("Bundle must be a JSON object.");
  }
  if (value.kind !== BUNDLE_KIND) {
    throw new Error("Unsupported bundle kind.");
  }
  if (value.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    throw new Error(`Unsupported bundle schema version: ${String(value.schemaVersion)}`);
  }
  if (typeof value.bundleId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.bundleId)) {
    throw new Error("Bundle is missing a sha256 bundleId.");
  }
  if (typeof value.exportedAt !== "string") {
    throw new Error("Bundle is missing exportedAt.");
  }
  if (!isRecord(value.producer) || value.producer.name !== "agentpack-cli" || typeof value.producer.version !== "string") {
    throw new Error("Bundle producer is invalid.");
  }
  if (
    !isRecord(value.origin) ||
    typeof value.origin.projectName !== "string" ||
    !optionalString(value.origin.repository) ||
    !nullableString(value.origin.branch) ||
    !nullableString(value.origin.head)
  ) {
    throw new Error("Bundle origin is invalid.");
  }
  if (
    !isRecord(value.task) ||
    typeof value.task.id !== "string" ||
    typeof value.task.title !== "string" ||
    typeof value.task.objective !== "string" ||
    !stringArrayValue(value.task.constraints) ||
    !stringArrayValue(value.task.writeScope) ||
    !taskRiskValue(value.task.risk) ||
    !stringArrayValue(value.task.tags) ||
    !stringArrayValue(value.task.nextActions) ||
    !taskStatusValue(value.task.originalStatus) ||
    !isRecord(value.task.originVerification) ||
    !verificationStatusValue(value.task.originVerification.status) ||
    !stringArrayValue(value.task.originVerification.evidence) ||
    typeof value.task.originVerification.summary !== "string"
  ) {
    throw new Error("Bundle task is invalid.");
  }
  if (typeof value.handoffMarkdown !== "string") {
    throw new Error("Bundle handoffMarkdown must be a string.");
  }
  if (value.checkpoint !== undefined && !isTaskCheckpoint(value.checkpoint)) {
    throw new Error(`Bundle checkpoint must be valid metadata within the ${MAX_TASK_CHECKPOINT_BYTES} byte limit.`);
  }
  if (!Array.isArray(value.sources) || value.sources.length > MAX_SOURCES) {
    throw new Error(`Bundle sources must be an array with at most ${MAX_SOURCES} items.`);
  }
  if (!Array.isArray(value.evidence) || value.evidence.length > MAX_EVIDENCE) {
    throw new Error(`Bundle evidence must be an array with at most ${MAX_EVIDENCE} items.`);
  }
  for (const source of value.sources) {
    if (
      !isRecord(source) ||
      typeof source.path !== "string" ||
      typeof source.hash !== "string" ||
      typeof source.size !== "number" ||
      typeof source.recordedAt !== "string" ||
      typeof source.summary !== "string" ||
      typeof source.snippet !== "string"
    ) {
      throw new Error("Bundle source entry is invalid.");
    }
  }
  for (const evidence of value.evidence) {
    if (
      !isRecord(evidence) ||
      typeof evidence.originId !== "string" ||
      typeof evidence.kind !== "string" ||
      typeof evidence.command !== "string" ||
      !(typeof evidence.exitCode === "number" || evidence.exitCode === null) ||
      typeof evidence.content !== "string" ||
      typeof evidence.contentDigest !== "string"
    ) {
      throw new Error("Bundle evidence entry is invalid.");
    }
  }

  return value as unknown as TaskBundle;
}

function validateBundleRecords(bundle: TaskBundle): string[] {
  const warnings: string[] = [];
  validateBundleTaskId(bundle.task.id);
  const sourcePaths = new Set<string>();
  for (const source of bundle.sources) {
    validateRelativeBundlePath(source.path, "source");
    if (sourcePaths.has(source.path)) {
      throw new Error(`Duplicate source path in bundle: ${source.path}`);
    }
    sourcePaths.add(source.path);
    if (!/^[0-9a-f]{64}$/.test(source.hash) || !Number.isSafeInteger(source.size) || source.size < 0) {
      throw new Error(`Invalid source metadata in bundle: ${source.path}`);
    }
  }
  for (const writePath of bundle.task.writeScope) {
    validateRelativeBundlePath(writePath, "write scope", true);
  }
  const evidenceIds = new Set<string>();
  for (const evidence of bundle.evidence) {
    if (!/^evt_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(evidence.originId)) {
      throw new Error(`Invalid evidence id in bundle: ${evidence.originId || "(empty)"}`);
    }
    if (evidenceIds.has(evidence.originId)) {
      throw new Error(`Duplicate evidence id in bundle: ${evidence.originId}`);
    }
    evidenceIds.add(evidence.originId);
    if (evidence.contentDigest !== `sha256:${sha256(evidence.content)}`) {
      throw new Error(`Evidence digest mismatch for ${evidence.originId}.`);
    }
    if (Buffer.byteLength(evidence.content, "utf8") > MAX_EVIDENCE_CONTENT_BYTES) {
      throw new Error(`Evidence ${evidence.originId} exceeds ${MAX_EVIDENCE_CONTENT_BYTES} byte limit.`);
    }
    if (evidence.kind === "json") {
      JSON.parse(evidence.content);
    }
  }
  if (bundle.task.originVerification.evidence.length > bundle.evidence.length) {
    warnings.push("verification references evidence not included in this bundle");
  }
  return warnings;
}

function validateBundleTaskId(taskId: string): void {
  if (!/^task_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) {
    throw new Error(`Invalid task id in bundle: ${taskId || "(empty)"}`);
  }
}

function validateRelativeBundlePath(filePath: string, label: string, allowDot = false): void {
  if (allowDot && filePath === ".") {
    return;
  }
  const normalized = normalizePath(path.posix.normalize(filePath));
  if (
    !filePath ||
    filePath.includes("\\") ||
    /^[A-Za-z]:\//.test(filePath) ||
    path.isAbsolute(filePath) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid ${label} path in bundle: ${filePath || "(empty)"}`);
  }
}

function stripBundleEnvelope(bundle: TaskBundle): Omit<TaskBundle, "bundleId" | "exportedAt"> {
  const { bundleId: _bundleId, exportedAt: _exportedAt, ...payload } = bundle;
  return payload;
}

function digestBundlePayload(payload: Omit<TaskBundle, "bundleId" | "exportedAt">): string {
  return `sha256:${sha256(stableStringify(payload))}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function stringArrayValue(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function taskRiskValue(value: unknown): boolean {
  return value === "low" || value === "medium" || value === "high" || value === "unknown";
}

function taskStatusValue(value: unknown): boolean {
  return value === "active" ||
    value === "parked" ||
    value === "blocked" ||
    value === "verifying" ||
    value === "completed" ||
    value === "abandoned";
}

function bundleOriginValue(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.projectName === "string" &&
    optionalString(value.repository) &&
    nullableString(value.branch) &&
    nullableString(value.head);
}

function verificationStatusValue(value: unknown): boolean {
  return value === "unknown" ||
    value === "pending" ||
    value === "passed" ||
    value === "failed" ||
    value === "accepted";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
