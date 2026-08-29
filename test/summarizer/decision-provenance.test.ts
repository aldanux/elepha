// Decision provenance and newest-K selection.
//
// The measured split on the live corpus: end-truncation caused ~83% of the lost
// turns, and the model dropping content it had received caused the rest. This
// file covers the second half — and the load-bearing property is that selection
// is decided in CODE. A model that ignores every ordering instruction must
// still not be able to bury the newest decisions.

import { describe, expect, it } from 'vitest';
import { mergeRollupContent, newestDecisions, type RollupDecision } from '../../src/storage/rollup-store.js';
import type { RollupTurnInput } from '../../src/summarizer/rollup-prompt.js';
import { attributeDecisions } from '../../src/summarizer/rollup-provider.js';

function batch(indices: number[], decisionsByTurn: Record<number, string[]> = {}): RollupTurnInput[] {
    return indices.map((i) => ({
        turnIndex: i,
        startedAt: `2026-08-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        decisions: decisionsByTurn[i] ?? [`decision from turn ${i}`],
        pendingItems: [],
        filesTouched: [],
    }));
}

describe('attributeDecisions', () => {
    it('accepts the model turn_index when it names a turn actually in the batch', () => {
        const out = attributeDecisions([{ what: 'chose SQLite', why: 'local', turn_index: 12 }], batch([10, 11, 12, 13]));
        expect(out[0].turnIndex).toBe(12);
        expect(out[0].at).toBe('2026-08-01T00:00:12.000Z');
    });

    it('ignores a turn_index the batch never contained rather than storing a lie', () => {
        const out = attributeDecisions([{ what: 'chose SQLite', why: 'local', turn_index: 999 }], batch([10, 11, 12]));
        expect(out[0].turnIndex).not.toBe(999);
        expect([10, 11, 12]).toContain(out[0].turnIndex);
    });

    it('recovers provenance by matching the text when the model omits turn_index', () => {
        const turns = batch([4, 5, 6], {
            4: ['upgraded phpstan to level 6'],
            5: ['added array shape docblocks everywhere'],
            6: ['refactored CacheSupport wrapper methods'],
        });
        const out = attributeDecisions([{ what: 'added array shape docblocks', why: 'phpstan level 6' }], turns);
        expect(out[0].turnIndex).toBe(5);
    });

    it('falls back to the NEWEST turn of the batch when nothing matches', () => {
        // Deliberate bias. An unplaceable decision sinking to the bottom of the
        // brief is the exact failure being fixed; over-attributing recency is
        // recoverable, under-attributing it is the bug.
        const out = attributeDecisions([{ what: 'something entirely unrelated', why: 'x' }], batch([10, 11, 12]));
        expect(out[0].turnIndex).toBe(12);
    });

    it('survives an empty batch without inventing provenance', () => {
        const out = attributeDecisions([{ what: 'a', why: 'b' }], []);
        expect(out[0].turnIndex).toBeUndefined();
    });

    it('places every decision, however uncooperative the model was', () => {
        const turns = batch([0, 1, 2, 3, 4]);
        const out = attributeDecisions(
            [
                { what: 'a', why: 'r' },
                { what: 'b', why: 'r', turn_index: -5 },
                { what: 'decision from turn 2', why: 'r' },
            ],
            turns,
        );
        expect(out.every((d) => d.turnIndex !== undefined)).toBe(true);
    });
});

describe('newest-K selection', () => {
    const decisions: RollupDecision[] = [
        { what: 'oldest', why: 'r', turnIndex: 1 },
        { what: 'middle', why: 'r', turnIndex: 50 },
        { what: 'newest', why: 'r', turnIndex: 99 },
        { what: 'unplaced', why: 'r' },
    ];

    it('keeps the newest K and returns them in turn order', () => {
        const cases = [
            { input: decisions, limit: 2, expected: ['middle', 'newest'] },
            { input: decisions, limit: 10, expected: ['unplaced', 'oldest', 'middle', 'newest'] },
            {
                // The model emitted oldest-last, i.e. exactly backwards. Selection is
                // by turnIndex, not by array position, so the outcome is unchanged.
                input: [...decisions].reverse(),
                limit: 2,
                expected: ['middle', 'newest'],
            },
        ];

        for (const testCase of cases) {
            expect(newestDecisions(testCase.input, testCase.limit).map((d) => d.what)).toEqual(testCase.expected);
        }
    });
});

describe('mergeRollupContent provenance', () => {
    it('keeps the EARLIEST turn for a repeated decision - the first occurrence is when it was made', () => {
        const merged = mergeRollupContent(
            { decisions: [{ what: 'chose SQLite', why: 'local', turnIndex: 3 }], pendingItems: [], filesTouched: [] },
            { decisions: [{ what: 'chose SQLite', why: 'local', turnIndex: 40 }], pendingItems: [], filesTouched: [] },
        );
        expect(merged.decisions).toHaveLength(1);
        expect(merged.decisions[0].turnIndex).toBe(3);
    });

    it('adopts provenance from the incoming copy when the stored one predates it', () => {
        const merged = mergeRollupContent(
            { decisions: [{ what: 'chose SQLite', why: 'local' }], pendingItems: [], filesTouched: [] },
            { decisions: [{ what: 'chose SQLite', why: 'local', turnIndex: 7 }], pendingItems: [], filesTouched: [] },
        );
        expect(merged.decisions[0].turnIndex).toBe(7);
    });

    it('stores decisions in turn order, so position carries meaning', () => {
        const merged = mergeRollupContent(
            { decisions: [{ what: 'late', why: 'r', turnIndex: 80 }], pendingItems: [], filesTouched: [] },
            {
                decisions: [
                    { what: 'early', why: 'r', turnIndex: 2 },
                    { what: 'later still', why: 'r', turnIndex: 90 },
                ],
                pendingItems: [],
                filesTouched: [],
            },
        );
        expect(merged.decisions.map((d) => d.what)).toEqual(['early', 'late', 'later still']);
    });

    it('never drops a new decision to keep an old one - the merge is a union', () => {
        // At the store layer, the model carrying old decisions forward must
        // not be able to displace new ones.
        const previous = {
            decisions: Array.from({ length: 14 }, (_, i) => ({ what: `old ${i}`, why: 'r', turnIndex: i })),
            pendingItems: [],
            filesTouched: [],
        };
        const incoming = {
            decisions: Array.from({ length: 5 }, (_, i) => ({ what: `new ${i}`, why: 'r', turnIndex: 100 + i })),
            pendingItems: [],
            filesTouched: [],
        };
        const merged = mergeRollupContent(previous, incoming);
        expect(merged.decisions).toHaveLength(19);
        expect(newestDecisions(merged.decisions, 5).map((d) => d.what)).toEqual(['new 0', 'new 1', 'new 2', 'new 3', 'new 4']);
    });
});
