# Protecting and recovering memory

elepha encrypts its whole SQLite database at rest, including session metadata,
summaries, privacy state, search indexes, and any durable conversation copies.
Existing plaintext databases migrate automatically during upgrade or the next
installed start; no export or import step is required. The migration preserves the
database contents and leaves the source transcripts untouched. It requires free space
equal to at least 2.1 times the combined size of the current database and its
write-ahead log. If an encryption migration is interrupted, the recorded recovery is
resumed before elepha opens the database; `elepha doctor` can stop capture and run
that recovery check.

The database key is created and retrieved without a passphrase prompt. elepha keeps it
in the operating system's secret store when a usable one is available, or in a private
key file under `$ELEPHA_HOME` where it is not. This protects database files at rest; it
does not protect against malware already running as your user.

## Durable conversation copies

[Durable capture](capture.md#durable-capture) stores a sanitized copy of each newly
captured Claude Code and Codex turn inside the encrypted database automatically;
OpenCode copies still require the legacy `durable-capture` setting. Ordinary Claude
Code and Codex reads use only retained database evidence; missing or incompatible
copies remain gaps even when the source is readable. Complete current copies serve
independently of source presence or contents; summaries and individually current
turns do not certify whole-session completeness. A sanitized copy can become the
only surviving record after the source tool deletes a transcript. Use a full backup
when that copy must survive disk or database loss.

Durable copies count toward the fixed live-memory capacity described in
[Live-memory capacity](#live-memory-capacity); no individual copy is evicted to make
room.

## Live-memory capacity

elepha keeps its whole live memory (session titles and summaries, per-turn memories,
rollups, task-state reports, durable copies and their search index, staged failed
turns, and embedding vectors) under a fixed capacity of 5,000,000,000 bytes, counted
as logical stored bytes rather than database file size. `elepha status` shows current
usage. From 4 GB, a new chat opening shows a warning at most once a week; from 4.75 GB,
every new chat opening warns.

When a capture would bring usage to 5 GB, elepha removes whole native sessions (every
segment and everything derived from them), oldest source start first, only as many as
needed to get back to at most 4.75 GB including the new turn. Only sessions whose
durable copy is complete in every segment qualify. It never removes a single turn, a
chat that is still active or has a staged turn, a session whose capture, source
generation or consent is unsettled, or a parent session another retained chat still
references.
Projects, consent, and standing rules are kept. Before removing anything it writes an
encrypted, verified backup beside the database; the removal and the new turn commit
together or not at all, and a removed session is never re-captured from its transcript.
Restoring that backup with `elepha restore` brings the removed sessions back; purge and
incognito decisions still apply. Bulk operations that cannot clean up, such as import,
restore and backfills, refuse a result that would reach 5 GB and change nothing.
`elepha status` lists removed sessions. If cleanup cannot safely reach the target,
nothing is removed and the new turn is deferred; `elepha status` names each deferred
chat and the reason, and capture retries automatically. Use [Deleting memory](purge.md)
to free space manually.

## Same-installation recovery

elepha provides three distinct storage operations. A backup writes an encrypted
SQLite file, a restore replaces the active database from a complete backup, and an
import merges eligible sessions from a plaintext export. Restore and import validate
their input and save a snapshot of the current database before writing.

User-requested complete backups and project exports go to `$ELEPHA_HOME/backups/` by
default. Complete backups and the safety snapshots made automatically by destructive
operations and encryption migration use this installation's database key and are
same-installation recovery files. Project exports use that key too, but are encrypted
archives rather than supported recovery inputs. All are created as ciphertext rather
than as plaintext intermediates and are not portable across installations.

## Create a backup

Run `elepha backup` in an interactive terminal to choose between all memory and one
project, then choose the destination. A full export uses a name beginning with
`elepha-full-`; a project export uses the project's name. Existing destinations are
never overwritten unless you explicitly allow it.

For scripts, choose the scope directly. `elepha backup --all` exports the complete
database, while `elepha backup --project <pathOrName>` exports the consolidated memory
for one resolved project. `--out <path>` changes the destination and accepts either a
file or directory. Add `--force` only when you intend to replace an existing backup
file.

```console
elepha backup --all --out /path/to/archive/
elepha backup --project my-app --out ./my-app-memory.db
```

A complete export preserves the whole database, including durable conversation copies,
and is suitable for restore on the same installation. A project export is an encrypted
archive containing only project, session, memory, and rollup tables; it does not
preserve durable conversation copies or their search index. Current elepha commands
cannot restore or import that encrypted project archive, so it is not a supported
recovery path.

Both export forms write into an encrypted SQLite destination from the first database
write and verify that ciphertext before installing the final file. They do not stage
a plaintext export beside the destination.

## Restore the complete database

`elepha restore` replaces the active database, so pause capture first. Without a file
argument, its interactive picker lists complete backups from
`$ELEPHA_HOME/backups/`, newest first, and also offers a manual path. Pass a file to
select it directly:

```console
elepha restore /path/to/elepha-full-backup.db
```

Restore accepts only a complete elepha backup. A current encrypted backup can be
opened only with the key from the installation that created it; compatible plaintext
backups from earlier releases are also accepted. elepha validates the SQLite file,
required tables, schema, integrity, relationships, and stored data semantics before
showing candidate table counts. Older compatible backups are staged through current
migrations during validation.

Restore keeps the active installation's consent decisions, purge and incognito
tombstones, paranoid read-lock authority, encryption identity, and records that stop
elepha's own injected output from being captured again. Durable-eviction markers from
both databases remain terminal. After confirmation, elepha rechecks those controls and
the active database identity; if the preview is stale, it aborts before replacement.

Before installation, restore removes durable rows vetoed by current privacy or
eviction state, rebuilds the filtered full-text index and byte accounting, checkpoints
and snapshots the current database, and replaces it atomically. The restored database
continues to use the active installation key. If post-replacement verification fails,
elepha attempts to roll back from the encrypted snapshot. Use
`--skip-confirmation` only for a non-interactive restore you have already reviewed.

## Merge a backup

`elepha import` also requires capture to be paused, but it merges rather than replaces.
It accepts only a plaintext export. It rejects an encrypted file with the
message `Portable encrypted import is not supported yet; import currently accepts a
plaintext export.` This includes encrypted project exports created by `elepha backup
--project`, so elepha does not currently provide an encrypted project-transfer path, even between
installations.

Without a file argument, the interactive wizard lists backups in
`$ELEPHA_HOME/backups/` and asks whether to keep all existing sessions or overwrite
matches with the backup's version.

The direct form is safe by default: it adds new sessions and leaves matching local
sessions unchanged.

```console
elepha import /path/to/backup.db
```

Pass `--overwrite` to replace matching session rows, turns, and rollups with the
backup's version. Both modes preview the number of new, matching, and skipped sessions
and save a pre-import snapshot before applying the merge in one transaction.

Import does not treat backup metadata as permission. It imports a session only when
its local source is inside the expected Claude Code or Codex transcript
store or the expected OpenCode database store, and its current project root is approved.
Sessions already purged, marked incognito, outside a provider store, or not currently
consented are skipped. Imported display and summary fields are sanitized before storage.

Interactive confirmation is required unless you pass `--skip-confirmation`. After a
restore or import, return to [Controlling capture](capture.md) to start the background
service again.
