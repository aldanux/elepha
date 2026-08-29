# Updating and maintaining elepha

Most users need only the updater. The remaining commands on this page are advanced
operator tools for repairing or migrating stored memory after a format, parser, or
schema change.

## Update elepha

`elepha self-update` runs the update workflow. On macOS, the updater finds the
installed global build, installs the latest release, restarts the capture daemon so
database migrations run, and verifies that capture becomes healthy again.

If the new build fails after installation, elepha makes one rollback attempt to the
previous recorded version and restarts the service again. A failed rollback or an
unhealthy restored service is reported with the next recovery command; it is never
presented as a successful update.

Because `elepha self-update` reinstalls the hooks, Codex requires approval again. Open
Codex, run `/hooks`, and approve both elepha hooks; until then, `elepha doctor` reports
`Codex hooks: approval is required` and Codex sessions are not captured. This is
expected Codex security behavior, not a failed update. Claude Code reactivates its
hooks automatically.

## Advanced operator commands

The commands below are tagged `[operator]`. They are runnable but hidden from the
default `elepha -h`; use `elepha <command> -h` to see the exact flags for one command.
The one-off maintenance and migration surface is dry-run by default: pass `--apply`
when a command is ready to write. Commands that migrate stored data back up the
database before changing it. Review every preview, especially when raw transcripts
are missing or projects have moved.

### `reingest`

`elepha reingest` reprocesses already-ingested turns in a chosen time window through
the current adapters and turn summarizer. It is intended for correcting rows after an
adapter or summarizer defect and never moves the live daemon cursor. It requires a
configured synthesis provider and reports calls, tokens, estimated cost, and duration.

### `rollup`

`elepha rollup` computes session rollups that are missing or not current. Normal work
is incremental and idempotent. `--rebuild` widens the operation to rollups written by
an older rollup version, previews the estimated provider cost, and requires
`--rebuild --apply` before making calls. Pause the daemon before applying a rebuild so
it cannot race the same session.

### `rekey-projects`

`elepha rekey-projects` consolidates duplicate project rows that resolve to the same
repository. Identity is matched by Git remote first, then root commit, then canonical
repository path; sessions and memories are moved to the selected canonical project.

### `sanitize`

`elepha sanitize` finds shell-active syntax in stored turns and rollups that predate
the current write-time sanitizer. Its preview shows each affected field before and
after neutralization, and an applied run verifies the database again afterward.

### `segment`

`elepha segment` previews session boundary corrections. Use `--resegment` to replay
retained native sessions through the current evaluator, `--split <id> --at <turn>` to
split one stored session, or `--merge <a> <b>` to join adjacent segments. Applied
changes invalidate affected rollups and verify the resulting relationships.

### `stats`

`elepha stats` is read-only instrumentation for ingestion volume, memories per
session, summarizer status and noise, pending-item accumulation, file-path misses, and
per-project totals over a selected time window.

### Backfill commands

`elepha backfill-rendered-chars` derives each session's rendered character and turn
counts from the filtered raw turns still on disk. Missing or unreadable transcripts
remain unset and are reported.

`elepha backfill-session-titles` derives segment titles from an AI-provided title or
the first real prompt. It makes no synthesis call and leaves sessions unchanged when
their transcript is unavailable.

`elepha backfill-custom-titles` reads Claude Code custom-title UI events into the
stored `custom_title` field without changing turns or rendered counts.

`elepha backfill-session-fields` re-derives older session metadata, including surface,
Git branch, session kind, and external-content markers, from transcripts that still
exist locally.

`elepha backfill-root-commits` fills the repository root commit for legacy project
rows so no-remote repositories can be matched by stable identity. Projects whose
repository no longer resolves remain unchanged and are listed.

System-invoked machinery also exists—`start`, `mcp serve`, `hook …`, and
`internal launcher-probe`—but these entry points are registered for launch services,
MCP clients, and hooks and are never typed by users.
