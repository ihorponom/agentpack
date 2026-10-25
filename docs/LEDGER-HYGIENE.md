# Ledger Hygiene

Agentpack keeps useful task memory. It must not turn the ledger into an activity log. Hygiene starts with visibility, not deletion.

## Principle

Ledger hygiene means you know what has accumulated and which records need human review. Cleanup is never automatic.

Keep reviewed durable state until a user or an agent decides to archive, refresh or remove it.

## Read-only status

Run:

```bash
agentpack ledger status
```

Add `--json` for the same inventory as structured data. The JSON output does not include the closing line.

The command prints a read-only inventory:

- task counts by lifecycle status (the abandoned count covers Passports from older versions or imported bundles)
- event count and event log size
- evidence file count and size, and the referenced and unreferenced evidence events
- checkpoint count and size
- export count and size
- source cache counts: recorded, unchanged, changed and missing
- oldest evidence and oldest checkpoint
- warnings, for example skipped malformed event lines
- ceremony review candidates, when any exist

The text output always ends with this line:

```text
No cleanup was performed.
```

`ledger status` is safe to run during a handoff, a release preflight or a diagnosis.

## What is safe to automate

Diagnostic steps are safe:

- count tasks, evidence, checkpoints, exports, events and source conclusions
- find missing source conclusions
- find evidence events that no task verification or other event payload references
- show old checkpoints and old evidence as possible review targets

These reports do not mean the data is bad. They show future agents and humans where the ledger gains weight.

## Ceremony review candidates

`task audit` and `ledger status` can show a small, bounded set of `review candidate` diagnostics. They cover:

- repeated final-verdict resets
- exact duplicate evidence or checkpoints
- repeated stale-source warnings kept in checkpoint resumes
- several short tasks with the same objective and overlapping scope

The diagnostics never block, change or clean anything. They never claim that they saved time or prevented defects. A single ordinary verification reset stays quiet by design.

To bound the cost, the diagnostics inspect only the newest 30 tasks, task events, evidence events and checkpoints. They skip individual files over 256 KiB. Agentpack skips malformed global event lines one by one and reports them as status warnings. Valid retained events stay visible.

## What needs explicit review

Do not delete or refresh these items automatically:

- the current Passport
- parked, blocked and verifying Passports
- evidence that a task verification or another event payload references
- task events that replay and audit history need
- source conclusions whose files changed
- checkpoints of active or parked work (but see [Compact the ledger](#compact-the-ledger): compaction slims old checkpoints by count)

A changed source conclusion needs a semantic review. Run:

```bash
agentpack source review <file> --summary "Updated durable conclusion."
```

## Remove source conclusions

Remove the conclusions for deleted files:

```bash
agentpack source prune --missing
```

Remove one conclusion that is no longer useful:

```bash
agentpack source remove <file>
```

## Compact the ledger

Run `ledger compact` when `doctor` reports a large ledger. The command is a dry run by default. It prints a plan and changes nothing.

```bash
agentpack ledger compact [--write] [--purge] [--keep-checkpoints <n>] [--evidence-age-days <n>]
```

| Option | Meaning |
|---|---|
| `--write` | Apply the plan. Agentpack moves the selected data to `.agentpack/archive/`. |
| `--purge` | Delete the selected data instead of archiving it. Use it with `--write`. |
| `--keep-checkpoints <n>` | Keep the newest `n` checkpoints in full. The default is 30. |
| `--evidence-age-days <n>` | Select unreferenced evidence older than `n` days. The default is 30. |

The plan selects three kinds of data:

- `diff.patch`, `git-status.txt` and `resume.md` of checkpoints older than the newest `n`. The count of checkpoints decides, not the lifecycle of their tasks. Every `checkpoint.json` stays.
- superseded source cache events in `events.jsonl`
- unreferenced evidence files older than the evidence age

Decisions, dead ends, referenced evidence and checkpoint metadata always stay. A checkpoint of an active or parked task can lose its snapshot files when newer checkpoints push it past the limit. Its `checkpoint.json` stays. Raise `--keep-checkpoints` to keep more snapshots in full.

Do not run `--purge` before you review the dry-run plan. Purged data cannot be restored. Archived data stays in `.agentpack/archive/`.
