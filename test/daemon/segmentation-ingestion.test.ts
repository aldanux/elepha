import { beforeEach, describe, expect, it } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { RollupService } from '../../src/daemon/rollup-service.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { RollupStore } from '../../src/storage/rollup-store.js';
import type { PreviousRollup, RollupTurnInput } from '../../src/summarizer/rollup-prompt.js';
import type { RollupProvider, RollupResult } from '../../src/summarizer/rollup-provider.js';
import type {
    ParsedTurn,
    ParseTurnsOptions,
    SessionAdapter,
    SummarizationInput,
    SummarizationOutput,
    SummarizationProvider,
} from '../../src/types/index.js';

const SOURCE = '/tmp/segmented-session.jsonl';
const NATIVE_ID = 'segmented-session';
const PROJECT = '/repo';

class FixedAdapter implements SessionAdapter {
    readonly tool = 'claude-code' as const;
    readonly watchGlobs = ['*.jsonl'];

    matches(filePath: string): boolean {
        return filePath === SOURCE;
    }

    async classifySession() {
        return { kind: 'primary' as const };
    }

    async classifyEmptySession() {
        return undefined;
    }

    nativeSessionId(): string {
        return NATIVE_ID;
    }

    async *parseTurns(_filePath: string, _sinceCursor?: string, _options?: ParseTurnsOptions): AsyncIterable<ParsedTurn> {
        // These tests drive the daemon's closed-turn ingestion seam directly;
        // adapter parsing has its own suite and is not the behavior under test.
    }
}

class TurnSummarizer implements SummarizationProvider {
    calls = 0;

    async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
        this.calls++;
        return { decisions: [{ what: input.userMessage, why: null }], pending_items: [], status: 'ok' };
    }
}

class RecordingRollupProvider implements RollupProvider {
    calls = 0;

    private result(turns: RollupTurnInput[]): RollupResult {
        this.calls++;
        return {
            status: 'ok',
            output: {
                title: `segment through ${turns.at(-1)?.turnIndex ?? -1}`,
                summary: `covered ${turns.map((turn) => turn.turnIndex).join(',')}`,
                decisions: turns.flatMap((turn) => turn.decisions.map((what) => ({ what, why: 'captured in turn' }))),
                pending_items: [],
                droppedDecisions: 0,
            },
        };
    }

    async rollup(turns: RollupTurnInput[]): Promise<RollupResult> {
        return this.result(turns);
    }

    async merge(_previous: PreviousRollup, newTurns: RollupTurnInput[]): Promise<RollupResult> {
        return this.result(newTurns);
    }
}

type DaemonIngestionSeam = {
    persistTurn(adapter: SessionAdapter, turn: ParsedTurn): Promise<boolean>;
    refreshRollup(adapter: SessionAdapter, filePath: string, nativeId: string, state: 'live' | 'final'): Promise<void>;
};

function turn(index: number, startedAt: string, branch: string, file: string): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: NATIVE_ID,
        sourcePath: SOURCE,
        projectPath: PROJECT,
        turnIndex: index,
        startedAt,
        endedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
        userMessage: `decision ${index}`,
        assistantText: `done ${index}`,
        toolCalls: [{ name: 'Edit', filePaths: [file] }],
        cursor: `${index * 100}|${index + 1}`,
        surface: 'cli',
        gitBranch: branch,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

describe('IngestionDaemon session segmentation', () => {
    let db: ReturnType<typeof openDb>;
    let store: MemoryStore;
    let rollups: RollupStore;
    let adapter: FixedAdapter;
    let summarizer: TurnSummarizer;
    let provider: RecordingRollupProvider;
    let daemon: DaemonIngestionSeam;

    beforeEach(() => {
        db = openDb(':memory:');
        store = new MemoryStore(db);
        store.consent.grant(PROJECT);
        rollups = new RollupStore(db);
        adapter = new FixedAdapter();
        summarizer = new TurnSummarizer();
        provider = new RecordingRollupProvider();
        const service = new RollupService({ store, rollups, provider });
        daemon = new IngestionDaemon({ store, summarizer, adapters: [adapter], rollupService: service }) as unknown as DaemonIngestionSeam;
    });

    const sessions = () =>
        db
            .prepare('SELECT id, segment_index, title, last_turn_at, trailing_branch, trailing_files FROM sessions ORDER BY segment_index')
            .all() as Array<{
            id: number;
            segment_index: number;
            title: string | null;
            last_turn_at: string | null;
            trailing_branch: string | null;
            trailing_files: string;
        }>;

    const ingestBatch = async (turns: ParsedTurn[]) => {
        let inserted = 0;
        for (const parsed of turns) {
            if (await daemon.persistTurn(adapter, parsed)) inserted++;
        }
        if (inserted > 0) await daemon.refreshRollup(adapter, SOURCE, NATIVE_ID, 'live');
        return inserted;
    };

    it('cuts mid-file into two session rows with consecutive segment indexes and fresh trailing state', async () => {
        const first = turn(0, '2026-08-01T00:00:00.000Z', 'main', '/repo/a.ts');
        const second = turn(1, '2026-08-01T05:01:00.000Z', 'feature/x', '/repo/b.ts');

        expect(await ingestBatch([first, second])).toBe(2);

        const rows = sessions();
        expect(rows.map((row) => row.segment_index)).toEqual([0, 1]);
        expect(rows[0]!.trailing_branch).toBe('main');
        expect(JSON.parse(rows[0]!.trailing_files)).toEqual(['/repo/a.ts']);
        expect(rows[1]!.trailing_branch).toBe('feature/x');
        expect(JSON.parse(rows[1]!.trailing_files)).toEqual(['/repo/b.ts']);
        expect(store.listMemoriesForSession(rows[0]!.id).map((memory) => memory.turn_index)).toEqual([0]);
        expect(store.listMemoriesForSession(rows[1]!.id).map((memory) => memory.turn_index)).toEqual([1]);
        expect(rollups.get(rows[0]!.id)?.rollup_state).toBe('final');
        expect(rollups.get(rows[1]!.id)?.rollup_state).toBe('live');
    });

    it('stores ai-title on its segment and never carries it through a later /compact segment', async () => {
        const first = { ...turn(0, '2026-08-01T00:00:00.000Z', 'main', '/repo/a.ts'), aiTitle: 'Review CSP headers for iframe components' };
        const compact = {
            ...turn(1, '2026-08-01T05:01:00.000Z', 'feature/csp', '/repo/b.ts'),
            userMessage: '/compact',
            aiTitle: 'Review CSP headers for iframe components',
        };
        const prompt = {
            ...turn(3, '2026-08-01T05:03:00.000Z', 'feature/csp', '/repo/b.ts'),
            userMessage: 'Replace the iframe sandbox directive with the reviewed policy',
        };
        const continuation = {
            ...turn(2, '2026-08-01T05:02:00.000Z', 'feature/csp', '/repo/b.ts'),
            userMessage: 'This session is being continued from a previous conversation that ran out of context. Summary: prior work.',
        };

        expect(await ingestBatch([first, compact, continuation, prompt])).toBe(4);
        expect(sessions().map((row) => row.title)).toEqual([
            'Review CSP headers for iframe components',
            'Replace the iframe sandbox directive with the reviewed policy',
        ]);
    });

    it('sanitizes the stored fallback title at the write boundary', async () => {
        const parsed = { ...turn(0, '2026-08-01T00:00:00.000Z', 'main', '/repo/a.ts'), userMessage: 'Review `$(date)` output handling' };

        expect(await ingestBatch([parsed])).toBe(1);
        expect(sessions()[0]?.title).toBe('Review date output handling');
    });

    it('appends to the current segment when the branch and files still overlap', async () => {
        const first = turn(0, '2026-08-01T00:00:00.000Z', 'main', '/repo/a.ts');
        const second = turn(1, '2026-08-01T05:01:00.000Z', 'main', '/repo/a.ts');

        expect(await ingestBatch([first, second])).toBe(2);
        expect(sessions().map((row) => row.segment_index)).toEqual([0]);
        expect(store.listMemoriesForSession(sessions()[0]!.id).map((memory) => memory.turn_index)).toEqual([0, 1]);
    });

    it('captures structural turn data without extraction or rollups when no provider is configured', async () => {
        const captureOnly = new IngestionDaemon({ store, adapters: [adapter], rollups }) as unknown as DaemonIngestionSeam;
        const parsed = turn(0, '2026-08-01T00:00:00.000Z', 'main', '/repo/a.ts');

        expect(await captureOnly.persistTurn(adapter, parsed)).toBe(true);
        await captureOnly.refreshRollup(adapter, SOURCE, NATIVE_ID, 'live');

        const session = sessions()[0]!;
        const memories = store.listMemoriesForSession(session.id);
        expect(memories).toHaveLength(1);
        expect(memories[0]).toEqual(
            expect.objectContaining({
                turn_index: 0,
                turn_started_at: parsed.startedAt,
                decisions: [],
                pending_items: [],
                files_touched: ['/repo/a.ts'],
                summarizer_status: 'not_configured',
            }),
        );
        expect(session.last_turn_at).toBe(parsed.endedAt);
        expect(rollups.get(session.id)).toBeUndefined();
        expect(summarizer.calls).toBe(0);
        expect(provider.calls).toBe(0);
    });

    it('reopens an existing final rollup on capture-only activity without merging it', async () => {
        const first = turn(0, '2026-08-01T00:00:00.000Z', 'main', '/repo/a.ts');
        await ingestBatch([first]);
        await daemon.refreshRollup(adapter, SOURCE, NATIVE_ID, 'final');
        const sessionId = sessions()[0]!.id;
        const rollupCalls = provider.calls;

        const captureOnly = new IngestionDaemon({ store, adapters: [adapter], rollups }) as unknown as DaemonIngestionSeam;
        const next = turn(1, '2026-08-01T05:01:00.000Z', 'main', '/repo/a.ts');
        expect(await captureOnly.persistTurn(adapter, next)).toBe(true);

        expect(rollups.get(sessionId)?.rollup_state).toBe('live');
        expect(rollups.get(sessionId)?.rolled_up_through_turn_index).toBe(0);
        expect(store.listMemoriesForSession(sessionId)[1]?.summarizer_status).toBe('not_configured');
        expect(provider.calls).toBe(rollupCalls);
    });

    it('keeps a finalized segment final and opens a new live segment when its wakeup cuts', async () => {
        const first = turn(0, '2026-08-01T00:00:00.000Z', 'main', '/repo/a.ts');
        await ingestBatch([first]);
        await daemon.refreshRollup(adapter, SOURCE, NATIVE_ID, 'final');
        expect(rollups.get(sessions()[0]!.id)?.rollup_state).toBe('final');

        const wakeup = turn(1, '2026-08-01T05:01:00.000Z', 'feature/x', '/repo/b.ts');
        await ingestBatch([wakeup]);

        const rows = sessions();
        expect(rows.map((row) => row.segment_index)).toEqual([0, 1]);
        expect(rollups.get(rows[0]!.id)?.rollup_state).toBe('final');
        expect(rollups.get(rows[1]!.id)?.rollup_state).toBe('live');
        expect(rollups.get(rows[1]!.id)?.turn_count).toBe(1);
    });

    it('wakes a finalized segment back to live and merges when the boundary test does not cut', async () => {
        const first = turn(0, '2026-08-01T00:00:00.000Z', 'main', '/repo/a.ts');
        await ingestBatch([first]);
        await daemon.refreshRollup(adapter, SOURCE, NATIVE_ID, 'final');
        const sessionId = sessions()[0]!.id;

        const wakeup = turn(1, '2026-08-01T05:01:00.000Z', 'main', '/repo/a.ts');
        await ingestBatch([wakeup]);

        expect(sessions()).toHaveLength(1);
        expect(rollups.get(sessionId)?.rollup_state).toBe('live');
        expect(rollups.get(sessionId)?.turn_count).toBe(2);
        expect(rollups.get(sessionId)?.rolled_up_through_turn_index).toBe(1);

        // The soft-final state is repeatable, not a one-shot transition.
        await daemon.refreshRollup(adapter, SOURCE, NATIVE_ID, 'final');
        expect(rollups.get(sessionId)?.rollup_state).toBe('final');
        const secondWakeup = turn(2, '2026-08-01T10:02:00.000Z', 'main', '/repo/a.ts');
        await ingestBatch([secondWakeup]);
        expect(sessions()).toHaveLength(1);
        expect(rollups.get(sessionId)?.rollup_state).toBe('live');
        expect(rollups.get(sessionId)?.turn_count).toBe(3);
        expect(rollups.get(sessionId)?.rolled_up_through_turn_index).toBe(2);
    });

    it('leaves the mutable rollup unchanged when the same closed turns are reprocessed twice', async () => {
        const first = turn(0, '2026-08-01T00:00:00.000Z', 'main', '/repo/a.ts');
        const second = turn(1, '2026-08-01T05:01:00.000Z', 'feature/x', '/repo/b.ts');
        await ingestBatch([first, second]);

        const rows = sessions();
        const before = rows.map((row) => rollups.get(row.id));
        const summarizerCalls = summarizer.calls;
        const rollupCalls = provider.calls;

        expect(await ingestBatch([first, second])).toBe(0);
        expect(await ingestBatch([first, second])).toBe(0);

        expect(sessions().map((row) => row.segment_index)).toEqual([0, 1]);
        expect(rows.flatMap((row) => store.listMemoriesForSession(row.id))).toHaveLength(2);
        expect(rows.map((row) => rollups.get(row.id))).toEqual(before);
        expect(summarizer.calls).toBe(summarizerCalls);
        expect(provider.calls).toBe(rollupCalls);
    });
});
