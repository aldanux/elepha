import { describe, expect, it } from 'vitest';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';

describe('durable capture remains inert', () => {
    it('sanitizes every stored leaf and excludes non-projected transcript content through the real store', () => {
        const store = new MemoryStore(openDb(':memory:'));
        const project = store.upsertProject('/repo');
        const session = store.upsertSession('codex', 'adversarial', project.id, '/repo/adversarial.jsonl');
        const syntax = `\`tick\` $(command) \${VARIABLE}\n<<EOF\n| chain\u001b[31m\u0007`;
        const parsedTurn = {
            tool: 'codex',
            sessionId: 'adversarial',
            sourcePath: '/repo/adversarial.jsonl',
            projectPath: '/repo',
            turnIndex: 0,
            startedAt: '2026-09-03T00:00:00.000Z',
            endedAt: '2026-09-03T00:00:01.000Z',
            userMessage: `prompt ${syntax}`,
            assistantText: `response ${syntax}`,
            toolCalls: [{ name: `tool ${syntax}`, filePaths: [`/repo/${syntax}/file.ts`], text: 'RAW_ARGUMENT_SECRET' }],
            cursor: '100|1',
            hasExternalContent: true,
            resumeMarkerBefore: false,
            thinking: 'THINKING_SECRET',
            toolOutput: 'TOOL_OUTPUT_SECRET',
            fetchedContent: 'FETCHED_CONTENT_SECRET',
        } satisfies ParsedTurn & { thinking: string; toolOutput: string; fetchedContent: string };

        expect(
            store.recordTurn(parsedTurn, session.id, project.id, { decisions: [], pending_items: [], status: 'not_configured' }, true),
        ).toBe(true);

        const row = store.database.prepare('SELECT user_prompt, assistant_response, tool_calls FROM filtered_turns').get() as {
            user_prompt: string;
            assistant_response: string;
            tool_calls: string;
        };
        const toolCalls = JSON.parse(row.tool_calls) as Array<{ name: string; filePaths: string[] }>;
        const leaves = [row.user_prompt, row.assistant_response, ...toolCalls.flatMap((call) => [call.name, ...call.filePaths])];
        expect(leaves.every((leaf) => !detectShellSyntax(leaf))).toBe(true);

        const stored = JSON.stringify(row);
        expect(stored).not.toContain('RAW_ARGUMENT_SECRET');
        expect(stored).not.toContain('THINKING_SECRET');
        expect(stored).not.toContain('TOOL_OUTPUT_SECRET');
        expect(stored).not.toContain('FETCHED_CONTENT_SECRET');
    });
});
