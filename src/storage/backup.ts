// Backups of the DB file, written before any destructive operation
// (purge, rekey). Two gaps closed here: backups inherited the process umask
// (world-readable, same as the DB itself before the file-permissions fix),
// and nothing ever pruned them - each is a full snapshot of exactly the data
// the user asked to erase, so an unbounded pile of them undercuts
// "revocation = deletion" as badly as skipping the delete would.

import { chmodSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { BACKUP_KEEP, PRIVATE_FILE_MODE } from '../config/constants.js';

const BACKUP_MARKER = '.bak-';

/** Checkpoints the live database, then copies it to a timestamped sibling, mode 0600. */
export function writeBackup(db: Database.Database, dbPath: string): string {
    const backupPath = `${dbPath}${BACKUP_MARKER}${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: unknown }>;
    if (checkpoint?.busy !== 0) {
        throw new Error(`Backup aborted: WAL checkpoint did not complete (busy=${String(checkpoint?.busy)}); no backup was written.`);
    }
    copyFileSync(dbPath, backupPath);
    chmodSync(backupPath, PRIVATE_FILE_MODE);
    return backupPath;
}

/** Deletes every backup for dbPath except the `keep` most recent (by filename, which sorts chronologically for the ISO-derived suffix). Returns the paths deleted. */
export function pruneBackups(dbPath: string, keep: number): string[] {
    const dir = path.dirname(dbPath);
    const prefix = `${path.basename(dbPath)}${BACKUP_MARKER}`;
    const backups = readdirSync(dir)
        .filter((f) => f.startsWith(prefix))
        .map((f) => path.join(dir, f))
        .sort();

    const toDelete = backups.length > keep ? backups.slice(0, backups.length - keep) : [];
    for (const p of toDelete) {
        unlinkSync(p);
    }
    return toDelete;
}

/** Writes a backup, retains the configured number of snapshots, and reports both actions. */
export function backupDatabaseAndReport(db: Database.Database, dbPath: string, log: (message: string) => void = console.log): string {
    const backupPath = writeBackup(db, dbPath);
    log(`\nBacked up ${dbPath} to ${backupPath}.`);
    const pruned = pruneBackups(dbPath, BACKUP_KEEP);
    if (pruned.length > 0) {
        log(`Pruned ${pruned.length} older backup(s), keeping the ${BACKUP_KEEP} most recent.`);
    }
    return backupPath;
}
