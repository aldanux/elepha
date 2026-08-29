// Regression test for the `elepha rollup --rebuild --all` loop that burned
// $1.66 on 106 API calls while making no visible progress: 9 of 10 sessions
// aborted with "watermark moved" after real API spend, and the CLI still
// reported "Rolled up 10 session(s)" - a false success. Root cause, confirmed
// by reproduction (not just reasoned about): the live daemon was running
// during the rebuild, and its OWN independent rollupSession call for the same
// session landed between the CLI's batches, moving the watermark out from
// under the CLI's own in-flight rebuild.
//
// Two real (file-backed, two-connection) writers stand in for the CLI's
// `--rebuild` pass and the daemon's own activity - this is not achievable
// with a single in-process test, because within one `rollupSession` call
// there is no async gap between a batch's write and the next batch's check
// for external code to land in; the race only exists across real OS
// processes/connections.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RollupService } from '../../src/daemon/rollup-service.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore, type SessionRow } from '../../src/storage/memory-store.js';
import { ROLLUP_VERSION, RollupStore } from '../../src/storage/rollup-store.js';
import type { RollupTurnInput } from '../../src/summarizer/rollup-prompt.js';
import type { RollupProvider, RollupResult } from '../../src/summarizer/rollup-provider.js';
import type { ParsedTurn } from '../../src/types/index.js';

function makeTurn(index: number): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: 's1',
        sourcePath: '/tmp/s1.jsonl',
        projectPath: '/repo',
        turnIndex: index,
        startedAt: `2026-08-01T00:${String(index).padStart(2, '0')}:00.000Z`,
        endedAt: `2026-08-01T00:${String(index).padStart(2, '0')}:30.000Z`,
        userMessage: `msg ${index}`,
        assistantText: `reply ${index}`,
        toolCalls: [],
        cursor: `${index * 100}|${index + 1}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

class StubProvider implements RollupProvider {
    result: RollupResult = {
        status: 'ok',
        output: { title: 'T', summary: 'S', decisions: [{ what: 'w', why: 'y' }], pending_items: [], droppedDecisions: 0 },
    };
    async rollup(_turns: RollupTurnInput[]): Promise<RollupResult> {
        return this.result;
    }
    async merge(_prev: unknown, _newTurns: RollupTurnInput[]): Promise<RollupResult> {
        return this.result;
    }
}

describe('rebuild vs. concurrent daemon activity', () => {
    let dbPath: string;
    let projectId: number;
    let session: SessionRow;

    beforeEach(() => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-rebuild-race-'));
        dbPath = path.join(root, 'elepha.db');

        const setupDb = openDb(dbPath);
        const setupStore = new MemoryStore(setupDb);
        const setupRollups = new RollupStore(setupDb);
        const setupService = new RollupService({ store: setupStore, rollups: setupRollups, provider: new StubProvider() });
        const project = setupStore.upsertProject('/repo');
        projectId = project.id;
        session = setupStore.upsertSession('claude-code', 's1', project.id, '/tmp/s1.jsonl');

        // 6 turns, ~3000 chars of decision text each, forces a multi-batch
        // rollup (MAX_BATCH_CHARS=8000) - the exact shape that hit this bug.
        const bigWhy = 'x'.repeat(3000);
        for (let i = 0; i < 6; i++) {
            setupStore.recordTurn(makeTurn(i), session.id, projectId, {
                decisions: [{ what: `decision ${i}`, why: bigWhy }],
                pending_items: [],
                status: 'ok',
            });
        }
        // First pass writes the current rollup; downgrade it to simulate
        // "already rolled up under an older version" - the --rebuild scenario.
        return setupService.rollupSession(session, 'primary', null, 'final').then(() => {
            setupDb.prepare('UPDATE session_rollups SET rollup_version = 0 WHERE session_id = ?').run(session.id);
            setupDb.close();
        });
    });

    it('reports complete:false (not a false success) when a concurrent writer wins the race, and the session still ends up fully covered', async () => {
        // Process A: the CLI's --rebuild pass, own DB connection.
        const dbA = openDb(dbPath);
        const storeA = new MemoryStore(dbA);
        const rollupsA = new RollupStore(dbA);

        // Process B: the daemon's own independent rollupSession call, own DB
        // connection - fires once, injected during A's first `merge` call
        // (i.e. after A's batch-1 `rollup` call already wrote).
        const dbB = openDb(dbPath);
        const storeB = new MemoryStore(dbB);
        const rollupsB = new RollupStore(dbB);
        const serviceB = new RollupService({ store: storeB, rollups: rollupsB, provider: new StubProvider() });

        let bFired = false;
        class RacingProvider extends StubProvider {
            async merge(prev: unknown, newTurns: RollupTurnInput[]): Promise<RollupResult> {
                if (!bFired) {
                    bFired = true;
                    const sessionB = storeB.findSession('claude-code', 's1')!;
                    await serviceB.rollupSession(sessionB, 'primary', null, 'final');
                }
                return super.merge(prev, newTurns);
            }
        }

        const logsA: string[] = [];
        const serviceA = new RollupService({ store: storeA, rollups: rollupsA, provider: new RacingProvider(), log: (m) => logsA.push(m) });
        const outcomeA = await serviceA.rollupSession(session, 'primary', null, 'final');

        expect(bFired).toBe(true);
        // A wrote something (batch 1 landed before the race) but did NOT
        // complete - this is what "Rolled up 10 session(s)" got wrong before:
        // it only checked truthiness, which partial success also satisfies.
        expect(outcomeA).toEqual({ wrote: true, complete: false });
        expect(logsA.some((l) => l.includes('watermark moved'))).toBe(true);

        // The deferred-version-stamp fix means B, arriving after A's batch 1,
        // correctly sees the session as still-stale (rollup_version kept at
        // the OLD value until A's own LAST batch) and does its own full
        // rebuild rather than wrongly merging onto partial content as if it
        // were already current-version. Data-wise the session still ends up
        // fully covered, courtesy of B - only A's own accounting was wrong.
        const finalRow = rollupsA.get(session.id)!;
        expect(finalRow.rollup_version).toBe(ROLLUP_VERSION);
        expect(finalRow.rolled_up_through_turn_index).toBe(5);
    });
});
