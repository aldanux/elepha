import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import {
    TASK_STATE_MANIFEST_PROJECTION_ENCODING,
    type TaskStateManifestInput,
    type TaskStateManifestSourceLocator,
    TaskStateManifestStore,
} from '../../src/storage/task-state-manifest-store.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const time = '2026-09-28T00:00:00.000Z';
const digest = 'a'.repeat(64);

function seedMemory(db: Database.Database): void {
    db.prepare('INSERT INTO projects (id, path, first_seen_at, last_seen_at) VALUES (1, ?, ?, ?)').run('/legacy', time, time);
    db.prepare(
        `INSERT INTO sessions (id, tool, native_id, project_id, source_path, started_at, last_ingested_at)
         VALUES (1, 'codex', 'chat', 1, '/legacy/chat.jsonl', ?, ?)`,
    ).run(time, time);
    db.prepare(
        `INSERT INTO memories (id, project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched,
                              pending_items, created_at)
         VALUES (1, 1, 1, 0, 'codex', ?, '[]', '[]', '[]', ?)`,
    ).run(time, time);
}

function input(): TaskStateManifestInput {
    const quote = 'Please keep `history`';
    const locator: TaskStateManifestSourceLocator = {
        section: 'objective',
        itemIndex: 0,
        quoteIndex: 0,
        sourceMemoryId: 1,
        sourceSessionId: 1,
        sourceTurnIndex: 0,
        sourceGeneration: 0,
        sourceDigest: digest,
        role: 'user',
        projectionEncoding: TASK_STATE_MANIFEST_PROJECTION_ENCODING,
        evidenceSource: 'transcript',
        start: 0,
        end: quote.length + 2,
    };
    return {
        memoryId: 1,
        report: {
            mode: 'precompact_manifest',
            request_id: '01J00000000000000000000000',
            objective: { text: 'Retain `history`', sources: [{ role: 'user', quote }] },
            decisions: [],
            constraints: [],
            pending_items: [],
        },
        reportingSource: { sessionId: 1, turnIndex: 0, sourceGeneration: 0, sourceDigest: digest },
        sourceLocators: [locator],
        coverage: { state: 'verified', resolvedSourceCount: 1, totalSourceCount: 1 },
        createdAt: time,
    };
}

describe('task-state manifest schema', () => {
    it('creates the child table in a fresh database and cascades with its reporting memory', () => {
        const db = openUnmanagedDb(':memory:');
        seedMemory(db);
        const store = new TaskStateManifestStore(db);
        expect(store.insert(input())).toBe('inserted');
        db.prepare('DELETE FROM memories WHERE id = 1').run();
        expect(store.get(1)).toBeUndefined();
        expect(db.pragma('foreign_key_check')).toEqual([]);
        db.close();
    });

    it('migrates a populated prior database and leaves both legacy and new rows intact on reopen', () => {
        const directory = withGrantableTestDir('elepha-task-state-manifest-migration-');
        const dbPath = path.join(directory, 'prior.db');
        const prior = new Database(dbPath);
        prior.exec(`
            CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
            CREATE TABLE sessions (
                id INTEGER PRIMARY KEY, tool TEXT NOT NULL, native_id TEXT NOT NULL, project_id INTEGER NOT NULL REFERENCES projects(id),
                source_path TEXT NOT NULL, cursor TEXT, started_at TEXT NOT NULL, last_ingested_at TEXT NOT NULL,
                UNIQUE (tool, native_id)
            );
            CREATE TABLE memories (
                id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), session_id INTEGER NOT NULL REFERENCES sessions(id),
                turn_index INTEGER NOT NULL, tool TEXT NOT NULL, turn_started_at TEXT NOT NULL, decisions TEXT NOT NULL,
                files_touched TEXT NOT NULL, pending_items TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (session_id, turn_index)
            );
        `);
        seedMemory(prior);
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        const store = new TaskStateManifestStore(migrated);
        expect(store.get(1)).toBeUndefined();
        expect(store.insert(input())).toBe('inserted');
        expect(migrated.pragma('foreign_key_check')).toEqual([]);
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        const retained = new TaskStateManifestStore(reopened).get(1);
        expect(retained?.report.objective?.text).toContain('history');
        expect(retained?.sourceLocators).toHaveLength(1);
        expect(retained?.sourceLocators[0]).toMatchObject({
            projectionEncoding: TASK_STATE_MANIFEST_PROJECTION_ENCODING,
            evidenceSource: 'transcript',
            start: 0,
            end: retained?.report.objective?.sources[0]?.quote.length,
        });
        expect(reopened.prepare('SELECT id FROM memories').all()).toEqual([{ id: 1 }]);
        expect(reopened.pragma('foreign_key_check')).toEqual([]);
        reopened.close();
    });
});

describe('task-state manifest store', () => {
    it('sanitizes transcript text on write and preserves explicit source coverage', () => {
        const db = openUnmanagedDb(':memory:');
        seedMemory(db);
        const store = new TaskStateManifestStore(db);
        const report = input();
        report.coverage = { state: 'incomplete', resolvedSourceCount: 0, totalSourceCount: 1, reason: 'source `missing`' };
        report.sourceLocators = [];
        expect(store.insert(report)).toBe('inserted');
        const stored = store.get(1);
        expect(detectShellSyntax(stored?.report.objective?.text ?? '')).toBe(false);
        expect(detectShellSyntax(stored?.report.objective?.sources[0]?.quote ?? '')).toBe(false);
        expect(stored?.coverage).toMatchObject({ state: 'incomplete', resolvedSourceCount: 0, totalSourceCount: 1 });
        expect(store.delete(1)).toBe(true);
        expect(store.get(1)).toBeUndefined();
        db.close();
    });

    it('rejects false complete coverage and conflicting duplicates without overwriting the first row', () => {
        const db = openUnmanagedDb(':memory:');
        seedMemory(db);
        const store = new TaskStateManifestStore(db);
        const report = input();
        expect(() => store.insert({ ...report, sourceLocators: [] })).toThrow('coverage');
        expect(() => store.insert({ ...report, reportingSource: { ...report.reportingSource, turnIndex: 1 } })).toThrow('does not match');
        expect(store.insert(report)).toBe('inserted');
        expect(store.insert({ ...report, createdAt: '2026-09-28T01:00:00.000Z' })).toBe('already-present');
        const conflict = input();
        conflict.report.objective!.text = 'A different objective';
        expect(() => store.insert(conflict)).toThrow('Conflicting');
        expect(store.get(1)?.report.objective?.text).toContain('history');
        db.close();
    });

    it('keeps a zero-claim precompact report explicitly incomplete', () => {
        const db = openUnmanagedDb(':memory:');
        seedMemory(db);
        const store = new TaskStateManifestStore(db);
        const empty = input();
        empty.report = {
            mode: 'precompact_manifest',
            request_id: '01J00000000000000000000000',
            objective: null,
            decisions: [],
            constraints: [],
            pending_items: [],
        };
        empty.sourceLocators = [];
        empty.coverage = { state: 'verified', resolvedSourceCount: 0, totalSourceCount: 0 };
        expect(() => store.insert(empty)).toThrow('verification state');
        expect(store.get(1)).toBeUndefined();
        empty.coverage = { state: 'incomplete', resolvedSourceCount: 0, totalSourceCount: 0, reason: 'no claims to verify' };
        expect(store.insert(empty)).toBe('inserted');
        expect(store.get(1)?.coverage).toEqual(empty.coverage);
        db.close();
    });

    it('rolls back an enclosing transaction when a duplicate conflicts', () => {
        const db = openUnmanagedDb(':memory:');
        seedMemory(db);
        const store = new TaskStateManifestStore(db);
        expect(() =>
            db.transaction(() => {
                store.insert(input());
                const conflict = input();
                conflict.report.objective!.text = 'Conflict';
                store.insert(conflict);
            })(),
        ).toThrow('Conflicting');
        expect(store.get(1)).toBeUndefined();
        db.close();
    });
});
