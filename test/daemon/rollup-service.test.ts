import { beforeEach, describe, expect, it } from 'vitest';
import { RollupService, watermarkStillMatches } from '../../src/daemon/rollup-service.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore, type SessionRow } from '../../src/storage/memory-store.js';
import { ROLLUP_VERSION, RollupStore } from '../../src/storage/rollup-store.js';
import type { RollupTurnInput } from '../../src/summarizer/rollup-prompt.js';
import type { RollupProvider, RollupResult } from '../../src/summarizer/rollup-provider.js';
import type { ParsedTurn } from '../../src/types/index.js';

function makeTurn(index: number, filePaths: string[] = []): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: 's1',
        sourcePath: '/tmp/s1.jsonl',
        projectPath: '/repo',
        turnIndex: index,
        startedAt: `2026-08-01T00:0${index}:00.000Z`,
        endedAt: `2026-08-01T00:0${index}:30.000Z`,
        userMessage: `msg ${index}`,
        assistantText: `reply ${index}`,
        toolCalls: filePaths.length ? [{ name: 'Edit', filePaths }] : [],
        cursor: `${index * 100}|${index + 1}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

class StubProvider implements RollupProvider {
    rollupCalls: RollupTurnInput[][] = [];
    mergeCalls: RollupTurnInput[][] = [];
    result: RollupResult = {
        status: 'ok',
        output: { title: 'T', summary: 'S', decisions: [{ what: 'w', why: 'y' }], pending_items: ['p'], droppedDecisions: 0 },
    };

    async rollup(turns: RollupTurnInput[]): Promise<RollupResult> {
        this.rollupCalls.push(turns);
        return this.result;
    }
    async merge(_prev: unknown, newTurns: RollupTurnInput[]): Promise<RollupResult> {
        this.mergeCalls.push(newTurns);
        return this.result;
    }
}

describe('RollupService', () => {
    let store: MemoryStore;
    let rollups: RollupStore;
    let provider: StubProvider;
    let service: RollupService;
    let session: SessionRow;
    let projectId: number;
    let db: ReturnType<typeof openDb>;

    beforeEach(() => {
        db = openDb(':memory:');
        store = new MemoryStore(db);
        rollups = new RollupStore(db);
        provider = new StubProvider();
        service = new RollupService({ store, rollups, provider });
        const project = store.upsertProject('/repo');
        projectId = project.id;
        session = store.upsertSession('claude-code', 's1', project.id, '/tmp/s1.jsonl');
    });

    const record = (index: number, filePaths: string[] = []) =>
        store.recordTurn(makeTurn(index, filePaths), session.id, projectId, {
            decisions: [{ what: 'd', why: null }],
            pending_items: [],
            status: 'ok',
        });

    it('creates a rollup from scratch on first pass, then merges only new turns', async () => {
        record(0, ['/repo/a.ts']);
        record(1);
        expect(await service.rollupSession(session, 'primary', null, 'live')).toEqual({ wrote: true, complete: true });
        expect(provider.rollupCalls).toHaveLength(1);
        expect(provider.rollupCalls[0]!.map((t) => t.turnIndex)).toEqual([0, 1]);
        expect(rollups.get(session.id)!.rolled_up_through_turn_index).toBe(1);

        record(2);
        expect(await service.rollupSession(session, 'primary', null, 'live')).toEqual({ wrote: true, complete: true });
        // Only the new turn is re-summarized - never the whole session again.
        expect(provider.mergeCalls).toHaveLength(1);
        expect(provider.mergeCalls[0]!.map((t) => t.turnIndex)).toEqual([2]);
    });

    it('does nothing when no turns have arrived past the watermark', async () => {
        record(0, ['/repo/a.ts']);
        await service.rollupSession(session, 'primary', null, 'live');
        expect(await service.rollupSession(session, 'primary', null, 'live')).toEqual({ wrote: false, complete: true });
        expect(provider.mergeCalls).toHaveLength(0);
    });

    // Codex Desktop reopens sessions days later and appends to the original
    // rollout, so this cycle must be repeatable indefinitely.
    it('survives repeated final -> live -> final cycles without reprocessing turns', async () => {
        record(0, ['/repo/a.ts']);
        await service.rollupSession(session, 'primary', null, 'final');
        expect(rollups.get(session.id)!.rollup_state).toBe('final');

        record(1);
        service.noteActivity(session.id);
        expect(rollups.get(session.id)!.rollup_state).toBe('live');
        await service.rollupSession(session, 'primary', null, 'final');
        expect(provider.mergeCalls[0]!.map((t) => t.turnIndex)).toEqual([1]);

        record(2);
        service.noteActivity(session.id);
        await service.rollupSession(session, 'primary', null, 'final');
        expect(provider.mergeCalls[1]!.map((t) => t.turnIndex)).toEqual([2]);
        expect(rollups.get(session.id)!.rolled_up_through_turn_index).toBe(2);
        expect(rollups.get(session.id)!.turn_count).toBe(3);
    });

    // Storing an empty rollup and advancing the watermark would silently mark
    // unaccounted turns as done - the exact failure this codebase already paid
    // for once.
    it('leaves the watermark untouched when summarization fails', async () => {
        record(0, ['/repo/a.ts']);
        provider.result = {
            status: 'parse_error',
            output: { title: '', summary: '', decisions: [], pending_items: [], droppedDecisions: 0 },
        };

        expect(await service.rollupSession(session, 'primary', null, 'live')).toEqual({ wrote: false, complete: false });
        expect(rollups.get(session.id)).toBeUndefined();

        provider.result = {
            status: 'ok',
            output: { title: 'T', summary: 'S', decisions: [{ what: 'w', why: 'y' }], pending_items: [], droppedDecisions: 0 },
        };
        expect(await service.rollupSession(session, 'primary', null, 'live')).toEqual({ wrote: true, complete: true });
        expect(rollups.get(session.id)!.rolled_up_through_turn_index).toBe(0);
    });

    it('routes failed rollup diagnostics to logError when provided', async () => {
        const logs: string[] = [];
        const errors: string[] = [];
        service = new RollupService({
            store,
            rollups,
            provider,
            log: (message) => logs.push(message),
            logError: (message) => errors.push(message),
        });
        record(0);
        provider.result = {
            status: 'api_error',
            output: { title: '', summary: '', decisions: [], pending_items: [], droppedDecisions: 0 },
        };

        await expect(service.rollupSession(session, 'primary', null, 'live')).resolves.toEqual({ wrote: false, complete: false });
        expect(errors).toContain('[elepha] rollup for session 1 failed at batch 1/1 (api_error); watermark left at none');
        expect(logs).not.toContain('[elepha] rollup for session 1 failed at batch 1/1 (api_error); watermark left at none');
    });

    it('records the parent session so sub-agent work attaches instead of listing as a peer', async () => {
        record(0, ['/repo/a.ts']);
        const parent = store.upsertSession('claude-code', 'parent-1', projectId, '/tmp/parent.jsonl');
        await service.rollupSession(session, 'subagent', parent.id, 'final');
        const row = rollups.get(session.id)!;
        expect(row.kind).toBe('subagent');
        expect(row.parent_session_id).toBe(parent.id);
    });

    it('isIdle respects the configured close threshold', () => {
        const svc = new RollupService({ store, rollups, provider, idleCloseMs: 1000 });
        expect(svc.isIdle(5_000, 5_500)).toBe(false);
        expect(svc.isIdle(5_000, 6_500)).toBe(true);
    });

    // Guards against a stale rollup being merged onto instead of rebuilt: the
    // whole point of a version bump is that the old content's shape is wrong.
    it('rebuilds from scratch when the stored rollup predates the current version', async () => {
        record(0, ['/repo/a.ts']);
        record(1);
        await service.rollupSession(session, 'primary', null, 'final');
        expect(provider.rollupCalls).toHaveLength(1);

        rollups.write(
            {
                sessionId: session.id,
                projectId,
                tool: 'claude-code',
                title: 'old',
                summary: 'old',
                decisions: [],
                pendingItems: [],
                filesTouched: [],
                turnCount: 2,
                startedAt: '2026-08-01T00:00:00.000Z',
                endedAt: '2026-08-01T00:01:00.000Z',
                kind: 'primary',
                parentSessionId: null,
                summarizerStatus: 'ok',
                state: 'final',
                throughTurnIndex: 1,
            },
            undefined,
        );
        db.prepare('UPDATE session_rollups SET rollup_version = 0 WHERE session_id = ?').run(session.id);

        expect(await service.rollupSession(session, 'primary', null, 'final')).toEqual({ wrote: true, complete: true });
        // Rebuilt over ALL turns, not merged over the tail.
        expect(provider.rollupCalls).toHaveLength(2);
        expect(provider.rollupCalls[1]!.map((t) => t.turnIndex)).toEqual([0, 1]);
        expect(provider.mergeCalls).toHaveLength(0);
        expect(rollups.get(session.id)!.rollup_version).toBe(ROLLUP_VERSION);
    });

    // A rebuild that never reaches its last batch (crash, API outage, or the
    // concurrent-writer race below) must not look "done" version-wise -
    // otherwise it silently drops out of `--rebuild`'s candidate query
    // (rollup_version <> current) despite covering only part of the session.
    it('keeps an in-progress rebuild at its OLD rollup_version until the final batch, so an interrupted rebuild stays a rebuild candidate', async () => {
        const bigWhy = 'x'.repeat(3000);
        for (let i = 0; i < 6; i++) {
            store.recordTurn(makeTurn(i), session.id, projectId, {
                decisions: [{ what: `d${i}`, why: bigWhy }],
                pending_items: [],
                status: 'ok',
            });
        }
        await service.rollupSession(session, 'primary', null, 'final');
        const batchCount = provider.rollupCalls.length + provider.mergeCalls.length;
        expect(batchCount).toBeGreaterThan(1); // must be multi-batch to test anything
        db.prepare('UPDATE session_rollups SET rollup_version = 0 WHERE session_id = ?').run(session.id);

        // Fail the FINAL batch only, so the rebuild gets partway through and
        // stops - simulates a crash/API-outage abort rather than a clean run.
        let calls = 0;
        const originalMerge = provider.merge.bind(provider);
        provider.merge = async (prev, newTurns) => {
            calls++;
            if (calls === batchCount - 1) {
                // last merge call (batches after the first use merge())
                return { status: 'api_error', output: { title: '', summary: '', decisions: [], pending_items: [], droppedDecisions: 0 } };
            }
            return originalMerge(prev, newTurns);
        };

        const outcome = await service.rollupSession(session, 'primary', null, 'final');
        expect(outcome.complete).toBe(false);
        expect(rollups.get(session.id)!.rollup_version).not.toBe(ROLLUP_VERSION);

        // And because it's still flagged stale, it's still selected for rebuild.
        expect(store.listSessionsForRollupRebuild(ROLLUP_VERSION).map((s) => s.id)).toContain(session.id);
    });
});

describe('watermarkStillMatches', () => {
    it('reports a mismatch when another writer has advanced the watermark since it was read', () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const rollups = new RollupStore(db);
        const project = store.upsertProject('/repo');
        const session = store.upsertSession('claude-code', 's1', project.id, '/tmp/s1.jsonl');
        rollups.write(
            {
                sessionId: session.id,
                projectId: project.id,
                tool: 'claude-code',
                title: 'T',
                summary: 'S',
                decisions: [],
                pendingItems: [],
                filesTouched: [],
                turnCount: 1,
                startedAt: '2026-08-01T00:00:00.000Z',
                endedAt: '2026-08-01T00:00:00.000Z',
                kind: 'primary',
                parentSessionId: null,
                summarizerStatus: 'ok',
                state: 'live',
                throughTurnIndex: 3,
            },
            undefined,
        );

        expect(watermarkStillMatches(rollups, session.id, 3)).toBe(true);
        expect(watermarkStillMatches(rollups, session.id, 2)).toBe(false);
        // undefined means "nothing to verify against yet" (the unconditional
        // first batch of a rebuild) - always passes.
        expect(watermarkStillMatches(rollups, session.id, undefined)).toBe(true);
    });
});
