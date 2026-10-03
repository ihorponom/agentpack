# Read-only Inspector

`agentpack tui` is a small keyboard-driven terminal browser for the canonical
`.agentpack` ledger. It is for inspecting an historical Task Passport without
switching the current task: task details, task-scoped timeline, linked
verification evidence, repository checkpoints, ledger health, and task usage
are available from one screen. Checkpoints are one repository list; those
taken while the selected task was current are marked `[this task]`, those of
other tasks `[other task]`, and older ones stay unmarked because they carry no
task link. Decisions are not joined to a task: the ledger schema does not
encode that relationship.

Controls: `j`/`k` or arrows move or scroll, `Enter` advances through task views
and opens the selected Evidence or Checkpoint, `Tab` changes the primary view,
`/` filters Tasks, `Esc` or backspace returns from a detail to its list and then
goes back, and `q` exits. Evidence is a task-linked selectable list;
Checkpoints is a repository-wide selectable list with task marks. When stdin or stdout is not a TTY, the command prints a
deterministic static Tasks/Health snapshot and exits, which makes it safe in CI
and pipes.

In an interactive terminal, the Inspector uses restrained ANSI styling to
separate the active view, selected task, task status, warnings, and secondary
context. Selection markers, status labels, and section boundaries remain
visible without color. Set `NO_COLOR` or use `TERM=dumb` to disable styling;
non-interactive output never contains color codes.

This is deliberately not a task manager. It has no mutation commands, no
preferences or cache, and never changes `.agentpack`, the current-task pointer,
or lifecycle state. The source of truth remains the existing JSON and JSONL
files. The initial inventory caps task directories, individual and aggregate
Passport bytes, global-event bytes/events, checkpoints, warnings, and rendered
rows. Timeline and Evidence are loaded lazily and within separate limits only
for the selected task. Evidence detail and the four known checkpoint files
(`checkpoint.json`, `git-status.txt`, `diff.patch`, and `resume.md`) use bounded
previews in separate scrollable views. These bounded direct reads are
comfortably fast at current ledger size and avoid a second database, migration
path, and stale-index failure mode.
The repository benchmark measures the live ledger and a deterministic
1,650-passport task-count fixture. It does not scale global events or linked
evidence proportionally; its output is evidence for the current implementation
and machine, not a permanent performance guarantee.

The Health view is the Inspector's bounded inventory, not an exhaustive hygiene
scan. Use `agentpack ledger status` when the complete ledger-health contract is
required.

## Safety boundary

Ledger, evidence, and checkpoint content is treated as untrusted terminal
input. Previews are bounded, redacted with the pack configuration, and stripped
of ANSI/control sequences. Evidence paths must remain regular non-symlink files
below `.agentpack/evidence`; checkpoint detail reads only the known regular
non-symlink files below the selected `.agentpack/checkpoints/<id>` directory.
The Usage view reports the sources linked to the selected task. When none are
linked it lists candidate sessions, which reads Claude Code and Codex
transcripts outside `.agentpack` (`$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, by
default `~/.claude` and `~/.codex`) with the same bounds as `agentpack usage
link`; it shows only counts, ids and paths, never transcript content, and
links nothing. Discovery runs synchronously on first open of a task's Usage
view, behind a loading line, and is cached for the session.
Malformed retained event lines and unsafe or unreadable detail files become
visible warnings instead of crashing the inspector. The terminal alternate
screen, cursor, and raw mode are restored on normal exit, Ctrl-C, SIGTERM,
input end, stream errors, and rendering failures.
