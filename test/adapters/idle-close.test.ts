import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { OpenTailObservation, ParsedTurn, SessionAdapter } from '../../src/types/index.js';
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

describe('Codex explicit lifecycle completion', () => {
    function transcript(lines: unknown[]): string {
        const directory = withTempDir('elepha-codex-lifecycle-');
        const file = path.join(directory, 'rollout-lifecycle.jsonl');
        writeFileSync(file, jsonl(lines.map((line) => JSON.stringify(line))));
        return file;
    }

    const failedAttempt = (sessionId = 'failed-eof') => [
        {
            timestamp: '2026-09-18T08:46:00.000Z',
            type: 'session_meta',
            payload: { id: sessionId, cwd, originator: 'codex-desktop' },
        },
        {
            timestamp: '2026-09-18T08:46:01.000Z',
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'provider-attempt-1' },
        },
        {
            timestamp: '2026-09-18T08:46:02.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate the issue.' }] },
        },
        {
            timestamp: '2026-09-18T08:46:03.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                phase: 'commentary',
                content: [{ type: 'output_text', text: 'Partial investigation.' }],
            },
        },
        {
            timestamp: '2026-09-18T08:47:17.715Z',
            type: 'event_msg',
            payload: {
                type: 'task_complete',
                turn_id: 'provider-attempt-1',
                last_agent_message: null,
                error: { message: 'Selected model is at capacity.', codex_error_info: 'server_overloaded' },
            },
        },
    ];

    it('reports a failed EOF through the deferred contract without emitting a final turn', async () => {
        const file = transcript(failedAttempt());
        let observed: OpenTailObservation | undefined;

        const turns = await collect(
            new CodexAdapter().parseTurns(file, undefined, {
                closeTrailingOnIdle: true,
                onOpenTail: (observation) => {
                    observed = observation;
                },
            }),
        );

        expect(turns).toEqual([]);
        expect(observed).toMatchObject({
            kind: 'failed-eof',
            anchorCursor: undefined,
            failedAt: '2026-09-18T08:47:17.715Z',
            receiptCoverage: {
                state: 'complete',
                turn: { turnIndex: 0, userMessage: 'Investigate the issue.', assistantText: 'Partial investigation.' },
            },
        });
    });

    it('reports a user-only terminal failure but still drops a sentinel-bearing failed tail', async () => {
        const userOnly = failedAttempt('failed-before-response').filter((_, index) => index !== 3);
        const userOnlyFile = transcript(userOnly);
        let observed: OpenTailObservation | undefined;
        await collect(
            new CodexAdapter().parseTurns(userOnlyFile, undefined, {
                closeTrailingOnIdle: true,
                onOpenTail: (candidate) => {
                    observed = candidate;
                },
            }),
        );
        expect(observed?.receiptCoverage.turn).toMatchObject({
            userMessage: 'Investigate the issue.',
            assistantText: '',
        });

        const sentinelTail = failedAttempt('failed-sentinel');
        const user = sentinelTail[2] as { payload: { content: Array<{ text: string }> } };
        user.payload.content[0]!.text = '[[elepha:brief:01J00000000000000000000000]] injected';
        const sentinelFile = transcript(sentinelTail);
        let sentinelObserved = false;
        await collect(
            new CodexAdapter(() => {}).parseTurns(sentinelFile, undefined, {
                closeTrailingOnIdle: true,
                onOpenTail: () => {
                    sentinelObserved = true;
                },
            }),
        );
        expect(sentinelObserved).toBe(false);
    });

    it('reparses a late automatic retry from the canonical anchor and emits one complete logical turn', async () => {
        const file = transcript(failedAttempt('late-retry'));
        const first = await collect(new CodexAdapter().parseTurns(file, undefined, { closeTrailingOnIdle: true }));
        expect(first).toEqual([]);
        appendFileSync(
            file,
            jsonl(
                [
                    {
                        timestamp: '2026-09-18T09:00:00.000Z',
                        type: 'event_msg',
                        payload: { type: 'task_started', turn_id: 'provider-attempt-2' },
                    },
                    {
                        timestamp: '2026-09-18T09:00:01.000Z',
                        type: 'response_item',
                        payload: {
                            type: 'message',
                            role: 'assistant',
                            phase: 'final_answer',
                            content: [{ type: 'output_text', text: 'Recovered final answer.' }],
                        },
                    },
                    {
                        timestamp: '2026-09-18T09:00:02.000Z',
                        type: 'event_msg',
                        payload: { type: 'task_complete', turn_id: 'provider-attempt-2', last_agent_message: 'Recovered final answer.' },
                    },
                ].map((line) => JSON.stringify(line)),
            ),
        );
        let observed = false;

        const completed = await collect(
            new CodexAdapter().parseTurns(file, undefined, {
                closeTrailingOnIdle: true,
                onOpenTail: () => {
                    observed = true;
                },
            }),
        );

        expect(observed).toBe(false);
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({
            turnIndex: 0,
            userMessage: 'Investigate the issue.',
            assistantText: 'Partial investigation.\nRecovered final answer.',
        });
    });

    it('suppresses the failed tail as soon as an automatic retry starts', async () => {
        const file = transcript([
            ...failedAttempt('retry-started'),
            {
                timestamp: '2026-09-18T09:00:00.000Z',
                type: 'event_msg',
                payload: { type: 'task_started', turn_id: 'provider-attempt-2' },
            },
        ]);
        let observed = false;

        const turns = await collect(
            new CodexAdapter().parseTurns(file, undefined, {
                closeTrailingOnIdle: true,
                onOpenTail: () => {
                    observed = true;
                },
            }),
        );

        expect(turns).toEqual([]);
        expect(observed).toBe(false);
    });

    it('closes a user-only failed turn on abort as an empty drop with an advancing cursor', async () => {
        const file = transcript([
            ...failedAttempt('user-only-aborted').filter((_, index) => index !== 3),
            {
                timestamp: '2026-09-18T08:48:00.000Z',
                type: 'event_msg',
                payload: { type: 'turn_aborted', turn_id: 'provider-attempt-1', reason: 'interrupted' },
            },
        ]);
        let observed = false;

        const turns = await collect(
            new CodexAdapter().parseTurns(file, undefined, {
                closeTrailingOnIdle: true,
                onOpenTail: () => {
                    observed = true;
                },
            }),
        );

        expect(observed).toBe(false);
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
            userMessage: 'Investigate the issue.',
            assistantText: '',
            droppedReason: 'empty',
            cursor: expect.any(String),
        });
    });

    it('closes the same logical turn when an automatic retry aborts before contributing content', async () => {
        const file = transcript([
            {
                timestamp: '2026-09-18T08:46:00.000Z',
                type: 'session_meta',
                payload: { id: 'retry-aborted', cwd, originator: 'codex-desktop' },
            },
            {
                timestamp: '2026-09-18T08:46:01.000Z',
                type: 'event_msg',
                payload: { type: 'task_started', turn_id: 'provider-attempt-1' },
            },
            {
                timestamp: '2026-09-18T08:46:02.000Z',
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate the issue.' }] },
            },
            {
                timestamp: '2026-09-18T08:46:03.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    phase: 'commentary',
                    content: [{ type: 'output_text', text: 'Partial investigation.' }],
                },
            },
            {
                timestamp: '2026-09-18T08:47:17.715Z',
                type: 'event_msg',
                payload: {
                    type: 'task_complete',
                    turn_id: 'provider-attempt-1',
                    last_agent_message: null,
                    error: { message: 'Selected model is at capacity.', codex_error_info: 'server_overloaded' },
                },
            },
            {
                timestamp: '2026-09-18T08:47:59.427Z',
                type: 'event_msg',
                payload: { type: 'task_started', turn_id: 'provider-attempt-2' },
            },
            {
                timestamp: '2026-09-18T08:48:00.000Z',
                type: 'event_msg',
                payload: { type: 'turn_aborted', turn_id: 'provider-attempt-2', reason: 'interrupted' },
            },
        ]);

        const turns = await collect(new CodexAdapter().parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
            userMessage: 'Investigate the issue.',
            assistantText: 'Partial investigation.',
        });
    });
});
