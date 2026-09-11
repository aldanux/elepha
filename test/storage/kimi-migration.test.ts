import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { withTempDir } from '../helpers/tmp.js';

const NOW = '2026-09-10T00:00:00.000Z';
function insertSession(db: Database.Database, tool: string, nativeId: string) {
    db.prepare(`INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
        VALUES (?, ?, 1, '/provider/session', ?, ?)`).run(tool, nativeId, NOW, NOW);
}

describe('session tool schema migration', () => {
    it.each([false, true])('admits Kimi and DeepSeek, preserves prior rows and reopens idempotently (legacy=%s)', (legacy) => {
        const dbPath = path.join(withTempDir('kimi-migration-'), 'memory.db');
        const initial = legacy ? new Database(dbPath) : openUnmanagedDb(dbPath);
        if (legacy) {
            initial.exec(readFileSync(path.resolve('test/fixtures/kimi-prior-schema.sql'), 'utf8'));
        }
        initial.prepare('INSERT INTO projects (id, path, first_seen_at, last_seen_at) VALUES (1, ?, ?, ?)').run('/project', NOW, NOW);
        insertSession(initial, 'opencode', 'prior-opencode');
        initial
            .prepare(`INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at,
            decisions, files_touched, pending_items, created_at) VALUES (1, 1, 0, 'opencode', ?, '[]', '[]', '[]', ?)`)
            .run(NOW, NOW);
        if (legacy) {
            expect(() => insertSession(initial, 'kimi', 'rejected')).toThrow(/CHECK/);
            expect(() => insertSession(initial, 'deepseek', 'rejected')).toThrow(/CHECK/);
        }
        initial.close();
        const migrated = openUnmanagedDb(dbPath);
        insertSession(migrated, 'kimi', 'kimi-capture');
        insertSession(migrated, 'deepseek', 'deepseek-capture');
        expect(migrated.prepare('SELECT id, tool, native_id FROM sessions ORDER BY id').all()).toEqual([
            { id: 1, tool: 'opencode', native_id: 'prior-opencode' },
            { id: 2, tool: 'kimi', native_id: 'kimi-capture' },
            { id: 3, tool: 'deepseek', native_id: 'deepseek-capture' },
        ]);
        expect(migrated.prepare('SELECT session_id, source_digest, provenance FROM memories').get()).toEqual({
            session_id: 1,
            source_digest: null,
            provenance: null,
        });
        expect(migrated.pragma('foreign_key_check')).toEqual([]);
        const schema = migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
        migrated.close();
        const reopened = openUnmanagedDb(dbPath);
        expect(reopened.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual(schema);
        expect(reopened.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 1 });
        expect(reopened.pragma('foreign_key_check')).toEqual([]);
        reopened.close();
    });
});
