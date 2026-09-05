import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DURABLE_CAPTURE_FILTER_VERSION, SESSION_CHAR_BUDGET } from '../../src/config/constants.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { createTestDb, seedProject, seedRollup, seedSession } from '../helpers/db.js';

function turn(overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'durable-session',
        sourcePath: '/repo/session.jsonl',
        projectPath: '/repo',
        turnIndex: 0,
        startedAt: '2026-09-03T00:00:00.000Z',
        endedAt: '2026-09-03T00:00:01.000Z',
        userMessage: 'durable needle prompt',
        assistantText: 'durable response',
        toolCalls: [
            { name: 'read_file', filePaths: ['/repo/src/a.ts'] },
            { name: 'pathless', filePaths: [], text: '{"command":"never store me"}' },
        ],
        cursor: '100|1',
        hasExternalContent: false,
        resumeMarkerBefore: false,
        ...overrides,
    };
}

const summary = { decisions: [], pending_items: [], status: 'not_configured' as const };

function fixture(): { store: MemoryStore; projectId: number; sessionId: number } {
    const store = new MemoryStore(openUnmanagedDb(':memory:'));
    const project = store.upsertProject('/repo');
    const session = store.upsertSession('codex', 'durable-session', project.id, '/repo/session.jsonl');
    return { store, projectId: project.id, sessionId: session.id };
}

describe('durable capture storage', () => {
    it('writes no filtered turn or status when durable capture is disabled by default', () => {
        const { store, projectId, sessionId } = fixture();

        expect(store.recordTurn(turn(), sessionId, projectId, summary)).toBe(true);

        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM durable_capture_status').get()).toEqual({ count: 0 });
    });

    it('writes a filtered row, its FTS entry, and complete status when enabled', () => {
        const { store, projectId, sessionId } = fixture();

        expect(store.recordTurn(turn(), sessionId, projectId, summary, true)).toBe(true);

        expect(store.database.prepare('SELECT * FROM filtered_turns').get()).toEqual(
            expect.objectContaining({
                included: 1,
                user_prompt: 'durable needle prompt',
                assistant_response: 'durable response',
                tool_calls: JSON.stringify([{ name: 'read_file', filePaths: ['/repo/src/a.ts'] }]),
                omitted_tool_call_count: 1,
                dropped_tool_ref_count: 0,
                omitted_before_chars: 0,
                filter_version: DURABLE_CAPTURE_FILTER_VERSION,
            }),
        );
        expect(store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'needle'").all()).toEqual([
            { rowid: 1 },
        ]);
        expect(store.database.prepare('SELECT state, filter_version FROM durable_capture_status').get()).toEqual({
            state: 'complete',
            filter_version: DURABLE_CAPTURE_FILTER_VERSION,
        });

        store.database.prepare("UPDATE filtered_turns SET user_prompt = 'replacement term'").run();
        expect(store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'needle'").all()).toEqual([]);
        expect(store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'replacement'").all()).toEqual([
            { rowid: 1 },
        ]);
        store.database.prepare('DELETE FROM filtered_turns').run();
        expect(store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'replacement'").all()).toEqual(
            [],
        );
    });

    it('records an accepted filter-excluded turn with empty content', () => {
        const { store, projectId, sessionId } = fixture();

        expect(
            store.recordTurn(
                turn({ userMessage: 'pause here', assistantText: 'Okay, waiting.', toolCalls: [] }),
                sessionId,
                projectId,
                summary,
                true,
            ),
        ).toBe(true);

        expect(store.database.prepare('SELECT included, user_prompt, assistant_response, tool_calls FROM filtered_turns').get()).toEqual({
            included: 0,
            user_prompt: '',
            assistant_response: '',
            tool_calls: '[]',
        });
        expect(store.database.prepare('SELECT state FROM durable_capture_status').get()).toEqual({ state: 'complete' });
    });

    it('rolls back the memory and cursor when the durable write fails', () => {
        const { store, projectId, sessionId } = fixture();
        store.database.exec(`
          CREATE TRIGGER force_durable_failure BEFORE INSERT ON filtered_turns BEGIN
            SELECT RAISE(ABORT, 'forced durable failure');
          END;
        `);

        expect(() => store.recordTurn(turn(), sessionId, projectId, summary, true)).toThrow('forced durable failure');

        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM durable_capture_status').get()).toEqual({ count: 0 });
        expect(store.getSessionCursor('codex', 'durable-session')).toBeUndefined();
    });

    it('drops oversized content from the oldest end and marks the session truncated', () => {
        const { store, projectId, sessionId } = fixture();
        const userMessage = `old-${'x'.repeat(SESSION_CHAR_BUDGET + 100)}`;
        const assistantText = 'newest-response';

        expect(store.recordTurn(turn({ userMessage, assistantText, toolCalls: [] }), sessionId, projectId, summary, true)).toBe(true);

        const stored = store.database.prepare('SELECT user_prompt, assistant_response, omitted_before_chars FROM filtered_turns').get() as {
            user_prompt: string;
            assistant_response: string;
            omitted_before_chars: number;
        };
        expect(stored.omitted_before_chars).toBe(userMessage.length + assistantText.length - SESSION_CHAR_BUDGET);
        expect(stored.user_prompt).toBe(userMessage.slice(stored.omitted_before_chars));
        expect(stored.assistant_response).toBe(assistantText);
        expect(stored.user_prompt.length + stored.assistant_response.length).toBe(SESSION_CHAR_BUDGET);
        expect(store.database.prepare('SELECT state FROM durable_capture_status').get()).toEqual({ state: 'complete_truncated' });
    });

    it('marks a session with earlier non-durable memories as a disabled gap', () => {
        const { store, projectId, sessionId } = fixture();
        expect(store.recordTurn(turn(), sessionId, projectId, summary)).toBe(true);
        expect(store.recordTurn(turn({ turnIndex: 1, cursor: '200|2' }), sessionId, projectId, summary, true)).toBe(true);

        expect(store.database.prepare('SELECT state FROM durable_capture_status').get()).toEqual({ state: 'disabled_gap' });
    });

    it('never exposes shell syntax by truncating between an escape and its token', () => {
        const { store, projectId, sessionId } = fixture();
        const userMessage = `${'x'.repeat(9)}\`${'y'.repeat(SESSION_CHAR_BUDGET - 1)}`;

        expect(store.recordTurn(turn({ userMessage, assistantText: '', toolCalls: [] }), sessionId, projectId, summary, true)).toBe(true);

        expect(store.database.prepare('SELECT user_prompt, omitted_before_chars FROM filtered_turns').get()).toEqual({
            user_prompt: 'y'.repeat(SESSION_CHAR_BUDGET - 1),
            omitted_before_chars: 11,
        });
    });

    it('evicts the current session when its only turn cannot fit under cap 1', () => {
        const { store, projectId, sessionId } = fixture();

        expect(store.recordTurn(turn(), sessionId, projectId, summary, true, 1)).toBe(true);

        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
        expect(store.getSessionCursor('codex', 'durable-session')).toBe('100|1');
        const usage = store.database.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as {
            total_bytes: number;
        };
        const actual = store.database
            .prepare(
                `SELECT COALESCE(SUM(
                   length(CAST(user_prompt AS BLOB)) +
                   length(CAST(assistant_response AS BLOB)) +
                   length(CAST(tool_calls AS BLOB))
                 ), 0) AS total_bytes
                 FROM filtered_turns`,
            )
            .get() as { total_bytes: number };
        expect(usage).toEqual(actual);
        expect(usage.total_bytes).toBeLessThanOrEqual(1);
        expect(store.database.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(sessionId)).toEqual({
            state: 'evicted',
        });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
        expect(store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'needle'").all()).toEqual([]);
        expect(usage).toEqual({ total_bytes: 0 });
    });

    it('keeps source progress while repeated appends terminally evict the current session', () => {
        const { store, projectId, sessionId } = fixture();
        const record = (turnIndex: number, cursor: string): boolean =>
            store.recordTurn(
                turn({
                    turnIndex,
                    cursor,
                    userMessage: `repeatcurrentneedle-${turnIndex}-${'x'.repeat(80)}`,
                    assistantText: '',
                    toolCalls: [],
                }),
                sessionId,
                projectId,
                summary,
                true,
                cap,
            );

        expect(
            store.recordTurn(
                turn({ userMessage: 'first retained turn', assistantText: '', toolCalls: [] }),
                sessionId,
                projectId,
                summary,
                true,
            ),
        ).toBe(true);
        const cap = (
            store.database.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as {
                total_bytes: number;
            }
        ).total_bytes;
        expect(record(1, '200|2')).toBe(true);
        expect(record(2, '300|3')).toBe(true);

        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 3 });
        expect(store.getSessionCursor('codex', 'durable-session')).toBe('300|3');
        expect(store.database.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(sessionId)).toEqual({
            state: 'evicted',
        });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
        expect(
            store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'repeatcurrentneedle'").all(),
        ).toEqual([]);
        const usage = store.database.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as {
            total_bytes: number;
        };
        const actual = store.database
            .prepare(
                `SELECT COALESCE(SUM(
                   length(CAST(user_prompt AS BLOB)) +
                   length(CAST(assistant_response AS BLOB)) +
                   length(CAST(tool_calls AS BLOB))
                 ), 0) AS total_bytes
                 FROM filtered_turns`,
            )
            .get() as { total_bytes: number };
        expect(usage).toEqual(actual);
        expect(usage.total_bytes).toBeLessThanOrEqual(cap);
    });

    it('evicts whole oldest recoverable sessions first and keeps the byte ledger exact', () => {
        const testDb = createTestDb('elepha-durable-cap-');
        const project = seedProject(testDb);
        const gone = seedSession(testDb, {
            project,
            nativeId: 'oldest-gone',
            sourcePath: path.join(testDb.directory, 'oldest-gone.jsonl'),
        });
        const recoverablePath = path.join(testDb.directory, 'newer-recoverable.jsonl');
        writeFileSync(recoverablePath, '{}\n');
        const recoverable = seedSession(testDb, { project, nativeId: 'newer-recoverable', sourcePath: recoverablePath });
        const current = seedSession(testDb, {
            project,
            nativeId: 'current',
            sourcePath: path.join(testDb.directory, 'current.jsonl'),
        });
        const capture = (session: typeof gone, marker: string, chars: number, cap?: number, turnIndex = 0): void => {
            expect(
                testDb.store.recordTurn(
                    turn({
                        sessionId: session.native_id,
                        sourcePath: session.source_path,
                        projectPath: project.path,
                        turnIndex,
                        cursor: `${turnIndex}`,
                        userMessage: `${marker}-${'x'.repeat(chars)}`,
                        assistantText: '',
                        toolCalls: [],
                    }),
                    session.id,
                    project.id,
                    summary,
                    true,
                    cap,
                ),
            ).toBe(true);
        };
        capture(gone, 'goneuniqueneedle', 400);
        capture(recoverable, 'recoverableuniqueneedle', 400);
        testDb.db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', gone.id);
        testDb.db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', recoverable.id);
        seedRollup(testDb, { project, session: recoverable, decisions: [{ what: 'retain rollup', why: 'pre-durable fallback' }] });
        const cap = (testDb.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number })
            .total_bytes;

        capture(current, 'currentuniqueneedle', 100, cap);

        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(recoverable.id)).toEqual({
            state: 'evicted',
        });
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(gone.id)).toEqual({
            state: 'complete',
        });
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(current.id)).toEqual({
            state: 'complete',
        });
        expect(
            testDb.db
                .prepare('SELECT COUNT(*) AS count FROM filtered_turns WHERE memory_id IN (SELECT id FROM memories WHERE session_id = ?)')
                .get(recoverable.id),
        ).toEqual({ count: 0 });
        expect(testDb.db.prepare('SELECT COUNT(*) AS count FROM memories WHERE session_id = ?').get(recoverable.id)).toEqual({ count: 1 });
        expect(testDb.db.prepare('SELECT COUNT(*) AS count FROM session_rollups WHERE session_id = ?').get(recoverable.id)).toEqual({
            count: 1,
        });
        testDb.db.exec('CREATE VIRTUAL TABLE temp.evicted_terms USING fts5vocab(main, filtered_turns_fts, instance)');
        expect(
            testDb.db
                .prepare('SELECT COUNT(*) AS count FROM temp.evicted_terms WHERE doc IN (SELECT id FROM memories WHERE session_id = ?)')
                .get(recoverable.id),
        ).toEqual({ count: 0 });
        expect(
            testDb.db
                .prepare("SELECT COUNT(*) AS count FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'recoverableuniqueneedle'")
                .get(),
        ).toEqual({ count: 0 });
        const usage = testDb.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number };
        const fresh = testDb.db
            .prepare(
                `SELECT COALESCE(SUM(
                   length(CAST(user_prompt AS BLOB)) +
                   length(CAST(assistant_response AS BLOB)) +
                   length(CAST(tool_calls AS BLOB))
                 ), 0) AS total_bytes
                 FROM filtered_turns`,
            )
            .get() as { total_bytes: number };
        expect(usage).toEqual(fresh);
        expect(usage.total_bytes).toBeLessThanOrEqual(cap);

        capture(recoverable, 'resumedaftereviction', 50, cap, 1);
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(recoverable.id)).toEqual({
            state: 'evicted',
        });
        expect(
            testDb.db
                .prepare('SELECT COUNT(*) AS count FROM filtered_turns WHERE memory_id IN (SELECT id FROM memories WHERE session_id = ?)')
                .get(recoverable.id),
        ).toEqual({ count: 0 });
    });
});
