import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { ParsedTurn } from '../../src/types/index.js';

const CODEX_FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'codex');

function writeRollout(lines: unknown[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'elepha-kind-'));
    const file = path.join(dir, 'rollout-2026-08-11T16-28-05-019ff026-8bd5-7c71-8f9a-a92f63c85b27.jsonl');
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return file;
}

const meta = (payload: Record<string, unknown>) => ({
    type: 'session_meta',
    timestamp: '2026-08-11T09:28:05.989Z',
    payload: { cwd: '/Users/test/demo-project', ...payload },
});

async function collect(iter: AsyncIterable<ParsedTurn>): Promise<ParsedTurn[]> {
    const out: ParsedTurn[] = [];
    for await (const t of iter) out.push(t);
    return out;
}

describe('CodexAdapter.classifySession', () => {
    it('excludes a real Codex v0.148.0-alpha.9 external-agent import fixture', async () => {
        const file = path.join(CODEX_FIXTURES, 'rollout-codex-v0.148.0-alpha.9-external-agent-import.jsonl');
        const result = await new CodexAdapter().classifySession(file);

        expect(result).toEqual({
            kind: 'primary',
            exclusion: 'external-agent-import',
            reason: 'turn_id starts with external-import-turn-',
        });
    });

    it('requires the external-import prefix at the start of payload.turn_id, not elsewhere in the line', async () => {
        const file = writeRollout([
            meta({ base_instructions: 'example text: external-import-turn-1' }),
            {
                type: 'event_msg',
                timestamp: '2026-08-11T09:28:06.000Z',
                payload: {
                    type: 'task_started',
                    turn_id: 'native-turn-containing-external-import-turn-1',
                    note: 'external-import-turn-1',
                },
            },
        ]);

        expect(await new CodexAdapter().classifySession(file)).toEqual({ kind: 'primary' });
    });

    it('flags a forked transcript as a fork-copy and names the parent', async () => {
        const file = writeRollout([meta({ forked_from_id: 'parent-123', thread_source: 'subagent' })]);
        const result = await new CodexAdapter().classifySession(file);
        expect(result.kind).toBe('fork-copy');
        expect(result.parentNativeId).toBe('parent-123');
    });

    // parent_thread_id is present on EVERY child session, copied or not. Using
    // it as a fork signal misclassified 26 real sessions (turns spanning hours
    // to days) as duplicates - only forked_from_id means a copied transcript.
    it('does not treat parent_thread_id alone as a fork-copy', async () => {
        const file = writeRollout([meta({ parent_thread_id: 'parent-456', thread_source: 'subagent', agent_nickname: 'Locke' })]);
        const result = await new CodexAdapter().classifySession(file);
        expect(result.kind).toBe('subagent');
        expect(result.parentNativeId).toBe('parent-456');
    });

    // The discriminator that matters: thread_source alone is set on genuine
    // subagents too, so keying off it would throw away real work.
    it('flags an approval adjudicator (subagent with no agent identity) but keeps a real subagent', async () => {
        const adjudicator = writeRollout([meta({ thread_source: 'subagent', agent_path: null, agent_nickname: null })]);
        expect((await new CodexAdapter().classifySession(adjudicator)).kind).toBe('adjudicator');

        const realSubagent = writeRollout([meta({ thread_source: 'subagent', agent_path: '/root/audit_docs', agent_nickname: 'Leibniz' })]);
        expect((await new CodexAdapter().classifySession(realSubagent)).kind).toBe('subagent');
    });

    it('treats an ordinary session as primary', async () => {
        const file = writeRollout([meta({ originator: 'codex-tui' })]);
        expect((await new CodexAdapter().classifySession(file)).kind).toBe('primary');
    });
});

describe('CodexAdapter file paths from exec envelopes', () => {
    // Codex embeds apply_patch inside the `exec` JS program as a string
    // literal. The envelope is identical to the standalone one; extraction was
    // previously gated on the tool NAME and so dropped 349 real writes.
    it('extracts patch paths embedded in a custom_tool_call/exec JS program', async () => {
        const file = writeRollout([
            meta({ originator: 'codex-tui' }),
            { type: 'event_msg', timestamp: '2026-08-11T09:28:06.000Z', payload: { type: 'user_message', message: 'patch it' } },
            {
                type: 'response_item',
                timestamp: '2026-08-11T09:28:07.000Z',
                payload: {
                    type: 'custom_tool_call',
                    name: 'exec',
                    input: 'const patch = "*** Begin Patch\\n*** Update File: src/app.ts\\n*** End Patch";\nawait tools.apply_patch({patch});',
                },
            },
            {
                type: 'event_msg',
                timestamp: '2026-08-11T09:28:08.000Z',
                payload: { type: 'user_message', message: 'next' },
            },
        ]);

        const turns = await collect(new CodexAdapter(() => {}).parseTurns(file, undefined, { closeTrailingOnIdle: true }));
        expect(turns[0]!.toolCalls[0]!.filePaths).toEqual(['/Users/test/demo-project/src/app.ts']);
    });

    it('extracts patch paths embedded in a function_call/exec_command JSON argument', async () => {
        const file = writeRollout([
            meta({ originator: 'codex-tui' }),
            { type: 'event_msg', timestamp: '2026-08-11T09:28:06.000Z', payload: { type: 'user_message', message: 'patch it' } },
            {
                type: 'response_item',
                timestamp: '2026-08-11T09:28:07.000Z',
                payload: {
                    type: 'function_call',
                    name: 'exec_command',
                    arguments: JSON.stringify({
                        cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: lib/util.ts\n*** End Patch\nPATCH",
                        workdir: '/Users/test/demo-project',
                    }),
                },
            },
            { type: 'event_msg', timestamp: '2026-08-11T09:28:08.000Z', payload: { type: 'user_message', message: 'next' } },
        ]);

        const turns = await collect(new CodexAdapter(() => {}).parseTurns(file, undefined, { closeTrailingOnIdle: true }));
        expect(turns[0]!.toolCalls[0]!.filePaths).toEqual(['/Users/test/demo-project/lib/util.ts']);
    });

    it('records no paths for a plain shell command (heuristic shell parsing is deliberately out of scope)', async () => {
        const file = writeRollout([
            meta({ originator: 'codex-tui' }),
            { type: 'event_msg', timestamp: '2026-08-11T09:28:06.000Z', payload: { type: 'user_message', message: 'run tests' } },
            {
                type: 'response_item',
                timestamp: '2026-08-11T09:28:07.000Z',
                payload: {
                    type: 'function_call',
                    name: 'exec_command',
                    arguments: JSON.stringify({ cmd: 'npm test -- src/app.test.ts', workdir: '/Users/test/demo-project' }),
                },
            },
            { type: 'event_msg', timestamp: '2026-08-11T09:28:08.000Z', payload: { type: 'user_message', message: 'next' } },
        ]);

        const turns = await collect(new CodexAdapter(() => {}).parseTurns(file, undefined, { closeTrailingOnIdle: true }));
        expect(turns[0]!.toolCalls[0]!.filePaths).toEqual([]);
    });
});
