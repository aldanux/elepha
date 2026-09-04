import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openUnmanagedDb } from '../../src/storage/db.js';

describe('openUnmanagedDb', () => {
    it('enables foreign_keys - better-sqlite3 does not turn this on by default, and it resets per connection', () => {
        const db = openUnmanagedDb(':memory:');
        const row = db.prepare('SELECT * FROM pragma_foreign_keys').get() as { foreign_keys: number };
        expect(row.foreign_keys).toBe(1);
    });

    it('persists WAL journal mode on a real file (not just the connection)', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-db-'));
        const dbPath = path.join(dir, 'elepha.db');
        const db = openUnmanagedDb(dbPath);
        const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
        expect(row.journal_mode).toBe('wal');
        db.close();
    });

    it('rejects an orphan memory row once foreign_keys is confirmed on', () => {
        const db = openUnmanagedDb(':memory:');
        expect(() =>
            db
                .prepare(
                    'INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at) VALUES (?,?,?,?,?,?)',
                )
                .run('claude-code', 'x', 999, 'p', 'now', 'now'),
        ).toThrow(/FOREIGN KEY/);
    });
});
