import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResumeContextRequiredError, TranscriptReadBudgetError } from '../../src/adapters/base.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { decodeResumeContext, encodeResumeContext } from '../../src/storage/source-resume-context.js';
import type { ParsedTurn, ParseTurnsOptions, ResumeContextDerivation } from '../../src/types/index.js';
import { withTempDir } from '../helpers/tmp.js';

const ID = '019fa000-0000-7000-8000-000000000301';

function line(second: number, type: string, payload: unknown): string {
    return `${JSON.stringify({ timestamp: new Date(Date.UTC(2026, 8, 28) + second * 1000).toISOString(), type, payload })}\n`;
}

type Format = 'response_item' | 'event_msg';

// One real Codex turn. Newer Codex writes an event_msg user_message beside
// the response_item prompt; older Codex writes only the response_item.
function exchange(second: number, prompt: string, format: Format = 'response_item'): string {
    return (
        line(second, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }) +
        (format === 'event_msg' ? line(second, 'event_msg', { type: 'user_message', message: prompt }) : '') +
        line(second + 1, 'response_item', {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `${prompt.slice(0, 16)} done` }],
        })
    );
}

// Real Codex turns that never repeat the working directory, surface or branch
// their session_meta header declared.
function turns(count: number, first = 0): string {
    return Array.from({ length: count }, (_, i) => exchange(2 * (first + i), `Request ${first + i}`)).join('');
}

function header(cwd: string): string {
    return line(0, 'session_meta', { id: ID, cwd, originator: 'codex-tui', git: { branch: 'main' } });
}

function source(): string {
    return path.join(withTempDir('codex-resume-context-'), `rollout-2026-09-28T00-00-00-${ID}.jsonl`);
}

async function parse(file: string, cursor?: string, options: ParseTurnsOptions = {}, warnings: string[] = []): Promise<ParsedTurn[]> {
    const adapter = new CodexAdapter((message) => warnings.push(message));
    const parsed: ParsedTurn[] = [];
    for await (const turn of adapter.parseTurns(file, cursor, { closeTrailingOnIdle: true, ...options })) {
        parsed.push(turn);
    }
    return parsed;
}

// Counts every byte actually read from the source through the handle.
async function instrumented(file: string): Promise<{ handle: FileHandle; bytesRead: () => number; close: () => Promise<void> }> {
    const handle = await open(file, 'r');
    let bytes = 0;
    const counted = new Proxy(handle, {
        get(target, property) {
            if (property === 'read') {
                return async (buffer: Buffer, offset: number, length: number, position: number) => {
                    const result = await target.read(buffer, offset, length, position);
                    bytes += result.bytesRead;
                    return result;
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    return { handle: counted, bytesRead: () => bytes, close: () => handle.close() };
}

const identity = (turn: ParsedTurn) => ({
    turnIndex: turn.turnIndex,
    projectPath: turn.projectPath,
    surface: turn.surface,
    gitBranch: turn.gitBranch,
    userMessage: turn.userMessage,
    cursor: turn.cursor,
    resumeContext: turn.resumeContext,
});

describe('Codex resume context', () => {
    it('resumes a header-only transcript with the context its cursor was issued with', async () => {
        const file = source();
        writeFileSync(file, header('/fixture/project') + turns(4));
        const full = await parse(file);
        expect(full.map((turn) => turn.projectPath)).toEqual(Array(4).fill('/fixture/project'));
        expect(full[1]!.resumeContext?.decisions).toEqual({ userBoundary: 'response_item' });

        const resumed = await parse(file, full[1]!.cursor, { resumeContext: full[1]!.resumeContext });
        expect(resumed.map(identity)).toEqual(full.slice(2).map(identity));
        expect(decodeResumeContext(encodeResumeContext(full[1]!.resumeContext))).toEqual(full[1]!.resumeContext);
    });

    it('follows a working-directory change and carries it across later resumes', async () => {
        const file = source();
        writeFileSync(file, header('/fixture/project') + turns(2) + line(4, 'turn_context', { cwd: '/fixture/other' }) + turns(3, 2));
        const full = await parse(file);
        expect(full.map((turn) => turn.projectPath)).toEqual([
            '/fixture/project',
            '/fixture/project',
            '/fixture/other',
            '/fixture/other',
            '/fixture/other',
        ]);
        for (const at of [0, 1, 2]) {
            const resumed = await parse(file, full[at]!.cursor, { resumeContext: full[at]!.resumeContext });
            expect(resumed.map(identity)).toEqual(full.slice(at + 1).map(identity));
        }
    });

    it('refuses to resume once a context record was rewritten in place', async () => {
        const file = source();
        writeFileSync(file, header('/fixture/project') + turns(3));
        const full = await parse(file);
        const before = statSync(file);
        writeFileSync(file, readFileSync(file, 'utf8').replace('/fixture/project', '/fixture/projecX'));
        expect(statSync(file).size).toBe(before.size);

        const warnings: string[] = [];
        let desynced = false;
        const resumed = await parse(
            file,
            full[0]!.cursor,
            {
                resumeContext: full[0]!.resumeContext,
                onDesync: () => {
                    desynced = true;
                },
            },
            warnings,
        );
        expect(resumed).toEqual([]);
        expect(desynced).toBe(true);
        expect(warnings.some((message) => message.includes('[cursor desync]'))).toBe(true);
        const handle = await open(file, 'r');
        try {
            const adapter = new CodexAdapter(() => {});
            const offset = adapter.cursorPosition(full[0]!.cursor).byteOffset;
            expect(await adapter.authenticateResumeContext(full[0]!.resumeContext!, handle, offset)).toBe(false);
        } finally {
            await handle.close();
        }
    });

    it('refuses to resume without the context issued with the cursor', async () => {
        const file = source();
        writeFileSync(file, header('/fixture/project') + turns(3));
        const full = await parse(file);
        await expect(parse(file, full[0]!.cursor)).rejects.toBeInstanceOf(ResumeContextRequiredError);
    });

    it.each(['response_item', 'event_msg'] as const)(
        'resumes a short %s turn after a long first prompt within a bound that every source read respects',
        async (format) => {
            const file = source();
            const longPrompt = 'x'.repeat(8192);
            writeFileSync(file, header('/fixture/project') + exchange(0, longPrompt, format) + exchange(2, 'Short follow-up', format));
            const full = await parse(file);
            expect(full).toHaveLength(2);
            expect(full[0]!.resumeContext?.decisions).toEqual({ userBoundary: format });
            const cursorOffset = new CodexAdapter().cursorPosition(full[0]!.cursor).byteOffset;
            expect(statSync(file).size - cursorOffset).toBeLessThan(512);

            // The cursor's authentication window, its context record and the
            // short tail fit; the long first prompt does not.
            const limit = 6000;
            expect(cursorOffset).toBeGreaterThan(limit);
            const counted = await instrumented(file);
            try {
                const resumed = await parse(file, full[0]!.cursor, {
                    handle: counted.handle,
                    resumeContext: full[0]!.resumeContext,
                    maxReadBytes: limit,
                });
                expect(resumed.map(identity)).toEqual(full.slice(1).map(identity));
                expect(counted.bytesRead()).toBeLessThanOrEqual(limit);
            } finally {
                await counted.close();
            }

            // A bound below the fixed authentication cost fails before reading past it.
            const tight = await instrumented(file);
            try {
                await expect(
                    parse(file, full[0]!.cursor, { handle: tight.handle, resumeContext: full[0]!.resumeContext, maxReadBytes: 1024 }),
                ).rejects.toBeInstanceOf(TranscriptReadBudgetError);
                expect(tight.bytesRead()).toBeLessThanOrEqual(1024);
            } finally {
                await tight.close();
            }
        },
    );
});

describe('Codex resume context reconstruction', () => {
    async function step(file: string, endOffset: number, bytes: number, from?: ResumeContextDerivation, signal?: AbortSignal) {
        const counted = await instrumented(file);
        try {
            const budget = { remaining: bytes };
            const result = await new CodexAdapter().deriveResumeContext(counted.handle, endOffset, { from, readBudget: budget, signal });
            return { result, bytesRead: counted.bytesRead() };
        } finally {
            await counted.close();
        }
    }

    it('reconstructs a cursor context in bounded steps that continue where the last one stopped', async () => {
        const file = source();
        writeFileSync(file, header('/fixture/project') + turns(40));
        const full = await parse(file);
        const target = full.at(-2)!;
        const endOffset = new CodexAdapter().cursorPosition(target.cursor).byteOffset;

        let from: ResumeContextDerivation | undefined;
        const offsets: number[] = [];
        for (;;) {
            // Each continuing step first re-authenticates its progress with the
            // 4096-byte window, then reads on; it reads past its allowance only
            // to finish the record it ran out in, a few kilobytes at a time.
            const { result, bytesRead } = await step(file, endOffset, 6000, from);
            expect(bytesRead).toBeLessThanOrEqual(6000 + 4096);
            if (result.state === 'complete') {
                expect(result.context).toEqual(target.resumeContext);
                break;
            }
            offsets.push(result.progress.offset);
            from = result.progress;
        }
        expect(offsets.length).toBeGreaterThan(3);
        expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
        expect(new Set(offsets).size).toBe(offsets.length);

        const resumed = await parse(file, target.cursor, { resumeContext: target.resumeContext });
        expect(resumed.map(identity)).toEqual(full.slice(-1).map(identity));
    });

    it('starts over when the bytes before its progress were rewritten, and makes no progress once cancelled', async () => {
        const file = source();
        writeFileSync(file, header('/fixture/project') + turns(40));
        const full = await parse(file);
        const endOffset = new CodexAdapter().cursorPosition(full.at(-2)!.cursor).byteOffset;
        const first = await step(file, endOffset, 4096);
        expect(first.result.state).toBe('partial');
        const progress = (first.result as { progress: ResumeContextDerivation }).progress;

        const cancelled = new AbortController();
        cancelled.abort();
        const stopped = await step(file, endOffset, 4096, progress, cancelled.signal);
        expect(stopped.result).toMatchObject({ state: 'partial', progress: { offset: progress.offset } });

        // The header behind the progress now declares another directory of the
        // same length; continuing would keep the stale record.
        writeFileSync(file, readFileSync(file, 'utf8').replace('/fixture/project', '/fixture/projecX'));
        const rewritten = await parse(file);
        let from: ResumeContextDerivation | undefined = progress;
        for (;;) {
            const { result } = await step(file, endOffset, 4096, from);
            if (result.state === 'complete') {
                expect(result.context).toEqual(rewritten.at(-2)!.resumeContext);
                expect(result.context).not.toEqual(full.at(-2)!.resumeContext);
                break;
            }
            from = result.progress;
        }
    });

    it('reconstructs the decision and context for an appended transcript', async () => {
        const file = source();
        writeFileSync(file, header('/fixture/project') + turns(2));
        const full = await parse(file);
        appendFileSync(file, turns(2, 2));
        const endOffset = new CodexAdapter().cursorPosition(full[1]!.cursor).byteOffset;
        const { result } = await step(file, endOffset, 1 << 20);
        expect(result).toEqual({ state: 'complete', context: full[1]!.resumeContext });
    });
});

describe('persisted resume context', () => {
    it('rejects malformed values and reads a bare record list as carrying no decisions', () => {
        for (const text of [
            '',
            'null',
            '{}',
            '[{"field":"cwd","offset":-1,"length":2,"digest":"x"}]',
            '{"records":[],"decisions":[]}',
            '{"records":[],"x":1}',
        ]) {
            expect(decodeResumeContext(text)).toBeUndefined();
        }
        expect(decodeResumeContext('[]')).toEqual({ records: [] });
        expect(decodeResumeContext('{"records":[],"decisions":{"userBoundary":"event_msg"}}')).toEqual({
            records: [],
            decisions: { userBoundary: 'event_msg' },
        });
    });
});
