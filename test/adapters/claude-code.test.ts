import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CLAUDE_COMPACT_SUMMARY_MAX_BYTES, CLAUDE_COMPACT_SUMMARY_TAIL_SCAN_MAX_BYTES } from '../../src/config/constants.js';
import { claudeProjectsRoot } from '../../src/config/paths.js';
import { titleForTurn } from '../../src/storage/session-title.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { withTempDir } from '../helpers/tmp.js';

async function collect(iter: AsyncIterable<ParsedTurn>): Promise<ParsedTurn[]> {
    const out: ParsedTurn[] = [];
    for await (const t of iter) out.push(t);
    return out;
}

describe('ClaudeCodeAdapter.matches', () => {
    const withConfigDir = (dir: string, fn: () => void) => {
        const prev = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = dir;
        try {
            fn();
        } finally {
            if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = prev;
        }
    };

    it('matches claude-code session paths and rejects others', () => {
        withConfigDir('/Users/x/.claude', () => {
            const adapter = new ClaudeCodeAdapter();
            expect(adapter.matches('/Users/x/.claude/projects/foo/abc.jsonl')).toBe(true);
            expect(adapter.matches('/Users/x/.codex/sessions/2026/01/01/rollout-abc.jsonl')).toBe(false);
            expect(adapter.matches('/Users/x/.claude/projects/foo/abc.txt')).toBe(false);
        });
    });

    // A user who relocates CLAUDE_CONFIG_DIR is otherwise invisible to elepha.
    it('follows CLAUDE_CONFIG_DIR when set, and stops matching the default location', () => {
        withConfigDir('/tmp/custom-claude', () => {
            const adapter = new ClaudeCodeAdapter();
            expect(adapter.matches('/tmp/custom-claude/projects/foo/abc.jsonl')).toBe(true);
            expect(adapter.matches('/Users/x/.claude/projects/foo/abc.jsonl')).toBe(false);
        });
    });

    it('matches case variants according to the host filesystem semantics', () => {
        withConfigDir('/Users/x/.claude', () => {
            const adapter = new ClaudeCodeAdapter();
            if (process.platform === 'darwin') {
                expect(adapter.matches('/Users/X/.Claude/Projects/Foo/abc.jsonl')).toBe(true);
            } else {
                expect(adapter.matches('/Users/X/.Claude/Projects/Foo/abc.jsonl')).toBe(false);
            }
        });
    });
});

describe('ClaudeCodeAdapter.classifySession', () => {
    it('tags subagent transcripts by directory layout and recovers the parent session id', async () => {
        const adapter = new ClaudeCodeAdapter();
        const parent = 'ed771351-5819-470e-9039-5e081c9cd9ec';
        const result = await adapter.classifySession(
            `/Users/x/.claude/projects/-Users-x-proj/${parent}/subagents/agent-a866aef073b040b75.jsonl`,
        );
        expect(result.kind).toBe('subagent');
        expect(result.parentNativeId).toBe(parent);
    });

    it('treats a top-level session file as primary', async () => {
        const adapter = new ClaudeCodeAdapter();
        const result = await adapter.classifySession('/Users/x/.claude/projects/-Users-x-proj/abc.jsonl');
        expect(result.kind).toBe('primary');
    });
});

describe('ClaudeCodeAdapter.parseTurns', () => {
    it('attaches a standalone ai-title to its active turn without treating it as turn content or an unknown line', async () => {
        const dir = withTempDir('elepha-ai-title-');
        const file = path.join(dir, 'session.jsonl');
        const line = (value: Record<string, unknown>) =>
            JSON.stringify({ cwd: '/Users/test/demo-project', sessionId: 'ai-title-sample', ...value });
        appendFileSync(
            file,
            `${line({ type: 'user', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'Review CSP headers' } })}\n`,
        );
        appendFileSync(file, `${line({ type: 'ai-title', aiTitle: 'Review CSP headers for iframe components' })}\n`);
        appendFileSync(
            file,
            `${line({
                type: 'assistant',
                timestamp: '2026-08-01T00:00:01.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] },
            })}\n`,
        );

        const adapter = new ClaudeCodeAdapter();
        const turns = await collect(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        expect(turns).toHaveLength(1);
        expect(turns[0]?.aiTitle).toBe('Review CSP headers for iframe components');
        expect(turns[0]?.userMessage).toBe('Review CSP headers');
        expect(turns.reduce((currentTitle, turn) => titleForTurn(currentTitle, turn, true), null as string | null)).toBe(
            'Review CSP headers for iframe components',
        );
    });

    it('uses the truncated first prompt as the session-title fallback when the transcript has no ai-title', async () => {
        const dir = withTempDir('elepha-title-fallback-');
        const file = path.join(dir, 'session.jsonl');
        const prompt = 'Implement the session title fallback so ticket-driven Claude sessions remain legible in the session list.';
        const line = (value: Record<string, unknown>) =>
            JSON.stringify({ cwd: '/Users/test/demo-project', sessionId: 'title-fallback-sample', ...value });
        writeFileSync(
            file,
            `${line({ type: 'user', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: prompt } })}\n${line({
                type: 'assistant',
                timestamp: '2026-08-01T00:00:01.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Implemented.' }] },
            })}\n`,
        );

        const turns = await collect(new ClaudeCodeAdapter().parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        expect(turns.reduce((currentTitle, turn) => titleForTurn(currentTitle, turn, true), null as string | null)).toBe(
            'Implement the session title fallback so ticket-driven Claude sessions r…',
        );
    });
});

describe('ClaudeCodeAdapter compact summary', () => {
    const summary = 'This session is being continued from a previous conversation that ran out of context.';
    const line = (value: Record<string, unknown>) => JSON.stringify({ cwd: '/Users/test/demo-project', sessionId: 'compact', ...value });

    function writeCompacted(summaryFlags: Record<string, unknown>): string {
        const dir = withTempDir('elepha-compact-');
        const file = path.join(dir, 'session.jsonl');
        writeFileSync(
            file,
            [
                line({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-08-01T00:00:00.000Z' }),
                line({
                    type: 'user',
                    timestamp: '2026-08-01T00:00:01.000Z',
                    ...summaryFlags,
                    message: { role: 'user', content: summary },
                }),
                line({ type: 'user', timestamp: '2026-08-01T00:00:02.000Z', message: { role: 'user', content: 'Next step' } }),
                line({
                    type: 'assistant',
                    timestamp: '2026-08-01T00:00:03.000Z',
                    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
                }),
            ]
                .map((l) => `${l}\n`)
                .join(''),
        );
        return file;
    }

    // The structural marker decides, not the wording: Claude Code writes
    // the generated summary as a user-shaped line after compact_boundary.
    // Earlier parses stored that summary as its own turn, so the boundary
    // still occupies its index as a dropped empty turn: later turns keep the
    // identities already persisted for them.
    it('drops the isCompactSummary line as an empty turn that keeps its historical index', async () => {
        const file = writeCompacted({ isCompactSummary: true, isVisibleInTranscriptOnly: true });
        const turns = await collect(new ClaudeCodeAdapter().parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        expect(turns.map((t) => [t.turnIndex, t.userMessage, t.assistantText, t.droppedReason])).toEqual([
            [0, '', '', 'empty'],
            [1, 'Next step', 'Done.', undefined],
        ]);
    });

    // The daemon persists a dropped turn's cursor without storing memory, so
    // a resume from it must start after the gap, at the next historical index.
    it('resumes after the dropped compact turn at the next historical index', async () => {
        const file = writeCompacted({ isCompactSummary: true, isVisibleInTranscriptOnly: true });
        const adapter = new ClaudeCodeAdapter();
        const full = await collect(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));
        const resumed = await collect(adapter.parseTurns(file, full[0]!.cursor, { closeTrailingOnIdle: true }));

        expect(resumed.map((t) => [t.turnIndex, t.userMessage, t.droppedReason, t.cursor])).toEqual([
            [1, 'Next step', undefined, full[1]!.cursor],
        ]);
    });

    it('agrees with a full parse when a manual compact arrives after an incremental cursor', async () => {
        const dir = withTempDir('elepha-compact-manual-resume-');
        const file = path.join(dir, 'session.jsonl');
        writeFileSync(file, precompact());
        const adapter = new ClaudeCodeAdapter();
        const first = await collect(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));
        expect(first.map((t) => t.userMessage)).toEqual(['First prompt']);

        appendFileSync(
            file,
            [
                line({
                    type: 'user',
                    timestamp: '2026-08-01T00:00:03.000Z',
                    isCompactSummary: true,
                    isVisibleInTranscriptOnly: true,
                    message: { role: 'user', content: summary },
                }),
            ]
                .map((l) => `${l}\n`)
                .join(''),
        );
        // A lone summary has no assistant reply yet, so it stays open exactly
        // like the old summary turn did.
        expect(await collect(adapter.parseTurns(file, first[0]!.cursor, { closeTrailingOnIdle: true }))).toEqual([]);

        appendFileSync(
            file,
            [
                line({ type: 'user', timestamp: '2026-08-01T00:00:04.000Z', message: { role: 'user', content: 'Next step' } }),
                line({
                    type: 'assistant',
                    timestamp: '2026-08-01T00:00:05.000Z',
                    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
                }),
            ]
                .map((l) => `${l}\n`)
                .join(''),
        );
        const resumed = await collect(adapter.parseTurns(file, first[0]!.cursor, { closeTrailingOnIdle: true }));
        const full = await collect(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        const shape = (t: ParsedTurn) => [t.turnIndex, t.userMessage, t.assistantText, t.droppedReason, t.cursor];
        expect(resumed.map(shape)).toEqual([
            [1, '', '', 'empty', full[1]!.cursor],
            [2, 'Next step', 'Done.', undefined, full[2]!.cursor],
        ]);
        expect(full.slice(1).map(shape)).toEqual(resumed.map(shape));
        expect(full.some((t) => t.userMessage.includes(summary))).toBe(false);
    });

    const precompact = () =>
        [
            line({ type: 'user', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'First prompt' } }),
            line({
                type: 'assistant',
                timestamp: '2026-08-01T00:00:01.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Before compact.' }] },
            }),
            line({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-08-01T00:00:02.000Z' }),
        ]
            .map((l) => `${l}\n`)
            .join('');
    // An automatic compact lets the assistant continue with no new human
    // prompt: summary, then assistant/tool lines, then maybe a real prompt.
    const autoContinuation = () =>
        [
            line({
                type: 'user',
                timestamp: '2026-08-01T00:00:03.000Z',
                isCompactSummary: true,
                isVisibleInTranscriptOnly: true,
                message: { role: 'user', content: summary },
            }),
            line({
                type: 'assistant',
                timestamp: '2026-08-01T00:00:04.000Z',
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/Users/test/demo-project/a.ts' } }],
                },
            }),
            line({
                type: 'user',
                timestamp: '2026-08-01T00:00:05.000Z',
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok' }] },
            }),
            line({
                type: 'assistant',
                timestamp: '2026-08-01T00:00:06.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'After compact.' }] },
            }),
        ]
            .map((l) => `${l}\n`)
            .join('');

    it('keeps assistant/tool continuation after an automatic compact as its own turn without the summary text', async () => {
        const dir = withTempDir('elepha-compact-auto-');
        const file = path.join(dir, 'session.jsonl');
        writeFileSync(file, precompact() + autoContinuation());
        const turns = await collect(new ClaudeCodeAdapter().parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        expect(turns.map((t) => [t.turnIndex, t.userMessage, t.assistantText, t.toolCalls.map((c) => c.name), t.droppedReason])).toEqual([
            [0, 'First prompt', 'Before compact.', [], undefined],
            [1, '', 'After compact.', ['Read'], undefined],
        ]);
        expect(turns.some((t) => t.userMessage.includes(summary) || t.assistantText.includes(summary))).toBe(false);
    });

    it('keeps automatic-compact continuation when an incremental parse starts at the summary line', async () => {
        const dir = withTempDir('elepha-compact-resume-');
        const file = path.join(dir, 'session.jsonl');
        writeFileSync(file, precompact());
        const adapter = new ClaudeCodeAdapter();
        const first = await collect(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));
        expect(first.map((t) => t.userMessage)).toEqual(['First prompt']);

        appendFileSync(file, autoContinuation());
        const resumed = await collect(adapter.parseTurns(file, first[0]!.cursor, { closeTrailingOnIdle: true }));

        expect(resumed.map((t) => [t.turnIndex, t.userMessage, t.assistantText, t.toolCalls.map((c) => c.name), t.droppedReason])).toEqual([
            [1, '', 'After compact.', ['Read'], undefined],
        ]);
    });

    it('keeps a genuine user message with summary-like wording as a turn', async () => {
        const file = writeCompacted({});
        const turns = await collect(new ClaudeCodeAdapter().parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        expect(turns.map((t) => [t.turnIndex, t.userMessage, t.droppedReason])).toEqual([
            [0, summary, undefined],
            [1, 'Next step', undefined],
        ]);
    });

    it('does not let a compact summary make an internal-command session substantive', async () => {
        const dir = withTempDir('elepha-compact-empty-');
        const file = path.join(dir, 'session.jsonl');
        writeFileSync(
            file,
            [
                line({
                    type: 'user',
                    message: { role: 'user', content: '<command-name>/compact</command-name><command-args></command-args>' },
                }),
                line({ type: 'system', subtype: 'compact_boundary' }),
                line({
                    type: 'user',
                    isCompactSummary: true,
                    isVisibleInTranscriptOnly: true,
                    message: { role: 'user', content: summary },
                }),
            ]
                .map((l) => `${l}\n`)
                .join(''),
        );

        await expect(new ClaudeCodeAdapter().classifyEmptySession(file)).resolves.toEqual({ kind: 'internal command' });
    });
});

describe('ClaudeCodeAdapter.readLatestCompactSummary', () => {
    let configDir: string | undefined;
    afterEach(() => {
        vi.unstubAllEnvs();
        configDir = undefined;
    });

    function transcript(records: Array<Record<string, unknown> | string>): string {
        const directory = withTempDir('elepha-native-compact-');
        configDir ??= path.join(directory, '.claude');
        vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
        const project = path.join(claudeProjectsRoot(), path.basename(directory));
        mkdirSync(project, { recursive: true });
        const file = path.join(project, 'session.jsonl');
        writeFileSync(file, `${records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n')}\n`);
        return file;
    }

    const boundary = { type: 'system', subtype: 'compact_boundary' };
    const summary = (content: unknown) => ({ type: 'user', isCompactSummary: true, message: { role: 'user', content } });
    const user = (content: string) => ({ type: 'user', message: { role: 'user', content } });

    it('reads the latest native summary with byte provenance while leaving human text out', async () => {
        const file = transcript([
            boundary,
            summary('Earlier decision'),
            user('Work after first compact'),
            boundary,
            summary('Latest decision'),
        ]);

        const result = await new ClaudeCodeAdapter().readLatestCompactSummary(file);

        expect(result).toMatchObject({ status: 'available', summary: 'Latest decision' });
        if (result.status !== 'available') throw new Error(result.reason);
        expect(result.byteStart).toBeGreaterThan(0);
        expect(result.byteEnd).toBeGreaterThan(result.byteStart);
        expect(result.boundaryByteStart).toBeLessThan(result.byteStart);
        expect(result.previousBoundaryByteStart).not.toBeNull();
        const turns = await collect(new ClaudeCodeAdapter().parseTurns(file, undefined, { closeTrailingOnIdle: true }));
        expect(turns.every((turn) => !turn.userMessage.includes('Latest decision'))).toBe(true);
    });

    it('does not infer a native summary from a human message or an older compact before an unfilled boundary', async () => {
        const withoutBoundary = transcript([summary('Flag without boundary')]);
        await expect(new ClaudeCodeAdapter().readLatestCompactSummary(withoutBoundary)).resolves.toEqual({
            status: 'unavailable',
            reason: 'summary_absent',
        });
        const humanOnly = transcript([boundary, user('This session is being continued from a previous conversation.')]);
        await expect(new ClaudeCodeAdapter().readLatestCompactSummary(humanOnly)).resolves.toEqual({
            status: 'unavailable',
            reason: 'summary_absent',
        });

        const unfilled = transcript([boundary, summary('Old summary'), boundary, user('Continue')]);
        await expect(new ClaudeCodeAdapter().readLatestCompactSummary(unfilled)).resolves.toEqual({
            status: 'unavailable',
            reason: 'summary_absent',
        });
    });

    it('reports repeated, malformed and oversized native summaries without returning partial content', async () => {
        const ambiguous = transcript([boundary, summary('One'), summary('Two')]);
        const malformed = transcript([boundary, summary({ text: 'Wrong shape' })]);
        const oversized = transcript([boundary, summary('x'.repeat(CLAUDE_COMPACT_SUMMARY_MAX_BYTES + 1))]);

        const adapter = new ClaudeCodeAdapter();
        await expect(adapter.readLatestCompactSummary(ambiguous)).resolves.toEqual({ status: 'unavailable', reason: 'summary_ambiguous' });
        await expect(adapter.readLatestCompactSummary(malformed)).resolves.toEqual({ status: 'unavailable', reason: 'summary_malformed' });
        await expect(adapter.readLatestCompactSummary(oversized)).resolves.toEqual({ status: 'unavailable', reason: 'summary_oversized' });
    });

    it('enforces the tail scan bound and provider-store containment', async () => {
        const file = transcript([boundary, summary('Too far back'), user('x'.repeat(CLAUDE_COMPACT_SUMMARY_TAIL_SCAN_MAX_BYTES))]);
        await expect(new ClaudeCodeAdapter().readLatestCompactSummary(file)).resolves.toEqual({
            status: 'unavailable',
            reason: 'scan_limit',
        });

        const outside = path.join(withTempDir('elepha-native-compact-outside-'), 'session.jsonl');
        writeFileSync(outside, `${JSON.stringify(summary('Private'))}\n`);
        await expect(new ClaudeCodeAdapter().readLatestCompactSummary(outside)).resolves.toEqual({
            status: 'unavailable',
            reason: 'transcript_outside_store',
        });
    });
});

describe('ClaudeCodeAdapter turn-boundary timing', () => {
    function ccLine(obj: Record<string, unknown>): string {
        return JSON.stringify({ cwd: '/Users/test/demo-project', sessionId: 'sid', ...obj });
    }

    function tmpFile(): string {
        const dir = withTempDir('elepha-cc-');
        const file = path.join(dir, 'session.jsonl');
        writeFileSync(file, '');
        return file;
    }

    it('never emits on a syntactically-incomplete trailing line, regardless of options', async () => {
        const adapter = new ClaudeCodeAdapter();
        const file = tmpFile();

        appendFileSync(
            file,
            `${ccLine({ type: 'user', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'Do the thing' } })}\n`,
        );
        // Partial trailing line: valid JSON prefix cut off mid-object, no newline.
        appendFileSync(
            file,
            '{"type":"assistant","timestamp":"2026-08-01T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"wor',
        );

        const turns = await collect(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));
        expect(turns).toHaveLength(0);
    });

    it('does not emit a structurally complete trailing turn without closeTrailingOnIdle, but does once idle is asserted', async () => {
        const adapter = new ClaudeCodeAdapter();
        const file = tmpFile();

        appendFileSync(
            file,
            `${ccLine({ type: 'user', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'Do the thing' } })}\n`,
        );
        appendFileSync(
            file,
            `${ccLine({
                type: 'assistant',
                timestamp: '2026-08-01T00:00:01.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
            })}\n`,
        );

        const notIdle = await collect(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: false }));
        expect(notIdle).toHaveLength(0);

        const idle = await collect(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));
        expect(idle).toHaveLength(1);
        expect(idle[0]!.userMessage).toBe('Do the thing');
        expect(idle[0]!.assistantText).toBe('Done.');
    });

    it('closes the previous turn as soon as the next turn-boundary line arrives, without waiting for idle', async () => {
        const adapter = new ClaudeCodeAdapter();
        const file = tmpFile();

        appendFileSync(
            file,
            `${ccLine({ type: 'user', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'Do the thing' } })}\n`,
        );
        appendFileSync(
            file,
            `${ccLine({
                type: 'assistant',
                timestamp: '2026-08-01T00:00:01.000Z',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' }, id: 't1' },
                        { type: 'text', text: 'Done.' },
                    ],
                },
            })}\n`,
        );
        appendFileSync(
            file,
            `${ccLine({ type: 'user', timestamp: '2026-08-01T00:00:02.000Z', message: { role: 'user', content: 'Next thing' } })}\n`,
        );

        const turns = await collect(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: false }));
        expect(turns).toHaveLength(1);
        expect(turns[0]!.userMessage).toBe('Do the thing');
        expect(turns[0]!.toolCalls).toHaveLength(1);
        expect(turns[0]!.toolCalls[0]!.filePaths).toEqual(['/Users/test/demo-project/a.ts']);
    });
});
