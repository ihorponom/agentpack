import { appendEvent, requirePackRoot } from "../core/store.js";
import { buildUsageReport, formatUsageReport } from "../core/usage.js";
import { buildTaskUsageReport, formatTaskUsageReport, usageTaskId } from "../core/usage-manifest.js";
import { buildTaskUsage, formatTaskUsage, formatUsageLinkResult, runUsageLink, type UsageLinkRequest } from "../core/usage-discovery.js";
import { buildResume } from "../core/resume.js";
import { createCheckpoint, diffCheckpoints } from "../core/checkpoints.js";
import {
  exportTaskBundle,
  formatBundleExportResult,
  formatBundleImportPlan,
  formatBundleImportResult,
  formatBundleInspectResult,
  importTaskBundle,
  inspectTaskBundle,
  planTaskBundleImport
} from "../core/bundles.js";
import { buildReleasePreflightReport } from "../core/release.js";
import { addEvidence, addSourceRecord, formatSourceStatuses, getCeremonyDiagnostics, getSourceStatuses, replayEvents, type SourceStatusKind } from "../operations.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { BUDGET_PRESET_NAMES, isBudgetPreset, resolveBudget, type BudgetPreset } from "../core/presets.js";
import { evaluateGate } from "../core/gate.js";
import { redactForRoot } from "../core/redaction.js";
import {
  auditCurrentTask,
  finalizeAdvisories,
  finalizeCurrentTask,
  formatCurrentTaskHandoff,
  formatTaskStatus,
  formatTaskAuditReport,
  formatTaskFinalizationMessage,
  formatTaskList,
  formatTaskMutationMessage,
  formatVerificationUpdateMessage,
  listTasks,
  OPEN_TASK_STATUSES,
  TASK_LIST_STATUSES,
  scopeOverlaps,
  parkCurrentTask,
  startTask,
  switchTask,
  type TaskStartOptions,
  type TaskUpdateOptions,
  updateCurrentTaskPassport,
  updateCurrentTaskVerification
} from "../core/tasks.js";

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const TASK_LIST_WARNINGS_META_KEY = "io.agentpack/taskListWarnings";
const MODERN_CACHEABLE_METHODS = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read"
]);

class McpProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

const READ_ONLY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false
};

const ADDITIVE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};

const UPDATING_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "usage_report",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Report local Codex/Claude Code usage when the user asks about work usage. Pass task (Task Passport id; omit for the current task) to report the sources linked to it; sessions that ran Agentpack for the task (and their subagents) are included automatically; if none are traced or linked, the result lists candidate sessions of the task worktree to link with usage_link. Task reports count only requests made while the task was the current Passport; a subagent counts whole for the task current when it started. Alternatively supply manifest, or client/files for a direct report. Same read-only report as CLI usage report; no collection, rates or ledger writes. Includes estimated Agentpack call overhead, not schema cost or billing. Optional byTurn shows boundaries and turns selects N, N: or N:M in one file. Monetary snapshots are source-session estimates, unavailable for filtered ranges. Supported clients: Codex and Claude Code.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        manifest: { type: "string", minLength: 1, description: "Local task usage manifest; exclusive with direct source options. Paths inside it resolve from its directory." },
        client: { type: "string", enum: ["codex", "claude"] },
        files: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, description: "Explicit local JSONL paths; relative paths resolve from the pack root." },
        task: { type: "string", description: "Task Passport id whose linked sources to report (omit for the current task). With client/files it is only a descriptive label." },
        from: { type: "string", description: "Inclusive ISO timestamp with timezone." },
        to: { type: "string", description: "Exclusive ISO timestamp with timezone." },
        byTurn: { type: "boolean", description: "Include source-local turn rows." },
        turns: { type: "string", description: "Inclusive N or N:M turn selection; exactly one file required." },
        json: { type: "boolean", description: "Return aggregate report JSON as text instead of human-readable text." }
      }, oneOf: [
        { required: ["manifest"], not: { anyOf: ["client", "files", "task", "from", "to", "turns"].map(key => ({ required: [key] })) } },
        { required: ["client", "files"], not: { required: ["manifest"] } },
        { not: { anyOf: ["manifest", "client", "files", "from", "to", "turns"].map(key => ({ required: [key] })) } }
      ]
    }
  },
  {
    name: "usage_link",
    annotations: UPDATING_TOOL_ANNOTATIONS,
    description: "Link Codex/Claude Code session transcripts to a Task Passport so usage_report can report the task by id. Without pick, file, remove or coverage it only lists candidate sessions of the task worktree with requests while the task was current. Show candidates to the user and link only what they confirm: pick links sessions by session id (numbers can shift between calls); client/file/turns links an explicit one. Re-linking a file replaces its selection; remove unlinks a linked file by path or session id (traced sessions are always included). Writes .agentpack/usage/<task id>.json only.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        task: { type: "string", minLength: 1, description: "Task Passport id; omit for the current task." },
        pick: { type: "array", minItems: 1, items: { oneOf: [{ type: "string", minLength: 1 }, { type: "integer", minimum: 1 }] }, description: "Candidate session ids (preferred) or numbers from the listing to link." },
        client: { type: "string", enum: ["codex", "claude"] },
        file: { type: "string", minLength: 1, description: "Explicit local JSONL path; relative paths resolve from the pack root." },
        turns: { type: "string", description: "Inclusive N, N: (to the end) or N:M turn selection for file." },
        phase: { type: "string", minLength: 1, description: "Phase label for the linked sources. Default main." },
        coverage: { type: "string", enum: ["partial", "declared-complete"], description: "Declared coverage; requires note." },
        note: { type: "string", minLength: 1, description: "Coverage note; requires coverage." },
        remove: { type: "string", minLength: 1, description: "Linked JSONL path or session id to unlink; exclusive with other link options." },
        json: { type: "boolean", description: "Return JSON instead of human-readable text." }
      }
    }
  },
  {
    name: "load_context",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Load a token-budgeted markdown resume of Agentpack state for the current task: Task Passport status and next actions, git state, query-relevant decisions, dead ends, and source conclusions, plus gate warnings when the task lifecycle needs attention. Call once at the start of a session or task, before reading code; re-call only for a different query or budget. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Focused free-text query for the current task. Matching source records keep full summaries; unrelated records collapse to compact stubs to save tokens."
        },
        budget: {
          type: "number",
          description: "Approximate token budget for the resume. Takes precedence over preset. Default 4000."
        },
        preset: {
          type: "string",
          enum: BUDGET_PRESET_NAMES,
          description: "Named token budget: quick (1200), chat (4000), agent (8000), or deep (16000). Use quick for task-start orientation."
        }
      }
    }
  },
  {
    name: "record_decision",
    annotations: ADDITIVE_TOOL_ANNOTATIONS,
    description: "Append a durable technical or product decision to the Agentpack ledger so future sessions inherit it. Call for decisions that matter beyond this session (architecture, contracts, tradeoffs), not for routine preferences or per-edit narration. Writes one event under .agentpack/; secret-like values are redacted.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The decision and its rationale, in one or two sentences."
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths the decision applies to."
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Evidence ids (from attach_evidence) supporting the decision."
        }
      },
      required: ["text"]
    }
  },
  {
    name: "record_dead_end",
    annotations: ADDITIVE_TOOL_ANNOTATIONS,
    description: "Record an approach that failed so future agents do not repeat it. Call when an attempted direction is abandoned for a durable reason, not for ordinary debugging iterations. Writes one event under .agentpack/; secret-like values are redacted.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The approach that was tried and abandoned."
        },
        reason: {
          type: "string",
          description: "Why it failed or must not be retried."
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths involved in the failed approach."
        }
      },
      required: ["text"]
    }
  },
  {
    name: "attach_evidence",
    annotations: ADDITIVE_TOOL_ANNOTATIONS,
    description: "Store verification output (test results, command output, review findings, notes, or links) as a file under .agentpack/evidence/ plus a ledger event, returning an evidence id to reference from task_update_verification, task_finalize, or record_decision. Call for meaningful verification worth preserving; for small tasks prefer one aggregated evidence item over many per-command items. Provide the body inline via content or from a file via path.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Free-form label such as test, command, note, link, or json. Defaults to note; kind json stores the file with a .json extension."
        },
        content: {
          type: "string",
          description: "Inline evidence body. Ignored when path is set."
        },
        path: {
          type: "string",
          description: "Repo-relative path to an existing file whose contents become the evidence body (alternative to content)."
        },
        command: {
          type: "string",
          description: "Command that produced the output, stored as metadata."
        },
        exitCode: {
          type: "number",
          description: "Exit code of that command, stored as metadata."
        }
      }
    }
  },
  {
    name: "record_source",
    annotations: UPDATING_TOOL_ANNOTATIONS,
    description: "Record a durable conclusion about a source file in the Source Cache: stores the file's current content hash with your summary so future sessions can reuse the conclusion until the file changes. Call after inspecting an important file when the conclusion is reusable; do not record every file read, and re-record only when the conclusion itself changed. Writes under .agentpack/.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repo-relative path of the inspected file."
        },
        summary: {
          type: "string",
          description: "Durable conclusion about the file. Always provide one; the fallback is a generic 'Reviewed source.'"
        },
        snippet: {
          type: "string",
          description: "Optional short excerpt worth keeping with the conclusion."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "source_status",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Check whether recorded source conclusions are unchanged, changed, or missing by re-hashing the files; use changed/missing filters for stale source-cache triage. Call when you need a full stale-source check beyond what load_context already showed; do not repeat it when a recent load_context, task_audit, or status check answered the question. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        },
        changed: {
          type: "boolean",
          description: "Only report sources whose content hash changed since recorded."
        },
        missing: {
          type: "boolean",
          description: "Only report recorded sources whose files no longer exist."
        }
      }
    }
  },
  {
    name: "task_audit",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Audit the current Task Passport for continuity risks and advisory-only risk-proportional adversarial-verification evidence (a concise verification note or test output at low risk; independent read-only review and a named disconfirming check at medium/high risk). It does not judge semantic correctness or block lifecycle actions. Call before finalizing, after a long gap, or when drift is suspected; skip when a recent audit already answered it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        }
      }
    }
  },
  {
    name: "release_preflight",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Report local release readiness: release metadata, Trusted Publisher wiring, and the manual release-prep commands. Read-only — never pushes, tags, publishes, or creates GitHub Releases. Call when preparing a release, not during routine work.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "bundle_export",
    annotations: ADDITIVE_TOOL_ANNOTATIONS,
    description: "Export one Task Passport with its decisions, dead ends, source conclusions, and optionally evidence to a redacted agentpack.task-bundle JSON file, for sharing tasks across repos, machines, or agents. Writes only the new bundle file at outputPath; pack state is unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Task Passport id to export. Defaults to the current task."
        },
        outputPath: {
          type: "string",
          description: "Destination bundle file: must be a new repo-relative path outside .agentpack/ and .git/; existing files and symlink escapes are rejected."
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative source paths whose Source Cache records to include."
        },
        includeEvidence: {
          type: "boolean",
          description: "Include referenced evidence file contents. Defaults to true."
        }
      },
      required: ["outputPath"]
    }
  },
  {
    name: "bundle_inspect",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Validate and summarize an untrusted task bundle file: schema and digest status, origin, included records, and warnings. Read-only — never writes pack state. Call before planning or applying an import of a bundle you did not produce.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the bundle JSON file to inspect."
        },
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "bundle_import_plan",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Plan a task bundle import against this pack without writing anything: returns create, idempotent, or conflict actions with an explicit read-only guarantee. Call to preview exactly what bundle_import with write: true would do.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the bundle JSON file to plan against this pack."
        },
        asNew: {
          type: "boolean",
          description: "Preview importing under a deterministic new task id instead of the bundle's original id (resolves id collisions)."
        },
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "bundle_import",
    annotations: ADDITIVE_TOOL_ANNOTATIONS,
    description: "Import a task bundle into this pack. By default it only returns the read-only import plan; nothing is written unless write is true. A write import runs under a pack lock, creates a parked task with local verification reset to unknown, retains the bundle and an import manifest, and never changes the current-task pointer. Inspect or plan untrusted bundles first.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the bundle JSON file to import."
        },
        write: {
          type: "boolean",
          description: "Apply the import. When false or omitted, only the read-only plan is returned."
        },
        asNew: {
          type: "boolean",
          description: "Resolve a task-id collision by importing under a deterministic new id."
        },
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "task_handoff",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Generate a compact handoff for the current Task Passport — objective, constraints, write scope, next actions, verification, drift, and audit summary — so another chat, client, worktree, or agent can continue the work. Call before switching contexts. Read-only.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "task_start",
    annotations: ADDITIVE_TOOL_ANNOTATIONS,
    description: "Create a new Task Passport and make it current, persisting it under .agentpack/. Call when starting a coherent phase of work and no task is active; it refuses to replace an active, blocked, or verifying current task — park or finalize that task first. Declare writeScope so the task gate can protect the task's boundaries.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short imperative task title."
        },
        objective: {
          type: "string",
          description: "What done looks like for this task."
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Rules the work must respect."
        },
        writeScope: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative prefix paths this task is allowed to modify. A directory path includes its children; globs are not supported."
        },
        nextActions: {
          type: "array",
          items: { type: "string" },
          description: "Initial concrete next steps."
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form labels for grouping tasks."
        },
        risk: {
          type: "string",
          enum: ["unknown", "low", "medium", "high"],
          description: "Risk level of the task."
        }
      },
      required: ["title"]
    }
  },
  {
    name: "task_status",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Print a compact current-task state line by default; pass full: true for the detailed current view, or id to inspect a selected Passport with objective, constraints, all next actions and verification without switching tasks. Gate warnings always concern the actual current task. No source-cache scan; use task_audit for the full continuity audit. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "Task Passport id to inspect in full without changing the current task or lifecycle." },
        full: { type: "boolean", description: "Show the detailed current-task summary instead of the compact state line." }
      }
    }
  },
  {
    name: "task_list",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Find Task Passport ids or inspect task history. Without status lists open tasks; pass all: true for full history. compact and limit shorten the result. Filters combine with AND; current task is marked with an asterisk. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        open: { type: "boolean", description: "Only active, parked, blocked, and verifying tasks (the default). Cannot combine true with status." },
        all: { type: "boolean", description: "Include completed and abandoned tasks. Cannot combine with open: true or status." },
        status: {
          description: "One status or a non-empty array of statuses (OR within this filter).",
          oneOf: [{ type: "string", enum: [...TASK_LIST_STATUSES] }, { type: "array", minItems: 1, items: { type: "string", enum: [...TASK_LIST_STATUSES] } }]
        },
        scope: {
          description: "One path or a non-empty array of paths overlapping task write scopes, matching CLI --scope semantics.",
          oneOf: [{ type: "string", minLength: 1 }, { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }]
        },
        compact: { type: "boolean", description: "Omit branch/scope in text or JSON whitespace; JSON fields remain unchanged." },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Return at most this many matching tasks, newest updated first. Result metadata reports matched/returned/omitted counts." },
        json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text."
        }
      }
    }
  },
  {
    name: "task_switch",
    annotations: UPDATING_TOOL_ANNOTATIONS,
    description: "Make another open Task Passport current by id. Set parkCurrent: true to park a different active/blocked/verifying current task in the same locked transaction, after validating the target. Otherwise park or finalize it first. A parked target with pending or unknown verification resumes as active; a parked target with a final verdict resumes as verifying and stays frozen until verification returns to pending. Closed targets cannot be switched to.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Task Passport id to switch to (see task_list)."
        },
        parkCurrent: { type: "boolean", description: "Park a different current open task and switch in one call. Default false; preserves its verification and bound HEAD." }
      },
      required: ["id"]
    }
  },
  {
    name: "task_park",
    annotations: UPDATING_TOOL_ANNOTATIONS,
    description: "Mark the current Task Passport parked so unrelated work can start without finalizing it. Use for intentionally deferred work: parking preserves verification state and the task can be resumed later with task_switch. Do not park to skip verification of finished work; use task_finalize to close it instead.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "task_update_verification",
    annotations: UPDATING_TOOL_ANNOTATIONS,
    description: "Update the current Task Passport verification state. A final verdict (passed, failed, or accepted) moves the task lifecycle to verifying; pending or unknown returns it to active. Call after attach_evidence so the verdict is evidence-backed; identical repeated calls are no-ops.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["unknown", "pending", "passed", "failed", "accepted"],
          description: "Verification status to set."
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Evidence ids from attach_evidence backing this verdict."
        },
        summary: {
          type: "string",
          description: "Short summary of what was verified and how."
        }
      }
    }
  },
  {
    name: "task_finalize",
    annotations: UPDATING_TOOL_ANNOTATIONS,
    description: "Close the current Task Passport. Requires verification to already be passed, failed, or accepted, or that final status passed explicitly via status. Use task_park for deferred work instead of closing it; accepted finalization with remaining next actions requires force. Returns non-blocking hygiene and adversarial-verification advisories only; it never judges semantic correctness or blocks completion.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["passed", "failed", "accepted"],
          description: "Final verification status to set while closing."
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Evidence ids from attach_evidence backing the final verdict."
        },
        summary: {
          type: "string",
          description: "Closing summary; mention relevant commit hashes here."
        },
        force: {
          type: "boolean",
          description: "Allow accepted finalization even though next actions remain."
        }
      }
    }
  },
  {
    name: "task_update",
    annotations: UPDATING_TOOL_ANNOTATIONS,
    description: "Patch the current Task Passport without changing lifecycle status. List fields (constraints, writeScope, nextActions, tags) append and deduplicate; omitted fields are preserved; empty or no-op updates fail. Pass clearNextActions to replace the next-actions list instead of appending, e.g. to clear a stale plan before finalizing. Pass replaceConstraints to replace constraints that are obsolete or superseded; removed constraints stay in the task history.",
    inputSchema: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description: "Replacement objective text."
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Constraints to append, or the full replacement list when replaceConstraints is true."
        },
        writeScope: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative prefix paths to append to the write scope. A directory path includes its children; globs are not supported."
        },
        nextActions: {
          type: "array",
          items: { type: "string" },
          description: "Next steps to append, or the full replacement list when clearNextActions is true."
        },
        clearNextActions: {
          type: "boolean",
          description: "Replace the next actions with the provided nextActions (or clear them) instead of appending."
        },
        replaceConstraints: {
          type: "boolean",
          description: "Replace the constraints with the provided constraints (or clear them) instead of appending; removed ones are recorded in the task-update event."
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form labels to append."
        },
        risk: {
          type: "string",
          enum: ["unknown", "low", "medium", "high"],
          description: "New risk level for the task."
        }
      }
    }
  },
  {
    name: "checkpoint",
    annotations: UPDATING_TOOL_ANNOTATIONS,
    description: "Save a durable progress checkpoint under .agentpack/checkpoints, capturing summary, git state (branch, commit, diff) and the current task id when that task is active, blocked or verifying, and updating the pack-level status and next actions that seed the next session's load_context. Call after meaningful progress, before ending a session, or before risky changes — not after every small step.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "What was accomplished and decided since the last checkpoint."
        },
        status: {
          type: "string",
          description: "Current overall status line, replacing the previous one."
        },
        nextActions: {
          type: "array",
          items: { type: "string" },
          description: "Concrete next steps, replacing the previous list when non-empty."
        }
      }
    }
  },
  {
    name: "resume",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Generate the same token-budgeted markdown resume as load_context: Task Passport state, git state, query-relevant records, and gate warnings. Prefer load_context at task start; use resume for ad-hoc re-reads with a different query or budget mid-session. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        budget: {
          type: "number",
          description: "Approximate token budget for the resume. Takes precedence over preset. Default 4000."
        },
        preset: {
          type: "string",
          enum: BUDGET_PRESET_NAMES,
          description: "Named token budget: quick (1200), chat (4000), agent (8000), or deep (16000)."
        },
        query: {
          type: "string",
          description: "Focused free-text query. Matching source records keep full summaries; unrelated records collapse to compact stubs."
        }
      }
    }
  },
  {
    name: "diff",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Compare two checkpoints, showing their summaries, status lines, and git refs side by side. Defaults to comparing the previous checkpoint against the latest. Call to see what changed between sessions. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Checkpoint id to compare from. Defaults to the second-most-recent checkpoint."
        },
        to: {
          type: "string",
          description: "Checkpoint id to compare to. Defaults to the latest checkpoint."
        }
      }
    }
  },
  {
    name: "replay",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    description: "Print a chronological timeline of recent Agentpack ledger events (decisions, dead ends, evidence, source records, checkpoints, task events), one line per event with timestamp and type. Call to audit how the task history unfolded when a resume is not enough; not part of the routine load_context/checkpoint loop. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of most recent events to show. Defaults to 30."
        }
      }
    }
  }
];

interface McpWarningState {
  branchWarningKey?: string;
}

export function startMcpServer(startDir: string, input: Readable = process.stdin, output: Writable = process.stdout): void {
  const root = requirePackRoot(startDir);
  const warnings: McpWarningState = {};
  let buffer = "";

  input.setEncoding("utf8");
  input.on("data", (chunk: string | Buffer) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      handleMessage(root, line, output, warnings);
    }
  });
}

function handleMessage(root: string, line: string, output: Writable, warnings: McpWarningState): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    send(output, null, null, { code: -32700, message: errorMessage(error) });
    return;
  }

  if (!isObject(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string"
      || (parsed.id !== undefined && parsed.id !== null && typeof parsed.id !== "string"
        && !(typeof parsed.id === "number" && Number.isFinite(parsed.id)))) {
    send(output, null, null, { code: -32600, message: "Invalid JSON-RPC request" });
    return;
  }

  const request = parsed as JsonRpcRequest;
  const notification = request.id === undefined;
  if (notification && request.method?.startsWith("notifications/")) {
    return;
  }

  try {
    if (request.params !== undefined && !isObject(request.params)) {
      throw new McpProtocolError(-32602, "params must be an object");
    }
    const params = request.params ?? {};
    const modern = validateModernRequest(params);
    // A notification has no response: it must not mark a warning as shown.
    const result = route(root, request.method, params, modern, notification ? {} : warnings);
    if (notification && request.method === "tools/call"
        && TOOL_DEFINITIONS.find((tool) => tool.name === params.name)?.annotations.readOnlyHint === false
        && !objectValue(result).isError) {
      delete warnings.branchWarningKey;
    }
    if (!notification) {
      send(output, request.id, modern ? modernResult(request.method, result) : result);
    }
  } catch (error) {
    delete warnings.branchWarningKey;
    if (notification) {
      return;
    }
    send(output, request.id, null, error instanceof McpProtocolError
      ? { code: error.code, message: error.message, data: error.data }
      : { code: -32000, message: errorMessage(error) });
  }
}

function route(root: string, method: string | undefined, params: Record<string, unknown>, modern: boolean, warnings: McpWarningState): unknown {
  if (method === "server/discover" && modern) {
    return {
      supportedVersions: [MODERN_PROTOCOL_VERSION],
      capabilities: serverCapabilities(),
      instructions: "Agentpack provides repo-local task continuity, evidence, source conclusions, and release/readiness tools for coding agents."
    };
  }

  if (method === "initialize") {
    delete warnings.branchWarningKey;
    if (modern) {
      throw new McpProtocolError(-32601, "Method not found: initialize");
    }
    return {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: serverCapabilities(),
      serverInfo: serverInfo()
    };
  }

  if (method === "tools/list") {
    return { tools: TOOL_DEFINITIONS };
  }

  if (method === "tools/call") {
    if (typeof params.name !== "string" || !params.name.trim()) {
      throw new McpProtocolError(-32602, "tools/call requires a tool name");
    }
    if (params.arguments !== undefined && !isObject(params.arguments)) {
      throw new McpProtocolError(-32602, "tools/call arguments must be an object");
    }
    const name = text(params.name);
    const result = callTool(root, name, objectValue(params.arguments), warnings);
    if (TOOL_DEFINITIONS.find((tool) => tool.name === name)?.annotations.readOnlyHint === false
        && !objectValue(result).isError) {
      delete warnings.branchWarningKey;
    }
    return result;
  }

  if (method === "resources/list") {
    return {
      resources: [
        {
          uri: "agentpack://resume/latest",
          name: "Latest Agentpack resume",
          mimeType: "text/markdown"
        }
      ]
    };
  }

  if (method === "resources/templates/list") {
    return { resourceTemplates: [] };
  }

  if (method === "resources/read") {
    const resume = buildResume(root, { budget: 4000 });
    return {
      contents: [
        {
          uri: params.uri,
          mimeType: "text/markdown",
          text: resume.markdown
        }
      ]
    };
  }

  if (method === "prompts/list") {
    return {
      prompts: [
        {
          name: "agentpack_resume",
          description: "Resume work from Agentpack context."
        },
        {
          name: "agentpack_checkpoint",
          description: "Checkpoint meaningful progress into Agentpack."
        }
      ]
    };
  }

  if (method === "prompts/get") {
    return {
      description: "Agentpack workflow prompt",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Use Agentpack to load context before work and checkpoint decisions, dead ends, source conclusions, and evidence as you progress."
          }
        }
      ]
    };
  }

  if (modern) {
    throw new McpProtocolError(-32601, `Method not found: ${method}`);
  }
  throw new Error(`Unsupported MCP method: ${method}`);
}

function validateModernRequest(params: Record<string, unknown>): boolean {
  const meta = objectValue(params._meta);
  const requested = meta[PROTOCOL_VERSION_META_KEY];
  if (requested === undefined) {
    return false;
  }
  if (typeof requested !== "string") {
    throw new McpProtocolError(-32602, `Invalid ${PROTOCOL_VERSION_META_KEY} metadata`);
  }
  if (requested !== MODERN_PROTOCOL_VERSION) {
    throw new McpProtocolError(-32022, `Unsupported MCP protocol version: ${requested}`, {
      supported: [MODERN_PROTOCOL_VERSION],
      requested
    });
  }
  if (!isObject(meta[CLIENT_CAPABILITIES_META_KEY])) {
    throw new McpProtocolError(-32602, `Missing or invalid ${CLIENT_CAPABILITIES_META_KEY} metadata`);
  }
  if (meta[CLIENT_INFO_META_KEY] !== undefined && !isImplementation(meta[CLIENT_INFO_META_KEY])) {
    throw new McpProtocolError(-32602, `Invalid ${CLIENT_INFO_META_KEY} metadata`);
  }
  return true;
}

function modernResult(method: string | undefined, result: unknown): Record<string, unknown> {
  const value = objectValue(result);
  return {
    ...(MODERN_CACHEABLE_METHODS.has(method || "")
      ? { ttlMs: 0, cacheScope: "private" }
      : {}),
    ...value,
    resultType: "complete",
    _meta: {
      ...objectValue(value._meta),
      [SERVER_INFO_META_KEY]: serverInfo()
    }
  };
}

function serverCapabilities(): Record<string, unknown> {
  return {
    tools: {},
    resources: {},
    prompts: {}
  };
}

function serverInfo(): Record<string, string> {
  return {
    name: "agentpack",
    version: readPackageVersion()
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isImplementation(value: unknown): boolean {
  return isObject(value) && typeof value.name === "string" && typeof value.version === "string";
}

function usageLinkTool(root: string, args: Record<string, unknown>): unknown {
  const allowed = new Set(["task", "pick", "client", "file", "turns", "phase", "coverage", "note", "remove", "json"]);
  if (Object.keys(args).some(key => !allowed.has(key))) throw new Error("Unknown usage_link argument");
  const request: UsageLinkRequest = {};
  for (const key of ["client", "file", "turns", "phase", "coverage", "note", "remove"] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) throw new Error(`${key} requires a non-empty string`);
    request[key] = value;
  }
  if (args.task !== undefined && (typeof args.task !== "string" || !args.task.trim())) throw new Error("task requires a non-empty string");
  if (args.json !== undefined && typeof args.json !== "boolean") throw new Error("json requires a boolean");
  if (args.pick !== undefined) {
    if (!Array.isArray(args.pick) || !args.pick.length || args.pick.some(value => !(Number.isSafeInteger(value) && (value as number) >= 1) && !(typeof value === "string" && value.trim()))) {
      throw new Error("pick requires candidate numbers or session ids");
    }
    request.pick = args.pick as Array<number | string>;
  }
  const result = runUsageLink(root, usageTaskId(root, args.task as string | undefined), request, root);
  return toolText(args.json ? JSON.stringify(result, null, 2) : formatUsageLinkResult(result));
}

function callTool(root: string, name: string, args: Record<string, unknown>, warnings: McpWarningState): unknown {
  if (name === "usage_link") {
    return usageLinkTool(root, args);
  }
  if (name === "usage_report") {
    const allowed = new Set(["client", "files", "task", "from", "to", "byTurn", "turns", "json", "manifest"]);
    if (Object.keys(args).some(key => !allowed.has(key))) throw new Error("Unknown usage_report argument");
    for (const key of ["byTurn", "json"]) if (args[key] !== undefined && typeof args[key] !== "boolean") throw new Error(`${key} requires a boolean`);
    if (args.manifest !== undefined) {
      if (typeof args.manifest !== "string" || !args.manifest.trim()) throw new Error("manifest requires a non-empty path");
      if (["client", "files", "task", "from", "to", "turns"].some(key => args[key] !== undefined)) throw new Error("manifest cannot be combined with direct source options");
      const report = buildTaskUsageReport(args.manifest, root, args.byTurn === true);
      return toolText(args.json ? JSON.stringify(report, null, 2) : formatTaskUsageReport(report));
    }
    if (args.client === undefined && args.files === undefined) {
      if (["from", "to", "turns"].some(key => args[key] !== undefined)) throw new Error("Task usage reports use linked turns; from, to and turns require client and files");
      if (args.task !== undefined && (typeof args.task !== "string" || !args.task.trim())) throw new Error("task requires a non-empty string");
      const taskId = usageTaskId(root, args.task as string | undefined);
      const view = buildTaskUsage(root, taskId, args.byTurn === true);
      return toolText(args.json ? JSON.stringify(view, null, 2) : formatTaskUsage(view));
    }
    if (args.client !== "codex" && args.client !== "claude") throw new Error("usage_report requires client codex or claude");
    if (!Array.isArray(args.files) || !args.files.length || args.files.some(file => typeof file !== "string" || !file.trim())) throw new Error("usage_report requires explicit files");
    for (const key of ["task", "from", "to", "turns"]) {
      if (args[key] !== undefined && (typeof args[key] !== "string" || !args[key].trim())) throw new Error(`${key} requires a non-empty string`);
    }
    const report = buildUsageReport({ client: args.client, files: args.files as string[],
      ...(typeof args.task === "string" ? { task: args.task } : {}),
      ...(typeof args.from === "string" ? { from: args.from } : {}),
      ...(typeof args.to === "string" ? { to: args.to } : {}),
      ...(typeof args.turns === "string" ? { turns: args.turns } : {}),
      ...(typeof args.byTurn === "boolean" ? { byTurn: args.byTurn } : {})
    }, root);
    return toolText(args.json ? JSON.stringify(report, null, 2) : formatUsageReport(report));
  }
  if ((name === "record_decision" || name === "record_dead_end")
      && (typeof args.text !== "string" || !args.text.trim())) {
    return { ...toolText(`${name} requires non-empty text.`), isError: true };
  }

  if (name === "load_context" || name === "resume") {
    const preset = mcpBudgetPreset(args.preset);
    const budget = resolveBudget({
      budget: numberValue(args.budget, 0),
      ...(preset ? { preset } : {})
    }, 4000);
    const resume = buildResume(root, { budget, query: text(args.query) });
    delete warnings.branchWarningKey;
    return toolText(appendGateWarnings(root, resume.markdown, warnings));
  }

  if (name === "record_decision") {
    const event = appendEvent(root, "decision", {
      text: redactForRoot(root, text(args.text)),
      files: stringArray(args.files),
      evidence: stringArray(args.evidence)
    });
    return toolText(`Recorded decision ${event.id}.`);
  }

  if (name === "record_dead_end") {
    const event = appendEvent(root, "dead-end", {
      text: redactForRoot(root, text(args.text)),
      reason: redactForRoot(root, text(args.reason)),
      files: stringArray(args.files)
    });
    return toolText(`Recorded dead end ${event.id}.`);
  }

  if (name === "attach_evidence") {
    const event = addEvidence(root, {
      kind: text(args.kind),
      content: text(args.content),
      path: text(args.path),
      command: text(args.command),
      exitCode: numberValue(args.exitCode, Number.NaN)
    });
    return toolText(`Attached evidence ${event.id}.`);
  }

  if (name === "record_source") {
    const source = addSourceRecord(root, text(args.path), {
      summary: text(args.summary) || "Reviewed source.",
      snippet: text(args.snippet)
    });
    return toolText(`Recorded source ${source.path} (${source.hash.slice(0, 12)}).`);
  }

  if (name === "source_status") {
    const filters = sourceStatusFilters(args);
    if (booleanValue(args.json, false)) {
      return toolText(redactForRoot(root, JSON.stringify(getSourceStatuses(root, filters), null, 2)));
    }
    return toolText(formatSourceStatuses(root, filters));
  }

  if (name === "task_audit") {
    const report = auditCurrentTask(root, getSourceStatuses(root), getCeremonyDiagnostics(root));
    if (booleanValue(args.json, false)) {
      return toolText(redactForRoot(root, JSON.stringify(report, null, 2)));
    }
    return toolText(redactForRoot(root, formatTaskAuditReport(report)));
  }

  if (name === "release_preflight") {
    const report = buildReleasePreflightReport(root);
    return toolText(redactForRoot(root, report.text));
  }

  if (name === "bundle_export") {
    const result = exportTaskBundle(root, {
      taskId: text(args.taskId) || "current",
      outputPath: text(args.outputPath),
      sourcePaths: stringArray(args.sources),
      includeEvidence: booleanValue(args.includeEvidence, true),
      producerVersion: readPackageVersion()
    });
    return toolText(redactForRoot(root, formatBundleExportResult(result)));
  }

  if (name === "bundle_inspect") {
    const result = inspectTaskBundle(text(args.path));
    if (booleanValue(args.json, false)) {
      return toolText(JSON.stringify(result, null, 2));
    }
    return toolText(formatBundleInspectResult(result));
  }

  if (name === "bundle_import_plan") {
    const plan = planTaskBundleImport(root, text(args.path), { asNew: booleanValue(args.asNew, false) });
    if (booleanValue(args.json, false)) {
      return toolText(JSON.stringify(plan, null, 2));
    }
    return toolText(formatBundleImportPlan(plan));
  }

  if (name === "bundle_import") {
    const options = { asNew: booleanValue(args.asNew, false) };
    if (!booleanValue(args.write, false)) {
      const plan = planTaskBundleImport(root, text(args.path), options);
      if (booleanValue(args.json, false)) {
        return toolText(JSON.stringify(plan, null, 2));
      }
      return toolText(formatBundleImportPlan(plan));
    }
    const result = importTaskBundle(root, text(args.path), options);
    if (booleanValue(args.json, false)) {
      return toolText(JSON.stringify(result, null, 2));
    }
    return toolText(formatBundleImportResult(result));
  }

  if (name === "task_handoff") {
    return toolText(redactForRoot(root, formatCurrentTaskHandoff(root, getSourceStatuses(root))));
  }

  if (name === "task_start") {
    const startOptions: TaskStartOptions = {
      title: redactForRoot(root, text(args.title)),
      constraints: stringArray(args.constraints).map((item) => redactForRoot(root, item)),
      writeScope: stringArray(args.writeScope),
      nextActions: stringArray(args.nextActions).map((item) => redactForRoot(root, item)),
      tags: stringArray(args.tags)
    };
    const objective = redactForRoot(root, text(args.objective));
    const risk = taskRisk(args.risk);
    if (objective) {
      startOptions.objective = objective;
    }
    if (risk) {
      startOptions.risk = risk;
    }
    const passport = startTask(root, startOptions);
    return toolText(formatTaskMutationMessage(root, "Started", passport));
  }

  if (name === "task_status") {
    if (args.id !== undefined && (typeof args.id !== "string" || !args.id.trim())) {
      throw new Error("task_status id must be a non-empty string");
    }
    if (args.full !== undefined && typeof args.full !== "boolean") throw new Error("task_status full must be a boolean");
    const id = args.id as string | undefined;
    return toolText(redactForRoot(root, appendGateWarnings(root, formatTaskStatus(root, id, args.full === true), warnings, id === undefined,
      id === undefined ? "Gate Warnings" : "Gate Warnings (actual current task)",
      id === undefined ? undefined : "These gate editing under the actual current task; this read-only inspection is not blocked.")));
  }

  if (name === "task_list") {
    const options = taskListOptions(args);
    const { tasks: all, warnings } = listTasks(root);
    const scoped = all.filter((task) => options.scope.length === 0 || scopeOverlaps(task.writeScope, options.scope));
    const matching = scoped.filter((task) => options.status.length === 0 || options.status.includes(task.status));
    const hidden = options.defaultOpen ? scoped.length - matching.length : 0;
    const tasks = options.limit === undefined ? matching : matching.slice(0, options.limit);
    const metadata = {
      ...(warnings.length > 0 ? { [TASK_LIST_WARNINGS_META_KEY]: warnings.map((warning) => redactForRoot(root, warning)) } : {}),
      ...(options.limit !== undefined ? { "io.agentpack/taskListPage": { matched: matching.length, returned: tasks.length, omitted: matching.length - tasks.length } } : {})
    };
    const meta = Object.keys(metadata).length > 0 ? metadata : undefined;
    if (booleanValue(args.json, false)) {
      return toolText(
        redactForRoot(root, JSON.stringify(tasks, null, options.compact ? undefined : 2)),
        meta
      );
    }
    const warningOutput = warnings.map((warning) => `[warn] ${warning}\n`).join("");
    if (tasks.length === 0) {
      const empty = all.length === 0 ? "No task passports yet. Call `task_start` first."
        : hidden > 0 ? "No open task passports. Pass `all: true` for history." : "No task passports match the filters.";
      return toolText(redactForRoot(root, `${warningOutput}${empty}`), meta);
    }
    const omitted = matching.length - tasks.length;
    const suffix = (omitted > 0 ? `\nShowing ${tasks.length} of ${matching.length} matching tasks (${omitted} omitted). Increase limit or narrow filters.` : "")
      + (hidden > 0 ? `\n${hidden} closed task${hidden === 1 ? "" : "s"} hidden; pass \`all: true\` for history.` : "");
    return toolText(redactForRoot(root, `${warningOutput}${formatTaskList(tasks, options.compact)}${suffix}`), meta);
  }

  if (name === "task_switch") {
    const taskId = text(args.id).trim();
    if (!taskId) {
      throw new Error("task_switch requires a task id");
    }
    if (args.parkCurrent !== undefined && typeof args.parkCurrent !== "boolean") {
      throw new Error("task_switch parkCurrent must be a boolean");
    }
    const passport = switchTask(root, taskId, { parkCurrent: args.parkCurrent === true });
    return toolText(formatTaskMutationMessage(root, "Switched to", passport));
  }

  if (name === "task_park") {
    const passport = parkCurrentTask(root);
    return toolText(formatTaskMutationMessage(root, "Parked", passport));
  }

  if (name === "task_update_verification") {
    const result = updateCurrentTaskVerification(root, {
      status: text(args.status),
      evidence: stringArray(args.evidence),
      summary: redactForRoot(root, text(args.summary))
    });
    const { passport } = result;
    return toolText(formatVerificationUpdateMessage(root, passport, result.changed));
  }

  if (name === "task_finalize") {
    const passport = finalizeCurrentTask(root, {
      status: text(args.status),
      evidence: stringArray(args.evidence),
      summary: redactForRoot(root, text(args.summary)),
      force: booleanValue(args.force, false)
    });
    const advisories = finalizeAdvisories(root, passport);
    const advisoryText = advisories.length > 0
      ? `\n\nAdvisories:\n${advisories.map((advisory) => `- ${advisory}`).join("\n")}`
      : "";
    return toolText(`${formatTaskFinalizationMessage(root, passport)}${advisoryText}`);
  }

  if (name === "task_update") {
    const updateOptions: TaskUpdateOptions = {
      constraints: stringArray(args.constraints).map((item) => redactForRoot(root, item)),
      writeScope: stringArray(args.writeScope),
      nextActions: stringArray(args.nextActions).map((item) => redactForRoot(root, item)),
      tags: stringArray(args.tags)
    };
    const objective = redactForRoot(root, text(args.objective));
    const risk = taskRisk(args.risk);
    if (objective) {
      updateOptions.objective = objective;
    }
    if (risk) {
      updateOptions.risk = risk;
    }
    for (const key of ["clearNextActions", "replaceConstraints"]) {
      if (args[key] !== undefined && typeof args[key] !== "boolean") throw new Error(`${key} requires a boolean`);
    }
    if (args.clearNextActions === true) {
      updateOptions.clearNextActions = true;
    }
    if (args.replaceConstraints === true) {
      updateOptions.replaceConstraints = true;
    }
    const passport = updateCurrentTaskPassport(root, updateOptions);
    return toolText(formatTaskMutationMessage(root, "Updated", passport));
  }

  if (name === "checkpoint") {
    const checkpoint = createCheckpoint(root, {
      summary: text(args.summary),
      status: text(args.status),
      nextActions: stringArray(args.nextActions)
    });
    return toolText(`Created checkpoint ${checkpoint.id}${checkpoint.manifest.taskId ? ` for task ${checkpoint.manifest.taskId}` : ""}.`);
  }

  if (name === "diff") {
    const diff = diffCheckpoints(root, text(args.from) || undefined, text(args.to) || undefined);
    return toolText(redactForRoot(root, diff));
  }

  if (name === "replay") {
    const replay = replayEvents(root, numberValue(args.limit, 30));
    return toolText(redactForRoot(root, replay));
  }

  throw new Error(`Unknown tool: ${name}`);
}

// MCP-warn layer: state-reading tools carry current gate findings so any MCP client sees
// lifecycle/drift warnings without needing client-specific hooks.
function appendGateWarnings(root: string, body: string, warnings: McpWarningState, compactRepeatedBranch = false, heading = "Gate Warnings", note?: string): string {
  try {
    const report = evaluateGate(root, {});
    const branch = report.findings.find((finding) => finding.code === "branch-drift");
    const key = branch ? JSON.stringify([report.mode, report.taskId, report.taskStatus, report.findings]) : undefined;
    const repeated = key !== undefined && key === warnings.branchWarningKey;
    if (key === undefined) delete warnings.branchWarningKey;
    else warnings.branchWarningKey = key;
    if (report.findings.length === 0) {
      return body;
    }
    const lines = report.findings.map((finding) => `- [${finding.level}] ${
      compactRepeatedBranch && repeated && finding.code === "branch-drift"
        ? "Branch drift unchanged; see Drift above. Resolve before editing."
        : finding.message}`);
    return `${body}\n\n## ${heading}\n${note ? `${note}\n` : ""}${lines.join("\n")}`;
  } catch {
    delete warnings.branchWarningKey;
    return body;
  }
}

function toolText(
  textValue: string,
  meta?: Record<string, unknown>
): { content: Array<{ type: "text"; text: string }>; _meta?: Record<string, unknown> } {
  return {
    content: [
      {
        type: "text",
        text: textValue
      }
    ],
    ...(meta ? { _meta: meta } : {})
  };
}

function send(output: Writable, id: JsonRpcRequest["id"], result: unknown, error: JsonRpcError | null = null): void {
  const payload: Record<string, unknown> = {
    jsonrpc: "2.0",
    id
  };

  if (error) {
    payload.error = error;
  } else {
    payload.result = result;
  }

  output.write(`${JSON.stringify(payload)}\n`);
}

function taskListOptions(args: Record<string, unknown>): { status: string[]; scope: string[]; compact: boolean; defaultOpen: boolean; limit?: number } {
  for (const field of ["open", "compact", "all"]) {
    if (args[field] !== undefined && typeof args[field] !== "boolean") {
      throw new Error(`task_list ${field} must be a boolean`);
    }
  }
  const strings = (field: string): string[] => {
    if (args[field] === undefined) return [];
    const values = Array.isArray(args[field]) ? args[field] : [args[field]];
    if (values.length === 0 || values.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error(`task_list ${field} must be a non-empty string or array of non-empty strings`);
    }
    return [...new Set((values as string[]).map((value) => value.trim()))];
  };
  const status = strings("status");
  const scope = strings("scope");
  if (args.open === true && args.status !== undefined) {
    throw new Error("task_list open cannot be combined with status");
  }
  if (args.all === true && (args.open === true || args.status !== undefined)) {
    throw new Error("task_list all cannot be combined with open or status");
  }
  if (status.some((value) => !(TASK_LIST_STATUSES as readonly string[]).includes(value))) {
    throw new Error(`task_list status requires one of: ${TASK_LIST_STATUSES.join(", ")}`);
  }
  if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000)) {
    throw new Error("task_list limit must be an integer between 1 and 1000");
  }
  const defaultOpen = args.open === undefined && args.status === undefined && args.all !== true;
  return { status: args.open === true || defaultOpen ? [...OPEN_TASK_STATUSES] : status, scope, compact: args.compact === true, defaultOpen,
    ...(args.limit !== undefined ? { limit: args.limit as number } : {}) };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mcpBudgetPreset(value: unknown): BudgetPreset | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !isBudgetPreset(value)) {
    throw new Error(`Unknown budget preset: ${String(value)}. Expected one of: ${BUDGET_PRESET_NAMES.join(", ")}.`);
  }

  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function sourceStatusFilters(args: Record<string, unknown>): SourceStatusKind[] {
  const filters: SourceStatusKind[] = [];
  if (booleanValue(args.changed, false)) {
    filters.push("changed");
  }
  if (booleanValue(args.missing, false)) {
    filters.push("missing");
  }
  return filters;
}

function taskRisk(value: unknown): "low" | "medium" | "high" | "unknown" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "unknown" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new Error(`Unknown task risk: ${String(value)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
