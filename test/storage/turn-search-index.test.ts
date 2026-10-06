import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { SESSION_CHAR_BUDGET, TURN_SEARCH_INDEX_MAX_FIELD_CHARS } from '../../src/config/constants.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { applySanitize } from '../../src/storage/sanitize-backfill.js';
import { SourceReconciliation } from '../../src/storage/source-reconciliation.js';
import { sourceTurnDigest } from '../../src/storage/source-turn-digest.js';
import { TURN_EMBEDDINGS_TABLE } from '../../src/storage/turn-embeddings.js';
import {
    RETIRED_TURN_SEARCH_SCHEMA_ERROR,
    RETIRED_TURN_SEARCH_STATE_TABLE,
    RetiredTurnSearchSchemaError,
    TURN_SEARCH_CLEANUP_TRIGGER,
    TURN_SEARCH_COPY_CLEANUP_TRIGGER,
    TURN_SEARCH_INDEX_TABLE,
} from '../../src/storage/turn-search-index.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { createTestDb, type TestDatabase } from '../helpers/db.js';
import { NONCANONICAL_RETIRED_SETS, retiredTurnSearchObjects, seedRetiredTurnSearchSchema } from '../helpers/retired-turn-search.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const summary = { decisions: [], pending_items: [], status: 'not_configured' as const };

interface Fixture extends TestDatabase {
    cwd: string;
    sourcePath: string;
}

function fixture(): Fixture {
    const f = createTestDb('elepha-turn-search-');
    const cwd = path.join(f.directory, 'checkout');
    mkdirSync(cwd);
    f.store.consent.grant(cwd);
    return { ...f, cwd, sourcePath: path.join(f.directory, 'rollout.jsonl') };
}

function turn(f: Fixture, overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'turn-search-session',
        sourcePath: f.sourcePath,
        projectPath: f.cwd,
        turnIndex: 0,
        startedAt: '2026-09-27T00:00:00.000Z',
        endedAt: '2026-09-27T00:00:01.000Z',
        userMessage: 'where does zebracorn configuration live',
        assistantText: 'the quokkafig module owns it',
        toolCalls: [],
        cursor: '100:1:abc',
        hasExternalContent: false,
        resumeMarkerBefore: false,
        ...overrides,
    };
}

function memoryIdFor(db: Database.Database, parsed: ParsedTurn): number {
    const row = db
        .prepare('SELECT m.id FROM memories m JOIN sessions s ON s.id = m.session_id WHERE s.native_id = ? AND m.turn_index = ?')
        .get(parsed.sessionId, parsed.turnIndex) as { id: number };
    return row.id;
}

function markLegacyEvicted(f: Fixture): void {
    f.db
        .prepare(
            `INSERT INTO durable_capture_status (session_id, state, filter_version, updated_at)
         SELECT id, 'evicted', 1, '2026-09-01T00:00:00.000Z' FROM sessions WHERE true
         ON CONFLICT (session_id) DO UPDATE SET state = 'evicted'`,
        )
        .run();
}

function ingest(f: Fixture, parsed: ParsedTurn, options: { capture?: boolean } = {}): number {
    const written = f.store.recordIngestedTurn(parsed, {}, false, summary, options.capture ?? true);
    expect(written?.inserted).toBe(true);
    return memoryIdFor(f.db, parsed);
}

function reingest(f: Fixture, parsed: ParsedTurn, options: { capture?: boolean } = {}): void {
    const session = f.store.findSession(parsed.tool, parsed.sessionId);
    if (session === undefined) {
        throw new Error('session missing');
    }
    expect(f.store.reingestTurn(parsed, session.id, session.project_id, summary, false, options.capture ?? true)).toBe(true);
}

function sessionIdFor(db: Database.Database, nativeId: string): number {
    return (db.prepare('SELECT id FROM sessions WHERE native_id = ?').get(nativeId) as { id: number }).id;
}

// Lexical matches through the production stored-content path
// (filtered_turns_fts via the session reader), by matching session id.
function search(db: Database.Database, query: string): number[] {
    const sessions = db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: number }>;
    const recall = new SessionReader(db).storedContentRecallFor(sessions, [query], 50, () => true);
    return [...recall.matches.keys()].sort((a, b) => a - b);
}

// Stored turns with no retained current copy. A miss over sessions with gaps
// is inconclusive, unlike an empty history.
function coverageGaps(db: Database.Database): number {
    return (
        db
            .prepare(
                `SELECT COUNT(*) AS count FROM memories m
                 WHERE NOT EXISTS (SELECT 1 FROM ${TURN_SEARCH_INDEX_TABLE} tsi WHERE tsi.memory_id = m.id)`,
            )
            .get() as { count: number }
    ).count;
}

function coverageRows(db: Database.Database): Array<Record<string, unknown>> {
    return db.prepare(`SELECT * FROM ${TURN_SEARCH_INDEX_TABLE} ORDER BY memory_id`).all() as Array<Record<string, unknown>>;
}

async function evidence(f: Fixture, parsed: ParsedTurn) {
    const session = f.store.findSession(parsed.tool, parsed.sessionId);
    if (session === undefined) {
        throw new Error('session missing');
    }
    return new SessionReader(f.db).indexedTurnEvidence({ ...session, expectedProjectPath: f.cwd }, parsed.turnIndex);
}

function indexSchema(db: Database.Database): Array<Record<string, unknown>> {
    return db
        .prepare(
            `SELECT type, name, tbl_name, sql FROM sqlite_master
             WHERE name GLOB 'turn_search_*' OR name IN (?, ?) ORDER BY type, name`,
        )
        .all(TURN_SEARCH_CLEANUP_TRIGGER, TURN_SEARCH_COPY_CLEANUP_TRIGGER) as Array<Record<string, unknown>>;
}

describe('turn search index schema', () => {
    it('keeps per-turn coverage as the only turn search object beside filtered_turns_fts', () => {
        const db = openUnmanagedDb(':memory:');
        expect(retiredTurnSearchObjects(db)).toEqual([]);
        expect(indexSchema(db).map((row) => [row.type, row.name, row.tbl_name])).toEqual(
            expect.arrayContaining([
                ['table', TURN_SEARCH_INDEX_TABLE, TURN_SEARCH_INDEX_TABLE],
                ['trigger', TURN_SEARCH_COPY_CLEANUP_TRIGGER, 'filtered_turns'],
                ['trigger', TURN_SEARCH_CLEANUP_TRIGGER, 'memories'],
            ]),
        );
        db.close();
    });

    it('adds the index to a prior database without indexing its memories and reopens idempotently', () => {
        const directory = withGrantableTestDir('elepha-turn-search-migration-');
        const dbPath = path.join(directory, 'legacy.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec(`
          DROP TRIGGER ${TURN_SEARCH_COPY_CLEANUP_TRIGGER};
          DROP TRIGGER ${TURN_SEARCH_CLEANUP_TRIGGER};
          DROP TABLE ${TURN_SEARCH_INDEX_TABLE};
          INSERT INTO projects (path, first_seen_at, last_seen_at) VALUES ('/legacy', '2026-01-01', '2026-01-01');
          INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
          VALUES ('codex', 'legacy', 1, '/legacy.jsonl', '2026-01-01', '2026-01-01');
          INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
          VALUES (1, 1, 0, 'codex', '2026-01-01', '[]', '[]', '[]', '2026-01-01');
        `);
        expect(indexSchema(prior)).toEqual([]);
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        const schema = indexSchema(migrated);
        const fresh = openUnmanagedDb(':memory:');
        expect(schema).toEqual(indexSchema(fresh));
        fresh.close();
        expect(retiredTurnSearchObjects(migrated)).toEqual([]);
        // A legacy memory has no coverage row: never indexed, not "empty".
        expect(coverageRows(migrated)).toEqual([]);
        expect(search(migrated, 'anything')).toEqual([]);
        expect(coverageGaps(migrated)).toBe(1);
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(indexSchema(reopened)).toEqual(schema);
        reopened.close();
    });
});

describe('turn search index writes', () => {
    it('serves a retained turn from search and stored evidence after its provider transcript disappears', async () => {
        const f = fixture();
        writeFileSync(f.sourcePath, '{}\n');
        const parsed = turn(f, {
            userMessage: 'where does zebracorn configuration live <oai-mem-citation>citationsecret</oai-mem-citation>',
        });
        const memoryId = ingest(f, parsed);
        const sessionId = sessionIdFor(f.db, parsed.sessionId);
        const before = { user: search(f.db, 'zebracorn'), assistant: search(f.db, 'quokkafig') };
        rmSync(f.sourcePath);

        expect(before).toEqual({ user: [sessionId], assistant: [sessionId] });
        expect({ user: search(f.db, 'zebracorn'), assistant: search(f.db, 'quokkafig') }).toEqual(before);
        expect(search(f.db, 'citationsecret')).toEqual([]);
        expect(coverageGaps(f.db)).toBe(0);
        expect(coverageRows(f.db)).toEqual([
            expect.objectContaining({
                memory_id: memoryId,
                coverage: 'included',
                locator: 'available',
                source_cursor: parsed.cursor,
                source_digest: sourceTurnDigest(parsed),
                omitted_user_chars: 0,
                omitted_assistant_chars: 0,
            }),
        ]);
        expect(await evidence(f, parsed)).toMatchObject({
            state: 'available',
            source: 'durable',
            projection: { assistantResponse: 'the quokkafig module owns it' },
        });
    });

    it('leaves no coverage when capture is off, and reports the turn as a gap rather than an empty history', async () => {
        const empty = fixture();
        expect(search(empty.db, 'zebracorn')).toEqual([]);
        expect(coverageGaps(empty.db)).toBe(0);

        const f = fixture();
        const parsed = turn(f);
        const memoryId = ingest(f, parsed, { capture: false });

        expect(search(f.db, 'zebracorn OR quokkafig')).toEqual([]);
        expect(coverageGaps(f.db)).toBe(1);
        expect(coverageRows(f.db)).toEqual([]);
        expect(f.db.prepare('SELECT id FROM memories').all()).toEqual([{ id: memoryId }]);
        expect(await evidence(f, parsed)).toEqual({ state: 'unavailable', reason: 'indexed_turn_evidence_missing' });
    });

    // The retired per-copy size limit left sessions in the terminal 'evicted'
    // state; those sessions keep refusing new copies.
    it('leaves no coverage when a legacy eviction refuses the copy', async () => {
        const f = fixture();
        ingest(f, turn(f, { turnIndex: 0, userMessage: 'first turn', assistantText: 'first answer', cursor: '50:0:abc' }), {
            capture: false,
        });
        markLegacyEvicted(f);
        const parsed = turn(f, { turnIndex: 1, cursor: '200:2:def' });
        ingest(f, parsed);

        expect(f.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
        expect(search(f.db, 'zebracorn OR quokkafig')).toEqual([]);
        expect(coverageGaps(f.db)).toBe(2);
        expect(await evidence(f, parsed)).toEqual({ state: 'unavailable', reason: 'indexed_turn_evidence_evicted' });
    });

    it('rolls back the memory, copy, and coverage together when the write transaction fails', () => {
        const f = fixture();
        const parsed = turn(f);
        const project = f.store.upsertProject(f.cwd);
        const session = f.store.upsertSession(parsed.tool, parsed.sessionId, project.id, parsed.sourcePath);

        expect(() =>
            f.db.transaction(() => {
                f.store.recordTurn(parsed, session.id, project.id, summary, true);
                throw new Error('simulated write failure');
            })(),
        ).toThrow('simulated write failure');

        expect(f.db.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
        expect(f.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
        expect(coverageRows(f.db)).toEqual([]);
        expect(search(f.db, 'zebracorn')).toEqual([]);
    });

    it('records an explicitly paused turn as excluded coverage without matches or a gap', () => {
        const f = fixture();
        const memoryId = ingest(f, turn(f, { userMessage: "don't do anything yet, zebracorn", assistantText: 'understood' }));

        expect(search(f.db, 'zebracorn OR understood')).toEqual([]);
        expect(coverageGaps(f.db)).toBe(0);
        expect(coverageRows(f.db)).toEqual([expect.objectContaining({ memory_id: memoryId, coverage: 'excluded' })]);
    });

    it('records the bounded projection of an oversized field as truncated coverage with its omitted length', () => {
        const f = fixture();
        const filler = 'filler '.repeat(Math.ceil(TURN_SEARCH_INDEX_MAX_FIELD_CHARS / 7) + 10);
        const userMessage = `oldestmarker ${filler}newestmarker`;
        const memoryId = ingest(f, turn(f, { userMessage, assistantText: 'short answer' }));

        const [row] = coverageRows(f.db);
        expect(row).toMatchObject({ memory_id: memoryId, coverage: 'truncated', omitted_assistant_chars: 0 });
        // The newest end is kept; the cut lands on a word boundary.
        expect(row?.omitted_user_chars).toBeGreaterThanOrEqual(userMessage.length - TURN_SEARCH_INDEX_MAX_FIELD_CHARS);
        expect(userMessage.charAt(Number(row?.omitted_user_chars))).toBe(' ');
        expect(search(f.db, 'newestmarker')).toEqual([sessionIdFor(f.db, 'turn-search-session')]);
    });

    it('marks a turn without a source cursor as locator-unavailable', () => {
        const f = fixture();
        const project = f.store.upsertProject(f.cwd);
        const session = f.store.upsertSession('codex', 'turn-search-session', project.id, f.sourcePath);

        expect(f.store.recordTurn(turn(f, { cursor: '' }), session.id, project.id, summary, true)).toBe(true);
        expect(coverageRows(f.db)).toEqual([
            expect.objectContaining({ coverage: 'included', locator: 'unavailable', source_cursor: null }),
        ]);
    });

    it('never indexes a turn withheld from memory', () => {
        const f = fixture();
        expect(f.store.recordIngestedTurn(turn(f, { droppedReason: 'sentinel' }), {}, false, summary, true)).toBeUndefined();

        expect(coverageRows(f.db)).toEqual([]);
        expect(search(f.db, 'zebracorn')).toEqual([]);
    });
});

describe('turn search index reingest', () => {
    it('replaces the stored copy and coverage together when the replacement is retained', async () => {
        const f = fixture();
        const memoryId = ingest(f, turn(f));
        const replacement = turn(f, { userMessage: 'rewritten prompt about wombatlight', assistantText: 'fresh reply' });

        reingest(f, replacement);

        expect(search(f.db, 'zebracorn OR quokkafig')).toEqual([]);
        expect(search(f.db, 'wombatlight')).toEqual([sessionIdFor(f.db, replacement.sessionId)]);
        expect(coverageGaps(f.db)).toBe(0);
        expect(coverageRows(f.db)).toEqual([
            expect.objectContaining({ memory_id: memoryId, source_digest: sourceTurnDigest(replacement) }),
        ]);
        expect(await evidence(f, replacement)).toMatchObject({
            state: 'available',
            projection: { userPrompt: 'rewritten prompt about wombatlight', assistantResponse: 'fresh reply' },
        });
    });

    it('withdraws the old coverage and never serves the old copy when capture is off for the replacement', async () => {
        const f = fixture();
        const original = turn(f);
        const memoryId = ingest(f, original);

        reingest(f, turn(f, { userMessage: 'rewritten prompt about wombatlight' }), { capture: false });

        expect(search(f.db, 'zebracorn OR quokkafig OR wombatlight')).toEqual([]);
        expect(coverageGaps(f.db)).toBe(1);
        // The superseded copy is kept, not silently deleted, but is reported stale.
        expect(f.db.prepare('SELECT memory_id FROM filtered_turns').all()).toEqual([{ memory_id: memoryId }]);
        expect(await evidence(f, original)).toEqual({ state: 'unavailable', reason: 'indexed_turn_evidence_stale' });
        // An old copy captured in the same millisecond as the reingest is still superseded.
        f.db.prepare('UPDATE filtered_turns SET captured_at = (SELECT reingested_at FROM memories WHERE id = ?)').run(memoryId);
        expect(await evidence(f, original)).toEqual({ state: 'unavailable', reason: 'indexed_turn_evidence_stale' });
        expect(search(f.db, 'zebracorn OR quokkafig')).toEqual([]);
    });

    it('withdraws the old coverage and reports the gap when the replacement copy is refused', async () => {
        const f = fixture();
        const original = turn(f);
        ingest(f, original);

        markLegacyEvicted(f);
        reingest(f, turn(f, { userMessage: 'rewritten prompt about wombatlight' }));

        expect(search(f.db, 'zebracorn OR quokkafig OR wombatlight')).toEqual([]);
        expect(coverageGaps(f.db)).toBe(1);
        expect(await evidence(f, original)).toEqual({ state: 'unavailable', reason: 'indexed_turn_evidence_evicted' });
    });

    it('keeps the previous copy and coverage current when the reingest transaction fails', async () => {
        const f = fixture();
        const original = turn(f);
        ingest(f, original);
        const coverage = coverageRows(f.db);

        expect(() =>
            f.db.transaction(() => {
                reingest(f, turn(f, { userMessage: 'rewritten prompt about wombatlight' }));
                throw new Error('simulated write failure');
            })(),
        ).toThrow('simulated write failure');

        expect(search(f.db, 'zebracorn')).toEqual([sessionIdFor(f.db, original.sessionId)]);
        expect(search(f.db, 'wombatlight')).toEqual([]);
        expect(coverageRows(f.db)).toEqual(coverage);
        expect(await evidence(f, original)).toMatchObject({
            state: 'available',
            projection: { userPrompt: 'where does zebracorn configuration live' },
        });
    });
});

describe('turn search index withdrawal', () => {
    it('withdraws coverage when a filtered copy row is deleted directly', () => {
        const f = fixture();
        const removed = ingest(f, turn(f));
        const kept = ingest(f, turn(f, { turnIndex: 1, userMessage: 'second zebracorn question', cursor: '200:2:def' }));

        f.db.prepare('DELETE FROM filtered_turns WHERE memory_id = ?').run(removed);

        expect(coverageRows(f.db).map((row) => row.memory_id)).toEqual([kept]);
        expect(coverageGaps(f.db)).toBe(1);
        expect(search(f.db, 'quokkafig')).toEqual([sessionIdFor(f.db, 'turn-search-session')]);
    });

    it('clears coverage when a memory row is deleted directly', () => {
        const f = fixture();
        const first = ingest(f, turn(f));
        const second = ingest(f, turn(f, { turnIndex: 1, userMessage: 'second zebracorn question', cursor: '200:2:def' }));

        f.db.prepare('DELETE FROM memories WHERE id = ?').run(first);

        expect(coverageRows(f.db).map((row) => row.memory_id)).toEqual([second]);
        expect(coverageGaps(f.db)).toBe(0);
    });

    it('clears the replaced suffix when source reconciliation deletes memories', () => {
        const f = fixture();
        const kept = ingest(f, turn(f));
        ingest(f, turn(f, { turnIndex: 1, userMessage: 'stale suffix wombatlight', cursor: '200:2:def' }));
        const reconciliation = new SourceReconciliation(f.store, 'codex', 'turn-search-session', f.cwd, () => true);

        reconciliation.observe(turn(f, { turnIndex: 1, userMessage: 'replacement suffix', cursor: '210:2:xyz' }));
        expect(reconciliation.commit()).toBe(1);

        expect(search(f.db, 'wombatlight')).toEqual([]);
        expect(coverageRows(f.db).map((row) => row.memory_id)).toEqual([kept]);
    });

    it('clears coverage for purged sessions', () => {
        const f = fixture();
        ingest(f, turn(f));

        f.store.purge({ projectIds: [f.store.upsertProject(f.cwd).id] });

        expect(search(f.db, 'zebracorn')).toEqual([]);
        expect(coverageRows(f.db)).toEqual([]);
    });

    it('withdraws coverage and matches on incognito while retaining the memory rows', () => {
        const f = fixture();
        const other = ingest(f, turn(f, { sessionId: 'other-session', userMessage: 'unrelated zebracorn note' }));
        const incognito = ingest(f, turn(f));

        f.store.recordIncognitoTranscript('codex', 'turn-search-session');

        expect(f.db.prepare('SELECT id FROM memories ORDER BY id').all()).toEqual([{ id: other }, { id: incognito }]);
        expect(search(f.db, 'zebracorn')).toEqual([sessionIdFor(f.db, 'other-session')]);
        expect(search(f.db, 'quokkafig')).toEqual([sessionIdFor(f.db, 'other-session')]);
        expect(coverageRows(f.db).map((row) => row.memory_id)).toEqual([other]);
    });
});

function storeVector(db: Database.Database, memoryId: number): void {
    db.prepare(
        `INSERT INTO ${TURN_EMBEDDINGS_TABLE}
           (memory_id, project_id, source_digest, text_hash, model, model_revision, dimensions, vector, computed_at)
         SELECT tsi.memory_id, m.project_id, tsi.source_digest, 'text-hash', 'model', 'revision', 2, ?, '2026-09-27T00:00:00.000Z'
         FROM ${TURN_SEARCH_INDEX_TABLE} tsi JOIN memories m ON m.id = tsi.memory_id WHERE tsi.memory_id = ?`,
    ).run(Buffer.alloc(8), memoryId);
}

// Everything the retirement must leave untouched.
function preserved(db: Database.Database) {
    return {
        copies: db.prepare('SELECT * FROM filtered_turns ORDER BY memory_id').all(),
        coverage: coverageRows(db),
        vectors: db.prepare(`SELECT * FROM ${TURN_EMBEDDINGS_TABLE} ORDER BY memory_id`).all(),
        consent: db.prepare('SELECT * FROM consent_roots ORDER BY id').all(),
        memories: db.prepare('SELECT * FROM memories ORDER BY id').all(),
    };
}

function fullSchema(db: Database.Database): unknown[] {
    return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
}

describe('retiring the duplicate turn postings', () => {
    it('drops the postings of a once-upgraded database, preserving copies, coverage, vectors and consent, and reopens idempotently', async () => {
        const f = fixture();
        writeFileSync(f.sourcePath, '{}\n');
        const retained = turn(f, { userMessage: 'retained keeperneedle', assistantText: 'keeper answer' });
        const retainedId = ingest(f, retained);
        storeVector(f.db, retainedId);
        const sessionId = sessionIdFor(f.db, retained.sessionId);
        const expectedSchema = fullSchema(f.db);
        const before = { preserved: preserved(f.db), user: search(f.db, 'keeperneedle'), assistant: search(f.db, 'keeper') };
        expect(before.preserved.vectors).toHaveLength(1);
        seedRetiredTurnSearchSchema(f.db, 1);
        expect(retiredTurnSearchObjects(f.db)).not.toEqual([]);
        f.close();
        rmSync(f.sourcePath);

        const migrated = openUnmanagedDb(f.dbPath);
        expect(retiredTurnSearchObjects(migrated)).toEqual([]);
        expect(fullSchema(migrated)).toEqual(expectedSchema);
        expect({ preserved: preserved(migrated), user: search(migrated, 'keeperneedle'), assistant: search(migrated, 'keeper') }).toEqual(
            before,
        );
        expect(before.user).toEqual([sessionId]);
        expect(await evidenceFrom(migrated, f, retained)).toMatchObject({
            state: 'available',
            projection: { userPrompt: 'retained keeperneedle' },
        });
        migrated.close();

        const reopened = openUnmanagedDb(f.dbPath);
        expect(fullSchema(reopened)).toEqual(expectedSchema);
        expect(preserved(reopened)).toEqual(before.preserved);
        // The replaced cleanup triggers no longer name the dropped postings.
        reopened.prepare('DELETE FROM filtered_turns WHERE memory_id = ?').run(retainedId);
        expect(coverageRows(reopened)).toEqual([]);
        expect(reopened.prepare(`SELECT COUNT(*) AS count FROM ${TURN_EMBEDDINGS_TABLE}`).get()).toEqual({ count: 0 });
        reopened.close();
    });

    it('reconciles orphan coverage before retiring a database whose postings were never reconciled', async () => {
        const f = fixture();
        const retained = turn(f, { sessionId: 'retained', userMessage: 'retained keeperneedle' });
        const retainedId = ingest(f, retained);
        const uncaptured = ingest(f, turn(f, { sessionId: 'uncaptured', userMessage: 'uncaptured orphanneedle' }), { capture: false });
        ingest(f, turn(f, { sessionId: 'posting-only', userMessage: 'bare postingneedle' }), { capture: false });
        const stale = ingest(f, turn(f, { sessionId: 'stale', userMessage: 'superseded staleneedle' }));
        seedRetiredTurnSearchSchema(f.db, undefined);
        // Earlier versions indexed turns without a retained copy and refreshed
        // coverage on reingest without recapturing the copy.
        f.db
            .prepare(
                `INSERT INTO ${TURN_SEARCH_INDEX_TABLE}
                 (memory_id, coverage, locator, source_cursor, source_digest, omitted_user_chars, omitted_assistant_chars, filter_version, indexed_at)
                 VALUES (?, 'included', 'available', '1', ?, 0, 0, 1, '2026-09-01')`,
            )
            .run(uncaptured, 'a'.repeat(64));
        f.db.prepare("UPDATE memories SET reingested_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(stale);
        f.close();

        const snapshot = (db: Database.Database) => ({
            coverage: coverageRows(db).map((row) => row.memory_id),
            gaps: coverageGaps(db),
            retained: search(db, 'keeperneedle'),
            orphans: search(db, 'orphanneedle OR postingneedle OR staleneedle'),
            copies: db.prepare('SELECT memory_id FROM filtered_turns ORDER BY memory_id').all(),
            retired: retiredTurnSearchObjects(db),
        });
        const reopened = openUnmanagedDb(f.dbPath);
        const reconciled = snapshot(reopened);
        expect(reconciled).toEqual({
            coverage: [retainedId],
            gaps: 3,
            retained: [sessionIdFor(reopened, 'retained')],
            orphans: [],
            copies: [{ memory_id: retainedId }, { memory_id: stale }],
            retired: [],
        });
        reopened.close();

        const again = openUnmanagedDb(f.dbPath);
        expect(snapshot(again)).toEqual(reconciled);
        expect(await evidenceFrom(again, f, retained)).toMatchObject({
            state: 'available',
            projection: { userPrompt: 'retained keeperneedle' },
        });
        again.close();
    });
});

async function evidenceFrom(db: Database.Database, f: Fixture, parsed: ParsedTurn) {
    const session = db
        .prepare('SELECT id, tool, native_id, source_path FROM sessions WHERE tool = ? AND native_id = ?')
        .get(parsed.tool, parsed.sessionId) as { id: number; tool: 'codex'; native_id: string; source_path: string };
    return new SessionReader(db).indexedTurnEvidence({ ...session, expectedProjectPath: f.cwd }, parsed.turnIndex);
}

// Models a database written by an earlier version whose coverage row predates
// the copy's own truncation, with the retired postings and a marker below the
// reconciled version.
function seedPriorCoverage(f: Fixture, marker: number | undefined): { memoryId: number; coverage: Record<string, unknown> } {
    const memoryId = ingest(f, turn(f, { userMessage: 'keeperterm question', assistantText: 'keeper answer' }));
    const [coverage] = coverageRows(f.db);
    f.db.prepare('UPDATE filtered_turns SET omitted_before_chars = 12 WHERE memory_id = ?').run(memoryId);
    seedRetiredTurnSearchSchema(f.db, marker);
    if (coverage === undefined) {
        throw new Error('coverage missing');
    }
    expect(coverage).toMatchObject({ coverage: 'included' });
    return { memoryId, coverage };
}

describe('noncanonical retired sets', () => {
    it.each(NONCANONICAL_RETIRED_SETS)(
        'refuses to open with %s, preserving it and all evidence, then migrates once it is repaired',
        async (_label, substitution, repair) => {
            const f = fixture();
            const retained = turn(f);
            const first = ingest(f, retained);
            const second = ingest(f, turn(f, { turnIndex: 1, userMessage: 'second zebracorn question', cursor: '200:2:def' }));
            storeVector(f.db, first);
            seedRetiredTurnSearchSchema(f.db, 0);
            f.db.exec(substitution);
            const schema = fullSchema(f.db);
            const before = preserved(f.db);
            const marker = f.db.prepare(`SELECT * FROM ${RETIRED_TURN_SEARCH_STATE_TABLE}`).all();
            f.close();

            for (let attempt = 0; attempt < 2; attempt += 1) {
                expect(() => openUnmanagedDb(f.dbPath)).toThrow(RetiredTurnSearchSchemaError);
                const raw = new Database(f.dbPath);
                // Nothing is retired, replaced, reconciled, or migrated.
                expect(fullSchema(raw)).toEqual(schema);
                expect(preserved(raw)).toEqual(before);
                expect(raw.prepare(`SELECT * FROM ${RETIRED_TURN_SEARCH_STATE_TABLE}`).all()).toEqual(marker);
                raw.close();
            }
            expect(() => openUnmanagedDb(f.dbPath)).toThrow(RETIRED_TURN_SEARCH_SCHEMA_ERROR);

            const raw = new Database(f.dbPath);
            raw.exec(repair);
            raw.close();
            const repaired = openUnmanagedDb(f.dbPath);
            expect(retiredTurnSearchObjects(repaired)).toEqual([]);
            expect(preserved(repaired)).toEqual(before);
            expect(await evidenceFrom(repaired, f, retained)).toMatchObject({ state: 'available' });
            repaired.prepare('DELETE FROM memories WHERE id = ?').run(second);
            expect(coverageRows(repaired).map((row) => row.memory_id)).toEqual([first]);
            repaired.close();
        },
    );
});

describe('coverage reconciliation during retirement', () => {
    it.each([
        ['without a marker', undefined],
        ['below the reconciled marker', 0],
    ])('re-derives coverage from the retained copy %s, keeping locator and digest, idempotently', (_label, marker) => {
        const f = fixture();
        const { memoryId, coverage } = seedPriorCoverage(f, marker);
        f.close();

        const snapshot = (db: Database.Database) => ({
            retained: search(db, 'keeperterm'),
            coverage: coverageRows(db),
            retired: retiredTurnSearchObjects(db),
        });
        const reopened = openUnmanagedDb(f.dbPath);
        const rebuilt = snapshot(reopened);
        expect(rebuilt).toEqual({
            retained: [sessionIdFor(reopened, 'turn-search-session')],
            // The source locator and digest survive; coverage now reports the copy's own truncation.
            coverage: [{ ...coverage, memory_id: memoryId, coverage: 'truncated', indexed_at: expect.any(String) }],
            retired: [],
        });
        reopened.close();

        const again = openUnmanagedDb(f.dbPath);
        expect(snapshot(again)).toEqual(rebuilt);
        again.close();
    });

    it('does not re-derive coverage a reconciled marker already covers', () => {
        const f = fixture();
        const { coverage } = seedPriorCoverage(f, 1);
        f.close();

        const reopened = openUnmanagedDb(f.dbPath);
        expect(coverageRows(reopened)).toEqual([coverage]);
        expect(retiredTurnSearchObjects(reopened)).toEqual([]);
        reopened.close();
    });

    it('leaves the copy, coverage, postings and marker untouched when reconciliation fails, then completes on the next open', () => {
        const f = fixture();
        const { memoryId, coverage } = seedPriorCoverage(f, 0);
        f.db.exec(`CREATE TRIGGER fail_turn_search_reconcile BEFORE UPDATE ON ${TURN_SEARCH_INDEX_TABLE}
            BEGIN SELECT RAISE(ABORT, 'simulated reconciliation failure'); END`);
        const retiredBefore = retiredTurnSearchObjects(f.db);
        f.close();

        expect(() => openUnmanagedDb(f.dbPath)).toThrow('simulated reconciliation failure');
        const raw = new Database(f.dbPath);
        expect(retiredTurnSearchObjects(raw)).toEqual(retiredBefore);
        expect(raw.prepare(`SELECT postings_version FROM ${RETIRED_TURN_SEARCH_STATE_TABLE}`).all()).toEqual([{ postings_version: 0 }]);
        expect(coverageRows(raw)).toEqual([coverage]);
        expect(raw.prepare('SELECT memory_id, user_prompt, omitted_before_chars FROM filtered_turns').all()).toEqual([
            { memory_id: memoryId, user_prompt: 'keeperterm question', omitted_before_chars: 12 },
        ]);
        raw.exec('DROP TRIGGER fail_turn_search_reconcile');
        raw.close();

        const reopened = openUnmanagedDb(f.dbPath);
        expect(retiredTurnSearchObjects(reopened)).toEqual([]);
        expect(coverageRows(reopened)).toEqual([expect.objectContaining({ memory_id: memoryId, coverage: 'truncated' })]);
        expect(search(reopened, 'keeperterm')).toEqual([sessionIdFor(reopened, 'turn-search-session')]);
        reopened.close();
    });

    it('re-derives coverage when sanitizing rewrites a retained copy', () => {
        const f = fixture();
        // A copy stored before write-time sanitization, whose control characters
        // pushed the field past the projection bound.
        const clean = `legacy ${'word '.repeat(Math.floor((TURN_SEARCH_INDEX_MAX_FIELD_CHARS - 20) / 5))}alphabeta`;
        expect(clean.length).toBeLessThan(TURN_SEARCH_INDEX_MAX_FIELD_CHARS);
        expect(clean.length).toBeLessThan(SESSION_CHAR_BUDGET);
        const memoryId = ingest(f, turn(f, { userMessage: clean }));
        const legacy = `${'\u0007'.repeat(TURN_SEARCH_INDEX_MAX_FIELD_CHARS)}${clean}`;
        f.db.prepare('UPDATE filtered_turns SET user_prompt = ? WHERE memory_id = ?').run(legacy, memoryId);
        f.db
            .prepare(`UPDATE ${TURN_SEARCH_INDEX_TABLE} SET coverage = 'truncated', omitted_user_chars = ? WHERE memory_id = ?`)
            .run(TURN_SEARCH_INDEX_MAX_FIELD_CHARS, memoryId);

        applySanitize(f.db);

        expect(f.db.prepare('SELECT user_prompt FROM filtered_turns WHERE memory_id = ?').get(memoryId)).toEqual({ user_prompt: clean });
        expect(coverageRows(f.db)).toEqual([expect.objectContaining({ memory_id: memoryId, coverage: 'included', omitted_user_chars: 0 })]);
        expect(search(f.db, 'alphabeta AND legacy')).toEqual([sessionIdFor(f.db, 'turn-search-session')]);
    });
});

describe('superseded copies in session-content recall', () => {
    it('neither matches nor renders a copy superseded by a reingest without recapture, and reports the gap', () => {
        const f = fixture();
        ingest(f, turn(f, { userMessage: 'supersededterm wombatlight plan' }));
        ingest(f, turn(f, { turnIndex: 1, userMessage: 'followup wombatlight note', cursor: '200:2:def' }));
        reingest(f, turn(f, { userMessage: 'rewritten plan' }), { capture: false });
        // Superseded even when captured in the same millisecond as the reingest.
        f.db.exec(`UPDATE filtered_turns SET captured_at = (SELECT reingested_at FROM memories WHERE memories.id = filtered_turns.memory_id)
                   WHERE memory_id IN (SELECT id FROM memories WHERE reingested_at IS NOT NULL)`);
        const sessions = f.db.prepare('SELECT id FROM sessions').all() as Array<{ id: number }>;
        const reader = new SessionReader(f.db);

        const superseded = reader.storedContentRecallFor(sessions, ['supersededterm'], 50, () => true);
        expect(superseded.matches.size).toBe(0);
        expect(superseded.coverage).toMatchObject({ complete: 0, completeTruncated: 0, incomplete: 1, total: 1 });

        const current = reader.storedContentRecallFor(sessions, ['wombatlight'], 50, () => true);
        const texts = [...current.matches.values()].flatMap((match) => match.texts).join('\n');
        expect(current.matches.size).toBe(1);
        expect(texts).toContain('followup wombatlight note');
        expect(texts).not.toContain('supersededterm');
    });
});
