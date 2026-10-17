import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatRepositories } from "./repositories.js";
import { clipToTokenBudget, estimateTokens, packSections } from "./budget.js";
import { getGitInfo } from "./git.js";
import { resolveRegularFileWithin, sha256File } from "./hash.js";
import {
  getPackPath,
  readEvents,
  readJson,
  readSources,
  readState
} from "./store.js";
import { redact } from "./redaction.js";
import { getCurrentPassport } from "./tasks.js";
import type { AgentpackConfig, AgentpackEvent, AgentpackState, GitInfo, SourceRecord, TaskPassport } from "./types.js";

const BUDGET_METADATA_RESERVE_TOKENS = 48;
const MAX_COMPACT_RELEVANT_CONTEXT_BUDGET = 1200;
const MAX_RELEVANT_CONTEXT_DECISIONS = 4;
const MAX_RELEVANT_CONTEXT_SOURCES = 4;
const MAX_QUERY_RELEVANT_SOURCE_ENTRIES = 8;
const MAX_QUERY_UNRELATED_SOURCE_STUBS = 12;
const SECTION_OMISSION_GUIDANCE: Record<string, string> = {
  "Source Cache": "rerun with a larger budget, use a narrower query, or call `source_status` for stale details.",
  "Decisions": "rerun with a larger budget or a query that names the decision topic.",
  "Dead Ends": "rerun with a larger budget when avoiding prior failed approaches matters.",
  "Evidence": "rerun with a larger budget when verification details matter.",
  "Recent Timeline": "use `agentpack replay` for full chronology."
};

interface ResumeOptions {
  budget?: number;
  query?: string;
}

interface SourceEntry {
  source: SourceRecord;
  status: string;
  meaning: string;
  guidance: string;
  score: number;
}

type SourceEntryMode = "full" | "stub" | "stale-stub";

export function buildResume(root: string, options: ResumeOptions = {}) {
  const budget = Number(options.budget || 0);
  const state = readState(root);
  const config = readJson<Partial<AgentpackConfig>>(getPackPath(root, "config.json"), {});
  const sources = readSources(root).sources || [];
  const events = readEvents(root);
  const git = getGitInfo(root);
  const currentTask = readCurrentTaskForResume(root);
  const relevantContext = budget > 0 && budget <= MAX_COMPACT_RELEVANT_CONTEXT_BUDGET
    ? formatRelevantContext(root, sources, events, options.query)
    : [];
  const generatedAt = new Date().toISOString();

  const header = [
    "# Agentpack Resume",
    "",
    `Pack root: ${formatPackRoot(root)}`,
    `Generated: ${generatedAt}`,
    budget ? `Budget: ~${budget} tokens` : "Budget: unbounded",
    options.query ? `Query: ${options.query}` : null
  ].filter(Boolean).join("\n");

  const sections = [
    {
      title: "Current State",
      required: true,
      text: section("Current State", formatCurrentState(state, currentTask))
    },
    {
      title: "Git State",
      required: true,
      text: section("Git State", formatGit(git))
    },
    relevantContext.length ? {
      title: "Relevant Context",
      required: true,
      text: section("Relevant Context", relevantContext)
    } : null,
    currentTask ? {
      title: "Current Task Passport",
      required: true,
      text: section("Current Task Passport", formatCurrentTaskPassport(currentTask, git))
    } : null,
    {
      title: "Source Cache",
      required: Boolean(options.query) && budget > MAX_COMPACT_RELEVANT_CONTEXT_BUDGET,
      text: section("Source Cache", formatSources(root, sources, options.query))
    },
    {
      title: "Decisions",
      text: section("Decisions", formatEvents(events, "decision"))
    },
    {
      title: "Dead Ends",
      text: section("Dead Ends", formatEvents(events, "dead-end"))
    },
    {
      title: "Evidence",
      text: section("Evidence", formatEvidence(root, events))
    },
    {
      title: "Recent Timeline",
      text: section("Recent Timeline", formatTimeline(events))
    }
  ].filter((entry): entry is { title: string; required?: boolean; text: string } => Boolean(entry));

  const { redacted, omittedSections, truncatedSections } = packResumeSections(header, sections, config, budget);

  return {
    markdown: redacted,
    estimatedTokens: estimateTokens(redacted),
    budget,
    omittedSections,
    truncatedSections,
    truncated: truncatedSections.length > 0 || omittedSections.length > 0
  };
}

function section(title: string, lines: Array<string | null | undefined>): string {
  const body = lines.filter((line) => line !== null && line !== undefined).join("\n").trimEnd();
  return `## ${title}\n${body || "- No entries yet."}`;
}

function formatPackRoot(root: string): string {
  const home = os.homedir();
  const relativeToHome = path.relative(home, root);

  if (relativeToHome && !relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)) {
    return path.join("~", relativeToHome);
  }

  return root;
}

function formatGit(git: GitInfo): string[] {
  if (!git.available) {
    return ["- Git repository not detected."];
  }

  return [
    `- Branch: ${git.branch || "unknown"}`,
    `- Commit: ${git.head || "unknown"}`,
    git.upstream ? `- Upstream: ${formatGitTracking(git)}` : "- Upstream: not set",
    git.aheadCommits.length ? "- Local commits ahead of upstream:" : null,
    ...git.aheadCommits.map((commit) => `  - ${commit}`),
    git.ahead !== null && git.aheadCommits.length > 0 && git.ahead > git.aheadCommits.length
      ? `  - ...and ${git.ahead - git.aheadCommits.length} more`
      : null,
    "- Changed files:",
    ...(git.status ? git.status.split("\n").map((line) => `  - ${line}`) : ["  - None"]),
    git.diffStat ? `- Current diff: ${git.diffStat.trim()}` : "- Current diff: none"
  ].filter((line): line is string => Boolean(line));
}

function formatGitTracking(git: GitInfo): string {
  const counts = git.ahead === null || git.behind === null
    ? "comparison unavailable"
    : `${git.ahead} ahead, ${git.behind} behind`;
  return `${git.upstream || "unknown"} (${counts})`;
}

function readCurrentTaskForResume(root: string): TaskPassport | null {
  try {
    return getCurrentPassport(root);
  } catch {
    return null;
  }
}

function formatCurrentState(state: AgentpackState, currentTask: TaskPassport | null): string[] {
  if (!currentTask) {
    return [
      `Goal: ${state.goal || "Not set"}`,
      `Status: ${state.currentStatus || "Not set"}`,
      state.currentCheckpoint ? `Current checkpoint: ${state.currentCheckpoint}` : null,
      "",
      "Next actions:",
      ...(state.nextActions.length > 0
        ? state.nextActions.map((item) => `- ${item}`)
        : ["- Not set"])
    ].filter((line): line is string => line !== null);
  }

  const nextActionsLabel = isClosedTask(currentTask)
    ? "Task next actions (historical; task is closed):"
    : "Task next actions:";
  return [
    `Goal: ${state.goal || "Not set"}`,
    `Status: ${currentTask.status} (current Task Passport)`,
    state.currentCheckpoint ? `Latest repo checkpoint: ${state.currentCheckpoint}` : null,
    "",
    nextActionsLabel,
    ...(currentTask.nextActions.length > 0
      ? currentTask.nextActions.map((item) => `- ${item}`)
      : ["- Not set"])
  ].filter((line): line is string => line !== null);
}

function formatCurrentTaskPassport(passport: TaskPassport, git: GitInfo): string[] {
  const drift = formatTaskDrift(passport, git);
  const nextActionsLabel = isClosedTask(passport)
    ? "Task next actions (historical; task is closed)"
    : "Task next actions";
  return [
    `- ID: ${passport.id}`,
    `- Title: ${passport.title}`,
    `- Status: ${passport.status}`,
    `- Objective: ${passport.objective || "Not set"}`,
    passport.constraints.length ? "- Constraints:" : null,
    ...passport.constraints.map((item) => `  - ${item}`),
    `- Risk: ${passport.risk}`,
    `- Worktree: ${formatPackRoot(passport.worktree)}`,
    `- Branch: ${passport.branch || "unknown"}`,
    passport.writeScope.length ? "- Write scope:" : "- Write scope: Not set",
    ...passport.writeScope.map((item) => `  - ${item}`),
    ...formatRepositories(passport.repositories),
    `- Verification: ${passport.verification.status}${passport.verification.summary ? ` - ${passport.verification.summary}` : ""}`,
    passport.verification.evidence.length ? `- Verification evidence: ${passport.verification.evidence.join(", ")}` : null,
    passport.nextActions.length ? `- ${nextActionsLabel}:` : `- ${nextActionsLabel}: Not set`,
    ...passport.nextActions.map((item) => `  - ${item}`),
    drift
  ].filter((line): line is string => Boolean(line));
}

function isClosedTask(passport: TaskPassport): boolean {
  return passport.status === "completed" || passport.status === "abandoned";
}

function formatTaskDrift(passport: TaskPassport, git: GitInfo): string | null {
  if (!git.available) {
    return "- Drift: Git repository not detected; verify task state manually.";
  }

  const drift: string[] = [];
  if (passport.branch && git.branch && passport.branch !== git.branch) {
    drift.push(`branch changed from ${passport.branch} to ${git.branch}`);
  }
  if (passport.currentHead && git.head && passport.currentHead !== git.head) {
    drift.push(`HEAD changed from ${passport.currentHead} to ${git.head}`);
  }

  return drift.length ? `- Drift: ${drift.join("; ")}. Verify task state before continuing.` : "- Drift: none detected.";
}

function formatRelevantContext(root: string, sources: SourceRecord[], events: AgentpackEvent[], query = ""): string[] {
  const queryTerms = tokenizeQuery(query);
  if (!queryTerms.length) {
    return [];
  }

  const relevantDecisions = events
    .filter((event) => event.type === "decision")
    .map((event) => ({ event, score: scoreEvent(event, queryTerms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || text(right.event.ts).localeCompare(text(left.event.ts)));
  const selectedDecisions = selectDiverseScored(
    relevantDecisions,
    queryTerms,
    MAX_RELEVANT_CONTEXT_DECISIONS,
    (entry, term) => scoreEvent(entry.event, [term])
  );
  const relevantSources = buildSourceEntries(root, sources, queryTerms)
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.source.path.localeCompare(right.source.path));
  const selectedSources = selectDiverseScored(
    relevantSources,
    queryTerms,
    MAX_RELEVANT_CONTEXT_SOURCES,
    (entry, term) => scoreSource(entry.source, [term])
  );

  const lines = [
    selectedDecisions.length ? "- Query-relevant decisions:" : null,
    ...selectedDecisions.map(({ event }) => {
      const files = stringArray(event.files);
      const filesText = files.length ? ` Files: ${files.slice(0, 3).join(", ")}.` : "";
      return `  - ${event.ts}: ${shortLabel(event)}${filesText}`;
    }),
    selectedSources.length ? "- Query-relevant source records:" : null,
    ...selectedSources.map((entry) => (
      `  - ${entry.source.path}: status ${entry.status}; topic ${topicHint(entry.source.summary, 100)}; guidance ${entry.guidance}`
    )),
    selectedDecisions.length || selectedSources.length
      ? "- Bulk details remain in Source Cache, Decisions, Evidence, and Recent Timeline when budget allows."
      : null
  ].filter((line): line is string => Boolean(line));

  return lines;
}

function selectDiverseScored<T extends { score: number }>(
  entries: T[],
  queryTerms: string[],
  limit: number,
  scoreForTerm: (entry: T, term: string) => number
): T[] {
  const selected: T[] = [];
  const selectedSet = new Set<T>();
  const add = (entry: T | undefined) => {
    if (entry && !selectedSet.has(entry) && selected.length < limit) {
      selected.push(entry);
      selectedSet.add(entry);
    }
  };

  for (const term of queryTerms) {
    const bestForTerm = entries
      .filter((entry) => !selectedSet.has(entry))
      .map((entry) => ({ entry, termScore: scoreForTerm(entry, term) }))
      .filter(({ termScore }) => termScore > 0)
      .sort((left, right) => right.termScore - left.termScore || right.entry.score - left.entry.score)[0]?.entry;
    add(bestForTerm);
    if (selected.length >= limit) {
      return selected;
    }
  }

  for (const entry of entries) {
    add(entry);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

function formatSources(root: string, sources: SourceRecord[], query = ""): string[] {
  if (!sources.length) {
    return [
      "- No inspected sources recorded yet.",
      "- Use `agentpack source add <file> --summary <text>` after reading important files."
    ];
  }

  const queryTerms = tokenizeQuery(query);
  const entries = buildSourceEntries(root, sources, queryTerms);

  if (!queryTerms.length) {
    return entries.map((entry) => formatSourceEntry(entry, "full"));
  }

  const matched = entries
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.source.path.localeCompare(right.source.path));
  const matchedPaths = new Set(matched.map((entry) => entry.source.path));
  const unmatched = entries.filter((entry) => !matchedPaths.has(entry.source.path));
  const unmatchedStale = unmatched
    .filter((entry) => entry.status !== "unchanged")
    .sort((left, right) => left.source.path.localeCompare(right.source.path));
  const unmatchedUnchanged = unmatched.filter((entry) => entry.status === "unchanged");
  const compactEntries = [...unmatchedStale, ...unmatchedUnchanged];
  const matchedStaleCount = matched.filter((entry) => entry.status !== "unchanged").length;
  const unmatchedStaleCount = unmatchedStale.length;
  const visibleMatched = matched.slice(0, MAX_QUERY_RELEVANT_SOURCE_ENTRIES);
  const omittedMatchedCount = Math.max(0, matched.length - visibleMatched.length);
  const visibleCompactEntries = compactEntries.slice(0, MAX_QUERY_UNRELATED_SOURCE_STUBS);
  const omittedCompactCount = Math.max(0, compactEntries.length - visibleCompactEntries.length);
  const visibleMatchedStaleCount = visibleMatched.filter((entry) => entry.status !== "unchanged").length;

  if (!matched.length) {
    return [
      omittedCompactCount > 0
        ? `- Query filter: no source summaries matched \`${query}\`; showing ${visibleCompactEntries.length} of ${entries.length} compact source stub(s), omitting ${omittedCompactCount}.`
        : `- Query filter: no source summaries matched \`${query}\`; showing compact stubs for all ${entries.length} recorded source(s).`,
      unmatchedStaleCount > 0
        ? `- Query-unrelated stale stubs: ${unmatchedStaleCount} changed/missing; call \`source_status\` for full stale details.`
        : null,
      omittedCompactCount > 0
        ? "- Omitted source stubs are query-unrelated; rerun without `--query` or call `source_status` for full Source Cache details."
        : null,
      "- Rerun without `--query` when you need the full Source Cache.",
      ...visibleCompactEntries.map((entry) => formatSourceEntry(entry, sourceEntryStubMode(entry)))
    ].filter((line): line is string => Boolean(line));
  }

  return [
    omittedMatchedCount > 0 || omittedCompactCount > 0
      ? `- Query filter: full summaries for ${visibleMatched.length} of ${matched.length} query-relevant source(s), compact stubs for ${visibleCompactEntries.length} of ${unmatched.length} query-unrelated source(s).`
      : `- Query filter: full summaries for ${matched.length} query-relevant source(s), compact stubs for ${unmatched.length} query-unrelated source(s).`,
    matchedStaleCount > 0
      ? omittedMatchedCount > 0
        ? `- Query-relevant stale source records shown in full: ${visibleMatchedStaleCount} of ${matchedStaleCount} changed/missing.`
        : `- Query-relevant stale source records shown in full: ${matchedStaleCount} changed/missing.`
      : null,
    unmatchedStaleCount > 0
      ? `- Query-unrelated stale stubs: ${unmatchedStaleCount} changed/missing; call \`source_status\` for full stale details.`
      : null,
    omittedMatchedCount > 0 || omittedCompactCount > 0
      ? `- Source entries omitted for compactness: ${omittedMatchedCount} query-relevant, ${omittedCompactCount} query-unrelated; rerun with a narrower query or larger budget for details.`
      : null,
    "- Compact stubs keep path/status/topic/guidance; full summaries require `source_status` or an unfiltered resume.",
    ...visibleMatched.map((entry) => formatSourceEntry(entry, "full")),
    ...visibleCompactEntries.map((entry) => formatSourceEntry(entry, sourceEntryStubMode(entry)))
  ].filter((line): line is string => Boolean(line));
}

function buildSourceEntries(root: string, sources: SourceRecord[], queryTerms: string[]): SourceEntry[] {
  return sources.map((source) => {
    const absolutePath = path.join(root, source.path);
    let status = "missing";
    if (existsSync(absolutePath)) {
      status = sha256File(absolutePath) === source.hash ? "unchanged" : "changed";
    }

    const guidance = status === "unchanged"
      ? "Do not re-open unless needed or unless hash changed."
      : "Re-open before relying on prior conclusions.";
    const meaning = status === "unchanged"
      ? "Matches recorded source hash. Summary is current for this file content."
      : "Does not match recorded source hash.";

    return {
      source,
      status,
      meaning,
      guidance,
      score: queryTerms.length > 0 ? scoreSource(source, queryTerms) : 0
    };
  });
}

function sourceEntryStubMode(entry: SourceEntry): SourceEntryMode {
  return entry.status === "unchanged" ? "stub" : "stale-stub";
}

function formatSourceEntry(entry: SourceEntry, mode: SourceEntryMode): string {
  if (mode === "stub") {
    return [
      `- ${entry.source.path}`,
      `  - status: ${entry.status}; topic: ${topicHint(entry.source.summary)}; guidance: ${entry.guidance}`
    ].join("\n");
  }

  if (mode === "stale-stub") {
    return [
      `- ${entry.source.path}`,
      `  - status: ${entry.status}; topic: ${topicHint(entry.source.summary, 60)} (recorded); guidance: call \`source_status\` before relying`
    ].join("\n");
  }

  const lines = [
    `- ${entry.source.path}`,
    `  - status: ${entry.status}`,
    `  - summary: ${entry.source.summary || "No summary recorded."}`,
    mode === "full" && entry.source.snippet ? `  - snippet: ${entry.source.snippet}` : null,
    `  - meaning: ${entry.meaning}`,
    `  - guidance: ${entry.guidance}`
  ];

  return lines.filter(Boolean).join("\n");
}

const QUERY_STOPWORDS = new Set([
  "about",
  "after",
  "agent",
  "agents",
  "agentpack",
  "cache",
  "code",
  "context",
  "contexts",
  "current",
  "file",
  "files",
  "from",
  "into",
  "source",
  "sources",
  "task",
  "tasks",
  "that",
  "this",
  "with",
  "work",
  "working"
]);

function tokenizeQuery(query: string): string[] {
  return uniqueTokens(query).filter((term) => !QUERY_STOPWORDS.has(term));
}

function scoreSource(source: SourceRecord, queryTerms: string[]): number {
  const basename = path.basename(source.path);
  const pathText = normalizedText(source.path);
  const basenameText = normalizedText(basename);
  const summaryText = normalizedText(source.summary);
  const snippetText = normalizedText(source.snippet);
  const pathTokens = uniqueTokens(source.path);
  const basenameTokens = uniqueTokens(basename);
  const summaryTokens = uniqueTokens(source.summary);
  const snippetTokens = uniqueTokens(source.snippet);
  let score = 0;

  for (const term of queryTerms) {
    score += scoreField(term, basenameText, basenameTokens, 8, 4);
    score += scoreField(term, pathText, pathTokens, 6, 3);
    score += scoreField(term, summaryText, summaryTokens, 3, 1);
    score += scoreField(term, snippetText, snippetTokens, 1, 1);
  }

  return score;
}

function scoreEvent(event: AgentpackEvent, queryTerms: string[]): number {
  const eventText = [
    text(event.text),
    text(event.summary),
    text(event.reason),
    text(event.kind),
    ...stringArray(event.files)
  ].join(" ");
  const normalized = normalizedText(eventText);
  const tokens = uniqueTokens(eventText);
  let score = 0;

  for (const term of queryTerms) {
    score += scoreField(term, normalized, tokens, 4, 2);
  }

  return score;
}

function scoreField(
  term: string,
  textValue: string,
  tokens: string[],
  exactScore: number,
  fuzzyScore: number
): number {
  if (tokens.includes(term)) {
    return exactScore;
  }

  if (term.length >= 4 && tokens.some((token) => token.startsWith(term) || term.startsWith(token))) {
    return fuzzyScore;
  }

  return term.length >= 5 && textValue.includes(term) ? Math.max(1, fuzzyScore) : 0;
}

function uniqueTokens(value: string): string[] {
  const seen = new Set<string>();
  const tokens = normalizedText(value)
    .split(/[^a-z0-9]+/u)
    .filter((term) => term.length >= 3);

  for (const token of tokens) {
    seen.add(token);
  }

  return [...seen];
}

function normalizedText(value: string): string {
  return String(value || "").toLowerCase();
}

function topicHint(summary: string, maxLength = 80): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No summary recorded.";
  }

  const sentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/u);
  return truncateOneLine(sentenceMatch?.[1] || normalized, maxLength);
}

function formatEvents(events: AgentpackEvent[], type: string): string[] {
  const filtered = events.filter((event) => event.type === type);
  if (!filtered.length) {
    return ["- No entries yet."];
  }

  return filtered.slice(-20).map((event) => {
    const files = stringArray(event.files);
    const filesText = files.length ? ` Files: ${files.join(", ")}.` : "";
    const reason = text(event.reason);
    const reasonText = reason ? ` Reason: ${reason}.` : "";
    return `- ${event.ts}: ${text(event.text) || text(event.summary) || "No text."}${reasonText}${filesText}`;
  });
}

function formatEvidence(root: string, events: AgentpackEvent[]): string[] {
  const evidenceEvents = events.filter((event) => event.type === "evidence");
  if (!evidenceEvents.length) {
    return ["- No evidence attached yet."];
  }

  return evidenceEvents.slice(-20).map((event) => {
    const eventPath = text(event.path);
    const preview = eventPath
      ? safeEvidencePreview(root, eventPath)
      : text(event.content);
    const lines = [
      `- ${event.ts}: ${text(event.kind) || "note"}`,
      text(event.command) ? `  - command: ${text(event.command)}` : null,
      event.exitCode !== undefined && event.exitCode !== null ? `  - exit code: ${String(event.exitCode)}` : null,
      eventPath ? `  - path: ${eventPath}` : null,
      preview ? `  - preview: ${preview}` : null
    ];

    return lines.filter(Boolean).join("\n");
  });
}

function safeEvidencePreview(root: string, eventPath: string): string {
  try {
    const packRoot = getPackPath(root);
    const file = resolveRegularFileWithin(packRoot, eventPath, "evidence preview path");
    const buffer = Buffer.alloc(4096);
    const descriptor = openSync(file, "r");
    try {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
      return previewText(buffer.subarray(0, bytes).toString("utf8"));
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return "[unsafe or unreadable evidence path omitted]";
  }
}

function formatTimeline(events: AgentpackEvent[]): string[] {
  if (!events.length) {
    return ["- No events yet."];
  }

  const counts = eventTypeCounts(events);
  const recentCheckpoints = events
    .filter((event) => event.type === "checkpoint")
    .slice(-3)
    .map((event) => `  - ${event.ts}: ${shortLabel(event)}`);
  const recentNonSourceEvents = events
    .filter((event) => event.type !== "source" && event.type !== "checkpoint")
    .slice(-8)
    .map((event) => `  - ${event.ts} [${event.type}] ${shortLabel(event)}`);
  const recentSourcePaths = uniqueRecent(
    events
      .filter((event) => event.type === "source")
      .map((event) => text(event.path))
      .filter(Boolean),
    8
  );

  return [
    `- Total events: ${events.length} (${counts}).`,
    "- Source details are in Source Cache; evidence details are in Evidence.",
    recentSourcePaths.length ? `- Recent source records: ${recentSourcePaths.join(", ")}` : null,
    recentCheckpoints.length ? "Recent checkpoints:" : null,
    ...recentCheckpoints,
    recentNonSourceEvents.length ? "Recent non-source events:" : null,
    ...recentNonSourceEvents,
    "- Full chronology: `agentpack replay`."
  ].filter((line): line is string => Boolean(line));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function previewText(value: string): string {
  return value
    .slice(0, 360)
    .replace(/\s+/g, " ")
    .trim();
}

function eventTypeCounts(events: AgentpackEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) || 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");
}

function shortLabel(event: AgentpackEvent): string {
  const label = text(event.text)
    || text(event.summary)
    || text(event.kind)
    || text(event.path)
    || text(event.checkpointId)
    || "No label";

  return truncateOneLine(label, 140);
}

function uniqueRecent(values: string[], limit: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const value of [...values].reverse()) {
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
    if (output.length >= limit) {
      break;
    }
  }

  return output.reverse();
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function packResumeSections(
  header: string,
  sections: Array<{ title: string; required?: boolean; text: string }>,
  config: Partial<AgentpackConfig>,
  budget: number
): { redacted: string; omittedSections: string[]; truncatedSections: string[] } {
  if (!budget) {
    const { markdown, omittedSections, truncatedSections } = packSections(header, sections, budget);
    return {
      redacted: withStableBudgetMetadata(markdown, config, budget, omittedSections, truncatedSections),
      omittedSections,
      truncatedSections
    };
  }

  let reserveTokens = BUDGET_METADATA_RESERVE_TOKENS;
  let fallback: { redacted: string; omittedSections: string[]; truncatedSections: string[] } | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { markdown, omittedSections, truncatedSections } = packSections(header, sections, budget, {
      reserveTokens,
      omissionGuidance: SECTION_OMISSION_GUIDANCE
    });
    const redacted = withStableBudgetMetadata(markdown, config, budget, omittedSections, truncatedSections);
    const usedTokens = estimateTokens(redacted);
    const packed = { redacted, omittedSections, truncatedSections };
    fallback = packed;

    if (usedTokens <= budget) {
      return packed;
    }

    reserveTokens = Math.min(budget - 1, reserveTokens + usedTokens - budget + 4);
  }

  if (fallback) {
    return {
      ...fallback,
      redacted: clipToTokenBudget(fallback.redacted, budget)
    };
  }

  return {
    redacted: clipToTokenBudget(header.trimEnd(), budget),
    omittedSections: sections.map((section) => section.title),
    truncatedSections: []
  };
}

function withStableBudgetMetadata(
  markdown: string,
  config: Partial<AgentpackConfig>,
  budget: number,
  omittedSections: string[],
  truncatedSections: string[]
): string {
  let estimatedTokens = estimateTokens(redact(markdown, config));
  let redacted = "";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    redacted = redact(addBudgetMetadata(markdown, budget, estimatedTokens, omittedSections, truncatedSections), config);
    const nextEstimate = estimateTokens(redacted);
    if (nextEstimate === estimatedTokens) {
      return redacted;
    }
    estimatedTokens = nextEstimate;
  }

  return redacted;
}

function addBudgetMetadata(
  markdown: string,
  budget: number,
  estimatedTokens: number,
  omittedSections: string[],
  truncatedSections: string[]
): string {
  const lines = markdown.split("\n");
  const budgetLineIndex = lines.findIndex((line) => line.startsWith("Budget: "));
  if (budgetLineIndex < 0) {
    return markdown;
  }

  const usage = budget
    ? `Estimated usage: ~${estimatedTokens} tokens (${Math.round((estimatedTokens / budget) * 100)}% of target)`
    : `Estimated usage: ~${estimatedTokens} tokens`;
  const status = formatBudgetStatus(budget, omittedSections, truncatedSections);

  lines.splice(budgetLineIndex + 1, 0, usage, `Budget status: ${status}`);
  const full = lines.join("\n");
  if (!budget || estimateTokens(full) <= budget) {
    return full;
  }

  const compactLines = markdown.split("\n");
  compactLines.splice(
    budgetLineIndex + 1,
    0,
    `Estimated usage: ~${estimatedTokens} tokens`,
    `Budget status: ${formatCompactBudgetStatus(budget, omittedSections, truncatedSections)}`
  );
  return compactLines.join("\n");
}

function formatBudgetStatus(budget: number, omittedSections: string[], truncatedSections: string[]): string {
  if (!budget) {
    return "unbounded";
  }

  const details = [];
  if (truncatedSections.length > 0) {
    details.push(`truncated ${truncatedSections.join(", ")}`);
  }
  if (omittedSections.length > 0) {
    details.push(`omitted ${omittedSections.join(", ")}`);
  }

  return details.length > 0 ? `limited; ${details.join("; ")}` : "within target";
}

function formatCompactBudgetStatus(budget: number, omittedSections: string[], truncatedSections: string[]): string {
  if (!budget) {
    return "unbounded";
  }

  const details = [];
  if (truncatedSections.length > 0) {
    details.push(`${truncatedSections.length} truncated`);
  }
  if (omittedSections.length > 0) {
    details.push(`${omittedSections.length} omitted`);
  }

  return details.length > 0 ? `limited; ${details.join(", ")}` : "within target";
}
