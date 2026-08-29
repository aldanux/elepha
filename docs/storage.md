# Protecting and moving memory

elepha provides three distinct storage operations. A backup creates a portable SQLite
file, a restore replaces the active database from a complete backup, and an import
merges eligible sessions into the active database. Restore and import validate their
input and save a snapshot of the current database before writing.

Portable backups go to `$ELEPHA_HOME/backups/` by default. The safety snapshots made
automatically by destructive operations are separate from these user-requested
exports.

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

A complete export is suitable for restore. A project export contains only portable
project, session, turn, and rollup data and is intended for import; it cannot replace
the active database.

## Restore the complete database

`elepha restore` replaces the active database, so pause capture first. Without a file
argument, its interactive picker lists complete backups from
`$ELEPHA_HOME/backups/`, newest first, and also offers a manual path. Pass a file to
select it directly:

```console
elepha restore /path/to/elepha-full-backup.db
```

Restore accepts only a complete elepha backup. It validates the SQLite file, required
tables, schema, integrity, relationships, and stored data semantics before showing the
row counts that will replace the active database. Older compatible backups are staged
through current migrations during validation.

After confirmation, elepha checkpoints and snapshots the current database, replaces
it atomically, and verifies the result. If post-replacement verification fails, it
attempts to roll back from that snapshot. Current incognito transcript vetoes are
preserved across the restore so an older backup cannot reopen deliberately private
sessions. Use `--skip-confirmation` only for a non-interactive restore you have already
reviewed.

## Merge a backup

`elepha import` also requires capture to be paused, but it merges rather than replaces.
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
