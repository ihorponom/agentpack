import type { TaskPassport } from "./types.js";

export interface CeremonyDiagnostic {
  signal: "repeated-verdict-resets" | "duplicate-evidence" | "duplicate-checkpoints" | "repeated-stale-source-warnings" | "fragmented-objective";
  message: string;
  samples: string[];
}

export interface CeremonyDiagnosticInput {
  passports: TaskPassport[];
  verificationTransitions: Array<{ taskId: string; statuses: string[] }>;
  evidence: Array<{ id: string; fingerprint: string }>;
  checkpoints: Array<{ id: string; fingerprint: string; staleSourcePaths: string[] }>;
}

const MAX_DIAGNOSTICS = 5;
const MAX_SAMPLES = 3;
const MAX_TEXT_LENGTH = 240;
const FINAL_VERDICTS = new Set(["passed", "failed", "accepted"]);
const RESET_VERDICTS = new Set(["pending", "unknown"]);

// Advisory-only, intentionally conservative patterns. Inputs are pre-read by
// callers so this module remains pure and can be used without lifecycle cycles.
export function findCeremonyDiagnostics(input: CeremonyDiagnosticInput): CeremonyDiagnostic[] {
  const diagnostics: CeremonyDiagnostic[] = [];
  const resets = input.verificationTransitions.flatMap(({ taskId, statuses }) => {
    let count = 0;
    for (let index = 1; index < statuses.length; index += 1) {
      if (FINAL_VERDICTS.has(statuses[index - 1] || "") && RESET_VERDICTS.has(statuses[index] || "")) count += 1;
    }
    return count >= 2 ? [`${taskId} (${count} final-to-pending/unknown resets)`] : [];
  });
  if (resets.length) diagnostics.push(candidate("repeated-verdict-resets", "Repeated final-to-pending/unknown resets are a review candidate; inspect whether each re-open represented new work.", resets));

  const evidenceDuplicates = duplicateSamples(input.evidence, 3);
  if (evidenceDuplicates.length) diagnostics.push(candidate("duplicate-evidence", "Exact duplicate evidence records are a review candidate; retain records when each anchors a distinct decision.", evidenceDuplicates));

  const checkpointDuplicates = duplicateSamples(input.checkpoints);
  if (checkpointDuplicates.length) diagnostics.push(candidate("duplicate-checkpoints", "Exact duplicate checkpoints are a review candidate; retained snapshots can still be useful handoff history.", checkpointDuplicates));

  const staleGroups = new Map<string, string[]>();
  for (const checkpoint of input.checkpoints) {
    if (!checkpoint.staleSourcePaths.length) continue;
    const key = checkpoint.staleSourcePaths.join(", ");
    const entries = staleGroups.get(key) || [];
    entries.push(checkpoint.id);
    staleGroups.set(key, entries);
  }
  for (const [paths, ids] of staleGroups) {
    if (ids.length >= 2) diagnostics.push(candidate("repeated-stale-source-warnings", `Repeated retained checkpoint warnings for ${clip(paths)} are a review candidate; confirm whether the source conclusion still matters.`, ids));
  }

  const fragmented = fragmentedObjectives(input.passports);
  if (fragmented.length) diagnostics.push(candidate("fragmented-objective", "Several short, overlapping tasks with the exact same objective are a review candidate; separate phases may still be intentional.", fragmented));

  return diagnostics.slice(0, MAX_DIAGNOSTICS);
}

function duplicateSamples(items: Array<{ id: string; fingerprint: string }>, minimum = 2): string[] {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    if (!item.fingerprint) continue;
    const ids = groups.get(item.fingerprint) || [];
    ids.push(item.id);
    groups.set(item.fingerprint, ids);
  }
  return [...groups.values()].filter((ids) => ids.length >= minimum).map((ids) => ids.slice(0, MAX_SAMPLES).join(", ")).slice(0, MAX_SAMPLES);
}

function fragmentedObjectives(passports: TaskPassport[]): string[] {
  const groups = new Map<string, TaskPassport[]>();
  for (const passport of passports) {
    const objective = passport.objective.trim();
    if (!objective || !passport.writeScope.length) continue;
    const entries = groups.get(objective) || [];
    entries.push(passport);
    groups.set(objective, entries);
  }
  const samples: string[] = [];
  for (const [objective, tasks] of groups) {
    const ordered = tasks
      .filter((task) => (task.status === "completed" || task.status === "abandoned") && isShortClosedTask(task))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (let index = 0; index <= ordered.length - 3; index += 1) {
      const cluster = ordered.slice(index, index + 3);
      const first = Date.parse(cluster[0]?.createdAt || "");
      const last = Date.parse(cluster[2]?.createdAt || "");
      if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 24 * 60 * 60 * 1000) continue;
      if (cluster.every((left) => cluster.every((right) => scopesOverlap(left.writeScope, right.writeScope)))) {
        samples.push(`${objective}: ${cluster.map((task) => task.id).join(", ")}`);
        break;
      }
    }
  }
  return samples.slice(0, MAX_SAMPLES);
}

function isShortClosedTask(task: TaskPassport): boolean {
  const createdAt = Date.parse(task.createdAt);
  const closedAt = Date.parse(task.closedAt || "");
  return Number.isFinite(createdAt) && Number.isFinite(closedAt) && closedAt >= createdAt && closedAt - createdAt <= 4 * 60 * 60 * 1000;
}

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((first) => right.some((second) => first === "." || second === "." || first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`)));
}

function candidate(signal: CeremonyDiagnostic["signal"], message: string, samples: string[]): CeremonyDiagnostic {
  return { signal, message: clip(message), samples: samples.slice(0, MAX_SAMPLES).map(clip) };
}

function clip(value: string): string {
  return value.length <= MAX_TEXT_LENGTH ? value : `${value.slice(0, MAX_TEXT_LENGTH - 3)}...`;
}
