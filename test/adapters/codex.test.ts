import { unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { withTempDir } from '../helpers/tmp.js';

// Both fixtures below are trimmed real samples (content genericized, structure
// and field names untouched) pulled from real ~/.codex/sessions transcripts
// and annotated by CLI version. An earlier adapter assumed a made-up envelope for
// apply_patch and missed 100% of real calls (0/542 across every sampled
// version), because the old fixtures were built on the same wrong assumption
// and so agreed with the adapter instead of catching it.
const V0_136_RENAME = path.join(
    __dirname,
    '..',
    'fixtures',
    'codex',
    'rollout-2026-06-02T22-39-08-019e88fd-18fa-7110-834e-7964cf78622c.jsonl',
);
const V0_145_MULTI_FILE = path.join(
    __dirname,
    '..',
    'fixtures',
    'codex',
    'rollout-2026-07-22T15-29-54-019f88f2-145b-7853-8390-75dac88737d6.jsonl',
);
// session_meta.payload.git present - the with-git counterpart to
// V0_136_RENAME, which predates git capture and stays useful as the "no git
// key" case below.
const V0_147_WITH_GIT = path.join(
    __dirname,
    '..',
    'fixtures',
    'codex',
    'rollout-2026-08-10-019fa000-0000-7000-8000-000000000001-with-git.jsonl',
);
// Resume-marker fixture, genericized from the two real occurrence shapes:
// a plain <environment_context> block and a reloaded instruction block
// (two content items, instructions first, environment_context second). A
// fourth turn has no marker line at all, as the negative control.
const V0_147_RESUME_MARKER = path.join(
    __dirname,
    '..',
    'fixtures',
    'codex',
    'rollout-2026-08-15T09-00-00-019fc000-0000-7000-8000-000000000002-resume-marker.jsonl',
);
// Trimmed real primary rollout. It has no event_msg.user_message at
// all; its response_item role:user record is the only human-turn shape.
const V0_147_RESPONSE_ITEM_ONLY = path.join(
    __dirname,
    '..',
    'fixtures',
    'codex',
    'rollout-2026-08-11T16-42-22-019ff033-9dec-7f73-ba44-b76ac18116de-response-item-only.jsonl',
);
// Trimmed real v0.149.0 shape: the synthetic resume marker is its own
// response_item and must never become a human turn.
const V0_149_RESUME_MARKER = path.join(__dirname, '..', 'fixtures', 'codex', 'rollout-codex-v0.149.0-resume-marker.jsonl');

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
            if (process.platform === 'darwin' || process.platform === 'win32') {
                expect(adapter.matches(caseVariant)).toBe(true);
            } else {
                expect(adapter.matches(caseVariant)).toBe(false);
            }
        });
    });
});

describe('CodexAdapter.parseTurns against a real (v0.136.0) rename-patch sample', () => {
    it('extracts the turn via the custom_tool_call/apply_patch envelope and records BOTH the source and destination path of a rename', async () => {
        const warn = vi.fn();
        const adapter = new CodexAdapter(warn);
        const turns = await collect(adapter.parseTurns(V0_136_RENAME, undefined, { closeTrailingOnIdle: true }));

        expect(turns).toHaveLength(1);
        const [turn] = turns;
        expect(turn!.tool).toBe('codex');
        expect(turn!.projectPath).toBe('/Users/test/demo-project');
        expect(turn!.userMessage).toBe('Rename the translation template and simplify the intro');
        expect(turn!.assistantText).toContain('Renamed the file');

        expect(turn!.toolCalls).toHaveLength(1);
        expect(turn!.toolCalls[0]!.name).toBe('apply_patch');
        expect(turn!.toolCalls[0]!.filePaths).toEqual(
            expect.arrayContaining([
                '/Users/test/demo-project/.ai/plans/prompt-translation-session-template.md',
                '/Users/test/demo-project/.ai/plans/translation-session-template.md',
            ]),
        );
        expect(turn!.toolCalls[0]!.filePaths).toHaveLength(2);

        // Real transcripts are full of shapes this adapter deliberately skips
        // (developer preamble, environment_context, agent_message, token_count).
        // None of those should be reported as unrecognized.
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('CodexAdapter.parseTurns against a real (v0.145.0) multi-file-patch sample', () => {
    it('captures all files from a single multi-file apply_patch call and a read_file MCP call for parity with CC Read', async () => {
        const warn = vi.fn();
        const adapter = new CodexAdapter(warn);
        const turns = await collect(adapter.parseTurns(V0_145_MULTI_FILE, undefined, { closeTrailingOnIdle: true }));

        expect(turns).toHaveLength(1);
        const [turn] = turns;
        expect(turn!.userMessage).toBe('Check the locale files against English and fix any drift');
        expect(turn!.assistantText).toContain('locale files');

        expect(turn!.toolCalls.map((c) => c.name)).toEqual(['read_file', 'apply_patch']);
        expect(turn!.toolCalls[0]!.filePaths).toEqual(['/Users/test/demo-project/extension/src/storage/system-prompts/en.js']);
        expect(turn!.toolCalls[1]!.filePaths).toEqual(
            expect.arrayContaining([
                '/Users/test/demo-project/extension/src/storage/system-prompts/es.js',
                '/Users/test/demo-project/extension/src/storage/system-prompts/de.js',
            ]),
        );
        expect(turn!.toolCalls[1]!.filePaths).toHaveLength(2);

        expect(warn).not.toHaveBeenCalled();
    });
});

describe('CodexAdapter.parseTurns against a real (v0.147.0) response_item-only sample', () => {
    it('uses the role:user response_item when event_msg.user_message is absent, without ingesting its resume marker', async () => {
        const adapter = new CodexAdapter();
        const turns = await collect(adapter.parseTurns(V0_147_RESPONSE_ITEM_ONLY, undefined, { closeTrailingOnIdle: true }));

        expect(turns).toHaveLength(1);
        expect(turns[0]!.userMessage).toBe('Clear the remaining static-analysis errors.');
        expect(turns[0]!.assistantText).toBe('I cleared the remaining errors.');
        expect(turns[0]!.resumeMarkerBefore).toBe(true);
        expect(turns[0]!.userMessage).not.toContain('<environment_context>');
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

describe('CodexAdapter surface/gitBranch/hasExternalContent capture', () => {
    it('captures surface (originator) from session_meta on every turn in the file', async () => {
        const adapter = new CodexAdapter();
        const turns = await collect(adapter.parseTurns(V0_136_RENAME, undefined, { closeTrailingOnIdle: true }));
        expect(turns.every((t) => t.surface === 'codex-tui')).toBe(true);
    });

    it('captures gitBranch from session_meta.payload.git.branch, constant across all turns', async () => {
        const adapter = new CodexAdapter();
        const turns = await collect(adapter.parseTurns(V0_147_WITH_GIT, undefined, { closeTrailingOnIdle: true }));
        expect(turns.length).toBeGreaterThan(0);
        expect(turns.every((t) => t.gitBranch === 'feature/git-branch-capture')).toBe(true);
    });

    it('leaves gitBranch undefined when session_meta has no git key (non-repo cwd)', async () => {
        const adapter = new CodexAdapter();
        const turns = await collect(adapter.parseTurns(V0_136_RENAME, undefined, { closeTrailingOnIdle: true }));
        expect(turns.every((t) => t.gitBranch === undefined)).toBe(true);
    });

    it('flags hasExternalContent on a web_search_call response_item, which classify() itself treats as skip', async () => {
        const adapter = new CodexAdapter();
        const turns = await collect(adapter.parseTurns(V0_147_WITH_GIT, undefined, { closeTrailingOnIdle: true }));
        const fetchTurn = turns.find((t) => t.hasExternalContent);
        expect(fetchTurn).toBeDefined();
    });
});

describe('CodexAdapter resume marker (P2.2)', () => {
    it('excludes the v0.149.0 marker response_item as a human turn', async () => {
        const adapter = new CodexAdapter();
        const turns = await collect(adapter.parseTurns(V0_149_RESUME_MARKER, undefined, { closeTrailingOnIdle: true }));

        expect(turns).toHaveLength(1);
        expect(turns[0]!.userMessage).toBe('Resume the implementation from the last verified test result.');
        expect(turns[0]!.userMessage).not.toContain('<environment_context>');
        expect(turns[0]!.resumeMarkerBefore).toBe(true);
    });

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

    it('flags resumeMarkerBefore on the turn a plain <environment_context> block immediately precedes, including the very first turn (launch)', async () => {
        const adapter = new CodexAdapter();
        const turns = await collect(adapter.parseTurns(V0_147_RESUME_MARKER, undefined, { closeTrailingOnIdle: true }));
        expect(turns).toHaveLength(4);
        expect(turns[0]!.resumeMarkerBefore).toBe(true); // launch marker
        expect(turns[1]!.resumeMarkerBefore).toBe(true); // plain marker after the 5h gap
    });

    it('flags resumeMarkerBefore on the AGENTS.md-reloaded variant the same way, without ingesting the reloaded file content into the turn', async () => {
        const adapter = new CodexAdapter();
        const turns = await collect(adapter.parseTurns(V0_147_RESUME_MARKER, undefined, { closeTrailingOnIdle: true }));
        const reloadTurn = turns[2]!;
        expect(reloadTurn.resumeMarkerBefore).toBe(true);
        expect(reloadTurn.userMessage).not.toContain('AGENTS.md');
        expect(reloadTurn.userMessage).not.toContain('environment_context');
        expect(reloadTurn.userMessage).not.toContain('INSTRUCTIONS');
    });

    it('leaves resumeMarkerBefore false on a turn with no preceding marker line', async () => {
        const adapter = new CodexAdapter();
        const turns = await collect(adapter.parseTurns(V0_147_RESUME_MARKER, undefined, { closeTrailingOnIdle: true }));
        expect(turns[3]!.resumeMarkerBefore).toBe(false);
    });

    it('does not flag resumeMarkerBefore on files with no environment_context occurrence at all', async () => {
        const adapter = new CodexAdapter();
        const turns = await collect(adapter.parseTurns(V0_147_WITH_GIT, undefined, { closeTrailingOnIdle: true }));
        expect(turns.every((t) => t.resumeMarkerBefore === false)).toBe(true);
    });
});
