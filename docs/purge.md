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

Purged transcript identities are recorded so capture and restore cannot silently
resurrect them. Treat an applied purge as permanent. The automatic pre-purge snapshot
protects the database if the operation fails; it is not a supported undo mechanism,
because restore preserves the current purge tombstones.

## Choose one base scope

Each invocation accepts at most one base scope: `--project <pathOrName>`, `--here`,
`--external-agent-imports`, `--orphan`, `--revoked`, or `--all`. `--here` selects the
currently consented project. `--project` selects all project rows resolved from a path
or display name.

Time scopes accept either a duration such as `24h`, `7d`, or `90d`, or an ISO date.
`--newer-than <durationOrDate>` selects sessions ingested at or after the cutoff, while
`--older-than <durationOrDate>` selects sessions ingested at or before it. A time
filter can stand alone or narrow the project, `--here`, `--orphan`, `--revoked`, or
`--all` scope. It cannot be combined with `--external-agent-imports`.

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
[Protecting and recovering memory](storage.md) to create an encrypted
same-installation archive before a large deletion or to restore a complete database
for disaster recovery. A backup does not override purge tombstones.
