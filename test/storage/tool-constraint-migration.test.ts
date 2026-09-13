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
    insert.run('retired-tool-a', 'legacy-retired-session-a', NOW, NOW);
    insert.run('retired-tool-b', 'legacy-retired-session-b', NOW, NOW);
    const insertShownList = prior.prepare(`INSERT INTO shown_session_lists (tool, native_session_id, session_ids) VALUES (?, ?, '[]')`);
    insertShownList.run('retired-tool-a', 'legacy-chat-a');
    insertShownList.run('retired-tool-b', 'legacy-chat-b');
    prior.close();
    return dbPath;
}

function tableSchema(db: Database.Database, table: 'sessions' | 'shown_session_lists'): string {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
}

function checkedTools(schema: string): string[] {
    const match = /CHECK \(tool IN \(([^)]+)\)\)/.exec(schema);
    if (match?.[1] === undefined) {
        throw new Error('tool CHECK missing from schema');
    }
    return match[1].split(',').map((literal) => literal.trim().slice(1, -1).replaceAll("''", "'"));
}

describe('tool CHECK migration', () => {
    it('opens a prior DB containing rows for tools this build no longer supports and retains both', () => {
        const db = openUnmanagedDb(createForwardToolDb());

        expect(db.prepare('SELECT tool, native_id FROM sessions ORDER BY tool').all()).toEqual([
            { tool: 'retired-tool-a', native_id: 'legacy-retired-session-a' },
            { tool: 'retired-tool-b', native_id: 'legacy-retired-session-b' },
        ]);
        expect(db.prepare('SELECT tool, native_session_id FROM shown_session_lists ORDER BY tool').all()).toEqual([
            { tool: 'retired-tool-a', native_session_id: 'legacy-chat-a' },
            { tool: 'retired-tool-b', native_session_id: 'legacy-chat-b' },
        ]);
        expect(checkedTools(tableSchema(db, 'sessions'))).toEqual([...SUPPORTED_TOOLS, 'retired-tool-a', 'retired-tool-b']);
        expect(checkedTools(tableSchema(db, 'shown_session_lists'))).toEqual([...SUPPORTED_TOOLS, 'retired-tool-a', 'retired-tool-b']);
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
                    VALUES ('unknown-tool', 'invalid-session', 1, '/provider/session', ?, ?)`)
                .run(NOW, NOW),
        ).toThrow(/CHECK/);
        expect(() =>
            db
                .prepare(`INSERT INTO shown_session_lists (tool, native_session_id, session_ids)
                    VALUES ('unknown-tool', 'invalid-chat', '[]')`)
                .run(),
        ).toThrow(/CHECK/);
        db.close();
    });

    it('creates a fresh DB with a CHECK covering every supported tool', () => {
        const db = openUnmanagedDb(':memory:');
        expect(checkedTools(tableSchema(db, 'sessions'))).toEqual(SUPPORTED_TOOLS);
        expect(checkedTools(tableSchema(db, 'shown_session_lists'))).toEqual(SUPPORTED_TOOLS);
        db.close();
    });

    it('reopens the forward-compatible migrated schema idempotently', () => {
        const dbPath = createForwardToolDb();
        const migrated = openUnmanagedDb(dbPath);
        const sessionsSchema = tableSchema(migrated, 'sessions');
        const shownListsSchema = tableSchema(migrated, 'shown_session_lists');
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(tableSchema(reopened, 'sessions')).toBe(sessionsSchema);
        expect(tableSchema(reopened, 'shown_session_lists')).toBe(shownListsSchema);
        expect(reopened.prepare('SELECT tool, native_id FROM sessions ORDER BY tool').all()).toEqual([
            { tool: 'retired-tool-a', native_id: 'legacy-retired-session-a' },
            { tool: 'retired-tool-b', native_id: 'legacy-retired-session-b' },
        ]);
        expect(reopened.prepare('SELECT tool, native_session_id FROM shown_session_lists ORDER BY tool').all()).toEqual([
            { tool: 'retired-tool-a', native_session_id: 'legacy-chat-a' },
            { tool: 'retired-tool-b', native_session_id: 'legacy-chat-b' },
        ]);
        reopened.close();
    });
});
