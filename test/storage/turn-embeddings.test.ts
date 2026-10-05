import path from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { LIVE_MEMORY_TRIGGER_NAMES } from '../../src/storage/live-memory-usage.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import {
    TURN_EMBEDDING_REFRESH_STATE_TABLE,
    TURN_EMBEDDINGS_REINDEX_TRIGGER,
    TURN_EMBEDDINGS_TABLE,
} from '../../src/storage/turn-embeddings.js';
import { TURN_SEARCH_CLEANUP_TRIGGER, TURN_SEARCH_INDEX_TABLE } from '../../src/storage/turn-search-index.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const PROJECT = '/Users/test/turn-vector-project';
const OTHER_PROJECT = '/Users/test/turn-vector-other';
const summary = { decisions: [], pending_items: [], status: 'not_configured' as const };

function turn(overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'turn-vector-session',
        sourcePath: `${PROJECT}/session.jsonl`,
        projectPath: PROJECT,
        turnIndex: 0,
        startedAt: '2026-09-27T00:00:00.000Z',
        endedAt: '2026-09-27T00:00:01.000Z',
        userMessage: 'where does the configuration live',
        assistantText: 'the settings module owns it',
        toolCalls: [],
        cursor: '100:1:abc',
        hasExternalContent: false,
        resumeMarkerBefore: false,
        ...overrides,
    };
}

function approvedStore(): MemoryStore {
    const store = new MemoryStore(openUnmanagedDb(':memory:'), { resolveGitRoot: () => null, resolveGitRemote: () => null });
    store.consent.grant(PROJECT);
    store.consent.grant(OTHER_PROJECT);
    return store;
}

function ingest(store: MemoryStore, parsed: ParsedTurn): number {
    expect(store.recordIngestedTurn(parsed, {}, false, summary, true)?.inserted).toBe(true);
    const row = store.database
        .prepare('SELECT m.id FROM memories m JOIN sessions s ON s.id = m.session_id WHERE s.native_id = ? AND m.turn_index = ?')
        .get(parsed.sessionId, parsed.turnIndex) as { id: number };
    return row.id;
}

function storeVector(db: Database.Database, memoryId: number, dimensions = 4): void {
    const source = db
        .prepare(
            `SELECT m.project_id, t.source_digest FROM memories m JOIN ${TURN_SEARCH_INDEX_TABLE} t ON t.memory_id = m.id WHERE m.id = ?`,
        )
        .get(memoryId) as { project_id: number; source_digest: string };
    db.prepare(
        `INSERT INTO ${TURN_EMBEDDINGS_TABLE}
           (memory_id, project_id, source_digest, text_hash, model, model_revision, dimensions, vector, computed_at)
         VALUES (?, ?, ?, 'text-hash', 'model', 'revision', ?, ?, '2026-09-27T00:00:00.000Z')`,
    ).run(memoryId, source.project_id, source.source_digest, dimensions, Buffer.alloc(dimensions * 4));
}

function vectorIds(db: Database.Database): number[] {
    return (db.prepare(`SELECT memory_id FROM ${TURN_EMBEDDINGS_TABLE} ORDER BY memory_id`).all() as Array<{ memory_id: number }>).map(
        (row) => row.memory_id,
    );
}

function vectorSchema(db: Database.Database): Array<Record<string, unknown>> {
    return db
        .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN (?, ?) OR tbl_name = ? ORDER BY type, name')
        .all(TURN_EMBEDDINGS_TABLE, TURN_EMBEDDINGS_REINDEX_TRIGGER, TURN_EMBEDDINGS_TABLE) as Array<Record<string, unknown>>;
}

describe('turn vector schema', () => {
    it('creates the refresh cursor on fresh and prior databases and reopens idempotently', () => {
        const fresh = openUnmanagedDb(':memory:');
        expect(
            (
                fresh.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(TURN_EMBEDDING_REFRESH_STATE_TABLE) as Array<{
                    name: string;
                }>
            ).map((column) => column.name),
        ).toEqual([
            'id',
            'before_memory_id',
            'model',
            'model_revision',
            'dimensions',
            'authority_hash',
            'authority_epoch',
            'sweep_issue_hash',
            'sweep_unavailable',
            'sweep_changed',
            'sweep_failed',
            'last_reported_issue_hash',
        ]);
        fresh.close();

        const directory = withGrantableTestDir('elepha-turn-refresh-migration-');
        const databasePath = path.join(directory, 'prior.db');
        const prior = openUnmanagedDb(databasePath);
        prior.exec(`
          DROP TRIGGER turn_embedding_refresh_consent_ai;
          DROP TRIGGER turn_embedding_refresh_consent_au;
          DROP TRIGGER turn_embedding_refresh_consent_ad;
          DROP TRIGGER turn_embedding_refresh_project_ai;
          DROP TRIGGER turn_embedding_refresh_project_au;
          DROP TRIGGER turn_embedding_refresh_project_ad;
          DROP TABLE ${TURN_EMBEDDING_REFRESH_STATE_TABLE};
        `);
        prior.close();

        const migrated = openUnmanagedDb(databasePath);
        const schema = migrated
            .prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'turn_embedding_refresh_%' ORDER BY type, name")
            .all();
        expect(schema).toHaveLength(7);
        expect(migrated.prepare(`SELECT * FROM ${TURN_EMBEDDING_REFRESH_STATE_TABLE}`).all()).toEqual([]);
        migrated.close();

        const reopened = openUnmanagedDb(databasePath);
        try {
            expect(
                reopened
                    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'turn_embedding_refresh_%' ORDER BY type, name")
                    .all(),
            ).toEqual(schema);
            expect(reopened.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        } finally {
            reopened.close();
        }
    });

    it('keys vectors by search coverage, cascades from coverage and project, and stores no turn prose', () => {
        const db = openUnmanagedDb(':memory:');
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(
            (db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(TURN_EMBEDDINGS_TABLE) as Array<{ name: string }>).map(
                (column) => column.name,
            ),
        ).toEqual([
            'memory_id',
            'project_id',
            'source_digest',
            'text_hash',
            'model',
            'model_revision',
            'dimensions',
            'vector',
            'computed_at',
        ]);
        expect(db.pragma(`foreign_key_list(${TURN_EMBEDDINGS_TABLE})`)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ table: TURN_SEARCH_INDEX_TABLE, from: 'memory_id', to: 'memory_id', on_delete: 'CASCADE' }),
                expect.objectContaining({ table: 'projects', from: 'project_id', to: 'id', on_delete: 'CASCADE' }),
            ]),
        );
        db.close();
    });

    it('rejects a vector without search coverage and a vector whose bytes disagree with its dimensions', () => {
        const store = approvedStore();
        const db = store.database;
        const memoryId = ingest(store, turn());
        const insert = db.prepare(
            `INSERT INTO ${TURN_EMBEDDINGS_TABLE}
               (memory_id, project_id, source_digest, text_hash, model, model_revision, dimensions, vector, computed_at)
             VALUES (?, (SELECT project_id FROM memories WHERE id = ?), 'digest', 'hash', 'model', 'revision', ?, ?, 'now')`,
        );

        expect(() => insert.run(memoryId + 1000, memoryId, 4, Buffer.alloc(16))).toThrow(
            expect.objectContaining({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }),
        );
        expect(() => insert.run(memoryId, memoryId, 4, Buffer.alloc(15))).toThrow(
            expect.objectContaining({ code: 'SQLITE_CONSTRAINT_CHECK' }),
        );
        expect(() => insert.run(memoryId, memoryId, 4, 'x'.repeat(16))).toThrow(
            expect.objectContaining({ code: 'SQLITE_CONSTRAINT_CHECK' }),
        );
        expect(() => insert.run(memoryId, memoryId, 0, Buffer.alloc(0))).toThrow(
            expect.objectContaining({ code: 'SQLITE_CONSTRAINT_CHECK' }),
        );
        expect(vectorIds(db)).toEqual([]);
        insert.run(memoryId, memoryId, 4, Buffer.alloc(16));
        expect(vectorIds(db)).toEqual([memoryId]);
    });

    it.each([
        ['a database without turn search or turn vectors', true],
        ['a database with turn search but without turn vectors', false],
    ])('migrates %s without inventing vectors and reopens idempotently', (_label, dropSearchIndex) => {
        const directory = withGrantableTestDir('elepha-turn-vector-migration-');
        const dbPath = path.join(directory, 'legacy.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec(`DROP TRIGGER ${TURN_EMBEDDINGS_REINDEX_TRIGGER};`);
        prior.exec(`DROP TABLE ${TURN_EMBEDDINGS_TABLE};`);
        if (dropSearchIndex) {
            prior.exec(`
              DROP TRIGGER ${TURN_SEARCH_CLEANUP_TRIGGER};
              DROP TABLE ${TURN_SEARCH_INDEX_TABLE};
            `);
        }
        prior.exec(`
          INSERT INTO projects (path, first_seen_at, last_seen_at) VALUES ('/legacy', '2026-01-01', '2026-01-01');
          INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
          VALUES ('codex', 'legacy', 1, '/legacy.jsonl', '2026-01-01', '2026-01-01');
          INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
          VALUES (1, 1, 0, 'codex', '2026-01-01', '[]', '[]', '[]', '2026-01-01');
        `);
        expect(vectorSchema(prior)).toEqual([]);
        const memoriesBefore = prior.prepare('SELECT * FROM memories').all();
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        const schema = vectorSchema(migrated);
        // The live-memory ledger charges each vector through its own triggers.
        const ledgerTriggers = LIVE_MEMORY_TRIGGER_NAMES.filter((name) => name.startsWith(`live_memory_${TURN_EMBEDDINGS_TABLE}_`));
        expect(ledgerTriggers).toHaveLength(3);
        expect(schema.map((row) => [row.type, row.name])).toEqual([
            ['index', 'idx_turn_embeddings_project'],
            ['table', TURN_EMBEDDINGS_TABLE],
            ...ledgerTriggers.map((name) => ['trigger', name]).sort(),
            ['trigger', TURN_EMBEDDINGS_REINDEX_TRIGGER],
        ]);
        expect(vectorIds(migrated)).toEqual([]);
        expect(migrated.prepare('SELECT * FROM memories').all()).toEqual(memoriesBefore);
        expect(migrated.pragma('foreign_key_check')).toEqual([]);
        const fullSchema = migrated.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        try {
            expect(reopened.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all()).toEqual(fullSchema);
            expect(vectorSchema(reopened)).toEqual(schema);
            expect(reopened.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        } finally {
            reopened.close();
        }
    });
});

describe('turn vector withdrawal', () => {
    it('invalidates a vector when reingest replaces its indexed source turn', () => {
        const store = approvedStore();
        const original = turn();
        const memoryId = ingest(store, original);
        storeVector(store.database, memoryId);
        const session = store.database
            .prepare('SELECT id, project_id FROM sessions WHERE tool = ? AND native_id = ?')
            .get(original.tool, original.sessionId) as { id: number; project_id: number };

        expect(
            store.reingestTurn(turn({ userMessage: 'replacement configuration question' }), session.id, session.project_id, summary),
        ).toBe(true);

        expect(vectorIds(store.database)).toEqual([]);
        expect(store.database.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toEqual({ id: memoryId });
    });

    it('removes the vector when its memory row is deleted directly', () => {
        const store = approvedStore();
        const removed = ingest(store, turn());
        const kept = ingest(store, turn({ turnIndex: 1, cursor: '200:2:def' }));
        storeVector(store.database, removed);
        storeVector(store.database, kept);

        store.database.prepare('DELETE FROM memories WHERE id = ?').run(removed);

        expect(vectorIds(store.database)).toEqual([kept]);
    });

    it('removes the vectors of purged sessions and keeps other projects', () => {
        const store = approvedStore();
        const purged = ingest(store, turn());
        const kept = ingest(
            store,
            turn({ sessionId: 'other-session', projectPath: OTHER_PROJECT, sourcePath: `${OTHER_PROJECT}/s.jsonl` }),
        );
        storeVector(store.database, purged);
        storeVector(store.database, kept);

        store.purge({ projectIds: [store.upsertProject(PROJECT).id] });

        expect(vectorIds(store.database)).toEqual([kept]);
    });

    it('removes the vectors of an incognito transcript while retaining its memory rows', () => {
        const store = approvedStore();
        const other = ingest(store, turn({ sessionId: 'other-session' }));
        const incognito = ingest(store, turn());
        storeVector(store.database, other);
        storeVector(store.database, incognito);

        store.recordIncognitoTranscript('codex', 'turn-vector-session');

        expect(store.database.prepare('SELECT id FROM memories ORDER BY id').all()).toEqual([{ id: other }, { id: incognito }]);
        expect(vectorIds(store.database)).toEqual([other]);
    });

    it('removes the revoked project vectors immediately while keeping its memories and other projects', () => {
        const store = approvedStore();
        const revoked = ingest(store, turn());
        const kept = ingest(
            store,
            turn({ sessionId: 'other-session', projectPath: OTHER_PROJECT, sourcePath: `${OTHER_PROJECT}/s.jsonl` }),
        );
        storeVector(store.database, revoked);
        storeVector(store.database, kept);

        store.consent.revoke(PROJECT);

        expect(vectorIds(store.database)).toEqual([kept]);
        expect(store.database.prepare('SELECT id FROM memories ORDER BY id').all()).toEqual([{ id: revoked }, { id: kept }]);
        expect(store.database.prepare(`SELECT memory_id FROM ${TURN_SEARCH_INDEX_TABLE} ORDER BY memory_id`).all()).toEqual([
            { memory_id: revoked },
            { memory_id: kept },
        ]);
    });

    it('removes vectors that lose their only grant when the consent root is removed', () => {
        const store = approvedStore();
        const removed = ingest(store, turn());
        const kept = ingest(
            store,
            turn({ sessionId: 'other-session', projectPath: OTHER_PROJECT, sourcePath: `${OTHER_PROJECT}/s.jsonl` }),
        );
        storeVector(store.database, removed);
        storeVector(store.database, kept);
        const root = store.consent.list().find((candidate) => candidate.path === PROJECT);

        expect(store.consent.remove(root?.ulid ?? '')).toBe(true);

        expect(vectorIds(store.database)).toEqual([kept]);
    });
});
