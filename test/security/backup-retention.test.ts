// Every destructive CLI command writes a full timestamped DB backup and
// never prunes - five accumulate on disk right now, each a complete snapshot
// of exactly the data the user asked to erase, and (before this fix) at the
// process umask - world-readable. Undercuts "revocation = deletion."

import { copyFileSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { backupDatabaseAndReport, pruneBackups, writeBackup } from '../../src/storage/backup.js';

function mode(p: string): number {
    return statSync(p).mode & 0o777;
}

describe('writeBackup', () => {
    it('copies the DB file to a timestamped .bak- path, mode 0600', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-backup-'));
        const dbPath = path.join(root, 'elepha.db');
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');

        const backupPath = writeBackup(db, dbPath);

        expect(existsSync(backupPath)).toBe(true);
        expect(backupPath).toMatch(/elepha\.db\.bak-/);
        expect(mode(backupPath)).toBe(0o600);
        db.close();
    });

    it('includes committed rows that existed only in the WAL before the backup checkpoint', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-backup-wal-'));
        const dbPath = path.join(root, 'elepha.db');
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE records (value TEXT NOT NULL)');
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.pragma('wal_autocheckpoint = 0');
        db.prepare('INSERT INTO records (value) VALUES (?)').run('committed only in WAL');

        const uncheckedCopy = path.join(root, 'unchecked.db');
        copyFileSync(dbPath, uncheckedCopy);
        const unchecked = new Database(uncheckedCopy, { readonly: true });
        expect(unchecked.prepare('SELECT COUNT(*) AS count FROM records').get()).toEqual({ count: 0 });
        unchecked.close();

        const backupPath = writeBackup(db, dbPath);
        const backup = new Database(backupPath, { readonly: true });
        expect(backup.prepare('SELECT value FROM records').all()).toEqual([{ value: 'committed only in WAL' }]);
        backup.close();
        db.close();
    });

    it('aborts without writing a file when the checkpoint is incomplete', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-backup-busy-'));
        const dbPath = path.join(root, 'elepha.db');
        writeFileSync(dbPath, 'database');
        const db = { pragma: () => [{ busy: 1, log: 1, checkpointed: 0 }] } as unknown as Database.Database;

        expect(() => writeBackup(db, dbPath)).toThrow('Backup aborted: WAL checkpoint did not complete (busy=1); no backup was written.');
        expect(readdirSync(root).filter((file) => file.includes('.bak-'))).toEqual([]);
    });
});

describe('pruneBackups', () => {
    it('deletes all but the N most recent backups', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-backup-'));
        const dbPath = path.join(root, 'elepha.db');
        writeFileSync(dbPath, 'fake db contents');

        const backups: string[] = [];
        for (let i = 0; i < 7; i++) {
            // Distinct, monotonically increasing suffixes stand in for real
            // timestamps without needing real time to pass between writes.
            const p = `${dbPath}.bak-2026-08-${String(10 + i).padStart(2, '0')}`;
            writeFileSync(p, 'backup');
            backups.push(p);
        }

        const deleted = pruneBackups(dbPath, 3);

        const remaining = readdirSync(root).filter((f) => f.includes('.bak-'));
        expect(remaining.length).toBe(3);
        expect(remaining.sort()).toEqual(
            backups
                .slice(4)
                .map((p) => path.basename(p))
                .sort(),
        );
        expect(deleted.length).toBe(4);
    });

    it('is a no-op when there are fewer backups than the keep count', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-backup-'));
        const dbPath = path.join(root, 'elepha.db');
        writeFileSync(dbPath, 'fake db contents');
        writeFileSync(`${dbPath}.bak-2026-08-10`, 'backup');

        const deleted = pruneBackups(dbPath, 5);

        expect(deleted).toEqual([]);
        expect(readdirSync(root).filter((f) => f.includes('.bak-')).length).toBe(1);
    });
});

describe('backupDatabaseAndReport', () => {
    it('writes, prunes to the configured retention count, and reports both actions through the injected logger', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-backup-'));
        const dbPath = path.join(root, 'elepha.db');
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        for (let index = 0; index < 5; index++) {
            writeFileSync(`${dbPath}.bak-1999-01-${String(index + 1).padStart(2, '0')}`, 'backup');
        }
        const messages: string[] = [];

        const backupPath = backupDatabaseAndReport(db, dbPath, (message) => messages.push(message));

        expect(existsSync(backupPath)).toBe(true);
        expect(messages).toEqual([`\nBacked up ${dbPath} to ${backupPath}.`, 'Pruned 1 older backup(s), keeping the 5 most recent.']);
        expect(readdirSync(root).filter((file) => file.includes('.bak-'))).toHaveLength(5);
        db.close();
    });
});
