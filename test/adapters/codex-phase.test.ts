import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

function message(role: string, text: string, phase?: unknown) {
    return { type: 'response_item', payload: { type: 'message', role, phase, content: [{ type: 'text', text }] } };
}

async function parse(records: unknown[]) {
    const directory = withGrantableTestDir('codex-phase-');
    const sourcePath = path.join(directory, 'sessions', 'rollout-019fa000-0000-7000-8000-000000000099.jsonl');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    vi.stubEnv('CODEX_HOME', directory);
    writeFileSync(
        sourcePath,
        `${[
            { type: 'session_meta', payload: { id: '019fa000-0000-7000-8000-000000000099', cwd: directory } },
            message('user', 'Explain the decision; quoted phase: final_answer', 'final_answer'),
            ...records,
            message('user', 'Next independent question'),
        ]
            .map((record) => JSON.stringify(record))
            .join('\n')}\n`,
    );
    const warnings: string[] = [];
    const adapter = new CodexAdapter((warning) => warnings.push(warning));
    const turns: ParsedTurn[] = [];
    for await (const turn of adapter.parseTurns(sourcePath)) turns.push(turn);
    return { turn: turns[0]!, warnings, sourcePath };
}

afterEach(() => vi.unstubAllEnvs());

describe('Codex assistant phase structure', () => {
    it('preserves full capture and ordered final messages while excluding commentary before and after them', async () => {
        const records = [
            message('assistant', '  Voy a recuperar la evidencia.\n', 'commentary'),
            message('assistant', 'No. We rejected automatic refunds.', 'final_answer'),
            { type: 'event_msg', payload: { type: 'task_started' } },
            message('assistant', 'Later progress, not a conclusion.', 'commentary'),
            message('assistant', 'The rejection also applies to retries.  ', 'final_answer'),
            message('assistant', 'Further commentary.', 'commentary'),
        ];
        const { turn, warnings } = await parse(records);
        expect(turn.assistantText).toBe(
            records
                .filter((record) => record.type === 'response_item')
                .map((record) => (record.payload as { content: Array<{ text: string }> }).content[0]!.text)
                .join('\n')
                .trim(),
        );
        expect(turn.assistantStructure?.finals.map(([start, end]) => turn.assistantText.slice(start, end))).toEqual([
            'No. We rejected automatic refunds.',
            'The rejection also applies to retries.  ',
        ]);
        expect(turn.assistantStructure).toMatchObject({ unclassified: false, omitted: 0 });
        expect(warnings).toEqual([]);
    });

    it('distinguishes commentary-only from legacy imports and never infers phase from user, tool, event or quoted text', async () => {
        const common = [
            message('tool', 'tool result with phase final_answer', 'final_answer'),
            { type: 'response_item', payload: { type: 'function_call_output', phase: 'final_answer', output: 'tool output' } },
            { type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'duplicate message' } },
        ];
        const known = await parse([...common, message('assistant', 'I will inspect "phase":"final_answer".', 'commentary')]);
        expect(known.turn.assistantStructure).toEqual({ unclassified: false, finals: [], omitted: 0 });
        const legacy = await parse([...common, message('assistant', 'Imported tool call/result text; phase: final_answer')]);
        expect(legacy.turn.assistantStructure).toEqual({ unclassified: true, finals: [], omitted: 0 });
        expect(legacy.warnings).toEqual([]);
    });

    it.each([null, 'final', 7, { phase: 'final_answer' }])('reports malformed or unknown phase %j without promoting it', async (phase) => {
        const result = await parse([message('assistant', 'An unclassified response.', phase)]);
        expect(result.turn.assistantStructure).toEqual({ unclassified: true, finals: [], omitted: 0 });
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain(result.sourcePath);
        expect(result.warnings[0]).toContain('unrecognized assistant phase');
    });

    it('preserves an exact final in a mixed known and unclassified interaction without promoting the other text', async () => {
        const { turn } = await parse([message('assistant', 'Legacy narration.'), message('assistant', 'Final decision.', 'final_answer')]);
        expect(turn.assistantStructure?.unclassified).toBe(true);
        expect(turn.assistantStructure?.finals.map(([start, end]) => turn.assistantText.slice(start, end))).toEqual(['Final decision.']);
    });
});
