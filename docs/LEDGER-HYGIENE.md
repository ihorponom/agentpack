# Ledger Hygiene

Agentpack should keep useful task memory without turning the repo ledger into an
activity log. Hygiene starts with visibility, not deletion.

## Principle

Ledger hygiene is about knowing what has accumulated and which records may need
human review. It is not automatic cleanup.

Reviewed durable state should be preserved until a user or agent makes an
explicit decision to archive, refresh, or remove it.

## Read-Only Status

Use:

```bash
agentpack ledger status
```

Append `--json` for the same additive inventory as structured data.

The command prints a read-only inventory:

- task counts by lifecycle status
- event count and event log size
- evidence file count, size, and referenced/unreferenced event counts
- checkpoint count and size
- export count and size
- source-cache unchanged/changed/missing counts

It always ends with:

```text
No cleanup was performed.
```

That line is part of the contract: `ledger status` is safe to run during
handoff, release pre-flight, or exploratory diagnosis.

## What Is Safe To Automate

Safe first steps are diagnostic:

- count tasks, evidence, checkpoints, exports, events, and source records
- identify missing source records
- identify evidence events that are not referenced by task verification or other event payloads
- show old checkpoints or evidence as possible review targets

These reports do not imply the data is bad. They give future agents and humans a
map of where ledger weight is accumulating.

## Ceremony Review Candidates

`task audit` and `ledger status` may show a small, bounded set of `review candidate`
diagnostics: repeated final-verdict resets, exact duplicate evidence or checkpoints,
repeated stale-source warnings retained in checkpoint resumes, or several short tasks
with the exact same objective and overlapping scope. They never block, mutate, clean,
or claim that time or defects were saved. A preserved external wait and one ordinary
verification reset stay quiet by design. To bound status cost, diagnostics inspect only
the newest 30 tasks, task events, evidence events, and checkpoints, skipping individual
files over 256 KiB. Malformed global event lines are skipped individually and reported
as additive status warnings; valid retained events remain visible.

## What Requires Explicit Review

Do not automatically delete or refresh:

- current task passports
- parked, blocked, or verifying task passports
- evidence referenced by task verification or other event payloads
- task events needed for replay/audit history
- source records whose files changed
- checkpoints for active or paused work

Changed source records require semantic review. Use:

```bash
agentpack source review <file> --summary "Updated durable conclusion."
```

Missing source records can be pruned explicitly:

```bash
agentpack source prune --missing
```

## Future Archive Direction

Archive should come before destructive compaction. A task archive bundle should
include at least:

- `passport.json`
- task event history
- referenced evidence files
- checkpoint metadata needed for handoff
- a compact manifest

Only after archive bundles are dogfooded should Agentpack add destructive prune
or compact commands, and those commands should require explicit flags such as
`--dry-run`, `--confirm`, or age filters.
