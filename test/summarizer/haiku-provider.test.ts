import { describe, expect, it } from 'vitest';
import { parseOutput } from '../../src/summarizer/haiku-provider.js';

describe('parseOutput', () => {
    it('parses direct unfenced JSON', () => {
        expect(parseOutput('{"decisions": ["a"], "pending_items": []}')).toEqual({
            decisions: [{ what: 'a', why: null }],
            pending_items: [],
        });
    });

    it('strips a ```json fenced block - the actual observed 100%-reproduction failure mode', () => {
        const raw = '```json\n{\n  "decisions": ["chose SQLite"],\n  "pending_items": ["add test"]\n}\n```';
        expect(parseOutput(raw)).toEqual({ decisions: [{ what: 'chose SQLite', why: null }], pending_items: ['add test'] });
    });

    it('strips a bare ``` fence with no "json" language tag', () => {
        const raw = '```\n{"decisions": [], "pending_items": ["x"]}\n```';
        expect(parseOutput(raw)).toEqual({ decisions: [], pending_items: ['x'] });
    });

    it('extracts JSON from surrounding commentary via brace-matching', () => {
        const raw = 'Sure, here is the JSON: {"decisions": ["y"], "pending_items": []} - hope that helps!';
        expect(parseOutput(raw)).toEqual({ decisions: [{ what: 'y', why: null }], pending_items: [] });
    });

    it('returns undefined for invalid model output', () => {
        const invalidResponses = ['I cannot summarize this turn.', '{"decisions": "not an array", "pending_items": []}', ''];
        for (const response of invalidResponses) {
            expect(parseOutput(response)).toBeUndefined();
        }
    });
});
