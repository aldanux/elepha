import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KimiCodeAdapter } from '../../src/adapters/kimi-code.js';
import { readKimiMetadata } from '../../src/adapters/kimi-metadata.js';
import { kimiSessionDir, kimiSessionIndexPath } from '../../src/config/paths.js';
import { wrap } from '../../src/security/sentinel.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { createKimiFixture, kimiTurn } from '../fixtures/kimi-wire.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

async function collect(wire: string, cursor?: string): Promise<ParsedTurn[]> {
    const turns: ParsedTurn[] = [];
    for await (const turn of new KimiCodeAdapter().parseTurns(wire, cursor)) {
        turns.push(turn);
    }
    return turns;
}

function fixture(records: object[], forked = false) {
    vi.stubEnv('KIMI_CODE_HOME', withGrantableTestDir('kimi-store-'));
    return createKimiFixture(withGrantableTestDir('kimi-project-'), records, 'session-main', forked);
}

afterEach(() => vi.unstubAllEnvs());

describe('Kimi event reduction', () => {
    it('reduces completed multi-step text, excludes thinking/context duplicates, records changing models and completion time', async () => {
        const first = kimiTurn(0, 'Hello', { model: 'provider/one' });
        first.splice(
            6,
            0,
            {
                type: 'context.append_loop_event',
                agentId: 'main',
                event: { type: 'content.part', turnId: 0, step: 1, part: { type: 'text', text: ' world' } },
                time: 1600,
            },
            {
                type: 'context.append_message',
                agentId: 'main',
                message: { role: 'user', origin: { kind: 'injection' }, content: [{ type: 'text', text: 'date_change reminder' }] },
                time: 1500,
            },
        );
        const { wire } = fixture([...first, ...kimiTurn(1, 'Second', { model: 'provider/two' })]);
        const turns = await collect(wire);
        expect(turns).toHaveLength(2);
        expect(turns[0]).toMatchObject({
            userMessage: 'Prompt 0',
            assistantText: 'Hello world',
            endedAt: new Date(1800).toISOString(),
            provenance: { protocolVersion: '1.5', producerVersion: 'unknown', modelAliases: ['provider/one'] },
        });
        expect(turns[1]?.provenance?.modelAliases).toEqual(['provider/two']);
        expect(await collect(wire, turns[0]?.cursor)).toHaveLength(1);
    });

    it('represents failed turns as empty and excludes non-main wire paths', async () => {
        const { wire } = fixture(kimiTurn(0, '', { failed: true }));
        expect((await collect(wire))[0]).toMatchObject({ userMessage: '', assistantText: '', droppedReason: 'empty' });
        const subagent = wire.replace(`${path.sep}main${path.sep}`, `${path.sep}worker${path.sep}`);
        mkdirSync(path.dirname(subagent), { recursive: true });
        writeFileSync(subagent, '');
        expect(new KimiCodeAdapter().matches(subagent)).toBe(false);
        expect(new KimiCodeAdapter().matches(wire)).toBe(true);
        rmSync(wire);
        symlinkSync(subagent, wire);
        await expect(collect(wire)).rejects.toThrow('excludes non-main agent sources');
    });

    it('drops the whole turn when a phase-2 sentinel appears in injection-origin context', async () => {
        const records = kimiTurn(0);
        records.splice(4, 0, {
            type: 'context.append_message',
            agentId: 'main',
            message: {
                role: 'user',
                origin: { kind: 'injection' },
                content: [{ type: 'text', text: wrap('brief', '01J00000000000000000000000', 'Memory brief') }],
            },
            time: 1500,
        });
        const { wire } = fixture([...records, ...kimiTurn(1)]);
        expect((await collect(wire)).map((turn) => turn.droppedReason)).toEqual(['sentinel', undefined]);
    });

    it('suppresses the copied fork prefix and keeps only new local turns', async () => {
        const { wire } = fixture([...kimiTurn(0), { type: 'forked', time: 1900 }, ...kimiTurn(1)], true);
        expect(await collect(wire)).toMatchObject([{ turnIndex: 0, userMessage: 'Prompt 1', assistantText: 'Answer 1' }]);
    });

    it('excludes unwrapped blocked hook context and keeps the following model response', async () => {
        const { wire } = fixture([
            {
                type: 'context.append_message',
                agentId: 'main',
                message: {
                    role: 'assistant',
                    origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
                    content: [{ type: 'text', text: '<hook_result hook_event="UserPromptSubmit">\nCommand payload\n</hook_result>' }],
                },
                time: 900,
            },
            {
                type: 'context.append_message',
                agentId: 'main',
                message: {
                    role: 'user',
                    origin: { kind: 'user' },
                    content: [{ type: 'text', text: 'elepha:info' }],
                    id: 'blocked-prompt',
                },
                time: 901,
            },
            { type: 'prompt.completed', agentId: 'main', promptId: 'blocked-prompt', reason: 'blocked', time: 902 },
            ...kimiTurn(1),
        ]);
        expect(await collect(wire)).toMatchObject([{ userMessage: 'Prompt 1', assistantText: 'Answer 1' }]);
    });

    it('leaves an incomplete prompt open and accepts a later completion', async () => {
        const events = kimiTurn(0);
        const { wire } = fixture(events.slice(0, -2));
        expect(await collect(wire)).toEqual([]);
        appendFileSync(
            wire,
            `${events
                .slice(-2)
                .map((event) => JSON.stringify(event))
                .join('\n')}\n`,
        );
        expect(await collect(wire)).toHaveLength(1);
    });
    it('uses the literal state cwd ahead of the index and applies index deletion records on fallback', async () => {
        const f = fixture(kimiTurn(0));
        const state = JSON.parse(readFileSync(f.state, 'utf8'));
        const other = withGrantableTestDir('kimi-other-project-');
        const entry = { sessionId: state.id, sessionDir: kimiSessionDir(f.wire), workDir: other };
        writeFileSync(kimiSessionIndexPath(), `${JSON.stringify(entry)}\n`);
        expect((await readKimiMetadata(f.wire))?.cwd).toBe(state.cwd);
        rmSync(f.state);
        const fallback = await readKimiMetadata(f.wire);
        expect(fallback?.cwd).toBe(other);
        expect(fallback?.validate()).toBe(true);
        appendFileSync(kimiSessionIndexPath(), `${JSON.stringify({ sessionId: state.id, deleted: true })}\n`);
        expect(fallback?.validate()).toBe(false);
        expect(await readKimiMetadata(f.wire)).toBeUndefined();
    });

    it('rejects a state path that resolves outside the provider store', async () => {
        const f = fixture(kimiTurn(0));
        const outside = path.join(withGrantableTestDir('kimi-outside-'), 'state.json');
        writeFileSync(outside, readFileSync(f.state));
        rmSync(f.state);
        symlinkSync(outside, f.state);
        await expect(collect(f.wire)).rejects.toThrow('Cannot read Kimi state');
    });

    it('latches a sentinel in tool plumbing and reports malformed complete records before reconciliation', async () => {
        const records = kimiTurn(0);
        records.splice(4, 0, {
            type: 'context.append_loop_event',
            agentId: 'main',
            event: { type: 'tool.call', turnId: 0, arguments: wrap('brief', '01J00000000000000000000000', 'Injected arguments') },
            time: 1500,
        });
        const f = fixture(records);
        expect((await collect(f.wire))[0]?.droppedReason).toBe('sentinel');
        appendFileSync(f.wire, 'invalid json\n');
        const warn = vi.fn();
        await expect(
            (async () => {
                for await (const turn of new KimiCodeAdapter(warn).parseTurns(f.wire)) {
                    expect(turn.droppedReason).toBe('sentinel');
                }
            })(),
        ).rejects.toThrow('1 malformed records');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`1 malformed complete JSONL record in ${f.wire}`));
    });
});
