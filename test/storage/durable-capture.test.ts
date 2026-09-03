import { describe, expect, it } from 'vitest';
import { DURABLE_CAPTURE_FILTER_VERSION, SESSION_CHAR_BUDGET } from '../../src/config/constants.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';

function turn(overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'durable-session',
        sourcePath: '/repo/session.jsonl',
        projectPath: '/repo',
        turnIndex: 0,
        startedAt: '2026-09-03T00:00:00.000Z',
        endedAt: '2026-09-03T00:00:01.000Z',
        userMessage: 'durable needle prompt',
        assistantText: 'durable response',
        toolCalls: [
            { name: 'read_file', filePaths: ['/repo/src/a.ts'] },
            { name: 'pathless', filePaths: [], text: '{"command":"never store me"}' },
        ],
        cursor: '100|1',
        hasExternalContent: false,
        resumeMarkerBefore: false,
        ...overrides,
    };
}

const summary = { decisions: [], pending_items: [], status: 'not_configured' as const };

function fixture(): { store: MemoryStore; projectId: number; sessionId: number } {
    const store = new MemoryStore(openDb(':memory:'));
    const project = store.upsertProject('/repo');
    const session = store.upsertSession('codex', 'durable-session', project.id, '/repo/session.jsonl');
    return { store, projectId: project.id, sessionId: session.id };
}

describe('durable capture storage', () => {
    it('writes no filtered turn or status when durable capture is disabled by default', () => {
        const { store, projectId, sessionId } = fixture();

        expect(store.recordTurn(turn(), sessionId, projectId, summary)).toBe(true);

        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM durable_capture_status').get()).toEqual({ count: 0 });
    });

    it('writes a filtered row, its FTS entry, and complete status when enabled', () => {
        const { store, projectId, sessionId } = fixture();

        expect(store.recordTurn(turn(), sessionId, projectId, summary, true)).toBe(true);

        expect(store.database.prepare('SELECT * FROM filtered_turns').get()).toEqual(
            expect.objectContaining({
                included: 1,
                user_prompt: 'durable needle prompt',
                assistant_response: 'durable response',
                tool_calls: JSON.stringify([{ name: 'read_file', filePaths: ['/repo/src/a.ts'] }]),
                omitted_tool_call_count: 1,
                dropped_tool_ref_count: 0,
                omitted_before_chars: 0,
                filter_version: DURABLE_CAPTURE_FILTER_VERSION,
            }),
        );
        expect(store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'needle'").all()).toEqual([
            { rowid: 1 },
        ]);
        expect(store.database.prepare('SELECT state, filter_version FROM durable_capture_status').get()).toEqual({
            state: 'complete',
            filter_version: DURABLE_CAPTURE_FILTER_VERSION,
        });

        store.database.prepare("UPDATE filtered_turns SET user_prompt = 'replacement term'").run();
        expect(store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'needle'").all()).toEqual([]);
        expect(store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'replacement'").all()).toEqual([
            { rowid: 1 },
        ]);
        store.database.prepare('DELETE FROM filtered_turns').run();
        expect(store.database.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'replacement'").all()).toEqual(
            [],
        );
    });

    it('records an accepted filter-excluded turn with empty content', () => {
        const { store, projectId, sessionId } = fixture();

        expect(
            store.recordTurn(
                turn({ userMessage: 'pause here', assistantText: 'Okay, waiting.', toolCalls: [] }),
                sessionId,
                projectId,
                summary,
                true,
            ),
        ).toBe(true);

        expect(store.database.prepare('SELECT included, user_prompt, assistant_response, tool_calls FROM filtered_turns').get()).toEqual({
            included: 0,
            user_prompt: '',
            assistant_response: '',
            tool_calls: '[]',
        });
        expect(store.database.prepare('SELECT state FROM durable_capture_status').get()).toEqual({ state: 'complete' });
    });

    it('rolls back the memory and cursor when the durable write fails', () => {
        const { store, projectId, sessionId } = fixture();
        store.database.exec(`
          CREATE TRIGGER force_durable_failure BEFORE INSERT ON filtered_turns BEGIN
            SELECT RAISE(ABORT, 'forced durable failure');
          END;
        `);

        expect(() => store.recordTurn(turn(), sessionId, projectId, summary, true)).toThrow('forced durable failure');

        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM durable_capture_status').get()).toEqual({ count: 0 });
        expect(store.getSessionCursor('codex', 'durable-session')).toBeUndefined();
    });

    it('drops oversized content from the oldest end and marks the session truncated', () => {
        const { store, projectId, sessionId } = fixture();
        const userMessage = `old-${'x'.repeat(SESSION_CHAR_BUDGET + 100)}`;
        const assistantText = 'newest-response';

        expect(store.recordTurn(turn({ userMessage, assistantText, toolCalls: [] }), sessionId, projectId, summary, true)).toBe(true);

        const stored = store.database.prepare('SELECT user_prompt, assistant_response, omitted_before_chars FROM filtered_turns').get() as {
            user_prompt: string;
            assistant_response: string;
            omitted_before_chars: number;
        };
        expect(stored.omitted_before_chars).toBe(userMessage.length + assistantText.length - SESSION_CHAR_BUDGET);
        expect(stored.user_prompt).toBe(userMessage.slice(stored.omitted_before_chars));
        expect(stored.assistant_response).toBe(assistantText);
        expect(stored.user_prompt.length + stored.assistant_response.length).toBe(SESSION_CHAR_BUDGET);
        expect(store.database.prepare('SELECT state FROM durable_capture_status').get()).toEqual({ state: 'complete_truncated' });
    });

    it('marks a session with earlier non-durable memories as a disabled gap', () => {
        const { store, projectId, sessionId } = fixture();
        expect(store.recordTurn(turn(), sessionId, projectId, summary)).toBe(true);
        expect(store.recordTurn(turn({ turnIndex: 1, cursor: '200|2' }), sessionId, projectId, summary, true)).toBe(true);

        expect(store.database.prepare('SELECT state FROM durable_capture_status').get()).toEqual({ state: 'disabled_gap' });
    });

    it('never exposes shell syntax by truncating between an escape and its token', () => {
        const { store, projectId, sessionId } = fixture();
        const userMessage = `${'x'.repeat(9)}\`${'y'.repeat(SESSION_CHAR_BUDGET - 1)}`;

        expect(store.recordTurn(turn({ userMessage, assistantText: '', toolCalls: [] }), sessionId, projectId, summary, true)).toBe(true);

        expect(store.database.prepare('SELECT user_prompt, omitted_before_chars FROM filtered_turns').get()).toEqual({
            user_prompt: 'y'.repeat(SESSION_CHAR_BUDGET - 1),
            omitted_before_chars: 11,
        });
    });
});
