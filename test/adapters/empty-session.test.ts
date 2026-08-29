import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { EmptySessionAnalysis, SessionAdapter } from '../../src/types/index.js';

type TranscriptShape = 'claude-code' | 'codex';

function writeTranscript(shape: TranscriptShape, lines: unknown[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), `elepha-empty-${shape}-`));
    const file =
        shape === 'claude-code'
            ? path.join(dir, 'session.jsonl')
            : path.join(dir, 'rollout-2026-08-21T00-00-00-019fc000-0000-7000-8000-000000000001.jsonl');
    writeFileSync(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`);
    return file;
}

function adapterFor(shape: TranscriptShape): SessionAdapter {
    return shape === 'claude-code' ? new ClaudeCodeAdapter() : new CodexAdapter();
}

function user(shape: TranscriptShape, content: string): unknown {
    return shape === 'claude-code'
        ? { type: 'user', message: { role: 'user', content } }
        : { type: 'event_msg', payload: { type: 'user_message', message: content } };
}

function assistant(shape: TranscriptShape): unknown {
    return shape === 'claude-code'
        ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }
        : { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } };
}

function toolCall(shape: TranscriptShape): unknown {
    return shape === 'claude-code'
        ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } }
        : { type: 'response_item', payload: { type: 'function_call', name: 'read_file', arguments: '{}' } };
}

describe('SessionAdapter.classifyEmptySession parity', () => {
    const cases: Array<{ name: string; lines: (shape: TranscriptShape) => unknown[]; expected: EmptySessionAnalysis | undefined }> = [
        {
            name: 'empty user prompt',
            lines: (shape) => [user(shape, 'Waiting for a response')],
            expected: { kind: 'no assistant contribution' },
        },
        {
            name: 'assistant contribution',
            lines: (shape) => [user(shape, 'Respond'), assistant(shape)],
            expected: undefined,
        },
        {
            name: 'tool call contribution',
            lines: (shape) => [user(shape, 'Read the file'), toolCall(shape)],
            expected: undefined,
        },
        {
            name: 'internal slash command only',
            lines: (shape) => [user(shape, '<command-name>/compact</command-name><command-args></command-args>')],
            expected: { kind: 'internal command' },
        },
        {
            name: 'malformed JSONL',
            lines: () => ['{not json'],
            expected: undefined,
        },
    ];

    for (const testCase of cases) {
        it(`classifies ${testCase.name} identically for Claude Code and Codex`, async () => {
            const results = await Promise.all(
                (['claude-code', 'codex'] as const).map((shape) =>
                    adapterFor(shape).classifyEmptySession(writeTranscript(shape, testCase.lines(shape))),
                ),
            );
            expect(results).toEqual([testCase.expected, testCase.expected]);
        });
    }

    it('classifies Codex aborted prompts and internal command rollouts', async () => {
        const adapter = new CodexAdapter();
        await expect(
            adapter.classifyEmptySession(writeTranscript('codex', [{ type: 'event_msg', payload: { type: 'turn_aborted' } }])),
        ).resolves.toEqual({ kind: 'aborted prompt' });
        await expect(
            adapter.classifyEmptySession(
                writeTranscript('codex', [{ type: 'session_meta', payload: { source: { subagent: { thread_spawn: {} } } } }]),
            ),
        ).resolves.toEqual({ kind: 'internal command' });
    });
});
