import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';

function makeTurn(overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: 'sess-1',
        sourcePath: '/tmp/sess-1.jsonl',
        projectPath: '/Users/test/demo-project',
        turnIndex: 0,
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-01T00:00:01.000Z',
        userMessage: 'do a thing',
        assistantText: 'done',
        toolCalls: [],
        cursor: '100|1',
        ...overrides,
        hasExternalContent: overrides.hasExternalContent ?? false,
        resumeMarkerBefore: overrides.resumeMarkerBefore ?? false,
    };
}

describe('MemoryStore.getStats', () => {
    let store: MemoryStore;

    beforeEach(() => {
        store = new MemoryStore(openDb(':memory:'));
    });

    it('aggregates sessions/turns by tool, noise rate, files_touched misses, and pending_items accumulation', () => {
        const project = store.upsertProject('/Users/test/demo-project');
        const ccSession = store.upsertSession('claude-code', 'cc-1', project.id, '/tmp/cc-1.jsonl');
        const codexSession = store.upsertSession('codex', 'cx-1', project.id, '/tmp/cx-1.jsonl');

        // CC: two turns, one with a decision + a file path, one pure noise.
        store.recordTurn(
            makeTurn({ tool: 'claude-code', turnIndex: 0, toolCalls: [{ name: 'Edit', filePaths: ['/a.ts'] }] }),
            ccSession.id,
            project.id,
            { decisions: [{ what: 'picked X', why: null }], pending_items: ['follow up on Y'], status: 'ok' },
        );
        store.recordTurn(makeTurn({ tool: 'claude-code', turnIndex: 1 }), ccSession.id, project.id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });

        // Codex: one turn, no file paths extracted, one pending item.
        store.recordTurn(makeTurn({ tool: 'codex', turnIndex: 0 }), codexSession.id, project.id, {
            decisions: [],
            pending_items: ['add tests'],
            status: 'ok',
        });

        const stats = store.getStats('2026-01-01T00:00:00.000Z');

        expect(stats.totalMemories).toBe(3);
        expect(stats.byTool).toEqual(
            expect.arrayContaining([
                { tool: 'claude-code', sessions: 1, turns: 2 },
                { tool: 'codex', sessions: 1, turns: 1 },
            ]),
        );

        expect(stats.memoriesPerSession).toEqual({ min: 1, median: 1.5, max: 2, count: 2 });
        expect(stats.noise).toEqual({ count: 1, total: 3 });

        const cc = stats.filesTouchedZero.find((f) => f.tool === 'claude-code')!;
        expect(cc).toEqual({ tool: 'claude-code', zero_paths: 1, total: 2 });
        const codex = stats.filesTouchedZero.find((f) => f.tool === 'codex')!;
        expect(codex).toEqual({ tool: 'codex', zero_paths: 1, total: 1 });

        expect(stats.byProject).toHaveLength(1);
        expect(stats.byProject[0]!.memories).toBe(3);
        expect(stats.byProject[0]!.open_pending_items).toBe(2);

        expect(stats.byStatus).toEqual([{ summarizer_status: 'ok', count: 3 }]);
    });

    it('excludes memories outside the since window', () => {
        const project = store.upsertProject('/Users/test/demo-project');
        const session = store.upsertSession('claude-code', 'cc-1', project.id, '/tmp/cc-1.jsonl');
        store.recordTurn(makeTurn({ turnIndex: 0, startedAt: '2020-01-01T00:00:00.000Z' }), session.id, project.id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });

        const stats = store.getStats('2026-01-01T00:00:00.000Z');
        expect(stats.totalMemories).toBe(0);
    });
});
