import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { createTestDb, seedProject, seedRollup, seedSession } from '../helpers/db.js';
import { withTempDir } from '../helpers/tmp.js';

function vectorTable(db: ReturnType<typeof openUnmanagedDb>) {
    return db.prepare("SELECT sql FROM sqlite_master WHERE name = 'session_embeddings'").get();
}

describe('Memory-Plus vector migration', () => {
    it('creates a fresh table with cascade provenance and a vector-size constraint', () => {
        const f = createTestDb('embedding-fresh-');
        const { db } = f;
        const project = seedProject(f);
        const session = seedSession(f, { project });
        expect(vectorTable(db)).toBeDefined();
        expect(db.pragma('foreign_key_list(session_embeddings)')).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ table: 'sessions', on_delete: 'CASCADE' }),
                expect.objectContaining({ table: 'session_rollups', on_delete: 'CASCADE' }),
                expect.objectContaining({ table: 'projects', on_delete: 'CASCADE' }),
            ]),
        );
        expect(() =>
            db
                .prepare('INSERT INTO session_embeddings VALUES (?, NULL, ?, ?, ?, ?, 384, ?, ?)')
                .run(session.id, project.id, 'hash', 'model', 'revision', Buffer.alloc(1), 'now'),
        ).toThrow(
            expect.objectContaining({
                code: 'SQLITE_CONSTRAINT_CHECK',
                message: 'CHECK constraint failed: length(vector) = dimensions * 4',
            }),
        );
    });

    it('migrates an on-disk legacy database missing the table, preserving existing sessions and rollups', () => {
        const f = createTestDb('embedding-legacy-');
        const project = seedProject(f);
        const session = seedSession(f, { project, title: 'Legacy title' });
        seedRollup(f, { project, session, decisions: [{ what: 'Preserve history', why: 'Irrecoverable source' }] });
        // The prior released schema has these source rows and no vector table.
        f.db.exec('DROP TABLE session_embeddings');
        const before = f.db.prepare('SELECT * FROM session_rollups').all();
        expect(vectorTable(f.db)).toBeUndefined();
        f.close();
        const migrated = openUnmanagedDb(f.dbPath);
        try {
            expect(vectorTable(migrated)).toBeDefined();
            expect(migrated.prepare('SELECT * FROM session_rollups').all()).toEqual(before);
            expect(migrated.prepare('SELECT title FROM sessions WHERE id = ?').get(session.id)).toEqual({ title: 'Legacy title' });
            expect(migrated.prepare('SELECT * FROM session_embeddings').all()).toEqual([]);
            expect(migrated.pragma('foreign_key_check')).toEqual([]);
        } finally {
            migrated.close();
        }
    });

    it('reopens idempotently without changing the schema', () => {
        const dbPath = path.join(withTempDir('embedding-reopen-'), 'elepha.db');
        const first = openUnmanagedDb(dbPath);
        const schema = first.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
        first.close();
        const second = openUnmanagedDb(dbPath);
        try {
            expect(second.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all()).toEqual(schema);
            expect(second.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        } finally {
            second.close();
        }
    });
});
