export type GateMode = "off" | "warn" | "block";

export interface AgentpackConfig {
  schemaVersion: number;
  projectName: string;
  redactions: string[];
  defaultBudget: number;
  includeGitDiff: boolean;
  gateMode?: GateMode;
}

export interface AgentpackState {
  schemaVersion: number;
  goal: string | null;
  currentStatus: string;
  nextActions: string[];
  currentCheckpoint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceRecord {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  recordedAt: string;
  summary: string;
  snippet: string;
}

export interface SourcesFile {
  schemaVersion: number;
  sources: SourceRecord[];
}

export type TaskStatus = "active" | "parked" | "blocked" | "verifying" | "completed" | "abandoned";
export type TaskRisk = "low" | "medium" | "high" | "unknown";

export interface TaskVerification {
  status: "unknown" | "pending" | "passed" | "failed" | "accepted";
  evidence: string[];
  summary: string;
}

export interface TaskPassport {
  schemaVersion: number;
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  objective: string;
  constraints: string[];
  branch: string | null;
  baseHead: string | null;
  currentHead: string | null;
  worktree: string;
  writeScope: string[];
  risk: TaskRisk;
  verification: TaskVerification;
  nextActions: string[];
  tags: string[];
  blockedReason?: string;
}

export interface AgentpackEvent {
  id: string;
  ts: string;
  type: string;
  [key: string]: unknown;
}

export interface GitInfo {
  available: boolean;
  topLevel?: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  aheadCommits: string[];
  status: string;
  diffStat?: string;
  diff: string;
}

export interface TaskBundleProducer {
  name: "agentpack-cli";
  version: string;
}

export interface TaskBundleOrigin {
  projectName: string;
  repository?: string;
  branch: string | null;
  head: string | null;
}

export interface TaskBundleTask {
  id: string;
  title: string;
  objective: string;
  constraints: string[];
  writeScope: string[];
  risk: TaskRisk;
  tags: string[];
  nextActions: string[];
  originalStatus: TaskStatus;
  originVerification: TaskVerification;
}

export interface TaskBundleSource {
  path: string;
  hash: string;
  size: number;
  recordedAt: string;
  summary: string;
  snippet: string;
}

export interface TaskBundleEvidence {
  originId: string;
  kind: string;
  command: string;
  exitCode: number | null;
  content: string;
  contentDigest: string;
}

export interface TaskCheckpoint {
  id: string;
  taskId: string;
  createdAt: string;
  summary: string;
  git: { branch: string | null; head: string | null };
  truncated?: boolean;
}

export interface TaskBundle {
  kind: "agentpack.task-bundle";
  schemaVersion: 1;
  bundleId: string;
  exportedAt: string;
  producer: TaskBundleProducer;
  origin: TaskBundleOrigin;
  task: TaskBundleTask;
  handoffMarkdown: string;
  checkpoint?: TaskCheckpoint;
  sources: TaskBundleSource[];
  evidence: TaskBundleEvidence[];
}

export interface BundleExportOptions {
  taskId?: string;
  outputPath: string;
  sourcePaths?: string[];
  includeEvidence?: boolean;
  producerVersion?: string;
}

export interface BundleExportResult {
  bundleId: string;
  outputPath: string;
  taskId: string;
  sources: number;
  evidence: number;
  bytes: number;
  checkpoint?: Pick<TaskCheckpoint, "id" | "taskId" | "truncated">;
}

export interface BundleInspectResult {
  valid: boolean;
  bundleId: string;
  digestStatus: "valid";
  schemaVersion: number;
  producer: TaskBundleProducer;
  origin: TaskBundleOrigin;
  task: {
    id: string;
    title: string;
    originalStatus: TaskStatus;
    verificationStatus: TaskVerification["status"];
  };
  counts: {
    sources: number;
    evidence: number;
  };
  warnings: string[];
  checkpoint?: Pick<TaskCheckpoint, "id" | "taskId" | "truncated">;
}

export type BundleImportOutcome = "create" | "idempotent" | "conflict";
export type BundleImportDestinationStatus =
  | "uninitialized"
  | "task-missing"
  | "task-present"
  | "already-imported"
  | "orphaned-import"
  | "import-conflict";

export interface BundleImportConflict {
  kind: "task-id" | "destination-state";
  message: string;
}

export interface BundleImportPlan {
  readOnly: true;
  writes: [];
  bundle: BundleInspectResult;
  destination: {
    status: BundleImportDestinationStatus;
    packInitialized: boolean;
    taskExists: boolean;
    taskStatus: TaskStatus | null;
    importedBundleExists: boolean;
    taskId: string | null;
  };
  action: {
    outcome: BundleImportOutcome;
    task: "create" | "reuse" | "conflict";
    bundle: "retain" | "reuse" | "blocked";
  };
  conflicts: BundleImportConflict[];
  warnings: string[];
}

export interface BundleImportOptions {
  asNew?: boolean;
}

export interface BundleImportEvidenceRecord {
  originId: string;
  destinationId: string;
  contentDigest: string;
  action: "created" | "reused" | "remapped";
}

export interface BundleImportSourceRecord {
  path: string;
  hash: string;
  action: "created" | "reused" | "skipped";
  reason: string;
}

export interface BundleImportManifest {
  schemaVersion: 1;
  bundleId: string;
  importedAt: string;
  sourceTaskId: string;
  destinationTaskId: string;
  asNew: boolean;
  origin: TaskBundleOrigin;
  originalStatus: TaskStatus;
  originVerification: TaskVerification;
  unresolvedOriginEvidence: string[];
  task: {
    action: "created" | "reused";
    remappedFrom: string | null;
  };
  evidence: BundleImportEvidenceRecord[];
  sources: BundleImportSourceRecord[];
}

export interface BundleImportResult {
  applied: boolean;
  idempotent: boolean;
  bundleId: string;
  taskId: string;
  manifestPath: string;
  plan: BundleImportPlan;
  manifest: BundleImportManifest;
}
