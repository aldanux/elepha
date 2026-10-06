// Backups of the DB file, written before any destructive operation
// (purge, rekey). Two gaps closed here: backups inherited the process umask
// (world-readable, same as the DB itself before the file-permissions fix),
// and nothing ever pruned them - each is a full snapshot of exactly the data
// the user asked to erase, so an unbounded pile of them undercuts
// "revocation = deletion" as badly as skipping the delete would.

import { chmodSync, closeSync, copyFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import { BACKUP_KEEP, PRIVATE_FILE_MODE } from '../config/constants.js';
import { resolveSQLiteMainDatabaseFilename } from './database-lifecycle.js';
import { hasPlaintextDatabaseHeader } from './db.js';
import {
    createPrivateEmptyDatabaseDescriptor,
    inspectPrivateEmptyDatabaseDescriptor,
    writeEncryptedDatabaseSnapshot,
} from './encrypted-database-export.js';

const BACKUP_MARKER = '.bak-';
const VERIFIED_BACKUP_SCHEMA = 'elepha_verified_backup';

function managedBackupPath(dbPath: string): string {
    return `${dbPath}${BACKUP_MARKER}${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

// Checkpoints the live database, then copies it to a timestamped sibling, mode 0600.
export function writeBackup(db: Database.Database, dbPath: string): string {
    const backupPath = managedBackupPath(dbPath);
    const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: unknown }>;
    if (checkpoint?.busy !== 0) {
        throw new Error(`Backup aborted: WAL checkpoint did not complete (busy=${String(checkpoint?.busy)}); no backup was written.`);
    }
    copyFileSync(dbPath, backupPath);
    chmodSync(backupPath, PRIVATE_FILE_MODE);
    return backupPath;
}

// The ISO-derived filename suffix sorts chronologically, so filename order
// determines the retained snapshots.
export function listManagedBackups(dbPath: string): string[] {
    const dir = path.dirname(dbPath);
    const prefix = `${path.basename(dbPath)}${BACKUP_MARKER}`;
    return readdirSync(dir)
        .filter((f) => f.startsWith(prefix))
        .map((f) => path.join(dir, f))
        .sort();
}

export function pruneBackups(dbPath: string, keep: number): string[] {
    const backups = listManagedBackups(dbPath);
    const toDelete = backups.length > keep ? backups.slice(0, backups.length - keep) : [];
    for (const p of toDelete) {
        unlinkSync(p);
    }
    return toDelete;
}

export function removePlaintextManagedBackups(dbPath: string): string[] {
    if (hasPlaintextDatabaseHeader(dbPath)) {
        return [];
    }
    const dir = path.dirname(dbPath);
    const prefix = `${path.basename(dbPath)}${BACKUP_MARKER}`;
    const removed: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) {
            continue;
        }
        const backupPath = path.join(dir, entry.name);
        if (hasPlaintextDatabaseHeader(backupPath)) {
            unlinkSync(backupPath);
            removed.push(backupPath);
        }
    }
    return removed;
}

// Writes a backup, retains the configured number of snapshots, and reports both actions.
export function backupDatabaseAndReport(db: Database.Database, dbPath: string, log: (message: string) => void = console.log): string {
    const backupPath = writeBackup(db, dbPath);
    log(`\nBacked up ${dbPath} to ${backupPath}.`);
    const removedPlaintext = removePlaintextManagedBackups(dbPath);
    if (removedPlaintext.length > 0) {
        log(`Removed ${removedPlaintext.length} plaintext managed backup(s).`);
    }
    const pruned = pruneBackups(dbPath, BACKUP_KEEP);
    if (pruned.length > 0) {
        log(`Pruned ${pruned.length} older backup(s), keeping the ${BACKUP_KEEP} most recent.`);
    }
    return backupPath;
}

// Snapshots the whole database through the live connection's own codec into a
// managed backup sibling, then reopens that copy (attached under the same key)
// and hands its schema name to verify, which throws when the copy lacks what
// the caller must be able to recover. A plaintext database is refused rather
// than copied in the clear, and a copy that fails to write or verify is
// removed so no partial snapshot is mistaken for a recovery source. Must run
// outside a transaction: SQLite cannot attach a database inside one.
export function writeVerifiedEncryptedBackup(db: Database.Database, verify: (schema: string) => void): string {
    const dbPath = resolveSQLiteMainDatabaseFilename(db);
    if (dbPath === undefined) {
        throw new Error('A verified backup requires an on-disk database.');
    }
    const backupPath = managedBackupPath(dbPath);
    const descriptor = createPrivateEmptyDatabaseDescriptor(backupPath);
    let identity: ReturnType<typeof inspectPrivateEmptyDatabaseDescriptor>;
    try {
        identity = inspectPrivateEmptyDatabaseDescriptor(descriptor);
    } finally {
        closeSync(descriptor);
    }
    let verified = false;
    try {
        writeEncryptedDatabaseSnapshot(db, backupPath, identity);
        db.prepare(`ATTACH DATABASE ? AS ${VERIFIED_BACKUP_SCHEMA}`).run(backupPath);
        try {
            const integrity = db.pragma(`${VERIFIED_BACKUP_SCHEMA}.quick_check(1)`) as Array<{ quick_check: string }>;
            if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') {
                throw new Error('Verified backup failed quick_check.');
            }
            verify(VERIFIED_BACKUP_SCHEMA);
        } finally {
            db.exec(`DETACH DATABASE ${VERIFIED_BACKUP_SCHEMA}`);
        }
        verified = true;
    } finally {
        if (!verified) {
            rmSync(backupPath, { force: true });
        }
    }
    pruneBackups(dbPath, BACKUP_KEEP);
    return backupPath;
}
