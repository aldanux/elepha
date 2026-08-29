import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

describe('Rule 4 injections storage', () => {
    it('creates injections and its session index in a fresh schema', () => {
        const db = openDb(':memory:');

        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'injections'").get()).toEqual({
            name: 'injections',
        });
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_injections_session'").get()).toEqual({
            name: 'idx_injections_session',
        });
    });

    it('records normalized bodies idempotently and scopes lookups to an eligible session and time', () => {
        const store = new MemoryStore(openDb(':memory:'));
        const input = {
            tool: 'claude-code' as const,
            nativeSessionId: 'session-a',
            injectedAt: '2026-08-17T10:00:00.000Z',
            injectionId: '01J00000000000000000000000',
            body: 'Remember the selected architecture.',
        };

        expect(store.recordInjection(input)).toBe(true);
        // A retry is safe only after the exact scoped row is observable; the
        // hook can therefore emit once without creating a duplicate row.
        expect(store.recordInjection(input)).toBe(true);
        expect(store.recordInjection({ ...input, body: ' remember, the selected architecture! ' })).toBe(false);
        expect(
            store.recordInjection({
                ...input,
                nativeSessionId: 'session-b',
                injectedAt: '2026-08-17T11:00:00.000Z',
                injectionId: '01J00000000000000000000001',
            }),
        ).toBe(true);

        expect(store.injectionsForSession('claude-code', 'session-a', '2026-08-17T09:59:59.000Z')).toHaveLength(0);
        expect(store.injectionsForSession('codex', 'session-a', '2026-08-17T12:00:00.000Z')).toHaveLength(0);
        expect(store.injectionsForSession('claude-code', 'session-a', '2026-08-17T10:00:00.000Z')).toMatchObject([{ body: input.body }]);
    });
});
