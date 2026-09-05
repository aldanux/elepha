import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DURABLE_CAPTURE_FILTER_VERSION, SESSION_CHAR_BUDGET } from '../../src/config/constants.js';
import { codexSessionsRoot } from '../../src/config/paths.js';
import { filterTurn } from '../../src/rendering/filtered-turn.js';
import { openProviderTranscript, validateOpenedProviderTranscriptIdentitySync } from '../../src/security/provider-transcript.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { type DurableEvictionPlan, withValidatedDurableEvictionSources } from '../../src/storage/durable-capture-store.js';
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

function evictionFixture(): {
    testDb: ReturnType<typeof createTestDb>;
    first: ReturnType<typeof seedSession>;
    second: ReturnType<typeof seedSession>;
    current: ReturnType<typeof seedSession>;
    capture: (
        session: ReturnType<typeof seedSession>,
        marker: string,
        chars: number,
        cap?: number,
        evictionPlan?: DurableEvictionPlan,
    ) => void;
    cap: () => number;
} {
    const testDb = createTestDb('elepha-durable-source-validation-');
    vi.stubEnv('CODEX_HOME', path.join(testDb.directory, '.codex'));
    const providerStore = codexSessionsRoot();
    mkdirSync(providerStore, { recursive: true });
    const project = seedProject(testDb);
    const source = (name: string): string => {
        const sourcePath = path.join(providerStore, `${name}.jsonl`);
        writeFileSync(sourcePath, `${name}\n`);
        return sourcePath;
    };
    const first = seedSession(testDb, { project, nativeId: 'first', sourcePath: source('first') });
    const second = seedSession(testDb, { project, nativeId: 'second', sourcePath: source('second') });
    const current = seedSession(testDb, { project, nativeId: 'current', sourcePath: source('current') });
    const capture = (session: typeof first, marker: string, chars: number, cap?: number, evictionPlan?: DurableEvictionPlan): void => {
        expect(
            testDb.store.recordTurn(
                turn({
                    sessionId: session.native_id,
                    sourcePath: session.source_path,
                    projectPath: project.path,
                    userMessage: `${marker}-${'x'.repeat(chars)}`,
                    assistantText: '',
                    toolCalls: [],
                }),
                session.id,
                project.id,
                summary,
                true,
                cap,
                evictionPlan,
            ),
        ).toBe(true);
    };
    capture(first, 'firstneedle', 400);
    capture(second, 'secondneedle', 400);
    testDb.db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', first.id);
    testDb.db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', second.id);
    return {
        testDb,
        first,
        second,
        current,
        capture,
        cap: () =>
            (testDb.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number }).total_bytes,
    };
}

function captureSeededTurn(
    testDb: ReturnType<typeof createTestDb>,
    project: ReturnType<typeof seedProject>,
    session: ReturnType<typeof seedSession>,
    marker: string,
    cap?: number,
    evictionPlan?: DurableEvictionPlan,
): void {
    const parsed = turn({
        sessionId: session.native_id,
        sourcePath: session.source_path,
        projectPath: project.path,
        userMessage: marker,
        assistantText: '',
        toolCalls: [],
    });
    expect(testDb.store.recordTurn(parsed, session.id, project.id, summary, true, cap, evictionPlan)).toBe(true);
}

describe('durable capture storage', () => {
    afterEach(() => vi.unstubAllEnvs());

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

    it('retains an unsafe older copy while a valid provider source remains recoverable', async () => {
        const testDb = createTestDb('elepha-durable-cap-');
        vi.stubEnv('CODEX_HOME', path.join(testDb.directory, '.codex'));
        const providerStore = codexSessionsRoot();
        mkdirSync(providerStore, { recursive: true });
        const project = seedProject(testDb);
        const unsafePath = path.join(providerStore, 'unsafe-directory');
        mkdirSync(unsafePath);
        const unsafe = seedSession(testDb, {
            project,
            nativeId: 'oldest-unsafe',
            sourcePath: unsafePath,
        });
        const recoverablePath = path.join(providerStore, 'newer-recoverable.jsonl');
        writeFileSync(recoverablePath, '{}\n');
        const recoverable = seedSession(testDb, { project, nativeId: 'newer-recoverable', sourcePath: recoverablePath });
        const current = seedSession(testDb, {
            project,
            nativeId: 'current',
            sourcePath: path.join(testDb.directory, 'current.jsonl'),
        });
        const capture = (
            session: typeof unsafe,
            marker: string,
            chars: number,
            cap?: number,
            turnIndex = 0,
            evictionPlan?: DurableEvictionPlan,
        ): void => {
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
                    evictionPlan,
                ),
            ).toBe(true);
        };
        capture(unsafe, 'unsafeuniqueneedle', 400);
        capture(recoverable, 'recoverableuniqueneedle', 400);
        testDb.db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', unsafe.id);
        testDb.db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', recoverable.id);
        seedRollup(testDb, { project, session: recoverable, decisions: [{ what: 'retain rollup', why: 'pre-durable fallback' }] });
        const cap = (testDb.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number })
            .total_bytes;

        await withValidatedDurableEvictionSources(
            testDb.db,
            filterTurn(turn({ userMessage: `currentuniqueneedle-${'x'.repeat(100)}`, assistantText: '', toolCalls: [] })),
            cap,
            { sessionId: current.id, tool: current.tool, sourcePath: current.source_path },
            (evictionPlan) => capture(current, 'currentuniqueneedle', 100, cap, 0, evictionPlan),
        );

        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(recoverable.id)).toEqual({
            state: 'evicted',
        });
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(unsafe.id)).toEqual({
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

    it('evicts the oldest copy when historical and new current sources are both unavailable', async () => {
        const testDb = createTestDb('elepha-durable-current-unavailable-');
        vi.stubEnv('CODEX_HOME', path.join(testDb.directory, '.codex'));
        const providerStore = codexSessionsRoot();
        mkdirSync(providerStore, { recursive: true });
        const project = seedProject(testDb);
        const older = seedSession(testDb, {
            project,
            nativeId: 'older-unavailable',
            sourcePath: path.join(providerStore, 'older-missing.jsonl'),
        });
        const current = seedSession(testDb, {
            project,
            nativeId: 'current-unavailable',
            sourcePath: path.join(providerStore, 'current-missing.jsonl'),
        });
        captureSeededTurn(testDb, project, older, 'older-unavailable-copy');
        testDb.db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?').run('2027-01-01T00:00:00.000Z', current.id);
        const maxBytes = (testDb.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number })
            .total_bytes;
        const currentTurn = turn({
            sessionId: current.native_id,
            sourcePath: current.source_path,
            projectPath: project.path,
            userMessage: 'current',
            assistantText: '',
            toolCalls: [],
        });

        await withValidatedDurableEvictionSources(
            testDb.db,
            filterTurn(currentTurn),
            maxBytes,
            { sessionId: current.id, tool: current.tool, sourcePath: current.source_path },
            (evictionPlan) => captureSeededTurn(testDb, project, current, 'current', maxBytes, evictionPlan),
        );

        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(older.id)).toEqual({
            state: 'evicted',
        });
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(current.id)).toEqual({
            state: 'complete',
        });
    });

    it.each([
        { label: 'valid', drift: false, olderState: 'complete', currentState: 'evicted' },
        { label: 'changed in the database after final validation', drift: true, olderState: 'evicted', currentState: 'complete' },
    ] as const)('treats a new current source as $label', async ({ drift, olderState, currentState }) => {
        const testDb = createTestDb('elepha-durable-current-identity-');
        vi.stubEnv('CODEX_HOME', path.join(testDb.directory, '.codex'));
        const providerStore = codexSessionsRoot();
        mkdirSync(providerStore, { recursive: true });
        const project = seedProject(testDb);
        const older = seedSession(testDb, {
            project,
            nativeId: 'older-unavailable',
            sourcePath: path.join(providerStore, 'older-missing.jsonl'),
        });
        const currentPath = path.join(providerStore, 'current-valid.jsonl');
        writeFileSync(currentPath, '{}\n');
        const current = seedSession(testDb, { project, nativeId: 'current', sourcePath: currentPath });
        captureSeededTurn(testDb, project, older, `older-${'x'.repeat(100)}`);
        testDb.db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?').run('2027-01-01T00:00:00.000Z', current.id);
        const maxBytes = (testDb.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number })
            .total_bytes;
        const currentTurn = turn({
            sessionId: current.native_id,
            sourcePath: current.source_path,
            projectPath: project.path,
            userMessage: 'current',
            assistantText: '',
            toolCalls: [],
        });

        await withValidatedDurableEvictionSources(
            testDb.db,
            filterTurn(currentTurn),
            maxBytes,
            { sessionId: current.id, tool: current.tool, sourcePath: current.source_path },
            (plan) => captureSeededTurn(testDb, project, current, 'current', maxBytes, plan),
            drift
                ? {
                      afterFinalIdentityCheck: () =>
                          testDb.db
                              .prepare('UPDATE sessions SET source_path = ? WHERE id = ?')
                              .run(path.join(providerStore, 'current-drifted.jsonl'), current.id),
                  }
                : {},
        );

        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(older.id)).toEqual({
            state: olderState,
        });
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(current.id)).toEqual({
            state: currentState,
        });
    });

    it.each(['unlink', 'substitute'] as const)('treats a source %s before the final identity check as unavailable', async (change) => {
        const { testDb, first, second, current, capture, cap } = evictionFixture();
        let changed = false;

        await withValidatedDurableEvictionSources(
            testDb.db,
            filterTurn(turn({ userMessage: `currentneedle-${'x'.repeat(100)}`, assistantText: '', toolCalls: [] })),
            cap(),
            { sessionId: current.id, tool: current.tool, sourcePath: current.source_path },
            (evictionPlan) => capture(current, 'currentneedle', 100, cap(), evictionPlan),
            {
                validateIdentity: (tool, sourcePath, opened) => {
                    if (!changed && sourcePath === first.source_path) {
                        changed = true;
                        unlinkSync(sourcePath);
                        if (change === 'substitute') {
                            writeFileSync(sourcePath, 'replacement inode\n');
                        }
                    }
                    return validateOpenedProviderTranscriptIdentitySync(tool, sourcePath, opened);
                },
            },
        );

        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(first.id)).toEqual({
            state: 'complete',
        });
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(second.id)).toEqual({
            state: 'evicted',
        });
    });

    it('does not retroactively reorder a source unlinked after the final identity check', async () => {
        const { testDb, first, second, current, capture, cap } = evictionFixture();

        const maxBytes = cap();
        await withValidatedDurableEvictionSources(
            testDb.db,
            filterTurn(turn({ userMessage: `currentneedle-${'x'.repeat(100)}`, assistantText: '', toolCalls: [] })),
            maxBytes,
            { sessionId: current.id, tool: current.tool, sourcePath: current.source_path },
            (evictionPlan) => capture(current, 'currentneedle', 100, maxBytes, evictionPlan),
            { afterFinalIdentityCheck: () => unlinkSync(first.source_path) },
        );

        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(first.id)).toEqual({
            state: 'evicted',
        });
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(second.id)).toEqual({
            state: 'complete',
        });
    });

    it('linearizes each candidate in one synchronous final identity pass', async () => {
        const { testDb, first, second, current, capture, cap } = evictionFixture();
        const maxBytes = cap();
        const checked: string[] = [];

        await withValidatedDurableEvictionSources(
            testDb.db,
            filterTurn(turn({ userMessage: `currentneedle-${'x'.repeat(100)}`, assistantText: '', toolCalls: [] })),
            maxBytes,
            { sessionId: current.id, tool: current.tool, sourcePath: current.source_path },
            (evictionPlan) => capture(current, 'currentneedle', 100, maxBytes, evictionPlan),
            {
                validateIdentity: (tool, sourcePath, opened) => {
                    if (sourcePath === second.source_path) {
                        expect(checked).toEqual([first.source_path]);
                        unlinkSync(first.source_path);
                    }
                    checked.push(sourcePath);
                    return validateOpenedProviderTranscriptIdentitySync(tool, sourcePath, opened);
                },
            },
        );

        expect(checked).toEqual([first.source_path, second.source_path, current.source_path]);
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(first.id)).toEqual({
            state: 'evicted',
        });
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(second.id)).toEqual({
            state: 'complete',
        });
    });

    it('fails closed when a frozen candidate identity no longer matches the transaction row', async () => {
        const { testDb, first, second, current, capture, cap } = evictionFixture();
        const maxBytes = cap();

        await withValidatedDurableEvictionSources(
            testDb.db,
            filterTurn(turn({ userMessage: `currentneedle-${'x'.repeat(100)}`, assistantText: '', toolCalls: [] })),
            maxBytes,
            { sessionId: current.id, tool: current.tool, sourcePath: current.source_path },
            (evictionPlan) => {
                testDb.db.prepare('UPDATE sessions SET source_path = ? WHERE id = ?').run(second.source_path, first.id);
                capture(current, 'currentneedle', 100, maxBytes, evictionPlan);
            },
        );

        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(first.id)).toEqual({
            state: 'complete',
        });
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(second.id)).toEqual({
            state: 'evicted',
        });
    });

    it('skips filesystem preflight when exact bytes cannot bind and treats raced candidates as unavailable', async () => {
        const { testDb, first, second, current, capture, cap } = evictionFixture();
        const projection = filterTurn(turn({ userMessage: `currentneedle-${'x'.repeat(100)}`, assistantText: '', toolCalls: [] }));
        const maxBytes = cap() + 1_000;
        const openTranscript = vi.fn(openProviderTranscript);

        await withValidatedDurableEvictionSources(
            testDb.db,
            projection,
            maxBytes,
            { sessionId: current.id, tool: current.tool, sourcePath: current.source_path },
            (evictionPlan) => {
                expect(evictionPlan).toBeUndefined();
                testDb.db
                    .prepare(
                        `UPDATE filtered_turns
                         SET assistant_response = assistant_response || ?
                         WHERE memory_id IN (SELECT id FROM memories WHERE session_id = ?)`,
                    )
                    .run('r'.repeat(950), first.id);
                capture(current, 'currentneedle', 100, maxBytes, evictionPlan);
            },
            { openTranscript },
        );

        expect(openTranscript).not.toHaveBeenCalled();
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(first.id)).toEqual({
            state: 'evicted',
        });
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(second.id)).toEqual({
            state: 'complete',
        });
        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(current.id)).toEqual({
            state: 'complete',
        });
        const usage = testDb.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number };
        expect(usage.total_bytes).toBeLessThanOrEqual(maxBytes);
    });

    it('performs source filesystem checks before SQLite and retains handles through commit', async () => {
        const { testDb, first, current, capture, cap } = evictionFixture();
        const handles: FileHandle[] = [];
        let observedDeleteInTransaction = false;
        let observedOpenHandle = false;
        testDb.db.function('observe_eviction_source', () => {
            observedDeleteInTransaction = testDb.db.inTransaction;
            observedOpenHandle = handles.length > 0 && handles.every((handle) => handle.fd >= 0);
            return 1;
        });
        testDb.db.exec(`
          CREATE TRIGGER observe_eviction_source_before_delete
          BEFORE DELETE ON filtered_turns BEGIN
            SELECT observe_eviction_source();
          END;
        `);

        const maxBytes = cap();
        await withValidatedDurableEvictionSources(
            testDb.db,
            filterTurn(turn({ userMessage: `currentneedle-${'x'.repeat(100)}`, assistantText: '', toolCalls: [] })),
            maxBytes,
            { sessionId: current.id, tool: current.tool, sourcePath: current.source_path },
            (evictionPlan) => capture(current, 'currentneedle', 100, maxBytes, evictionPlan),
            {
                openTranscript: async (tool, sourcePath) => {
                    expect(testDb.db.inTransaction).toBe(false);
                    const result = await openProviderTranscript(tool, sourcePath);
                    if (!('reason' in result)) {
                        handles.push(result.handle);
                    }
                    return result;
                },
                validateIdentity: (tool, sourcePath, opened) => {
                    expect(testDb.db.inTransaction).toBe(false);
                    return validateOpenedProviderTranscriptIdentitySync(tool, sourcePath, opened);
                },
                afterFinalIdentityCheck: () => expect(testDb.db.inTransaction).toBe(false),
            },
        );

        expect(testDb.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(first.id)).toEqual({
            state: 'evicted',
        });
        expect(observedDeleteInTransaction).toBe(true);
        expect(observedOpenHandle).toBe(true);
        expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    });
});
