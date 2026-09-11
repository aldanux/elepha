import { appendFileSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekHarnessAdapter } from '../../src/adapters/deepseek-harness.js';
import { MAX_TRANSCRIPT_RECORD_BYTES } from '../../src/config/constants.js';
import { dshSessionsRoot } from '../../src/config/paths.js';
import { wrap } from '../../src/security/sentinel.js';
import type { ParsedTurn } from '../../src/types/index.js';
import {
    appendDeepSeekZstdFrame,
    createDeepSeekFixture,
    deepSeekHeader,
    deepSeekTurn,
    deepSeekZstdBytes,
} from '../fixtures/deepseek-session.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

async function collect(filePath: string, cursor?: string): Promise<ParsedTurn[]> {
    const turns: ParsedTurn[] = [];
    for await (const turn of new DeepSeekHarnessAdapter().parseTurns(filePath, cursor)) {
        turns.push(turn);
    }
    return turns;
}

describe('DeepSeek Harness event reduction', () => {
    let projectPath: string;

    beforeEach(() => {
        vi.stubEnv('DSH_HOME', withTempDir('deepseek-home-'));
        projectPath = withGrantableTestDir('deepseek-project-');
    });

    afterEach(() => vi.unstubAllEnvs());

    it('streams checksummed frames, reduces multiple turns per frame, and resumes from its native end sequence', async () => {
        const file = createDeepSeekFixture(projectPath, [
            [deepSeekHeader(projectPath)],
            [
                ...deepSeekTurn(0),
                { type: 'step/start', seq: 5, data: { turn: 1, step: 1 } },
                { type: 'assistant/message.stream', seq: 6, data: { text: 'duplicate stream text' } },
                ...deepSeekTurn(1),
            ],
        ]);

        const turns = await collect(file);

        expect(turns).toHaveLength(2);
        expect(turns[0]).toMatchObject({
            tool: 'deepseek',
            sessionId: 'session-main',
            projectPath,
            turnIndex: 4,
            userMessage: 'Prompt 0',
            assistantText: 'Answer 0',
            surface: 'cli',
            sourceKey: 'session-main:4',
        });
        expect(await collect(file, turns[0]?.cursor)).toMatchObject([{ turnIndex: 14, assistantText: 'Answer 1' }]);
        expect(await collect(file, turns[1]?.cursor)).toEqual([]);
    });

    it('reads raw JSONL, ignores a torn final raw record, and rejects Zstandard bytes under a raw name', async () => {
        const raw = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath), ...deepSeekTurn(0)]], { encoding: 'raw' });
        appendFileSync(raw, '{"type":"turn/start"');
        expect(await collect(raw)).toHaveLength(1);

        writeFileSync(raw, deepSeekZstdBytes([[deepSeekHeader(projectPath)], deepSeekTurn(0)]));
        await expect(collect(raw)).rejects.toThrow('contains Zstandard data');
    });

    it('requires frame zero to contain exactly one header line and requires compressed-name magic', async () => {
        const multiHeader = createDeepSeekFixture(projectPath, [
            [deepSeekHeader(projectPath), { type: 'permission/preset', data: { preset: 'standard' } }],
        ]);
        await expect(collect(multiHeader)).rejects.toThrow('frame 0 must contain exactly one');

        const wrongMagic = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath)]], {
            sessionId: 'session-wrong-magic',
        });
        writeFileSync(wrongMagic, `${JSON.stringify(deepSeekHeader(projectPath, 'session-wrong-magic'))}\n`);
        await expect(collect(wrongMagic)).rejects.toThrow('does not start with Zstandard magic');
    });

    it('rejects an oversized record while decoding and rejects a bad frame checksum', async () => {
        const oversized = createDeepSeekFixture(projectPath, [
            [deepSeekHeader(projectPath)],
            [
                { type: 'turn/start', seq: 1, time: '2026-09-11T00:00:00.000Z' },
                {
                    type: 'assistant/message',
                    seq: 2,
                    surfaceOp: 'append',
                    data: {
                        message: {
                            source: { kind: 'model' },
                            content: [{ type: 'text', text: 'x'.repeat(MAX_TRANSCRIPT_RECORD_BYTES) }],
                        },
                    },
                },
            ],
        ]);
        await expect(collect(oversized)).rejects.toThrow('oversized record');

        const corrupt = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath)], deepSeekTurn(0)], {
            sessionId: 'session-corrupt',
        });
        const bytes = readFileSync(corrupt);
        bytes[bytes.length - 1] ^= 0xff;
        writeFileSync(corrupt, bytes);
        await expect(collect(corrupt)).rejects.toThrow();
    });

    it('stops before an incomplete final frame and accepts its deterministic interrupted closer later', async () => {
        const opening = deepSeekTurn(0).slice(0, -1);
        const file = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath)], opening]);
        expect(await collect(file)).toEqual([]);

        appendDeepSeekZstdFrame(file, [
            {
                type: 'turn/end',
                seq: 4,
                time: Date.parse('2026-09-11T00:00:01.000Z'),
                data: { turn: 1, reason: { kind: 'interrupted' } },
            },
        ]);
        expect(await collect(file)).toMatchObject([{ turnIndex: 4, assistantText: 'Answer 0' }]);

        const completeSize = readFileSync(file).length;
        appendDeepSeekZstdFrame(file, deepSeekTurn(1));
        truncateSync(file, readFileSync(file).length - 3);
        expect(await collect(file)).toHaveLength(1);
        expect(readFileSync(file).length).toBeGreaterThan(completeSize);
    });

    it('selects only the highest canonical generation and refuses newer or mixed encodings', async () => {
        const v2 = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath, 'session-main', 2)], deepSeekTurn(0)], {
            generation: 2,
        });
        const v3 = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath)], deepSeekTurn(1)]);
        const adapter = new DeepSeekHarnessAdapter();
        expect(adapter.matches(v2)).toBe(false);
        expect(adapter.matches(v3)).toBe(true);
        expect(await collect(v3)).toMatchObject([{ turnIndex: 14 }]);

        const v4 = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath, 'session-main', 4)]], { generation: 4 });
        expect(adapter.eventSourcePath(v2)).toBe(v4);
        await expect(collect(v4)).rejects.toThrow('newer than supported generation 3');

        const mixed = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath, 'session-mixed', 2)]], {
            sessionId: 'session-mixed',
            generation: 2,
            encoding: 'raw',
        });
        const mixedSelected = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath, 'session-mixed', 3)]], {
            sessionId: 'session-mixed',
            generation: 3,
        });
        expect(new DeepSeekHarnessAdapter().eventSourcePath(mixed)).toBe(mixedSelected);
        await expect(collect(mixedSelected)).rejects.toThrow('mixed raw and Zstandard encodings');
    });

    it('treats a reused end sequence with changed content as corruption', async () => {
        const file = createDeepSeekFixture(projectPath, [
            [deepSeekHeader(projectPath)],
            [...deepSeekTurn(0), ...deepSeekTurn(0, 'Changed answer')],
        ]);
        await expect(collect(file)).rejects.toThrow('sequence 4 identifies different turn content');
    });

    it('ignores the entire seeded prefix through the last inherited boundary', async () => {
        const file = createDeepSeekFixture(projectPath, [
            [deepSeekHeader(projectPath, 'session-main', 3, true)],
            [
                ...deepSeekTurn(0),
                { type: 'session/end-seed', seq: 20, data: { inherited: true } },
                ...deepSeekTurn(1, 'Still copied'),
                { type: 'session/end-seed', seq: 30, data: { inherited: true } },
                ...deepSeekTurn(2, 'Local answer'),
            ],
        ]);
        expect(await collect(file)).toMatchObject([{ turnIndex: 24, userMessage: 'Prompt 2', assistantText: 'Local answer' }]);
    });

    it('ignores replacement messages but inspects them for the Rule-4 sentinel', async () => {
        const replaced = deepSeekTurn(0);
        replaced.splice(2, 0, {
            type: 'assistant/message',
            surfaceOp: 'replace',
            data: {
                message: { source: { kind: 'model' }, content: [{ type: 'text', text: 'Replacement copy' }] },
            },
        });
        const normal = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath)], replaced]);
        expect(await collect(normal)).toMatchObject([{ assistantText: 'Answer 0' }]);

        replaced.splice(2, 0, {
            type: 'system/message',
            surfaceOp: 'replace',
            data: {
                message: { content: [{ type: 'text', text: wrap('brief', '01J00000000000000000000000', 'Injected') }] },
            },
        });
        const poisoned = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath, 'session-poisoned')], replaced], {
            sessionId: 'session-poisoned',
        });
        expect(await collect(poisoned)).toMatchObject([{ droppedReason: 'sentinel' }]);
    });

    it('uses last-wins title provenance and refuses duplicated session ids across project directories', async () => {
        const titled = createDeepSeekFixture(projectPath, [
            [deepSeekHeader(projectPath)],
            [
                { type: 'session/title', data: { title: 'Provider title', source: { kind: 'provider' } } },
                { type: 'session/title', data: { title: 'My title', source: { kind: 'user' } } },
                ...deepSeekTurn(0),
            ],
        ]);
        await expect(new DeepSeekHarnessAdapter().readSourceMetadata(titled)).resolves.toMatchObject({
            customTitle: 'My title',
            titleKind: 'custom',
        });

        createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath)]], { projectKey: '--another-project--' });
        await expect(collect(titled)).rejects.toThrow('appears in 2 project directories');
    });

    it('ignores session.lock, reports unknown optional records, and refuses unknown required records', async () => {
        const warn = vi.fn();
        const turn = deepSeekTurn(0);
        turn.splice(
            1,
            0,
            { type: 'hook/invoked', data: { turn: 1, point: 'UserPromptSubmit', dialect: 'claude-code', handlerId: 'hook-1' } },
            { type: 'hook/result', data: { turn: 1, point: 'UserPromptSubmit', handlerId: 'hook-1', decision: 'pass', durationMs: 1 } },
        );
        const file = createDeepSeekFixture(projectPath, [[deepSeekHeader(projectPath)], [{ type: 'future/event' }, ...turn]]);
        writeFileSync(path.join(path.dirname(file), 'session.lock'), 'locked');
        const adapter = new DeepSeekHarnessAdapter(warn);
        expect(adapter.matches(path.join(path.dirname(file), 'session.lock'))).toBe(false);
        for await (const _turn of adapter.parseTurns(file)) {
            // Exhaust the stream so unknown-record diagnostics run.
        }
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown DeepSeek record future/event'));

        const required = createDeepSeekFixture(
            projectPath,
            [[deepSeekHeader(projectPath, 'session-required')], [{ type: 'future/required', required: true }]],
            { sessionId: 'session-required' },
        );
        await expect(collect(required)).rejects.toThrow('Unsupported required DeepSeek event future/required');
    });

    it('refuses missing or non-absolute literal cwd metadata', async () => {
        const missing = createDeepSeekFixture(projectPath, [[{ type: 'session', id: 'session-main', version: 3 }]]);
        await expect(collect(missing)).rejects.toThrow('cwd is missing or not absolute');
        expect(missing).toContain(dshSessionsRoot());
    });
});
