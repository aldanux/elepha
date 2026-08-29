// When a bound binds, drop the oldest and say so.
//
// The prompt builder used to end-truncate the rendered turns at 12,000/8,000
// chars, so on a large session the NEWEST turns never reached the model. These
// tests pin the replacement: chunking with nothing discarded on the normal
// path, and oldest-end truncation with a visible marker in the one irreducible
// case.

import { describe, expect, it } from 'vitest';
import { MAX_ROLLUP_BATCH_CHARS } from '../../src/config/constants.js';
import {
    buildRollupMergeUserContent,
    buildRollupUserContent,
    chunkTurns,
    type PreviousRollup,
    type RollupTurnInput,
    renderPreviousRollup,
    renderTurn,
    shrinkOversizedTurn,
} from '../../src/summarizer/rollup-prompt.js';

function turn(index: number, decisionChars = 40): RollupTurnInput {
    return {
        turnIndex: index,
        startedAt: `2026-08-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        decisions: [`decision ${index} ${'x'.repeat(decisionChars)}`],
        pendingItems: [`pending ${index}`],
        filesTouched: [`/repo/file${index}.ts`],
    };
}

describe('chunkTurns', () => {
    it('leaves a small session as one batch - the normal path is unchanged', () => {
        const batches = chunkTurns([turn(0), turn(1), turn(2)]);
        expect(batches).toHaveLength(1);
        expect(batches[0].turns.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
        expect(batches[0].omitted).toBe(0);
        expect(chunkTurns([])).toEqual([{ turns: [], omitted: 0 }]);
    });

    it('never discards a turn, however large the session', () => {
        const turns = Array.from({ length: 400 }, (_, i) => turn(i));
        const batches = chunkTurns(turns);
        expect(batches.length).toBeGreaterThan(1);

        const seen = batches.flatMap((b) => b.turns.map((t) => t.turnIndex));
        expect(seen).toEqual(turns.map((t) => t.turnIndex));
        expect(batches.every((b) => b.omitted === 0)).toBe(true);

        const promptBuilders = [
            (input: RollupTurnInput[]) => buildRollupUserContent(input),
            (input: RollupTurnInput[]) =>
                buildRollupMergeUserContent({ title: 't', summary: 's', decisions: [{ what: 'a', why: 'b' }], pendingItems: [] }, input),
        ];
        const promptTurns = Array.from({ length: 30 }, (_, i) => turn(i));
        for (const buildPrompt of promptBuilders) {
            const rendered = buildPrompt(promptTurns);
            for (const inputTurn of promptTurns) {
                expect(rendered).toContain(`<turn index="${inputTurn.turnIndex}"`);
            }
            expect(rendered).not.toContain('[truncated]');
        }

        expect(shrinkOversizedTurn(turn(1), 100_000).omitted).toBe(0);
    });

    it('keeps every batch within the budget', () => {
        const batches = chunkTurns(Array.from({ length: 400 }, (_, i) => turn(i)));
        for (const b of batches) {
            expect(buildRollupUserContent(b.turns).length).toBeLessThanOrEqual(MAX_ROLLUP_BATCH_CHARS);
        }
    });

    it('preserves order across batches - the newest turns are in the LAST batch', () => {
        const turns = Array.from({ length: 400 }, (_, i) => turn(i));
        const batches = chunkTurns(turns);
        const last = batches[batches.length - 1];
        expect(last.turns[last.turns.length - 1].turnIndex).toBe(399);
        // The regression this whole change exists for: under the old
        // truncate-from-the-end behaviour, turn 399 was simply absent.
        expect(batches.flatMap((b) => b.turns.map((t) => t.turnIndex))).toContain(399);
    });

    it('reports omissions when a single turn cannot fit', () => {
        const huge: RollupTurnInput = {
            turnIndex: 7,
            startedAt: '2026-08-01T00:00:00.000Z',
            decisions: Array.from({ length: 200 }, (_, i) => `decision ${i} ${'y'.repeat(200)}`),
            pendingItems: [],
            filesTouched: [],
        };
        const batches = chunkTurns([huge]);
        expect(batches).toHaveLength(1);
        expect(batches[0].omitted).toBeGreaterThan(0);
        expect(buildRollupUserContent(batches[0].turns).length).toBeLessThanOrEqual(MAX_ROLLUP_BATCH_CHARS);
    });
});

describe('shrinkOversizedTurn', () => {
    const huge: RollupTurnInput = {
        turnIndex: 3,
        startedAt: '2026-08-01T00:00:00.000Z',
        decisions: Array.from({ length: 50 }, (_, i) => `decision ${i} ${'z'.repeat(100)}`),
        pendingItems: Array.from({ length: 50 }, (_, i) => `pending ${i} ${'z'.repeat(100)}`),
        filesTouched: ['/repo/a.ts'],
    };

    it('drops files_touched first - it is recomputed deterministically anyway', () => {
        const { turn: shrunk } = shrinkOversizedTurn(huge, 100_000);
        expect(shrunk.filesTouched).toEqual([]);
        expect(shrunk.decisions).toHaveLength(50);
    });

    it('drops from the OLDEST end, keeping the newest items', () => {
        const { turn: shrunk } = shrinkOversizedTurn(huge, 2000);
        expect(shrunk.decisions).toContain('decision 49 zzz'.replace('zzz', 'z'.repeat(100)));
        expect(shrunk.decisions.some((d) => d.startsWith('decision 0 '))).toBe(false);
        expect(shrunk.pendingItems.some((p) => p.startsWith('pending 0 '))).toBe(false);
    });

    it('says so - the omission is visible in the rendered text, not silent', () => {
        const { turn: shrunk, omitted } = shrinkOversizedTurn(huge, 2000);
        expect(omitted).toBeGreaterThan(0);
        expect(renderTurn(shrunk)).toContain(`[${omitted} earlier items in this turn omitted - batch budget]`);
    });
});

describe('renderPreviousRollup', () => {
    function previous(decisionCount: number, summaryChars = 600): PreviousRollup {
        return {
            title: 'A session',
            summary: 'S'.repeat(summaryChars),
            decisions: Array.from({ length: decisionCount }, (_, i) => ({
                what: `choice ${i} ${'w'.repeat(60)}`,
                why: `reason ${i} ${'r'.repeat(60)}`,
            })),
            pendingItems: ['still open'],
        };
    }

    it('shortens the summary before dropping any decision', () => {
        const small = renderPreviousRollup({ title: 't', summary: 's', decisions: [{ what: 'a', why: 'b' }], pendingItems: [] });
        expect(small).toContain('a (because b)');
        expect(small).not.toContain('omitted');

        // Over budget on the summary alone: shortening it must be enough, and
        // no decision may be sacrificed while prose is still on the table.
        const out = renderPreviousRollup(previous(4, 3600));
        expect(out).toContain('…');
        expect(out).not.toContain('omitted');
        for (let i = 0; i < 4; i++) {
            expect(out).toContain(`choice ${i} `);
        }
    });

    it('drops the OLDEST decisions when it still does not fit, and keeps the newest', () => {
        const out = renderPreviousRollup(previous(60));
        expect(out.length).toBeLessThanOrEqual(4000);
        expect(out).toContain('choice 59 ');
        expect(out).not.toContain('choice 0 ');
        expect(out).toMatch(/\[\d+ earlier decisions omitted - batch budget]/);
    });

    it('never drops the pending items - they are the continuity payload', () => {
        expect(renderPreviousRollup(previous(60))).toContain('still open');
    });
});
