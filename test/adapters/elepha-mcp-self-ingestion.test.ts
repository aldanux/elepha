import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { boundedMcpResult, ElephaMcpCoverageError } from '../../src/adapters/base.js';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import {
    ELEPHA_MCP_CALL_ID_MAX_BYTES,
    ELEPHA_MCP_RESULT_MAX_BYTES,
    ELEPHA_MCP_RESULTS_PER_TURN_MAX,
    ELEPHA_MCP_RESULTS_PER_TURN_MAX_BYTES,
    ELEPHA_MCP_UNMATCHED_RESULT_IDS_MAX,
    SESSION_CHAR_BUDGET,
} from '../../src/config/constants.js';
import type { ParsedTurn } from '../../src/types/index.js';

const cwd = '/Users/test/demo-project';

async function collect(iter: AsyncIterable<ParsedTurn>): Promise<ParsedTurn[]> {
    const turns: ParsedTurn[] = [];
    for await (const turn of iter) turns.push(turn);
    return turns;
}

function fixture(name: string, lines: unknown[]): string {
    const directory = path.join(process.cwd(), '.test-scratch', 'elepha-mcp-rule4-static');
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    return file;
}

function claudeTurn(name = 'mcp__elepha__future_tool', result: unknown = 'stored Elepha result body'): unknown[] {
    return [
        {
            type: 'user',
            cwd,
            timestamp: '2026-09-17T00:00:00.000Z',
            message: { role: 'user', content: 'What did we decide?' },
        },
        {
            type: 'assistant',
            cwd,
            timestamp: '2026-09-17T00:00:01.000Z',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name, input: {} }] },
        },
        {
            type: 'user',
            cwd,
            timestamp: '2026-09-17T00:00:02.000Z',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: result }] },
        },
        {
            type: 'assistant',
            cwd,
            timestamp: '2026-09-17T00:00:03.000Z',
            message: { role: 'assistant', content: [{ type: 'text', text: 'The earlier decision was to keep it local.' }] },
        },
    ];
}

function codexTurn(namespace = 'mcp__elepha', result: unknown = 'stored Elepha result body'): unknown[] {
    return [
        {
            timestamp: '2026-09-17T00:00:00.000Z',
            type: 'session_meta',
            payload: { id: '019fa000-0000-7000-8000-000000000123', cwd, originator: 'codex-tui' },
        },
        {
            timestamp: '2026-09-17T00:00:00.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What did we decide?' }] },
        },
        {
            timestamp: '2026-09-17T00:00:01.000Z',
            type: 'response_item',
            payload: { type: 'function_call', namespace, name: 'future_tool', arguments: '{}', call_id: 'call-1' },
        },
        {
            timestamp: '2026-09-17T00:00:02.000Z',
            type: 'response_item',
            payload: { type: 'function_call_output', call_id: 'call-1', output: result },
        },
        {
            timestamp: '2026-09-17T00:00:03.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'The earlier decision was to keep it local.' }],
            },
        },
    ];
}

function codexDesktopTurn(server = 'elepha', result: unknown = { content: [{ type: 'text', text: 'stored desktop result' }] }): unknown[] {
    return [
        {
            timestamp: '2026-09-17T00:00:00.000Z',
            type: 'session_meta',
            payload: { id: '019fa000-0000-7000-8000-000000000123', cwd, originator: 'codex-desktop' },
        },
        {
            timestamp: '2026-09-17T00:00:00.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What did we decide?' }] },
        },
        {
            timestamp: '2026-09-17T00:00:01.000Z',
            type: 'response_item',
            payload: { type: 'custom_tool_call', name: 'exec', input: '{}', call_id: 'outer-exec-call' },
        },
        {
            timestamp: '2026-09-17T00:00:02.000Z',
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                item: {
                    type: 'McpToolCall',
                    id: 'exec-real-desktop-id',
                    server,
                    tool: 'recall',
                    arguments: { query: 'What did we decide?' },
                    status: 'completed',
                    result,
                    duration: { secs: 1, nanos: 123 },
                },
            },
        },
        {
            timestamp: '2026-09-17T00:00:03.000Z',
            type: 'response_item',
            payload: { type: 'custom_tool_call_output', call_id: 'outer-exec-call', output: 'outer transport output' },
        },
        {
            timestamp: '2026-09-17T00:00:04.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'The earlier decision was to keep it local.' }],
            },
        },
    ];
}

describe.each([
    ['Claude Code', () => new ClaudeCodeAdapter(), 'session.jsonl', claudeTurn],
    ['Codex', () => new CodexAdapter(), 'rollout-session.jsonl', codexTurn],
] as const)('canonical Elepha MCP self-ingestion in $0', (_name, adapter, fileName, lines) => {
    it('drops the whole invoking turn, including immediate synthesis, and retains only verified receipt evidence', async () => {
        const turns = await collect(adapter().parseTurns(fixture(fileName, lines()), undefined, { closeTrailingOnIdle: true }));

        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            toolCalls: [],
            aiTitle: undefined,
            elephaMcpResultReceipts: [{ callId: 'call-1', body: 'stored Elepha result body' }],
        });
        expect(turns[0]!.assistantStructure).toBeUndefined();
    });

    it('does not match the same bare tool under another MCP server', async () => {
        const other = lines('mcp__other' as never);
        const turns = await collect(adapter().parseTurns(fixture(fileName, other), undefined, { closeTrailingOnIdle: true }));
        expect(turns[0]?.droppedReason).toBeUndefined();
        expect(turns[0]?.userMessage).toBe('What did we decide?');
    });
});

describe('Elepha MCP coverage failures', () => {
    it('fails closed at the next boundary when a canonical result is missing', async () => {
        const lines = claudeTurn().filter(
            (line) => !JSON.stringify(line).includes('tool_result') && !JSON.stringify(line).includes('earlier decision'),
        );
        lines.push({ type: 'user', cwd, timestamp: '2026-09-17T00:00:04.000Z', message: { role: 'user', content: 'Next' } });

        await expect(collect(new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines)))).rejects.toMatchObject({
            reason: 'missing-result',
        });
    });

    it('fails closed at an interrupted EOF when a canonical result is missing', async () => {
        const lines = claudeTurn().filter(
            (line) => !JSON.stringify(line).includes('tool_result') && !JSON.stringify(line).includes('earlier decision'),
        );

        await expect(
            collect(new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'missing-result' });
    });

    it('does not retroactively accept a result that arrives after the next turn boundary', async () => {
        const lines = claudeTurn().filter(
            (line) => !JSON.stringify(line).includes('tool_result') && !JSON.stringify(line).includes('earlier decision'),
        );
        lines.push(
            { type: 'user', cwd, timestamp: '2026-09-17T00:00:04.000Z', message: { role: 'user', content: 'Next' } },
            {
                type: 'user',
                cwd,
                timestamp: '2026-09-17T00:00:05.000Z',
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'late' }] },
            },
        );

        await expect(collect(new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines)))).rejects.toMatchObject({
            reason: 'missing-result',
        });
    });

    it('rejects out-of-order result correlation', async () => {
        const lines = claudeTurn();
        [lines[1], lines[2]] = [lines[2], lines[1]];
        lines.push({ type: 'user', cwd, timestamp: '2026-09-17T00:00:04.000Z', message: { role: 'user', content: 'Next' } });
        await expect(
            collect(new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toBeInstanceOf(ElephaMcpCoverageError);
    });

    it('rejects a forged canonical call envelope without a correlation ID', async () => {
        const lines = claudeTurn();
        delete (lines[1] as { message: { content: Array<{ id?: string }> } }).message.content[0]!.id;

        await expect(
            collect(new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'missing-call-id' });
    });

    it('rejects an oversized Claude MCP call ID without truncating it', async () => {
        const lines = claudeTurn();
        const oversizedCallId = 'c'.repeat(ELEPHA_MCP_CALL_ID_MAX_BYTES + 1);
        (lines[1] as { message: { content: Array<{ id: string }> } }).message.content[0]!.id = oversizedCallId;
        (lines[2] as { message: { content: Array<{ tool_use_id: string }> } }).message.content[0]!.tool_use_id = oversizedCallId;

        await expect(
            collect(new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'oversized-call-id' });
    });

    it('rejects a result larger than the canonical serving budget without truncating it', async () => {
        const lines = codexTurn('mcp__elepha', 'x'.repeat(ELEPHA_MCP_RESULT_MAX_BYTES + 1));
        await expect(
            collect(new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'oversized-result' });
    });

    it('bounds a JSON-encoded string before attempting to decode its envelope', () => {
        const encoded = JSON.stringify({ content: [{ type: 'text', text: 'x'.repeat(ELEPHA_MCP_RESULT_MAX_BYTES) }] });

        expect(boundedMcpResult(encoded)).toEqual({ state: 'incomplete', reason: 'oversized-result' });
    });

    it('accepts the complete served-character budget when every character is multibyte', async () => {
        const body = '😀'.repeat(SESSION_CHAR_BUDGET);
        const turns = await collect(
            new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', codexTurn('mcp__elepha', body)), undefined, {
                closeTrailingOnIdle: true,
            }),
        );
        expect(turns[0]?.elephaMcpResultReceipts?.[0]?.body).toBe(body);
    });

    it('does not reinterpret arbitrary textual JSON as an MCP result envelope', async () => {
        const body = JSON.stringify({ content: 'ordinary JSON text' });
        const turns = await collect(
            new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', codexTurn('mcp__elepha', body)), undefined, {
                closeTrailingOnIdle: true,
            }),
        );
        expect(turns[0]?.elephaMcpResultReceipts?.[0]?.body).toBe(body);
    });

    it('treats marker-like prose as ordinary content', async () => {
        const lines = claudeTurn('Read');
        (lines[0] as { message: { content: string } }).message.content = 'I saw mcp__elepha__get_session in some prose.';
        const turns = await collect(
            new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true }),
        );
        expect(turns[0]?.droppedReason).toBeUndefined();
    });

    it('correlates mixed, multiple, and error result envelopes without preserving turn content', async () => {
        const lines = claudeTurn();
        lines.splice(
            2,
            0,
            {
                type: 'assistant',
                cwd,
                timestamp: '2026-09-17T00:00:01.500Z',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'tool_use', id: 'call-other', name: 'Read', input: { file_path: 'README.md' } },
                        { type: 'tool_use', id: 'call-2', name: 'mcp__elepha__unknown_future_tool', input: {} },
                    ],
                },
            },
            {
                type: 'user',
                cwd,
                timestamp: '2026-09-17T00:00:02.000Z',
                message: {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'call-other', content: 'ordinary result' },
                        { type: 'tool_result', tool_use_id: 'call-2', content: 'Elepha error body', is_error: true },
                    ],
                },
            },
        );
        const turns = await collect(
            new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true }),
        );
        expect(turns[0]?.droppedReason).toBe('elepha-mcp');
        expect(turns[0]?.elephaMcpResultReceipts).toMatchObject([
            { callId: 'call-2', body: 'Elepha error body' },
            { callId: 'call-1', body: 'stored Elepha result body' },
        ]);
    });

    it('rejects a duplicate result envelope for the same canonical call', async () => {
        const lines = claudeTurn();
        lines.splice(3, 0, {
            type: 'user',
            cwd,
            timestamp: '2026-09-17T00:00:02.500Z',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'duplicate' }] },
        });

        await expect(
            collect(new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'duplicate-call-id' });
    });

    it('fails while accumulating more canonical calls than the evidence bound', async () => {
        const calls = Array.from({ length: ELEPHA_MCP_RESULTS_PER_TURN_MAX + 1 }, (_, index) => ({
            type: 'tool_use',
            id: `call-${index}`,
            name: 'mcp__elepha__future_tool',
            input: {},
        }));
        const results = calls.map((call) => ({ type: 'tool_result', tool_use_id: call.id, content: 'bounded result' }));
        const lines = claudeTurn();
        (lines[1] as { message: { content: unknown[] } }).message.content = calls;
        (lines[2] as { message: { content: unknown[] } }).message.content = results;

        await expect(
            collect(new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'oversized-call-set' });
    });

    it('fails when individually valid results cross the aggregate evidence byte bound', async () => {
        const resultCount = Math.floor(ELEPHA_MCP_RESULTS_PER_TURN_MAX_BYTES / ELEPHA_MCP_RESULT_MAX_BYTES) + 1;
        const calls = Array.from({ length: resultCount }, (_, index) => ({
            type: 'tool_use',
            id: `aggregate-${index}`,
            name: 'mcp__elepha__future_tool',
            input: {},
        }));
        const results = calls.map((call) => ({
            type: 'tool_result',
            tool_use_id: call.id,
            content: 'x'.repeat(ELEPHA_MCP_RESULT_MAX_BYTES),
        }));
        const lines = claudeTurn();
        (lines[1] as { message: { content: unknown[] } }).message.content = calls;
        (lines[2] as { message: { content: unknown[] } }).message.content = results;

        await expect(
            collect(new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'oversized-result' });
    });

    it('uses a canonical prior turn timestamp when the result timestamp is malformed', async () => {
        const lines = codexTurn();
        (lines[3] as { timestamp: string }).timestamp = 'not-a-timestamp';
        const turns = await collect(
            new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', lines), undefined, { closeTrailingOnIdle: true }),
        );

        expect(turns[0]?.elephaMcpResultReceipts?.[0]?.observedAt).toBe('2026-09-17T00:00:01.000Z');
    });

    it('keeps diagnostic chronology anchored to the turn when the result timestamp is in the future', async () => {
        const lines = codexTurn();
        (lines[3] as { timestamp: string }).timestamp = '2099-01-01T00:00:00.000Z';
        const turns = await collect(
            new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', lines), undefined, { closeTrailingOnIdle: true }),
        );

        expect(turns[0]?.elephaMcpResultReceipts?.[0]?.observedAt).toBe('2026-09-17T00:00:01.000Z');
    });

    it('keeps an MCP receipt with a null diagnostic timestamp when every timestamp is invalid', async () => {
        const lines = claudeTurn();
        for (const line of lines as Array<{ timestamp: string }>) {
            line.timestamp = 'not-a-timestamp';
        }

        const turns = await collect(
            new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true }),
        );

        expect(turns[0]?.elephaMcpResultReceipts?.[0]?.observedAt).toBeNull();
    });

    it('allows a following clean turn to remain persistable', async () => {
        const lines = claudeTurn();
        lines.push(
            { type: 'user', cwd, timestamp: '2026-09-17T00:00:04.000Z', message: { role: 'user', content: 'Unrelated clean work' } },
            {
                type: 'assistant',
                cwd,
                timestamp: '2026-09-17T00:00:05.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Completed unrelated clean work.' }] },
            },
        );
        const turns = await collect(
            new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true }),
        );
        expect(turns).toHaveLength(2);
        expect(turns[0]?.droppedReason).toBe('elepha-mcp');
        expect(turns[1]?.userMessage).toBe('Unrelated clean work');
        expect(turns[1]?.droppedReason).toBeUndefined();
    });

    it('bounds ordinary Claude result correlation and fails only when a later Elepha call needs discarded history', async () => {
        const ordinary = claudeTurn('Read');
        (ordinary[2] as { message: { content: unknown[] } }).message.content = Array.from(
            { length: ELEPHA_MCP_UNMATCHED_RESULT_IDS_MAX + 1 },
            (_, index) => ({ type: 'tool_result', tool_use_id: `ordinary-${index}`, content: 'ordinary result' }),
        );
        const turns = await collect(
            new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', ordinary), undefined, { closeTrailingOnIdle: true }),
        );
        expect(turns[0]?.droppedReason).toBeUndefined();

        const relevant = structuredClone(ordinary);
        relevant.splice(
            3,
            0,
            {
                type: 'assistant',
                cwd,
                timestamp: '2026-09-17T00:00:02.500Z',
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'later-elepha', name: 'mcp__elepha__recall', input: {} }],
                },
            },
            {
                type: 'user',
                cwd,
                timestamp: '2026-09-17T00:00:02.750Z',
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'later-elepha', content: 'later result' }],
                },
            },
        );
        await expect(
            collect(new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', relevant), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'incomplete-correlation' });
    });

    it('bounds open canonical Claude calls before retaining an unbounded set', async () => {
        const lines = claudeTurn();
        (lines[1] as { message: { content: unknown[] } }).message.content = Array.from(
            { length: ELEPHA_MCP_RESULTS_PER_TURN_MAX + 1 },
            (_, index) => ({ type: 'tool_use', id: `open-${index}`, name: 'mcp__elepha__recall', input: {} }),
        );
        (lines[2] as { message: { content: unknown[] } }).message.content = [];

        await expect(
            collect(new ClaudeCodeAdapter().parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'oversized-call-set' });
    });
});

describe('Codex Elepha MCP envelope coverage', () => {
    it('keeps an explicit Codex lifecycle open until its matching completion while legacy turns retain idle close', async () => {
        const legacy = codexDesktopTurn('other');
        expect(
            await collect(
                new CodexAdapter().parseTurns(fixture('rollout-legacy-idle.jsonl', legacy), undefined, { closeTrailingOnIdle: true }),
            ),
        ).toHaveLength(1);

        const lifecycle = structuredClone(legacy);
        lifecycle.splice(1, 0, {
            timestamp: '2026-09-17T00:00:00.000Z',
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'provider-turn-1' },
        });
        const file = fixture('rollout-explicit-lifecycle.jsonl', lifecycle);
        expect(await collect(new CodexAdapter().parseTurns(file, undefined, { closeTrailingOnIdle: true }))).toEqual([]);

        lifecycle.push({
            timestamp: '2026-09-17T00:00:05.000Z',
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'different-provider-turn' },
        });
        fixture('rollout-explicit-lifecycle.jsonl', lifecycle);
        expect(await collect(new CodexAdapter().parseTurns(file, undefined, { closeTrailingOnIdle: true }))).toEqual([]);

        lifecycle.push({
            timestamp: '2026-09-17T00:00:06.000Z',
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'provider-turn-1' },
        });
        fixture('rollout-explicit-lifecycle.jsonl', lifecycle);
        expect(await collect(new CodexAdapter().parseTurns(file, undefined, { closeTrailingOnIdle: true }))).toHaveLength(1);
    });

    it('drops the real Codex Desktop MCP item and records its bounded result', async () => {
        const turns = await collect(
            new CodexAdapter().parseTurns(fixture('rollout-desktop.jsonl', codexDesktopTurn()), undefined, {
                closeTrailingOnIdle: true,
            }),
        );

        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            toolCalls: [],
            elephaMcpResultReceipts: [
                {
                    callId: 'exec-real-desktop-id',
                    body: 'stored desktop result',
                    observedAt: '2026-09-17T00:00:01.000Z',
                },
            ],
        });
    });

    it('deduplicates matching CLI and Desktop evidence but rejects conflicting bodies', async () => {
        const lines = codexDesktopTurn();
        lines.splice(3, 0, {
            timestamp: '2026-09-17T00:00:01.500Z',
            type: 'response_item',
            payload: {
                type: 'function_call',
                namespace: 'mcp__elepha',
                name: 'recall',
                arguments: '{}',
                call_id: 'exec-real-desktop-id',
            },
        });
        lines.splice(5, 0, {
            timestamp: '2026-09-17T00:00:02.500Z',
            type: 'response_item',
            payload: {
                type: 'function_call_output',
                call_id: 'exec-real-desktop-id',
                output: [{ type: 'text', text: 'stored desktop result' }],
            },
        });

        const turns = await collect(
            new CodexAdapter().parseTurns(fixture('rollout-desktop.jsonl', lines), undefined, { closeTrailingOnIdle: true }),
        );

        expect(turns[0]?.droppedReason).toBe('elepha-mcp');
        expect(turns[0]?.elephaMcpResultReceipts).toHaveLength(1);
        expect(turns[0]?.elephaMcpResultReceipts?.[0]?.body).toBe('stored desktop result');

        (lines[5] as { payload: { output: unknown } }).payload.output = [{ type: 'text', text: 'conflicting result' }];
        await expect(
            collect(new CodexAdapter().parseTurns(fixture('rollout-desktop.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'duplicate-call-id' });
    });

    it('does not treat another Codex Desktop MCP server as Elepha', async () => {
        const turns = await collect(
            new CodexAdapter().parseTurns(fixture('rollout-desktop.jsonl', codexDesktopTurn('other')), undefined, {
                closeTrailingOnIdle: true,
            }),
        );

        expect(turns[0]?.droppedReason).toBeUndefined();
        expect(turns[0]?.userMessage).toBe('What did we decide?');
    });

    it('rejects a malformed Codex Desktop Elepha item without an ID', async () => {
        const lines = codexDesktopTurn();
        delete (lines[3] as { payload: { item: { id?: string } } }).payload.item.id;

        await expect(
            collect(new CodexAdapter().parseTurns(fixture('rollout-desktop.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'missing-call-id' });
    });

    it('rejects an oversized Codex Desktop Elepha result', async () => {
        const result = { content: [{ type: 'text', text: 'x'.repeat(ELEPHA_MCP_RESULT_MAX_BYTES + 1) }] };

        await expect(
            collect(
                new CodexAdapter().parseTurns(fixture('rollout-desktop.jsonl', codexDesktopTurn('elepha', result)), undefined, {
                    closeTrailingOnIdle: true,
                }),
            ),
        ).rejects.toMatchObject({ reason: 'oversized-result' });
    });

    it('rejects a canonical call without an ID', async () => {
        const lines = codexTurn();
        delete (lines[2] as { payload: { call_id?: string } }).payload.call_id;
        await expect(
            collect(new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'missing-call-id' });
    });

    it('rejects an oversized Codex MCP call ID without truncating it', async () => {
        const lines = codexTurn();
        const oversizedCallId = '😀'.repeat(Math.floor(ELEPHA_MCP_CALL_ID_MAX_BYTES / 4) + 1);
        (lines[2] as { payload: { call_id: string } }).payload.call_id = oversizedCallId;
        (lines[3] as { payload: { call_id: string } }).payload.call_id = oversizedCallId;

        await expect(
            collect(new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'oversized-call-id' });
    });

    it('rejects a canonical call without its result', async () => {
        const lines = codexTurn().filter((line) => (line as { payload?: { type?: string } }).payload?.type !== 'function_call_output');
        await expect(
            collect(new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'missing-result' });
    });

    it('rejects out-of-order and duplicate result envelopes', async () => {
        const outOfOrder = codexTurn();
        [outOfOrder[2], outOfOrder[3]] = [outOfOrder[3], outOfOrder[2]];
        await expect(
            collect(new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', outOfOrder), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'out-of-order-result' });

        const duplicate = codexTurn();
        duplicate.splice(4, 0, structuredClone(duplicate[3]));
        await expect(
            collect(new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', duplicate), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'duplicate-call-id' });
    });

    it('correlates multiple canonical calls and rejects unsupported result bodies', async () => {
        const multiple = codexTurn();
        multiple.splice(
            3,
            0,
            {
                timestamp: '2026-09-17T00:00:01.500Z',
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    namespace: 'mcp__elepha',
                    name: 'another_tool',
                    arguments: '{}',
                    call_id: 'call-2',
                },
            },
            {
                timestamp: '2026-09-17T00:00:01.750Z',
                type: 'response_item',
                payload: { type: 'function_call_output', call_id: 'call-2', output: 'second result' },
            },
        );
        const turns = await collect(
            new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', multiple), undefined, { closeTrailingOnIdle: true }),
        );
        expect(turns[0]?.elephaMcpResultReceipts).toMatchObject([
            { callId: 'call-2', body: 'second result' },
            { callId: 'call-1', body: 'stored Elepha result body' },
        ]);

        const unsupported = codexTurn('mcp__elepha', { unexpected: true });
        await expect(
            collect(new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', unsupported), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'unsupported-result' });
    });

    it('bounds ordinary Codex result correlation and fails only when a later Elepha call needs discarded history', async () => {
        const ordinary = codexTurn('mcp__other');
        ordinary.splice(
            3,
            1,
            ...Array.from({ length: ELEPHA_MCP_UNMATCHED_RESULT_IDS_MAX + 1 }, (_, index) => ({
                timestamp: '2026-09-17T00:00:02.000Z',
                type: 'response_item',
                payload: { type: 'function_call_output', call_id: `ordinary-${index}`, output: 'ordinary result' },
            })),
        );
        const turns = await collect(
            new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', ordinary), undefined, { closeTrailingOnIdle: true }),
        );
        expect(turns[0]?.droppedReason).toBeUndefined();

        const relevant = structuredClone(ordinary);
        relevant.splice(
            relevant.length - 1,
            0,
            {
                timestamp: '2026-09-17T00:00:02.500Z',
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    namespace: 'mcp__elepha',
                    name: 'recall',
                    arguments: '{}',
                    call_id: 'later-elepha',
                },
            },
            {
                timestamp: '2026-09-17T00:00:02.750Z',
                type: 'response_item',
                payload: { type: 'function_call_output', call_id: 'later-elepha', output: 'later result' },
            },
        );
        await expect(
            collect(new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', relevant), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'incomplete-correlation' });
    });

    it('bounds open canonical Codex calls before retaining an unbounded set', async () => {
        const lines = codexTurn();
        lines.splice(
            2,
            2,
            ...Array.from({ length: ELEPHA_MCP_RESULTS_PER_TURN_MAX + 1 }, (_, index) => ({
                timestamp: '2026-09-17T00:00:01.000Z',
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    namespace: 'mcp__elepha',
                    name: 'recall',
                    arguments: '{}',
                    call_id: `open-${index}`,
                },
            })),
        );

        await expect(
            collect(new CodexAdapter().parseTurns(fixture('rollout-session.jsonl', lines), undefined, { closeTrailingOnIdle: true })),
        ).rejects.toMatchObject({ reason: 'oversized-call-set' });
    });
});
