# Read-only Inspector

`agentpack tui` opens the Inspector. It is a small keyboard-driven terminal browser for the `.agentpack` ledger. Use it to inspect a historical Task Passport. It does not change the current task.

One screen shows these views:

- Tasks, Passport and Timeline for the selected task
- Evidence linked to the task verification
- Checkpoints for the repository
- Health, a bounded ledger inventory
- Usage for the selected task

Checkpoints are one repository list. A checkpoint taken while the selected task was current has the mark `[this task]`. A checkpoint of another task has the mark `[other task]`. Older checkpoints have no mark because they have no task link. Decisions are not joined to a task. The ledger schema does not store that relationship.

## Controls

| Key | Action |
|---|---|
| `j`, `k` or arrow keys | Move or scroll. |
| `Enter` | Go through the task views. Open the selected Evidence or Checkpoint item. |
| `Tab` | Change the primary view. |
| `/` | Filter the Tasks list. |
| `Esc` or backspace | Go from a detail view back to its list, then go back. |
| `q` | Exit. |

In filter mode, type to change the filter. `Enter` confirms the filter. `Esc` clears the filter and leaves filter mode. `Ctrl-C` quits.

Evidence is a selectable list linked to the task. Checkpoints is a selectable list for the whole repository.

If stdin or stdout is not a terminal, the command prints a static snapshot and exits. The snapshot is the same on each run, so it is safe in CI and pipes. It contains:

- the task list (at most 40 tasks)
- the counts of Tasks, Events and Checkpoints
- warnings

The static snapshot does not show the Health view.

In an interactive terminal, the Inspector uses plain ANSI styling to separate the active view, the selected task, the task status, warnings and secondary context. Selection markers, status labels and section boundaries stay visible without color. Set `NO_COLOR` or `TERM=dumb` to turn styling off. Non-interactive output never contains color codes.

## Limits

The Inspector is not a task manager. It has no commands that change state, no preferences and no cache of ledger data. It never changes `.agentpack`, the current-task pointer or the lifecycle state. The existing JSON and JSONL files stay the source of truth.

The initial inventory limits these items:

- task directories
- the size of each Passport and the total size of all Passports
- global event bytes and event count
- checkpoints
- warnings
- rendered rows

Timeline and Evidence load only for the selected task, with separate limits. Evidence detail and the four known checkpoint files have bounded previews in separate scrollable views. The four files are `checkpoint.json`, `git-status.txt`, `diff.patch` and `resume.md`.

The Health view is a bounded inventory. It is not a full hygiene scan. Use `agentpack ledger status` for the complete ledger health report.

## Usage view

The Usage view shows the linked sessions of the selected task. It also shows the traced sessions, which are the sessions that ran Agentpack for the task. If there are none, the view lists candidate sessions.

To find candidates, the Inspector reads Claude Code and Codex transcripts outside `.agentpack`. The locations are `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME`. The defaults are `~/.claude` and `~/.codex`. The bounds are the same as for `agentpack usage link`. The view shows only counts, ids and paths. It never shows transcript content. It links nothing.

Discovery runs synchronously the first time you open the Usage view of a task. A loading line shows while it runs. The cache holds one task only. If you switch to another task, discovery runs again.

## Safety boundary

The Inspector treats ledger, evidence and checkpoint content as untrusted terminal input.

- Previews are bounded. They are redacted with the pack configuration. Agentpack removes ANSI and control sequences.
- Evidence paths must be regular files that are not symlinks, below `.agentpack/evidence`.
- Checkpoint detail reads only the known regular files that are not symlinks, below the selected `.agentpack/checkpoints/<id>` directory.
- Malformed event lines, and unsafe or unreadable detail files, become visible warnings. They do not crash the Inspector.
- The terminal alternate screen, cursor and raw mode are restored on normal exit, `Ctrl-C`, SIGTERM, end of input, stream errors and rendering failures.
