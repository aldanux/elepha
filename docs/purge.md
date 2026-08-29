# Deleting memory

`elepha purge` permanently removes selected sessions, turns, and rollups from elepha's
local memory. It may also remove a project row left with no sessions. The original 
session transcripts on disk are never changed.

Purge is deliberately separate from consent. Pausing permission keeps existing
memory; purging deletes it without changing which roots are approved.

## Preview before deleting

Every purge is a dry run unless you pass `--apply`. The preview prints the affected
projects, session counts, and the actual sessions that match, so you can review the
selection before anything changes:

```console
elepha purge --project my-app
```

When `--apply` is present, elepha shows the preview again, asks for confirmation,
briefly stops capture if necessary, saves a database backup, applies the deletion in a
transaction, and verifies that the selected memory is gone. `--skip-confirmation`
skips only the prompt; it does not skip the preview, backup, or verification.

```console
elepha purge --project my-app --apply
```

Purged transcripts are recorded so the capture service does not silently ingest them
again. Restoring the pre-purge database backup is the recovery path if you later need
that memory.

## Choose one scope

Each invocation accepts exactly one scope. `--project <pathOrName>` selects all memory
for the project resolved from a path or display name.

Time scopes accept either a duration such as `24h`, `7d`, or `90d`, or an ISO date.
`--newer-than <durationOrDate>` selects sessions ingested at or after the cutoff, while
`--older-than <durationOrDate>` selects sessions ingested at or before it.

`--external-agent-imports` selects Codex sessions identified as imported from external
agents. `--orphan` selects memory for temporary project directories and directories
that no longer exist. `--orphan` clears orphaned memory; to also remove the stale entry
from `elepha consent list`, use [`elepha consent prune`](consent.md#prune-stale-consent-roots).
`--revoked` selects memory belonging to projects you have revoked. `--all`
selects every session and project in elepha's memory.

For example:

```console
elepha purge --older-than 90d
elepha purge --newer-than 2026-08-01
elepha purge --revoked --apply
elepha purge --all --apply --skip-confirmation
```

An empty match stays empty; no scope falls back to deleting everything. See
[Protecting and moving memory](storage.md) to create your own portable backup before
a large deletion or to restore a full backup.
