// Service-level half of the truncation fix. rollup-chunking.test.ts proves the
// batching function; this proves RollupService actually sends every batch, and
// that the per-batch watermark keeps partial work on a mid-session failure.

import { beforeEach, describe, expect, it } from 'vitest';
import { RollupService } from '../../src/daemon/rollup-service.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore, type SessionRow } from '../../src/storage/memory-store.js';
import { RollupStore } from '../../src/storage/rollup-store.js';
import type { PreviousRollup, RollupTurnInput } from '../../src/summarizer/rollup-prompt.js';
import type { RollupProvider, RollupResult } from '../../src/summarizer/rollup-provider.js';
import type { ParsedTurn } from '../../src/types/index.js';

function makeTurn(index: number): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: 's1',
        sourcePath: '/tmp/s1.jsonl',
        projectPath: '/repo',
        turnIndex: index,
        startedAt: `2026-08-01T00:00:00.000Z`,
        endedAt: `2026-08-01T00:00:30.000Z`,
        userMessage: `msg ${index}`,
        assistantText: `reply ${index}`,
        toolCalls: [{ name: 'Edit', filePaths: [`/repo/file${index}.ts`] }],
        cursor: `${index * 100}|${index + 1}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

/** Records one decision per turn, each long enough that ~12 turns fill a batch. */
const BULK = 'q'.repeat(600);

class CountingProvider implements RollupProvider {
    rollupCalls: RollupTurnInput[][] = [];
    mergeCalls: Array<{ previous: PreviousRollup; turns: RollupTurnInput[] }> = [];
    /** Batch index (1-based across all calls) at which to return a failure. */
    failAtCall: number | null = null;

    private callCount = 0;

    private next(turns: RollupTurnInput[]): RollupResult {
        this.callCount++;
        if (this.failAtCall !== null && this.callCount === this.failAtCall) {
            return { status: 'parse_error', output: { title: '', summary: '', decisions: [], pending_items: [], droppedDecisions: 0 } };
        }
        return {
            status: 'ok',
            output: {
                title: `T${this.callCount}`,
                summary: `S${this.callCount}`,
                // One decision per turn seen, so coverage is checkable.
                decisions: turns.map((t) => ({ what: `from turn ${t.turnIndex}`, why: 'reason' })),
                pending_items: [`p${this.callCount}`],
                droppedDecisions: 0,
            },
        };
    }

    async rollup(turns: RollupTurnInput[]): Promise<RollupResult> {
        this.rollupCalls.push(turns);
        return this.next(turns);
    }

    async merge(previous: PreviousRollup, newTurns: RollupTurnInput[]): Promise<RollupResult> {
        this.mergeCalls.push({ previous, turns: newTurns });
        return this.next(newTurns);
    }
}

describe('RollupService chunked merge', () => {
    let store: MemoryStore;
    let rollups: RollupStore;
    let provider: CountingProvider;
    let service: RollupService;
    let session: SessionRow;
    let projectId: number;
    const logs: string[] = [];

    beforeEach(() => {
        const db = openDb(':memory:');
        store = new MemoryStore(db);
        rollups = new RollupStore(db);
        provider = new CountingProvider();
        logs.length = 0;
        service = new RollupService({ store, rollups, provider, log: (m) => logs.push(m) });
        const project = store.upsertProject('/repo');
        projectId = project.id;
        session = store.upsertSession('claude-code', 's1', project.id, '/tmp/s1.jsonl');
    });

    const recordMany = (count: number) => {
        for (let i = 0; i < count; i++) {
            store.recordTurn(makeTurn(i), session.id, projectId, {
                decisions: [{ what: `decision ${i} ${BULK}`, why: null }],
                pending_items: [],
                status: 'ok',
            });
        }
    };

    it('sends a small session in exactly one call - the normal path is unchanged', async () => {
        recordMany(3);
        expect(await service.rollupSession(session, 'primary', null, 'final')).toEqual({ wrote: true, complete: true });
        expect(provider.rollupCalls).toHaveLength(1);
        expect(provider.mergeCalls).toHaveLength(0);
    });

    it('sends EVERY turn of a large session, across sequential batches', async () => {
        recordMany(60);
        expect(await service.rollupSession(session, 'primary', null, 'final')).toEqual({ wrote: true, complete: true });

        const seen = [...provider.rollupCalls.flat(), ...provider.mergeCalls.flatMap((c) => c.turns)].map((t) => t.turnIndex);
        // The regression: under end-truncation the tail simply never arrived.
        expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => i));
        expect(provider.rollupCalls).toHaveLength(1);
        expect(provider.mergeCalls.length).toBeGreaterThan(1);
    });

    it('carries the running rollup forward into each subsequent batch', async () => {
        recordMany(60);
        await service.rollupSession(session, 'primary', null, 'final');
        // Every merge call must receive the rollup produced by the batch before
        // it, not the original stored one.
        for (const call of provider.mergeCalls) {
            expect(call.previous.decisions.length).toBeGreaterThan(0);
        }
        expect(provider.mergeCalls[provider.mergeCalls.length - 1]!.previous.title).toBe(`T${provider.mergeCalls.length}`);
    });

    it('finishes with the newest turns represented in the stored rollup', async () => {
        recordMany(60);
        await service.rollupSession(session, 'primary', null, 'final');
        const stored = rollups.get(session.id)!;
        expect(stored.decisions.some((d) => d.what === 'from turn 59')).toBe(true);
        expect(stored.rolled_up_through_turn_index).toBe(59);
        expect(stored.rollup_state).toBe('final');
    });

    it('keeps the batches that landed when a later batch fails, and resumes from there', async () => {
        recordMany(60);
        provider.failAtCall = 3;
        await service.rollupSession(session, 'primary', null, 'final');

        const afterFailure = rollups.get(session.id)!;
        // Two batches committed; the watermark sits where they left it, not at
        // the start and not at the end.
        expect(afterFailure.rolled_up_through_turn_index).toBeGreaterThan(0);
        expect(afterFailure.rolled_up_through_turn_index).toBeLessThan(59);
        // An intermediate batch must never mark the rollup final - it isn't.
        expect(afterFailure.rollup_state).toBe('live');
        expect(logs.some((l) => l.includes('failed at batch 3'))).toBe(true);

        // The retry picks up exactly where it stopped.
        provider.failAtCall = null;
        const resumedFrom = afterFailure.rolled_up_through_turn_index;
        expect(await service.rollupSession(session, 'primary', null, 'final')).toEqual({ wrote: true, complete: true });
        const resumed = rollups.get(session.id)!;
        expect(resumed.rolled_up_through_turn_index).toBe(59);
        expect(provider.mergeCalls.at(2)!.turns[0]!.turnIndex).toBe(resumedFrom + 1);
    });

    it('logs when a single oversized turn forces an omission, rather than dropping silently', async () => {
        store.recordTurn(makeTurn(0), session.id, projectId, {
            decisions: Array.from({ length: 60 }, (_, i) => ({ what: `decision ${i} ${'z'.repeat(300)}`, why: null })),
            pending_items: [],
            status: 'ok',
        });
        await service.rollupSession(session, 'primary', null, 'final');
        expect(logs.some((l) => l.includes('omitted from an oversized turn'))).toBe(true);
    });
});
