import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { titleForSegment } from '../../src/storage/session-title.js';
import type { ParsedTurn } from '../../src/types/index.js';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'claude-code', 'sample-session.jsonl');

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
            if (process.platform === 'darwin' || process.platform === 'win32') {
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

describe('ClaudeCodeAdapter.parseTurns against fixture', () => {
    it('attaches a standalone ai-title to its active turn without treating it as turn content or an unknown line', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-ai-title-'));
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
        expect(titleForSegment(turns, true)).toBe('Review CSP headers for iframe components');
    });

    it('uses the truncated first prompt as the session-title fallback when the transcript has no ai-title', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-title-fallback-'));
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

        expect(titleForSegment(turns, true)).toBe('Implement the session title fallback so ticket-driven Claude sessions r…');
    });

    it('extracts both real turns, filters meta/tool_result noise, resolves tool_use file paths', async () => {
        const adapter = new ClaudeCodeAdapter();
        const turns = await collect(adapter.parseTurns(FIXTURE, undefined, { closeTrailingOnIdle: true }));

        expect(turns).toHaveLength(3);

        const [first, second] = turns;
        expect(first!.turnIndex).toBe(0);
        expect(first!.sessionId).toBe('sample-session');
        expect(first!.tool).toBe('claude-code');
        expect(first!.projectPath).toBe('/Users/test/demo-project');
        expect(first!.userMessage).toBe('Add a health check endpoint to the API');
        expect(first!.assistantText).toContain('Added GET /health endpoint');
        expect(first!.assistantText).not.toContain('tool_result');
        expect(first!.toolCalls.map((c) => c.name)).toEqual(['Read', 'Edit', 'Write']);
        expect(first!.toolCalls.flatMap((c) => c.filePaths)).toEqual([
            '/Users/test/demo-project/src/server.ts',
            '/Users/test/demo-project/src/server.ts',
            '/Users/test/demo-project/src/health.ts',
        ]);

        expect(second!.turnIndex).toBe(1);
        expect(second!.userMessage).toBe('Also add a TODO for adding rate limiting later');
        expect(second!.assistantText).toContain('rate limiting');
        // local-command-caveat / command-name / command-stdout noise between the
        // two real turns must not leak into either turn's userMessage.
        expect(second!.userMessage).not.toContain('command-name');
        expect(first!.userMessage).not.toContain('command-name');
    });

    it('resumes correctly from a previously emitted cursor', async () => {
        const adapter = new ClaudeCodeAdapter();
        const all = await collect(adapter.parseTurns(FIXTURE, undefined, { closeTrailingOnIdle: true }));
        const resumed = await collect(adapter.parseTurns(FIXTURE, all[0]!.cursor, { closeTrailingOnIdle: true }));
        expect(resumed).toHaveLength(2);
        expect(resumed[0]!.turnIndex).toBe(1);
        expect(resumed[0]!.userMessage).toBe(all[1]!.userMessage);
    });
});

describe('ClaudeCodeAdapter surface/gitBranch/hasExternalContent capture', () => {
    it('captures surface (entrypoint) and gitBranch on emitted turns', async () => {
        const adapter = new ClaudeCodeAdapter();
        const turns = await collect(adapter.parseTurns(FIXTURE, undefined, { closeTrailingOnIdle: true }));
        expect(turns[0]!.surface).toBe('cli');
        expect(turns[0]!.gitBranch).toBe('main');
    });

    it('flags hasExternalContent when a turn contains a WebFetch/WebSearch tool_use', async () => {
        const adapter = new ClaudeCodeAdapter();
        const turns = await collect(adapter.parseTurns(FIXTURE, undefined, { closeTrailingOnIdle: true }));
        const fetchTurn = turns.find((t) => t.toolCalls.some((c) => c.name === 'WebFetch'));
        expect(fetchTurn?.hasExternalContent).toBe(true);
        const otherTurn = turns.find((t) => !t.toolCalls.some((c) => c.name === 'WebFetch' || c.name === 'WebSearch'));
        expect(otherTurn?.hasExternalContent).toBe(false);
    });

    // The resume marker is a Codex-only concept: Claude Code has per-turn
    // gitBranch and does not need it. ClaudeCodeAdapter never overrides
    // isResumeMarkerLine, so every turn must use the base class's default false.
    it('never sets resumeMarkerBefore - the resume marker is a Codex-only concept', async () => {
        const adapter = new ClaudeCodeAdapter();
        const turns = await collect(adapter.parseTurns(FIXTURE, undefined, { closeTrailingOnIdle: true }));
        expect(turns.every((t) => t.resumeMarkerBefore === false)).toBe(true);
    });
});

describe('ClaudeCodeAdapter turn-boundary timing', () => {
    function ccLine(obj: Record<string, unknown>): string {
        return JSON.stringify({ cwd: '/Users/test/demo-project', sessionId: 'sid', ...obj });
    }

    function tmpFile(): string {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-cc-'));
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
