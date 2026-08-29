# Read-only Inspector

`agentpack tui` is a small keyboard-driven terminal browser for the canonical
`.agentpack` ledger. It is for inspecting an historical Task Passport without
switching the current task: task details, task-scoped timeline, linked
verification evidence, global repository checkpoints, and ledger health are available
from one screen. Checkpoints are shown as a clearly labeled global repository
list and decisions are not joined to a task: the current ledger schema does
not reliably encode either relationship.

Controls: `j`/`k` or arrows move, `Enter` drills into the next view,
`Tab` changes view, `/` filters Tasks, `Esc` or backspace goes back, and `q`
exits. When stdin or stdout is not a TTY, the command prints a deterministic
static Tasks/Health snapshot and exits, which makes it safe in CI and pipes.

This is deliberately not a task manager. It has no mutation commands, no
preferences or cache, and never changes `.agentpack`, the current-task pointer,
or lifecycle state. The source of truth remains the existing JSON and JSONL
files. The initial inventory caps task directories, individual and aggregate
Passport bytes, global-event bytes/events, checkpoints, warnings, and rendered
rows. Timeline and Evidence are loaded lazily and within separate limits only
for the selected task. These bounded direct reads are comfortably fast at
current ledger size and avoid a second database, migration path, and stale-index
failure mode.
The repository benchmark measures the live ledger and a deterministic
1,650-passport task-count fixture. It does not scale global events or linked
evidence proportionally; its output is evidence for the current implementation
and machine, not a permanent performance guarantee.

The Health view is the Inspector's bounded inventory, not an exhaustive hygiene
scan. Use `agentpack ledger status` when the complete ledger-health contract is
required.

## Safety boundary

Ledger and evidence content is treated as untrusted terminal input. Previews
are bounded, redacted with the pack configuration, stripped of ANSI/control
sequences, and evidence paths must remain regular non-symlink files below
`.agentpack/evidence`. Malformed retained event lines become visible warnings
instead of crashing the inspector. The terminal alternate screen, cursor, and
raw mode are restored on normal exit, Ctrl-C, SIGTERM, input end, stream errors,
and rendering failures.
