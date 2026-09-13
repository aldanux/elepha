import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { readProjectSessionAggregates, readProjectSessions, readSessionById } from '../../src/storage/session-read-model.js';
import { SUPPORTED_TOOLS } from '../../src/types/index.js';
import { withTempDir } from '../helpers/tmp.js';

const NOW = '2026-09-12T00:00:00.000Z';

function createForwardToolDb(): string {
    const dbPath = path.join(withTempDir('forward-tool-migration-'), 'memory.db');
    const prior = new Database(dbPath);
    prior.exec(readFileSync(path.resolve('test/fixtures/forward-tool-prior-schema.sql'), 'utf8'));
    prior.prepare('INSERT INTO projects (id, path, first_seen_at, last_seen_at) VALUES (1, ?, ?, ?)').run('/project', NOW, NOW);
    const insert = prior.prepare(`INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
        VALUES (?, ?, 1, '/provider/session', ?, ?)`);
    insert.run('retired-tool', 'legacy-retired-session', NOW, NOW);
    insert.run('unknown-tool', 'foreign-session', NOW, NOW);
    prior.close();
    return dbPath;
}

function sessionsSchema(db: Database.Database): string {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() as { sql: string }).sql;
}

describe('sessions tool CHECK migration', () => {
    it('opens a prior DB containing rows for tools this build no longer supports and retains both', () => {
        const db = openUnmanagedDb(createForwardToolDb());

        expect(db.prepare('SELECT tool, native_id FROM sessions ORDER BY tool').all()).toEqual([
            { tool: 'retired-tool', native_id: 'legacy-retired-session' },
            { tool: 'unknown-tool', native_id: 'foreign-session' },
        ]);
        expect(SUPPORTED_TOOLS).not.toContain('retired-tool');
        expect(sessionsSchema(db)).toContain("'retired-tool'");
        expect(sessionsSchema(db)).toContain("'unknown-tool'");
        expect(readProjectSessions(db, [1])).toEqual([]);
        expect(readProjectSessionAggregates(db, [1])).toEqual([]);
        expect(readSessionById(db, 1)).toBeUndefined();
        expect(readSessionById(db, 2)).toBeUndefined();
        db.close();
    });

    it('still rejects a tool that is neither supported nor present before migration', () => {
        const db = openUnmanagedDb(createForwardToolDb());

        expect(() =>
            db
                .prepare(`INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
                    VALUES ('invalid-tool', 'invalid-session', 1, '/provider/session', ?, ?)`)
                .run(NOW, NOW),
        ).toThrow(/CHECK/);
        db.close();
    });

    it('creates a fresh DB with a CHECK covering every supported tool', () => {
        const db = openUnmanagedDb(':memory:');
        const schema = sessionsSchema(db);

        for (const tool of SUPPORTED_TOOLS) {
            expect(schema).toContain(`'${tool}'`);
        }
        db.close();
    });

    it('reopens the forward-compatible migrated schema idempotently', () => {
        const dbPath = createForwardToolDb();
        const migrated = openUnmanagedDb(dbPath);
        const schema = sessionsSchema(migrated);
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(sessionsSchema(reopened)).toBe(schema);
        expect(reopened.prepare('SELECT tool, native_id FROM sessions ORDER BY tool').all()).toEqual([
            { tool: 'retired-tool', native_id: 'legacy-retired-session' },
            { tool: 'unknown-tool', native_id: 'foreign-session' },
        ]);
        reopened.close();
    });
});
