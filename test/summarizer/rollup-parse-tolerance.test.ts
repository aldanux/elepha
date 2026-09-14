// Regression guard for a rebuild failure caused by a model-emitted string.
//
// `turn_index` was added to the rollup schema as `z.number().int().optional()`,
// with a comment asserting that optionality kept a non-compliant model parseable.
// It does not: optional() tolerates an ABSENT key, not a wrong-typed one. Haiku
// returns `"turn_index": "0"` — a string, in fixed-sampling runs, reproducibly — so
// every rollup failed to parse and the rebuild died on its first three sessions.
//
// Format instructions are a suggestion, not a contract. These tests ensure
// the next field added to this schema cannot repeat the failure.

import { describe, expect, it } from 'vitest';
import { attributeInstructions, parseRollup } from '../../src/summarizer/rollup-provider.js';

const base = { title: 'T', summary: 'S', pending_items: ['p'] };

function output(decisions: unknown[], rest: Record<string, unknown> = {}): string {
    return JSON.stringify({ ...base, ...rest, decisions });
}

describe('parseRollup tolerance', () => {
    it('accepts turn_index as a NUMBER', () => {
        const parsed = parseRollup(output([{ what: 'a', why: 'b', turn_index: 3 }]));
        expect(parsed?.decisions[0].turn_index).toBe(3);
    });

    it('accepts turn_index as a STRING - the shape the model actually emits', () => {
        const parsed = parseRollup(output([{ what: 'a', why: 'b', turn_index: '3' }]));
        expect(parsed?.decisions[0].turn_index).toBe(3);
    });

    it('keeps the decision when turn_index is unusable, rather than losing it', () => {
        for (const turn_index of [null, 'abc', 1.5, {}, []]) {
            const parsed = parseRollup(output([{ what: 'a', why: 'b', turn_index }]));
            expect(parsed?.decisions).toHaveLength(1);
            expect(parsed?.decisions[0].turn_index).toBeUndefined();
        }
    });

    it('keeps the decision when turn_index is absent entirely', () => {
        const parsed = parseRollup(output([{ what: 'a', why: 'b' }]));
        expect(parsed?.decisions[0].turn_index).toBeUndefined();
    });

    it('drops a hollow decision without failing the rollup around it', () => {
        // The old behaviour lost the title, the summary, the pending items and
        // every other decision to one bad element.
        const parsed = parseRollup(
            output([
                { what: 'good', why: 'reason' },
                { what: 'no reason given', why: '' },
                { what: '', why: 'orphan reason' },
                'not even an object',
                null,
            ]),
        );
        expect(parsed).toBeDefined();
        expect(parsed?.title).toBe('T');
        expect(parsed?.decisions.map((d) => d.what)).toEqual(['good']);
        expect(parsed?.droppedDecisions).toBe(4);
    });

    it('reports zero drops on a clean response', () => {
        expect(parseRollup(output([{ what: 'a', why: 'b' }]))?.droppedDecisions).toBe(0);
    });

    it('still fails on genuinely unparseable output, rather than inventing a rollup', () => {
        // No silent degradation: a broken response must remain distinguishable
        // from a session with nothing to report.
        expect(parseRollup('not json at all')).toBeUndefined();
        expect(parseRollup(JSON.stringify({ title: '', summary: 'S', decisions: [], pending_items: [] }))).toBeUndefined();
        expect(parseRollup(JSON.stringify({ title: 'T', summary: 'S' }))).toBeUndefined();
    });

    it('still unwraps the markdown fence the model always adds', () => {
        const fenced = `\`\`\`json\n${output([{ what: 'a', why: 'b', turn_index: '7' }])}\n\`\`\``;
        expect(parseRollup(fenced)?.decisions[0].turn_index).toBe(7);
    });

    it('drops non-string pending items instead of failing', () => {
        const parsed = parseRollup(output([{ what: 'a', why: 'b' }], { pending_items: ['keep', 42, null, '  '] }));
        expect(parsed?.pending_items).toEqual(['keep']);
    });
});

describe('instruction parsing and attribution', () => {
    it('keeps missing, blank, or unusable reasons while counting malformed instructions independently', () => {
        const parsed = parseRollup(
            output([{ what: 'No rationale' }], {
                instructions: [
                    { what: ' Always run tests ', turn_index: '2' },
                    { what: 'Use tabs', why: ' ' },
                    { what: 'Avoid globals', why: 42 },
                    { what: 'Prefer SQLite', why: ' Local storage ' },
                    { what: '' },
                    null,
                    'bad entry',
                ],
            }),
        );
        expect(parsed?.instructions).toEqual([
            { what: 'Always run tests', turn_index: 2 },
            { what: 'Use tabs' },
            { what: 'Avoid globals' },
            { what: 'Prefer SQLite', why: 'Local storage' },
        ]);
        expect(parsed?.droppedInstructions).toBe(3);
        expect(parsed?.decisions).toEqual([]);
        expect(parsed?.droppedDecisions).toBe(1);
        expect(parseRollup(output([], { instructions: 'broken array' }))).toBeUndefined();
    });

    it('validates claimed turns and uses overlap or the batch fallback when provenance is absent or invalid', () => {
        const batch = [
            { turnIndex: 2, startedAt: 'earlier', decisions: ['Always run regression tests'], pendingItems: [], filesTouched: [] },
            { turnIndex: 5, startedAt: 'later', decisions: ['Use tabs'], pendingItems: [], filesTouched: [] },
        ];
        expect(
            attributeInstructions(
                [
                    { what: 'Use tabs', turn_index: 5 },
                    { what: 'Always run regression tests', turn_index: 999 },
                    { what: 'Preserve audit trails' },
                ],
                batch,
            ),
        ).toEqual([
            { what: 'Use tabs', turnIndex: 5, at: 'later' },
            { what: 'Always run regression tests', turnIndex: 2, at: 'earlier' },
            { what: 'Preserve audit trails', turnIndex: 5, at: 'later' },
        ]);
        expect(attributeInstructions([{ what: 'Use tabs' }], [])).toEqual([{ what: 'Use tabs' }]);
    });
});
