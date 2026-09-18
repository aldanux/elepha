import { mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ELEPHA_MCP_RESULT_MAX_BYTES, INJECTION_QUOTE_BACK_MAX_BYTES, INJECTION_QUOTE_BACK_MAX_ROWS } from '../../src/config/constants.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { InjectionStore } from '../../src/storage/injection-store.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

function makeTurn(overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'purged-after-early-gate',
        sourcePath: '/tmp/purged-after-early-gate.jsonl',
        projectPath: '/Users/test/purged-after-early-gate',
        turnIndex: 0,
        startedAt: '2026-08-24T00:00:00.000Z',
        endedAt: '2026-08-24T00:00:01.000Z',
        userMessage: 'remember this',
        assistantText: 'do not retain it once purged',
        toolCalls: [],
        cursor: '100|1',
        hasExternalContent: false,
        resumeMarkerBefore: false,
        ...overrides,
    };
}

const summary = { decisions: [], pending_items: [], status: 'not_configured' as const };

function seedMcpReceiptGenerations(store: MemoryStore, turn: ParsedTurn): void {
    const receipts = new InjectionStore(store.database);
    const structural = (generation: number): ParsedTurn => ({
        ...turn,
        turnIndex: generation,
        userMessage: '',
        assistantText: '',
        droppedReason: 'elepha-mcp',
        elephaMcpResultReceipts: [{ callId: `call-${generation}`, body: `private MCP receipt generation ${generation}`, observedAt: null }],
    });
    expect(receipts.recordElephaMcpReceipts(structural(0), 0)).toBe(true);
    store.database.prepare('UPDATE source_generations SET generation = 1 WHERE tool = ? AND native_id = ?').run(turn.tool, turn.sessionId);
    expect(receipts.recordElephaMcpReceipts(structural(1), 1)).toBe(true);
}

describe('ingest tombstone write guard', () => {
    let store: MemoryStore;

    beforeEach(() => {
        store = new MemoryStore(openUnmanagedDb(':memory:'));
    });

    it.each(['purged', 'incognito'] as const)('does not recreate a %s transcript after the early scan gate', (blocker) => {
        const turn = makeTurn({ sessionId: `${blocker}-after-early-gate` });
        store.consent.grant(turn.projectPath);

        // The daemon's cheap pre-parse guard already observed no tombstone.
        expect(
            blocker === 'purged'
                ? store.isTranscriptPurged(turn.tool, turn.sessionId)
                : store.isTranscriptIncognito(turn.tool, turn.sessionId),
        ).toBe(false);
        // The tombstone commits before the synchronous session/turn write begins.
        if (blocker === 'purged') {
            store.database
                .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                .run(turn.tool, turn.sessionId, '2026-08-24T00:00:02.000Z');
        } else {
            store.recordIncognitoTranscript(turn.tool, turn.sessionId);
        }

        expect(store.recordIngestedTurn(turn, {}, false, summary)).toBeUndefined();
        expect(store.isTranscriptIncognito(turn.tool, turn.sessionId)).toBe(true);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM incognito_transcripts').get()).toEqual({ count: 1 });
        expect(store.listProjects()).toEqual([]);
        expect(store.findSession(turn.tool, turn.sessionId)).toBeUndefined();
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
    });

    it.each(['ordinary', 'dropped'] as const)(
        'blocks pending consent at write time without recording an incognito tombstone for %s turns',
        (pathKind) => {
            const fixture = withGrantableTestDir(`elepha-pending-write-${pathKind}-`);
            const approvedRoot = path.join(fixture, 'approved');
            const physicalApprovedRoot = path.join(fixture, 'approved-before-swap');
            const unrelatedRoot = path.join(fixture, 'unrelated');
            mkdirSync(path.join(physicalApprovedRoot, 'project'), { recursive: true });
            mkdirSync(path.join(unrelatedRoot, 'project'), { recursive: true });
            symlinkSync(physicalApprovedRoot, approvedRoot);
            const projectPath = path.join(approvedRoot, 'project');
            const turn = makeTurn({ sessionId: `pending-${pathKind}`, projectPath });

            store.consent.grant(approvedRoot);
            expect(store.consent.consentState(projectPath)).toBe('approved');

            unlinkSync(approvedRoot);
            symlinkSync(unrelatedRoot, approvedRoot);
            expect(store.consent.consentState(projectPath)).toBe('pending');

            const result = pathKind === 'ordinary' ? store.recordIngestedTurn(turn, {}, false, summary) : store.recordDroppedTurn(turn, {});

            expect(result).toBe(pathKind === 'ordinary' ? undefined : false);
            expect(store.listProjects()).toEqual([]);
            expect(store.database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
            expect(store.getSessionCursor(turn.tool, turn.sessionId)).toBeUndefined();
            expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
            expect(store.database.prepare('SELECT COUNT(*) AS count FROM incognito_transcripts').get()).toEqual({ count: 0 });
        },
    );

    it('uses the same denied-consent guard for ordinary and dropped turns', () => {
        for (const path of ['ordinary', 'dropped'] as const) {
            const guardedStore = new MemoryStore(openUnmanagedDb(':memory:'));
            const turn = makeTurn({ sessionId: `denied-${path}`, projectPath: `/Users/test/denied-${path}` });
            guardedStore.consent.revoke(turn.projectPath);

            const result =
                path === 'ordinary' ? guardedStore.recordIngestedTurn(turn, {}, false, summary) : guardedStore.recordDroppedTurn(turn, {});

            expect(result).toBe(path === 'ordinary' ? undefined : false);
            expect(guardedStore.isTranscriptIncognito(turn.tool, turn.sessionId)).toBe(true);
            expect(guardedStore.listProjects()).toEqual([]);
            expect(guardedStore.database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
            expect(guardedStore.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
        }
    });

    it('deletes every existing durable segment when denial records incognito and never recreates the copy', () => {
        const turn = makeTurn({
            sessionId: 'approved-then-denied',
            projectPath: '/Users/test/approved-then-denied',
            userMessage: 'incognitouniqueneedle',
            assistantText: 'sensitive captured response',
        });
        store.consent.grant(turn.projectPath);
        const first = store.recordIngestedTurn(turn, {}, false, summary, true);
        expect(first).toBeDefined();
        if (!first) return;
        const second = store.startNextSegment(first.session, first.project.id, turn.sourcePath);
        expect(
            store.recordTurn(
                { ...turn, turnIndex: 1, cursor: '200|2', userMessage: 'non-durable segment' },
                second.id,
                first.project.id,
                summary,
            ),
        ).toBe(true);
        expect(
            store.database
                .prepare('SELECT COUNT(*) AS count FROM sessions WHERE tool = ? AND native_id = ?')
                .get(turn.tool, turn.sessionId),
        ).toEqual({
            count: 2,
        });
        expect(
            store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'incognitouniqueneedle'").all(),
        ).toHaveLength(1);
        seedMcpReceiptGenerations(store, turn);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').get()).toEqual({ count: 2 });

        store.consent.revoke(turn.projectPath);
        expect(store.recordIngestedTurn({ ...turn, turnIndex: 2, cursor: '300|3' }, {}, false, summary, true)).toBeUndefined();

        expect(store.isTranscriptIncognito(turn.tool, turn.sessionId)).toBe(true);
        expect(
            store.database
                .prepare('SELECT COUNT(*) AS count FROM sessions WHERE tool = ? AND native_id = ?')
                .get(turn.tool, turn.sessionId),
        ).toEqual({
            count: 2,
        });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 2 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM durable_capture_status').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM source_generations').get()).toEqual({ count: 0 });
        expect(
            store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'incognitouniqueneedle'").all(),
        ).toEqual([]);

        store.consent.grant(turn.projectPath);
        expect(store.recordIngestedTurn({ ...turn, turnIndex: 2, cursor: '300|3' }, {}, false, summary, true)).toBeUndefined();
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM durable_capture_status').get()).toEqual({ count: 0 });
    });

    it('records the incognito veto and deletes its durable copy atomically', () => {
        const turn = makeTurn({ sessionId: 'atomic-incognito', projectPath: '/Users/test/atomic-incognito' });
        store.consent.grant(turn.projectPath);
        const captured = store.recordIngestedTurn(turn, {}, false, summary, true);
        expect(captured).toBeDefined();
        seedMcpReceiptGenerations(store, turn);
        store.database.exec(`
            CREATE TRIGGER fail_incognito_filtered_delete
            BEFORE DELETE ON filtered_turns
            BEGIN
                SELECT RAISE(ABORT, 'forced filtered delete failure');
            END;
        `);

        expect(() => store.recordIncognitoTranscript(turn.tool, turn.sessionId)).toThrow('forced filtered delete failure');

        expect(store.isTranscriptIncognito(turn.tool, turn.sessionId)).toBe(false);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 1 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM durable_capture_status').get()).toEqual({ count: 1 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').get()).toEqual({ count: 2 });
        expect(store.database.prepare('SELECT generation FROM source_generations').get()).toEqual({ generation: 1 });
    });

    it('writes a non-tombstoned transcript normally', () => {
        const turn = makeTurn();
        store.consent.grant(turn.projectPath);

        const result = store.recordIngestedTurn(turn, {}, false, summary);

        expect(result).toEqual(expect.objectContaining({ inserted: true }));
        expect(store.findSession(turn.tool, turn.sessionId)).toEqual(expect.objectContaining({ id: result?.session.id }));
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
    });

    it('creates or locates a non-tombstoned dropped session and advances its cursor', () => {
        const turn = makeTurn({ userMessage: 'drop this sentinel turn', cursor: '100|1|first' });
        const meta = { surface: 'cli' as const, gitBranch: 'main', kind: 'main' as const, customTitle: 'Native title' };
        store.consent.grant(turn.projectPath);

        expect(store.recordDroppedTurn(turn, meta)).toBe(true);
        const created = store.findSession(turn.tool, turn.sessionId);
        expect(created).toEqual(
            expect.objectContaining({
                cursor: '100|1|first',
                surface: 'cli',
                git_branch: 'main',
                kind: 'main',
                custom_title: 'Native title',
            }),
        );

        expect(store.recordDroppedTurn(makeTurn({ turnIndex: 1, cursor: '200|2|second' }), meta)).toBe(true);
        expect(store.findSession(turn.tool, turn.sessionId)).toEqual(expect.objectContaining({ id: created?.id, cursor: '200|2|second' }));
        expect(store.listProjects()).toHaveLength(1);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
    });

    it('stores MCP receipts and advances the dropped cursor atomically without deriving content metadata', () => {
        const turn = makeTurn({
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            aiTitle: undefined,
            cursor: '250|1|mcp',
            elephaMcpResultReceipts: [
                {
                    callId: 'call-1',
                    body: 'A bounded Elepha MCP result body for later quote-back detection.',
                    observedAt: '2026-08-24T00:00:01.000Z',
                },
            ],
        });
        store.consent.grant(turn.projectPath);

        expect(store.recordDroppedTurn(turn, { customTitle: 'User title' })).toBe(true);
        expect(store.recordDroppedTurn(turn, { customTitle: 'User title' })).toBe(true);

        expect(store.mcpReceiptsForSession(turn.tool, turn.sessionId, 0)).toMatchObject([
            { call_id: 'call-1', source_turn_index: turn.turnIndex },
        ]);
        expect(store.findSession(turn.tool, turn.sessionId)).toEqual(
            expect.objectContaining({
                cursor: turn.cursor,
                custom_title: 'User title',
                title: null,
                first_prompt_search: null,
                last_turn_at: null,
                trailing_branch: null,
                trailing_files: [],
            }),
        );
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
    });

    it('rolls back every new receipt when one call ID replays with a conflicting body', () => {
        const original = makeTurn({
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            cursor: '255|1|original',
            elephaMcpResultReceipts: [{ callId: 'bound-call', body: 'Original bound body.', observedAt: '2026-08-24T00:00:00.000Z' }],
        });
        const turn = makeTurn({
            turnIndex: 1,
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            cursor: '260|1|conflict',
            elephaMcpResultReceipts: [
                { callId: 'new-call', body: 'This receipt must roll back.', observedAt: '2026-08-24T00:00:01.000Z' },
                { callId: 'bound-call', body: 'Conflicting later body.', observedAt: '2026-08-24T00:00:02.000Z' },
            ],
        });
        store.consent.grant(turn.projectPath);
        expect(store.recordDroppedTurn(original, {})).toBe(true);

        expect(store.recordDroppedTurn(turn, {})).toBe(false);
        expect(store.findSession(turn.tool, turn.sessionId)).toEqual(expect.objectContaining({ cursor: original.cursor }));
        expect(store.mcpReceiptsForSession(turn.tool, turn.sessionId, 0)).toMatchObject([
            { call_id: 'bound-call', body: 'Original bound body.', source_turn_index: original.turnIndex },
        ]);
    });

    it('rolls back the whole dropped turn before a prior-session receipt budget can be exceeded', () => {
        const turn = makeTurn({
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            cursor: '270|1|bounded',
            elephaMcpResultReceipts: [
                {
                    callId: 'fills-last-slot',
                    body: 'The receipt that would fill the final slot.',
                    observedAt: '2026-08-24T00:00:01.000Z',
                },
                {
                    callId: 'crosses-limit',
                    body: 'The receipt that must make the transaction fail.',
                    observedAt: '2026-08-24T00:00:02.000Z',
                },
            ],
        });
        store.consent.grant(turn.projectPath);
        for (let index = 0; index < INJECTION_QUOTE_BACK_MAX_ROWS - 1; index++) {
            expect(
                store.recordInjection({
                    tool: turn.tool,
                    nativeSessionId: turn.sessionId,
                    injectedAt: '2026-08-24T00:00:00.000Z',
                    injectionId: `historical-${index}`,
                    body: `Unique historical receipt ${index}.`,
                }),
            ).toBe(true);
        }

        expect(store.recordDroppedTurn(turn, {})).toBe(false);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM injections').get()).toEqual({
            count: INJECTION_QUOTE_BACK_MAX_ROWS - 1,
        });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').get()).toEqual({ count: 0 });
        expect(store.findSession(turn.tool, turn.sessionId)).toBeUndefined();
    });

    it('rejects an inter-turn receipt before the session-wide byte budget is crossed', () => {
        const turn = makeTurn({
            sessionId: 'byte-bounded-session',
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            cursor: '280|1|byte-bounded',
            elephaMcpResultReceipts: [
                {
                    callId: 'crosses-byte-limit',
                    body: 'z'.repeat(ELEPHA_MCP_RESULT_MAX_BYTES),
                    observedAt: '2026-08-24T00:00:01.000Z',
                },
            ],
        });
        store.consent.grant(turn.projectPath);
        const historicalBodyBytes = INJECTION_QUOTE_BACK_MAX_BYTES - ELEPHA_MCP_RESULT_MAX_BYTES + 1;
        store.database
            .prepare(
                `INSERT INTO injections (tool, native_session_id, injected_at, injection_id, body_hash, body)
                 VALUES (?, ?, '2026-08-24T00:00:00.000Z', 'historical-byte-budget', 'historical-byte-hash', ?)`,
            )
            .run(turn.tool, turn.sessionId, 'x'.repeat(historicalBodyBytes));

        expect(store.recordDroppedTurn(turn, {})).toBe(false);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM injections').get()).toEqual({ count: 1 });
        expect(store.findSession(turn.tool, turn.sessionId)).toBeUndefined();
    });

    it('learns receipts against the exact requested segment instead of only the latest one', () => {
        const turn = makeTurn({
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            elephaMcpResultReceipts: [
                { callId: 'old-segment', body: 'Receipt from the earlier segment.', observedAt: '2026-08-24T00:00:01.000Z' },
            ],
        });
        store.consent.grant(turn.projectPath);
        const project = store.upsertProject(turn.projectPath);
        const first = store.upsertSession(turn.tool, turn.sessionId, project.id, turn.sourcePath);
        const latest = store.startNextSegment(first, project.id, turn.sourcePath);

        expect(latest.id).not.toBe(first.id);
        expect(store.learnElephaMcpReceipts(turn, first.id)).toBe(true);
        expect(store.mcpReceiptsForSession(turn.tool, turn.sessionId, 0)).toMatchObject([
            { call_id: 'old-segment', body: 'Receipt from the earlier segment.' },
        ]);
    });

    it('rejects a replay batch when its expected source generation changed during the scan', () => {
        const turn = makeTurn({
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            elephaMcpResultReceipts: [{ callId: 'stale-generation', body: 'Must not bind to generation one.', observedAt: null }],
        });
        store.consent.grant(turn.projectPath);
        const project = store.upsertProject(turn.projectPath);
        const session = store.upsertSession(turn.tool, turn.sessionId, project.id, turn.sourcePath);
        store.database
            .prepare('INSERT INTO source_generations (tool, native_id, generation) VALUES (?, ?, ?)')
            .run(turn.tool, turn.sessionId, 1);

        expect(store.publishElephaMcpReceiptBatch([turn], session.id, turn.tool, turn.sessionId, 0)).toBe(false);
        expect(store.database.prepare('SELECT * FROM mcp_receipts').all()).toEqual([]);
        expect(store.database.prepare('SELECT generation FROM source_generations').get()).toEqual({ generation: 1 });
    });

    it('leaves neither receipt nor cursor when final source validation fails', () => {
        const turn = makeTurn({
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            validateSource: () => false,
            elephaMcpResultReceipts: [
                { callId: 'call-source', body: 'Receipt must roll back with the cursor.', observedAt: '2026-08-24T00:00:01.000Z' },
            ],
        });
        store.consent.grant(turn.projectPath);

        expect(store.recordDroppedTurn(turn, {})).toBe(false);
        expect(store.findSession(turn.tool, turn.sessionId)).toBeUndefined();
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').get()).toEqual({ count: 0 });
    });

    it('rolls back the dropped session when receipt insertion fails', () => {
        const turn = makeTurn({
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            elephaMcpResultReceipts: [
                { callId: 'call-insert', body: 'Receipt insert is forced to abort.', observedAt: '2026-08-24T00:00:01.000Z' },
            ],
        });
        store.consent.grant(turn.projectPath);
        store.database.exec(`
            CREATE TRIGGER fail_mcp_receipt_insert
            BEFORE INSERT ON mcp_receipts
            BEGIN
                SELECT RAISE(ABORT, 'forced receipt failure');
            END;
        `);

        expect(() => store.recordDroppedTurn(turn, {})).toThrow('forced receipt failure');
        expect(store.findSession(turn.tool, turn.sessionId)).toBeUndefined();
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').get()).toEqual({ count: 0 });
    });

    it('rolls back the dropped project and session when cursor advancement fails', () => {
        const turn = makeTurn({
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            cursor: '300|3|failure',
            elephaMcpResultReceipts: [
                { callId: 'call-cursor', body: 'Receipt must roll back on cursor failure.', observedAt: '2026-08-24T00:00:01.000Z' },
            ],
        });
        store.consent.grant(turn.projectPath);
        store.database.exec(`
            CREATE TRIGGER fail_dropped_cursor_update
            BEFORE UPDATE OF cursor ON sessions
            BEGIN
                SELECT RAISE(ABORT, 'forced cursor failure');
            END;
        `);

        expect(() => store.recordDroppedTurn(turn, {})).toThrow('forced cursor failure');
        expect(store.listProjects()).toEqual([]);
        expect(store.findSession(turn.tool, turn.sessionId)).toBeUndefined();
        expect(store.getSessionCursor(turn.tool, turn.sessionId)).toBeUndefined();
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').get()).toEqual({ count: 0 });
    });
});
