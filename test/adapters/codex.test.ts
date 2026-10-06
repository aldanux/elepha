import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { titleForTurn } from '../../src/storage/session-title.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

async function collect(iter: AsyncIterable<ParsedTurn>): Promise<ParsedTurn[]> {
    const out: ParsedTurn[] = [];
    for await (const t of iter) out.push(t);
    return out;
}

describe('CodexAdapter.matches', () => {
    const withCodexHome = (home: string, fn: () => void) => {
        const prev = process.env.CODEX_HOME;
        process.env.CODEX_HOME = home;
        try {
            fn();
        } finally {
            if (prev === undefined) delete process.env.CODEX_HOME;
            else process.env.CODEX_HOME = prev;
        }
    };

    it('matches codex rollout paths and rejects others', () => {
        withCodexHome('/Users/x/.codex', () => {
            const adapter = new CodexAdapter();
            expect(adapter.matches('/Users/x/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-abc.jsonl')).toBe(true);
            expect(adapter.matches('/Users/x/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-abc.jsonl.zst')).toBe(true);
            expect(adapter.matches('/Users/x/.claude/projects/foo/abc.jsonl')).toBe(false);
            expect(adapter.matches('/Users/x/.codex/sessions/2026/01/01/notes.jsonl')).toBe(false);
        });
    });

    // A user who relocates CODEX_HOME is otherwise invisible to elepha: the
    // watcher sits on a directory that never receives a write and the daemon
    // reports RUNNING forever.
    it('follows CODEX_HOME when set, and stops matching the default location', () => {
        withCodexHome('/tmp/custom-codex', () => {
            const adapter = new CodexAdapter();
            expect(adapter.matches('/tmp/custom-codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-abc.jsonl')).toBe(true);
            expect(adapter.matches('/Users/x/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-abc.jsonl')).toBe(false);
        });
    });

    it('matches case variants according to the host filesystem semantics', () => {
        withCodexHome('/Users/x/.codex', () => {
            const adapter = new CodexAdapter();
            const caseVariant = '/Users/X/.Codex/Sessions/2026/01/01/rollout-2026-01-01T00-00-00-abc.jsonl';
            if (process.platform === 'darwin') {
                expect(adapter.matches(caseVariant)).toBe(true);
            } else {
                expect(adapter.matches(caseVariant)).toBe(false);
            }
        });
    });
});

describe('CodexAdapter session index titles', () => {
    const sessionId = '019fa000-0000-7000-8000-000000000099';

    function fixture(home: string): string {
        const sessions = path.join(home, 'sessions', '2026', '09', '07');
        mkdirSync(sessions, { recursive: true });
        const filePath = path.join(sessions, `rollout-2026-09-07T00-00-00-${sessionId}.jsonl`);
        writeFileSync(
            filePath,
            `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/repo' } })}\n${JSON.stringify({
                type: 'event_msg',
                payload: { type: 'user_message', message: 'Fallback title from the first substantive prompt' },
            })}\n${JSON.stringify({
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
            })}\n`,
        );
        return filePath;
    }

    async function parsedTurns(index: string | undefined): Promise<ParsedTurn[]> {
        const home = withGrantableTestDir('elepha-codex-session-index-');
        vi.stubEnv('CODEX_HOME', home);
        if (index !== undefined) {
            writeFileSync(path.join(home, 'session_index.jsonl'), index);
        }
        return collect(new CodexAdapter().parseTurns(fixture(home), undefined, { closeTrailingOnIdle: true }));
    }

    async function parsedTitle(index: string | undefined): Promise<string | undefined> {
        return (await parsedTurns(index))[0]?.aiTitle;
    }

    afterEach(() => vi.unstubAllEnvs());

    it('seeds the latest matching thread_name without changing its text', async () => {
        const turns = await parsedTurns(
            `{"id":"${sessionId}","thread_name":"## Objective Make elepha's stored/se…","updated_at":"2026-09-07T12:11:11Z"}\n` +
                `{"id":"${sessionId}","thread_name":"  Wire Codex AI session titles D111  ","updated_at":"2026-09-07T12:11:16Z"}\n`,
        );

        expect(turns[0]?.aiTitle).toBe('  Wire Codex AI session titles D111  ');
        expect(turns.reduce((currentTitle, turn) => titleForTurn(currentTitle, turn, true), null as string | null)).toBe(
            'Wire Codex AI session titles D111',
        );
    });

    it('preserves shell-like text for the shared title pipeline to render', async () => {
        const turns = await parsedTurns(
            `{"id":"${sessionId}","thread_name":"  Keep $(this)  title  ","updated_at":"2026-09-07T00:00:00Z"}\n`,
        );

        expect(turns[0]?.aiTitle).toBe('  Keep $(this)  title  ');
        expect(turns.reduce((currentTitle, turn) => titleForTurn(currentTitle, turn, true), null as string | null)).toBe(
            'Keep $(this) title',
        );
    });

    it.each([
        ['missing timestamps', `{"id":"${sessionId}","thread_name":"Initial name"}\n{"id":"${sessionId}","thread_name":"Final name"}\n`],
        [
            'unparseable timestamps',
            `{"id":"${sessionId}","thread_name":"Initial name","updated_at":"not-a-date"}\n{"id":"${sessionId}","thread_name":"Final name","updated_at":"still-not-a-date"}\n`,
        ],
    ])('uses the last matching row when index timestamps are %s', async (_case, index) => {
        await expect(parsedTitle(index)).resolves.toBe('Final name');
    });

    it.each([
        ['row absent', `{"id":"other-session","thread_name":"Other title"}\n`],
        ['index missing', undefined],
        ['malformed index', '{not json}\n'],
    ])('falls back when the session index is %s', async (_case, index) => {
        await expect(parsedTitle(index)).resolves.toBeUndefined();
    });
});

describe('CodexAdapter.parseTurns incremental consumption', () => {
    it('does not parse transcript lines after the first yielded turn when the consumer stops', async () => {
        const directory = withTempDir('elepha-codex-first-turn-');
        const filePath = path.join(directory, 'rollout-first-turn.jsonl');
        const lines = [
            { type: 'session_meta', payload: { id: 'first-turn', cwd: directory, originator: 'codex-tui' } },
            {
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first request' }] },
            },
            { type: 'event_msg', payload: { type: 'user_message', message: 'first request' } },
            {
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first response' }] },
            },
            {
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second request' }] },
            },
            { type: 'event_msg', payload: { type: 'user_message', message: 'second request' } },
            { type: 'unknown_future_record' },
            {
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second response' }] },
            },
        ];
        writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
        const warn = vi.fn();
        const turns = new CodexAdapter(warn).parseTurns(filePath, undefined, { closeTrailingOnIdle: true })[Symbol.asyncIterator]();

        const first = await turns.next();
        await turns.return?.();

        expect(first.value?.userMessage).toBe('first request');
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('CodexAdapter caller-owned transcript handle', () => {
    it('classifies from the opened object after the pathname is replaced', async () => {
        const directory = withTempDir('elepha-codex-classification-handle-');
        const filePath = path.join(directory, 'rollout-handle.jsonl');
        writeFileSync(filePath, `${JSON.stringify({ type: 'session_meta', payload: { cwd: directory } })}\n`);
        const handle = await open(filePath, 'r');
        unlinkSync(filePath);
        writeFileSync(filePath, `${JSON.stringify({ type: 'session_meta', payload: { cwd: directory, thread_source: 'subagent' } })}\n`);

        await expect(new CodexAdapter().classifySession(filePath, { handle })).resolves.toEqual({ kind: 'primary' });
        await handle.close();
    });

    it('selects the boundary and parses turns from the same opened object after the pathname is replaced', async () => {
        const directory = withTempDir('elepha-codex-boundary-handle-');
        const filePath = path.join(directory, 'rollout-handle.jsonl');
        const insideLines = [
            { type: 'session_meta', payload: { id: 'inside', cwd: directory } },
            { type: 'event_msg', payload: { type: 'user_message', message: 'inside request' } },
            {
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'inside response' }] },
            },
        ];
        writeFileSync(filePath, `${insideLines.map((line) => JSON.stringify(line)).join('\n')}\n`);
        const handle = await open(filePath, 'r');
        unlinkSync(filePath);
        writeFileSync(
            filePath,
            `${JSON.stringify({
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'outside request' }] },
            })}\n`,
        );

        const turns = await collect(new CodexAdapter().parseTurns(filePath, undefined, { closeTrailingOnIdle: true, handle }));

        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({ userMessage: 'inside request', assistantText: 'inside response' });
        await handle.close();
    });
});

describe('CodexAdapter resume marker (P2.2)', () => {
    it('recognizes a reloaded instruction block with a trailing environment_context through the endsWith fallback', () => {
        class ExposedCodexAdapter extends CodexAdapter {
            isResumeMarker(line: unknown): boolean {
                return this.isResumeMarkerLine(line);
            }
        }

        const line = {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text:
                            '# AGENTS.md instructions for /Users/test/demo-project\n\n<INSTRUCTIONS>Reloaded instructions.</INSTRUCTIONS>\n' +
                            '<environment_context>\n  <cwd>/Users/test/demo-project</cwd>\n</environment_context>',
                    },
                ],
            },
        };

        expect(line.payload.content[0]!.text.startsWith('<environment_context>')).toBe(false);
        expect(new ExposedCodexAdapter().isResumeMarker(line)).toBe(true);
    });
});
