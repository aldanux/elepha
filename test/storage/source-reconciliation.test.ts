import { describe, expect, it } from 'vitest';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { SourceReconciliation } from '../../src/storage/source-reconciliation.js';
import { sourceTurnDigest } from '../../src/storage/source-turn-digest.js';
import type { ParsedTurn, TaskStateReport } from '../../src/types/index.js';

function mcpTurn(overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'reconciled-session',
        sourcePath: '/Users/test/project/session.jsonl',
        projectPath: '/Users/test/project',
        turnIndex: 0,
        startedAt: '2026-09-17T00:00:00.000Z',
        endedAt: '2026-09-17T00:00:01.000Z',
        userMessage: '',
        assistantText: '',
        toolCalls: [],
        cursor: '1|1',
        hasExternalContent: false,
        resumeMarkerBefore: false,
        droppedReason: 'elepha-mcp',
        elephaMcpResultReceipts: [
            {
                callId: 'call-1',
                body: 'Verified result that must remain private until reconciliation commits.',
                observedAt: '2026-09-17T00:00:01.000Z',
            },
        ],
        ...overrides,
    };
}

describe('source reconciliation Rule 4 receipts', () => {
    it('does not persist an observed receipt when final source validation fails', () => {
        const store = new MemoryStore(openUnmanagedDb(':memory:'));
        const turn = mcpTurn();
        store.consent.grant(turn.projectPath);
        let valid = true;
        const reconciliation = new SourceReconciliation(store, turn.tool, turn.sessionId, turn.projectPath, () => valid);

        reconciliation.observe(turn);
        expect(store.database.prepare('SELECT * FROM mcp_receipts').all()).toEqual([]);
        valid = false;

        expect(() => reconciliation.commit()).toThrow('authorization or generation changed');
        expect(store.database.prepare('SELECT * FROM mcp_receipts').all()).toEqual([]);
        expect(store.database.prepare('SELECT * FROM source_generations').all()).toEqual([]);
    });

    it('publishes a receipt-only replacement as a new active generation and retains the old generation inactive', () => {
        const store = new MemoryStore(openUnmanagedDb(':memory:'));
        const original = mcpTurn();
        store.consent.grant(original.projectPath);
        expect(store.recordDroppedTurn(original, {})).toBe(true);

        const replacement = mcpTurn({
            cursor: '2|2',
            elephaMcpResultReceipts: [
                {
                    callId: 'call-1',
                    body: 'Replacement result body bound only to the new source generation.',
                    observedAt: null,
                },
            ],
        });
        const reconciliation = new SourceReconciliation(
            store,
            replacement.tool,
            replacement.sessionId,
            replacement.projectPath,
            () => true,
        );

        reconciliation.observe(replacement);
        expect(reconciliation.commit()).toBe(0);

        expect(store.database.prepare('SELECT generation FROM source_generations').get()).toEqual({ generation: 1 });
        expect(store.mcpReceiptsForSession(replacement.tool, replacement.sessionId, 0)).toMatchObject([
            { call_id: 'call-1', body: original.elephaMcpResultReceipts?.[0]?.body },
        ]);
        expect(store.mcpReceiptsForSession(replacement.tool, replacement.sessionId, 1)).toMatchObject([
            { call_id: 'call-1', body: replacement.elephaMcpResultReceipts?.[0]?.body },
        ]);
        expect(
            store.injectionQuoteBackStatus({
                ...replacement,
                turnIndex: 1,
                droppedReason: undefined,
                elephaMcpResultReceipts: undefined,
                userMessage: original.elephaMcpResultReceipts?.[0]?.body ?? '',
            }),
        ).toBe('no-match');
        expect(
            store.injectionQuoteBackStatus({
                ...replacement,
                turnIndex: 1,
                droppedReason: undefined,
                elephaMcpResultReceipts: undefined,
                userMessage: replacement.elephaMcpResultReceipts?.[0]?.body ?? '',
            }),
        ).toBe('match');
    });
});

describe('source reconciliation task-state reports', () => {
    it('preserves the existing digest for turns without a report', () => {
        expect(sourceTurnDigest(mcpTurn())).toBe('a74bd804794f92e2eb4fb8a3a8d7dd6429c59e19e2d65fdfc192c9e9c40d3633');
    });

    it('retracts a stored turn when only its report changes', () => {
        const store = new MemoryStore(openUnmanagedDb(':memory:'));
        const report: TaskStateReport = {
            callId: 'report-1',
            mode: 'postcompact_retained',
            request_id: '01J00000000000000000000000',
            objective: { text: 'Finish the parser.' },
            decisions: [],
            constraints: [],
            pending_items: [],
        };
        const original = mcpTurn({
            droppedReason: undefined,
            elephaMcpResultReceipts: undefined,
            userMessage: 'Continue the parser work.',
            assistantText: 'Done.',
            taskStateReport: report,
        });
        store.consent.grant(original.projectPath);
        expect(
            store.recordIngestedTurn(original, {}, false, { decisions: [], pending_items: [], status: 'not_configured' })?.inserted,
        ).toBe(true);
        const replacement: ParsedTurn = {
            ...original,
            taskStateReport: { ...report, objective: { text: 'Finish the changed parser.' } },
        };
        expect(sourceTurnDigest(replacement)).not.toBe(sourceTurnDigest(original));

        const reconciliation = new SourceReconciliation(store, original.tool, original.sessionId, original.projectPath, () => true);
        reconciliation.observe(replacement);
        expect(reconciliation.commit()).toBe(1);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
    });
});
