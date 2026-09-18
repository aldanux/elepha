import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    ELEPHA_MCP_CALL_ID_MAX_BYTES,
    INJECTION_QUOTE_BACK_BUDGET_MS,
    INJECTION_QUOTE_BACK_MAX_ROWS,
    INJECTION_QUOTE_BACK_TURN_MAX_BYTES,
} from '../../src/config/constants.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { InjectionStore } from '../../src/storage/injection-store.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';

describe('Rule 4 injections storage', () => {
    it('creates hook injections and MCP receipts with their lookup indexes in a fresh schema', () => {
        const db = openUnmanagedDb(':memory:');

        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'injections'").get()).toEqual({
            name: 'injections',
        });
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_injections_session'").get()).toEqual({
            name: 'idx_injections_session',
        });
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_injections_session_order'").get()).toEqual({
            name: 'idx_injections_session_order',
        });
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_receipts'").get()).toEqual({
            name: 'mcp_receipts',
        });
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mcp_receipts_source_order'").get()).toEqual({
            name: 'idx_mcp_receipts_source_order',
        });
    });

    it('records normalized bodies idempotently and scopes lookups to an eligible session and time', () => {
        const store = new MemoryStore(openUnmanagedDb(':memory:'));
        const input = {
            tool: 'claude-code' as const,
            nativeSessionId: 'session-a',
            injectedAt: '2026-08-17T10:00:00.000Z',
            injectionId: '01J00000000000000000000000',
            body: 'Remember the selected architecture.',
        };

        expect(store.recordInjection(input)).toBe(true);
        // A retry is safe only after the scoped normalized row is observable.
        // Equivalent whitespace preserves the earliest exact body and timestamp.
        expect(store.recordInjection(input)).toBe(true);
        expect(
            store.recordInjection({
                ...input,
                injectedAt: '2026-08-17T10:01:00.000Z',
                body: ' remember, the selected architecture! ',
            }),
        ).toBe(false);
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

    it('requires an exact hook body replay and preserves the earliest scoped body', () => {
        const store = new MemoryStore(openUnmanagedDb(':memory:'));
        const input = {
            tool: 'claude-code' as const,
            nativeSessionId: 'session-a',
            injectedAt: '2026-08-17T10:00:00.000Z',
            injectionId: 'first',
            body: 'Remember the selected architecture.',
        };

        expect(store.recordInjection(input)).toBe(true);
        expect(
            store.recordInjection({
                ...input,
                injectedAt: '2026-08-17T10:01:00.000Z',
                injectionId: 'replay',
                body: ' remember, the selected architecture! ',
            }),
        ).toBe(false);
        expect(store.injectionsForSession('claude-code', 'session-a', '2026-08-17T11:00:00.000Z')).toMatchObject([
            { injected_at: input.injectedAt, injection_id: input.injectionId, body: input.body },
        ]);
        store.database.exec(`
            CREATE TRIGGER ignore_injection_constraint
            BEFORE INSERT ON injections
            WHEN NEW.native_session_id = 'constraint-failure'
            BEGIN
                SELECT RAISE(IGNORE);
            END;
        `);
        expect(store.recordInjection({ ...input, nativeSessionId: 'constraint-failure' })).toBe(false);
    });

    it('binds MCP call identity to the exact body and source turn while allowing equal bodies under distinct calls', () => {
        const db = openUnmanagedDb(':memory:');
        const injections = new InjectionStore(db);
        const receiptTurn = mcpTurn(2, [
            { callId: 'call-a', body: 'The same verified result body.', observedAt: null },
            { callId: 'call-b', body: 'The same verified result body.', observedAt: 'not-a-timestamp' },
        ]);

        expect(injections.recordElephaMcpReceipts(receiptTurn)).toBe(true);
        expect(injections.recordElephaMcpReceipts(receiptTurn)).toBe(true);
        expect(db.prepare('SELECT * FROM source_generations').all()).toEqual([
            { tool: 'codex', native_id: receiptTurn.sessionId, generation: 0 },
        ]);
        expect(injections.mcpReceiptsForSession('codex', receiptTurn.sessionId, 0)).toMatchObject([
            { call_id: 'call-a', source_turn_index: 2, observed_at: null, body: 'The same verified result body.' },
            { call_id: 'call-b', source_turn_index: 2, observed_at: null, body: 'The same verified result body.' },
        ]);

        expect(
            injections.recordElephaMcpReceipts(
                mcpTurn(2, [{ callId: 'call-a', body: ' the same verified result body! ', observedAt: null }]),
            ),
        ).toBe(false);
        expect(
            injections.recordElephaMcpReceipts(
                mcpTurn(3, [{ callId: 'call-a', body: 'The same verified result body.', observedAt: null }]),
            ),
        ).toBe(false);
        expect(injections.mcpReceiptsForSession('codex', receiptTurn.sessionId, 0)).toHaveLength(2);
    });

    it('rejects forged oversized MCP call IDs before durable or transient state changes', () => {
        const db = openUnmanagedDb(':memory:');
        const injections = new InjectionStore(db);
        const retainedBody = 'This valid first receipt must not survive a later oversized call identifier in the same turn.';
        const turn = mcpTurn(2, [
            { callId: 'valid-first', body: retainedBody, observedAt: null },
            { callId: 'x'.repeat(ELEPHA_MCP_CALL_ID_MAX_BYTES + 1), body: 'oversized identity', observedAt: null },
        ]);

        expect(injections.recordElephaMcpReceipts(turn)).toBe(false);
        expect(injections.rememberElephaMcpReceipts(turn)).toBe(false);
        expect(db.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').get()).toEqual({ count: 0 });
        expect(db.prepare('SELECT COUNT(*) AS count FROM source_generations').get()).toEqual({ count: 0 });
        expect(injections.quoteBackStatus(quoteTurn(3, retainedBody, '2026-08-17T10:00:02.000Z'))).toBe('no-match');
    });

    it('gates MCP quote-back by active generation and source order, never by timestamps', () => {
        const db = openUnmanagedDb(':memory:');
        const injections = new InjectionStore(db);
        const body = 'A verified structural result body whose source order controls eligibility.';

        expect(injections.recordElephaMcpReceipts(mcpTurn(5, [{ callId: 'call-old', body, observedAt: '2099-01-01T00:00:00.000Z' }]))).toBe(
            true,
        );
        expect(injections.quoteBackStatus(quoteTurn(4, body, 'invalid'))).toBe('no-match');
        expect(injections.quoteBackStatus(quoteTurn(6, body, 'invalid'))).toBe('match');

        db.prepare('UPDATE source_generations SET generation = ? WHERE tool = ? AND native_id = ?').run(1, 'codex', 'mcp-session');
        expect(injections.quoteBackStatus(quoteTurn(6, body, 'invalid'))).toBe('no-match');
        expect(
            injections.recordElephaMcpReceipts(mcpTurn(5, [{ callId: 'call-current', body, observedAt: '2000-01-01T00:00:00.000Z' }]), 1),
        ).toBe(true);
        expect(injections.quoteBackStatus(quoteTurn(6, body, 'invalid'))).toBe('match');
        expect(injections.mcpReceiptsForSession('codex', 'mcp-session', 0)).toHaveLength(1);
        expect(injections.mcpReceiptsForSession('codex', 'mcp-session', 1)).toHaveLength(1);
    });

    it('returns explicit incomplete coverage when the bounded lookup row budget binds', () => {
        const store = new MemoryStore(openUnmanagedDb(':memory:'));
        const insert = store.database.prepare(
            `INSERT INTO injections (tool, native_session_id, injected_at, injection_id, body_hash, body)
             VALUES ('codex', 'bounded-session', '2026-08-17T10:00:00.000Z', ?, ?, ?)`,
        );
        for (let index = 0; index <= INJECTION_QUOTE_BACK_MAX_ROWS; index++) {
            insert.run(
                `row-${index}`,
                `legacy-hash-${index}`,
                `Historical injection body number ${index} with enough distinct text to remain unique.`,
            );
        }
        const turn: ParsedTurn = {
            tool: 'codex',
            sessionId: 'bounded-session',
            sourcePath: '/tmp/session.jsonl',
            projectPath: '/Users/test/project',
            turnIndex: 1,
            startedAt: '2026-08-17T11:00:00.000Z',
            endedAt: '2026-08-17T11:00:01.000Z',
            userMessage: 'Completely unrelated later work.',
            assistantText: 'Also unrelated.',
            toolCalls: [],
            cursor: '1',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        };

        expect(store.injectionQuoteBackStatus(turn)).toBe('incomplete');
    });

    it('returns incomplete when active MCP receipts reach the lookup overflow row', () => {
        const db = openUnmanagedDb(':memory:');
        const injections = new InjectionStore(db, { now: () => 0 });
        const insert = db.prepare(
            `INSERT INTO mcp_receipts
             (tool, native_session_id, source_generation, source_turn_index,
              call_id, observed_at, body_hash, body)
             VALUES ('codex', 'bounded-mcp-session', 0, ?, ?, NULL, ?, ?)`,
        );
        for (let index = 0; index <= INJECTION_QUOTE_BACK_MAX_ROWS; index++) {
            insert.run(
                index,
                `call-${index}`,
                `hash-${index}`,
                `Historical MCP receipt ${index} with distinct text that does not match the current turn.`,
            );
        }

        expect(
            injections.quoteBackStatus({
                ...quoteTurn(INJECTION_QUOTE_BACK_MAX_ROWS + 1, 'Completely unrelated later work.', 'invalid'),
                sessionId: 'bounded-mcp-session',
            }),
        ).toBe('incomplete');
    });

    it('rejects an oversized turn surface before normalization or matching', () => {
        const db = openUnmanagedDb(':memory:');
        let clockReads = 0;
        const injections = new InjectionStore(db, {
            now: () => {
                clockReads++;
                return 0;
            },
        });
        expect(
            injections.recordElephaMcpReceipts(
                mcpTurn(0, [{ callId: 'bounded-turn', body: 'A legitimate candidate body for the bounded matcher.', observedAt: null }]),
            ),
        ).toBe(true);

        const highEntropyTurn = randomBytes(INJECTION_QUOTE_BACK_TURN_MAX_BYTES + 1).toString('latin1');
        expect(injections.quoteBackStatus(quoteTurn(1, highEntropyTurn, 'invalid'))).toBe('incomplete');
        expect(clockReads).toBe(1);
    });

    it('does not inspect an oversized turn surface without an eligible candidate', () => {
        const db = openUnmanagedDb(':memory:');
        let clockReads = 0;
        const injections = new InjectionStore(db, {
            now: () => {
                clockReads++;
                return 0;
            },
        });
        const highEntropyTurn = randomBytes(INJECTION_QUOTE_BACK_TURN_MAX_BYTES + 1).toString('latin1');

        expect(injections.quoteBackStatus(quoteTurn(1, highEntropyTurn, 'invalid'))).toBe('no-match');
        expect(clockReads).toBe(0);
    });

    it('returns incomplete when the synchronous matcher deadline expires', () => {
        const db = openUnmanagedDb(':memory:');
        let clockReads = 0;
        const injections = new InjectionStore(db, {
            now: () => (++clockReads >= 8 ? INJECTION_QUOTE_BACK_BUDGET_MS : 0),
        });
        expect(
            injections.recordElephaMcpReceipts(
                mcpTurn(0, [
                    {
                        callId: 'deadline',
                        body: 'A distinct candidate body that requires the matcher to inspect normalized shingles.',
                        observedAt: null,
                    },
                ]),
            ),
        ).toBe(true);

        expect(injections.quoteBackStatus(quoteTurn(1, 'Completely unrelated high entropy text.', 'invalid'))).toBe('incomplete');
    });

    it('bounds transient MCP receipts across turns before quote-back lookup can become incomplete', () => {
        const db = openUnmanagedDb(':memory:');
        const injections = new InjectionStore(db);
        const receiptTurn = (index: number): ParsedTurn => ({
            tool: 'codex',
            sessionId: 'transient-bounded-session',
            sourcePath: '/tmp/session.jsonl',
            projectPath: '/Users/test/project',
            turnIndex: index,
            startedAt: '2026-08-17T10:00:00.000Z',
            endedAt: '2026-08-17T10:00:01.000Z',
            userMessage: '',
            assistantText: '',
            toolCalls: [],
            cursor: `${index}`,
            hasExternalContent: false,
            resumeMarkerBefore: false,
            droppedReason: 'elepha-mcp',
            elephaMcpResultReceipts: [
                {
                    callId: `call-${index}`,
                    body: `Unique transient MCP receipt body ${index}.`,
                    observedAt: '2026-08-17T10:00:00.000Z',
                },
            ],
        });

        for (let index = 0; index < INJECTION_QUOTE_BACK_MAX_ROWS; index++) {
            expect(injections.rememberElephaMcpReceipts(receiptTurn(index))).toBe(true);
        }
        expect(injections.rememberElephaMcpReceipts(receiptTurn(INJECTION_QUOTE_BACK_MAX_ROWS))).toBe(false);
        expect(db.prepare('SELECT COUNT(*) AS count FROM injections').get()).toEqual({ count: 0 });
    });
});

function mcpTurn(turnIndex: number, receipts: NonNullable<ParsedTurn['elephaMcpResultReceipts']>): ParsedTurn {
    return {
        ...quoteTurn(turnIndex, '', '2026-08-17T10:00:01.000Z'),
        userMessage: '',
        assistantText: '',
        droppedReason: 'elepha-mcp',
        elephaMcpResultReceipts: receipts,
    };
}

function quoteTurn(turnIndex: number, body: string, endedAt: string): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'mcp-session',
        sourcePath: '/tmp/session.jsonl',
        projectPath: '/Users/test/project',
        turnIndex,
        startedAt: endedAt,
        endedAt,
        userMessage: body,
        assistantText: '',
        toolCalls: [],
        cursor: `${turnIndex}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}
