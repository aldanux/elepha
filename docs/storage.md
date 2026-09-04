# Protecting and recovering memory

elepha encrypts its whole SQLite database at rest, including session metadata,
summaries, privacy state, search indexes, and any durable conversation copies.
Existing plaintext databases migrate automatically during upgrade or the next
installed start. The migration preserves the database contents and leaves the source
transcripts untouched.

The database key is created and retrieved without a passphrase prompt. elepha keeps it
in the operating system's secret store when a usable one is available, or in a private
key file under `$ELEPHA_HOME` where it is not. This protects database files at rest; it
does not protect against malware already running as your user.

## Durable conversation copies

[Durable capture](capture.md#durable-capture) can store a sanitized copy of each
eligible turn inside the encrypted database. With durable capture off, the database's
session content remains derivable from retained source transcripts. With it on, a
sanitized copy can become the only surviving record after the source tool deletes a
transcript. Use a full backup when that copy must survive disk or database loss.

The durable store is capped by `durable-capture-max-bytes`, which defaults to
1,073,741,824 bytes (1 GiB). When the cap is exceeded, elepha evicts the oldest
sessions' durable copies, starting with sessions whose source transcript still exists
and can therefore be rebuilt. If more must be removed, it proceeds to copies whose
source is unavailable. See [Configuration](configuration.md#durable-store-size) for
the exact JSON setting.

## Same-installation recovery

elepha provides three distinct storage operations. A backup writes an encrypted
SQLite file, a restore replaces the active database from a complete backup, and an
import merges eligible sessions from a plaintext export. Restore and import validate
their input and save a snapshot of the current database before writing.

User-requested backups go to `$ELEPHA_HOME/backups/` by default. They and the safety
snapshots made automatically by destructive operations use this installation's
database key. They are same-machine disaster-recovery files, not portable or
cross-machine backups.

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
and is suitable for restore on the same installation. A project export is also
encrypted with the installation key, but contains only project, session, memory, and
rollup tables; it cannot replace the active database and does not preserve durable
conversation copies or their search index.

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
showing the row counts that will replace the active database. Older compatible backups
are staged through current migrations during validation.

After confirmation, elepha checkpoints and snapshots the current database, replaces
it atomically, and verifies the result. If post-replacement verification fails, it
attempts to roll back from that snapshot. Current incognito transcript vetoes are
preserved across the restore so an older backup cannot reopen deliberately private
sessions. Use `--skip-confirmation` only for a non-interactive restore you have already
reviewed.

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
its local source transcript is inside the expected Claude Code or Codex store and its
current project root is approved. Sessions already purged, marked incognito, outside a
provider store, or not currently consented are skipped. Imported display and summary
fields are sanitized before storage.

Interactive confirmation is required unless you pass `--skip-confirmation`. After a
restore or import, return to [Controlling capture](capture.md) to start the background
service again.
