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
agents. `--orphan` classifies complete Claude Code/Codex native sessions against
recorded project ownership, relocation evidence and fresh filesystem observations.
Only confirmed missing directories with a complete bounded check and no protected
association become deletion candidates. Existing temporary directories are preserved.
`--orphan` clears confirmed orphaned memory; to also remove the stale entry
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


## Orphan classification and exact deletion

```console
elepha purge --orphan
elepha purge --orphan --details
elepha purge --orphan --apply
```

The report separates preserved memory from cleanup candidates. It explains which
chats have an existing project, relocation evidence, unresolved inspection, or
a mixture of missing and protected project parts. When no chats qualify for
deletion, it reports that no cleanup confirmation is needed. Missing provider transcripts,
historical gaps and revoked consent alone never authorize
deletion. Possible matches by recorded identity or name preserve memory and
require explicit association repair; they do not merge projects.

Inspection uses stored project paths and accessible ancestors, not a disk scan,
provider-corpus replay or model. Project discovery is paged and limited to 2,048
rows, filesystem inspection to 10,000 path observations and 10 seconds, and native
membership to 256 segments. Ancestor traversal and retained native rule associations
have separate bounds; oversized scopes are preserved or refused before deletion. Incomplete inspection, filesystem failures, dangling
links and ambiguity preserve memory. Details retain at most 64 KiB of newest
diagnostics and report omitted entries; totals cover all classified units.

A native session containing any protected sibling is preserved in full. Fragment
cleanup requires segment-scoped no-resurrection support and is not implemented
in this slice. OpenCode units are reported as unsupported and preserved by this
classifier; other explicit purge scopes keep their existing behavior.

Before confirmation, every affected project, host/native identity, segment row,
retained-content count and project/chat rule is displayed. Chat rules are selected
only for the confirmed host/native identities after checking all their checkout
associations. Other chats' rules and their owner projects are preserved, including
chats with no captured session rows. Project standing rules are preserved whenever
an unselected session or another chat's rules still need that owner. Time filters must cover every sibling before a
native unit can be selected, and exclude rules. Oversized deletion previews are
refused rather than truncated. Empty selections stay empty.

Filesystem/association checks run again before mutation; exact owned rows,
sibling membership, control state and rule scope are revalidated inside
the purge transaction. Directory recreation or identity/ownership changes abort
without expanding the confirmed plan. Transactional deletion checks native
tombstones, dependent state, foreign keys and retained-memory accounting.
Consent roots and provider files remain untouched.

Noninteractive orphan apply requires explicit `--skip-confirmation`. That option
skips only the standalone prompt; classification, full preview, capture pause,
encrypted backup, frozen-plan validation and verification still run.
