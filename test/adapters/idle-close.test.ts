import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { ParsedTurn, SessionAdapter } from '../../src/types/index.js';
import { withTempDir } from '../helpers/tmp.js';

interface IdleCloseFixture {
    name: string;
    adapter: () => SessionAdapter;
    fileName: string;
    expectedToolName: string;
    opening: string[];
    openingWithAssistantText: string[];
    completion: string[];
    expectedPostIdleFilePath: string;
    nextBoundary: string;
}

const cwd = '/Users/test/demo-project';

function jsonl(lines: string[]): string {
    return `${lines.join('\n')}\n`;
}

async function collect(iter: AsyncIterable<ParsedTurn>): Promise<ParsedTurn[]> {
    const turns: ParsedTurn[] = [];
    for await (const turn of iter) turns.push(turn);
    return turns;
}

const fixtures: IdleCloseFixture[] = [
    {
        name: 'Claude Code',
        adapter: () => new ClaudeCodeAdapter(),
        fileName: 'session.jsonl',
        expectedToolName: 'Read',
        opening: [
            JSON.stringify({
                type: 'user',
                cwd,
                sessionId: 'idle-close-claude',
                timestamp: '2026-08-24T00:00:00.000Z',
                message: { role: 'user', content: 'Inspect the file' },
            }),
            JSON.stringify({
                type: 'assistant',
                cwd,
                sessionId: 'idle-close-claude',
                timestamp: '2026-08-24T00:00:01.000Z',
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/index.ts' } }],
                },
            }),
        ],
        openingWithAssistantText: [
            JSON.stringify({
                type: 'user',
                cwd,
                sessionId: 'idle-close-claude',
                timestamp: '2026-08-24T00:00:00.000Z',
                message: { role: 'user', content: 'Inspect the file' },
            }),
            JSON.stringify({
                type: 'assistant',
                cwd,
                sessionId: 'idle-close-claude',
                timestamp: '2026-08-24T00:00:01.000Z',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Let me check.' },
                        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/index.ts' } },
                    ],
                },
            }),
        ],
        completion: [
            JSON.stringify({
                type: 'user',
                cwd,
                sessionId: 'idle-close-claude',
                timestamp: '2026-08-24T00:00:02.000Z',
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }] },
            }),
            JSON.stringify({
                type: 'assistant',
                cwd,
                sessionId: 'idle-close-claude',
                timestamp: '2026-08-24T00:00:03.000Z',
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'src/after-idle.ts' } }],
                },
            }),
            JSON.stringify({
                type: 'user',
                cwd,
                sessionId: 'idle-close-claude',
                timestamp: '2026-08-24T00:00:04.000Z',
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'more contents' }] },
            }),
            JSON.stringify({
                type: 'assistant',
                cwd,
                sessionId: 'idle-close-claude',
                timestamp: '2026-08-24T00:00:05.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'The file is valid.' }] },
            }),
        ],
        expectedPostIdleFilePath: path.join(cwd, 'src/after-idle.ts'),
        nextBoundary: JSON.stringify({
            type: 'user',
            cwd,
            sessionId: 'idle-close-claude',
            timestamp: '2026-08-24T00:00:04.000Z',
            message: { role: 'user', content: 'Next request' },
        }),
    },
    {
        name: 'Codex',
        adapter: () => new CodexAdapter(),
        fileName: 'rollout-idle-close.jsonl',
        expectedToolName: 'read_file',
        opening: [
            JSON.stringify({
                timestamp: '2026-08-24T00:00:00.000Z',
                type: 'session_meta',
                payload: { id: 'idle-close-codex', cwd, originator: 'codex-tui' },
            }),
            JSON.stringify({
                timestamp: '2026-08-24T00:00:00.000Z',
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the file' }] },
            }),
            JSON.stringify({
                timestamp: '2026-08-24T00:00:01.000Z',
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'read_file',
                    arguments: JSON.stringify({ file_path: 'src/index.ts' }),
                    call_id: 'tool-1',
                },
            }),
        ],
        openingWithAssistantText: [
            JSON.stringify({
                timestamp: '2026-08-24T00:00:00.000Z',
                type: 'session_meta',
                payload: { id: 'idle-close-codex', cwd, originator: 'codex-tui' },
            }),
            JSON.stringify({
                timestamp: '2026-08-24T00:00:00.000Z',
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the file' }] },
            }),
            JSON.stringify({
                timestamp: '2026-08-24T00:00:01.000Z',
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me check.' }] },
            }),
            JSON.stringify({
                timestamp: '2026-08-24T00:00:01.500Z',
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'read_file',
                    arguments: JSON.stringify({ file_path: 'src/index.ts' }),
                    call_id: 'tool-1',
                },
            }),
        ],
        completion: [
            JSON.stringify({
                timestamp: '2026-08-24T00:00:02.000Z',
                type: 'response_item',
                payload: { type: 'function_call_output', call_id: 'tool-1', output: 'file contents' },
            }),
            JSON.stringify({
                timestamp: '2026-08-24T00:00:03.000Z',
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'read_file',
                    arguments: JSON.stringify({ file_path: 'src/after-idle.ts' }),
                    call_id: 'tool-2',
                },
            }),
            JSON.stringify({
                timestamp: '2026-08-24T00:00:04.000Z',
                type: 'response_item',
                payload: { type: 'function_call_output', call_id: 'tool-2', output: 'more contents' },
            }),
            JSON.stringify({
                timestamp: '2026-08-24T00:00:05.000Z',
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The file is valid.' }] },
            }),
        ],
        expectedPostIdleFilePath: path.join(cwd, 'src/after-idle.ts'),
        nextBoundary: JSON.stringify({
            timestamp: '2026-08-24T00:00:04.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next request' }] },
        }),
    },
];

describe.each(fixtures)(
    '$name idle-close completeness',
    ({ adapter, fileName, expectedToolName, opening, openingWithAssistantText, completion, expectedPostIdleFilePath, nextBoundary }) => {
        function transcript(lines = opening): string {
            const directory = withTempDir('elepha-idle-close-');
            const file = path.join(directory, fileName);
            writeFileSync(file, jsonl(lines));
            return file;
        }

        it('keeps assistant text with an unresolved call open, then emits the complete turn once', async () => {
            const file = transcript(openingWithAssistantText);
            const subject = adapter();

            const whileToolIsOpen = await collect(subject.parseTurns(file, undefined, { closeTrailingOnIdle: true }));
            expect(whileToolIsOpen).toEqual([]);
            expect(whileToolIsOpen.map((turn) => turn.cursor)).toEqual([]);

            appendFileSync(file, jsonl(completion));
            const completed = await collect(subject.parseTurns(file, undefined, { closeTrailingOnIdle: true }));

            expect(completed).toHaveLength(1);
            expect(completed[0]!.userMessage).toBe('Inspect the file');
            expect(completed[0]!.toolCalls).toHaveLength(2);
            expect(completed[0]!.toolCalls[0]!.name).toBe(expectedToolName);
            expect(completed[0]!.toolCalls.flatMap((call) => call.filePaths)).toContain(expectedPostIdleFilePath);
            expect(completed[0]!.assistantText).toBe('Let me check.\nThe file is valid.');
        });

        it('does not emit or produce a cursor when startup finds only an open tool call', async () => {
            const turns = await collect(adapter().parseTurns(transcript(), undefined, { closeTrailingOnIdle: true }));

            expect(turns).toEqual([]);
            expect(turns.map((turn) => turn.cursor)).toEqual([]);
        });

        it('still idle-closes a completed trailing turn with assistant text', async () => {
            const file = transcript();
            appendFileSync(file, jsonl(completion));

            const turns = await collect(adapter().parseTurns(file, undefined, { closeTrailingOnIdle: true }));

            expect(turns).toHaveLength(1);
            expect(turns[0]!.toolCalls).toHaveLength(2);
            expect(turns[0]!.assistantText).toBe('The file is valid.');
        });

        it('still closes a tool-only turn at the next boundary', async () => {
            const file = transcript();
            appendFileSync(file, jsonl([nextBoundary]));

            const turns = await collect(adapter().parseTurns(file, undefined, { closeTrailingOnIdle: false }));

            expect(turns).toHaveLength(1);
            expect(turns[0]!.userMessage).toBe('Inspect the file');
            expect(turns[0]!.toolCalls).toHaveLength(1);
            expect(turns[0]!.assistantText).toBe('');
        });
    },
);
