// Per-turn `{what, why}` capture.
//
// Before this, turn rows stored bare strings and the rationale was manufactured
// later by the rollup model, which never saw the transcript - so a `why` always
// existed and was sometimes invented. The point of these tests is that "no
// reason was given" is now a recordable fact rather than a gap something else
// fills in.

import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { hydrateTurnDecisions, MemoryStore } from '../../src/storage/memory-store.js';
import { parseOutput } from '../../src/summarizer/haiku-provider.js';
import type { ParsedTurn } from '../../src/types/index.js';

function turn(index = 0): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: 's1',
        sourcePath: '/tmp/s1.jsonl',
        projectPath: '/repo',
        turnIndex: index,
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-01T00:00:30.000Z',
        userMessage: 'do it',
        assistantText: 'done',
        toolCalls: [],
        cursor: `c${index}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

describe('hydrateTurnDecisions', () => {
    it('reads legacy string rows as why: null rather than inventing rationale', () => {
        // Format instructions are a suggestion, not a contract - this model
        // reverts to the older shape, and every pre-existing row uses it.
        const modelOutputCases = [
            {
                raw: '{"decisions":[{"what":"chose SQLite","why":"single-user local tool"}],"pending_items":[]}',
                expected: [{ what: 'chose SQLite', why: 'single-user local tool' }],
            },
            { raw: '{"decisions":["chose SQLite"],"pending_items":[]}', expected: [{ what: 'chose SQLite', why: null }] },
            ...['""', '"   "', 'null'].map((why) => ({
                raw: `{"decisions":[{"what":"x","why":${why}}],"pending_items":[]}`,
                expected: [{ what: 'x', why: null }],
            })),
            { raw: '{"decisions":[{"what":"x"}],"pending_items":[]}', expected: [{ what: 'x', why: null }] },
        ];

        for (const testCase of modelOutputCases) {
            expect(parseOutput(testCase.raw)?.decisions).toEqual(testCase.expected);
        }

        // The honest migration. Backfilling a `why` into these rows would mean
        // manufacturing the very thing the column exists to record.
        const storedRowCases = [
            { raw: JSON.stringify(['upgraded phpstan to level 6']), expected: [{ what: 'upgraded phpstan to level 6', why: null }] },
            { raw: JSON.stringify([{ what: 'a', why: 'b' }]), expected: [{ what: 'a', why: 'b' }] },
            { raw: 'not json', expected: [] },
            { raw: '{"not":"an array"}', expected: [] },
            { raw: JSON.stringify([{ noWhat: 1 }, 'ok']), expected: [{ what: 'ok', why: null }] },
        ];

        for (const testCase of storedRowCases) {
            expect(hydrateTurnDecisions(testCase.raw)).toEqual(testCase.expected);
        }
    });
});

describe('storage round-trip', () => {
    let store: MemoryStore;

    beforeEach(() => {
        const db = openDb(':memory:');
        store = new MemoryStore(db);
        const project = store.upsertProject('/repo');
        store.upsertSession('claude-code', 's1', project.id, '/tmp/s1.jsonl');
    });

    it('preserves a captured why through write and read', () => {
        const cases = [
            {
                decision: { what: 'chose SQLite', why: 'single-user local tool, no server to run' },
                expectedWhy: 'single-user local tool, no server to run',
            },
            { decision: { what: 'bumped the version', why: null }, expectedWhy: null },
        ];

        for (const [index, testCase] of cases.entries()) {
            store.recordTurn(turn(index), 1, 1, { decisions: [testCase.decision], pending_items: [], status: 'ok' });
            expect(store.listMemoriesForSession(1)[index].decisions[0].why).toBe(testCase.expectedWhy);
        }
    });

    it('applies Rule 3 escaping to both fields', () => {
        store.recordTurn(turn(), 1, 1, {
            decisions: [{ what: 'rejected `$(date)`', why: 'it re-evaluates on ${EVERY} render' }],
            pending_items: [],
            status: 'ok',
        });
        const [d] = store.listMemoriesForSession(1)[0].decisions;
        expect(d.what).toBe('rejected \\`$\\(date)\\`');
        expect(d.why).toBe('it re-evaluates on $\\{EVERY} render');
    });
});
