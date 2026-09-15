import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { ASSISTANT_STRUCTURE_MAX_FINALS, SESSION_CHAR_BUDGET } from '../../src/config/constants.js';
import { decodeAssistantStructure, joinedAssistantStructure } from '../../src/rendering/assistant-structure.js';
import { filterTurn } from '../../src/rendering/filtered-turn.js';
import { escapeShellSyntax } from '../../src/security/sanitize.js';
import { tokenizeRecallQuery } from '../../src/serving/lexical-recall.js';
import { selectSessionEvidence } from '../../src/serving/session-evidence.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { readSessionById } from '../../src/storage/session-read-model.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { createTestDb, seedConsentRoot, seedProject, seedSession } from '../helpers/db.js';

const QUESTION = '¿Por qué descartamos usar la diferencia entre el primer y el segundo resultado para decidir el recuerdo automático?';
const DECISION =
    'El margen no separaba respuestas correctas del ruido: 0.0053 frente a 0.0049; con margen >= 0.01 hubo 5 correctos frente a 6 incorrectos.';
const SUMMARY = { decisions: [], pending_items: [], status: 'not_configured' as const };

async function fixture(messages: Array<{ text: string; phase?: string }>, durable = true) {
    const f = createTestDb('final-answer-evidence-');
    const project = seedProject(f);
    mkdirSync(project.path, { recursive: true });
    seedConsentRoot(f, { path: project.path });
    vi.stubEnv('CODEX_HOME', path.join(f.directory, 'codex'));
    const nativeId = '019fa000-0000-7000-8000-000000000099';
    const sourcePath = path.join(f.directory, 'codex', 'sessions', `rollout-${nativeId}.jsonl`);
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(
        sourcePath,
        `${[
            { type: 'session_meta', payload: { id: nativeId, cwd: project.path } },
            { type: 'event_msg', payload: { type: 'user_message', message: QUESTION } },
            ...messages.map(({ text, phase }) => ({
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] },
            })),
            { type: 'event_msg', payload: { type: 'user_message', message: 'Independent followup' } },
        ]
            .map((record) => JSON.stringify({ timestamp: '2026-09-15T00:00:00Z', ...record }))
            .join('\n')}\n`,
    );
    const turns: ParsedTurn[] = [];
    for await (const turn of new CodexAdapter().parseTurns(sourcePath)) turns.push(turn);
    const session = seedSession(f, { project, nativeId, sourcePath });
    f.store.recordTurn(turns[0]!, session.id, project.id, SUMMARY, durable);
    const reader = new SessionReader(f.db);
    const served = () => readSessionById(f.db, session.id)!;
    const evidence = (budget = 2200) => selectSessionEvidence(reader, served(), tokenizeRecallQuery('margen correctos'), budget);
    return { ...f, project, session, sourcePath, turn: turns[0]!, reader, served, evidence };
}

afterEach(() => vi.unstubAllEnvs());

describe('structural final-answer evidence', () => {
    it.each([false, true])('serves the complete final without commentary while preserving full rendering; durable=%s', async (durable) => {
        const f = await fixture(
            [
                { phase: 'commentary', text: 'Voy a recuperar la decisión. Los IDs no resuelven la cuestión.' },
                { phase: 'final_answer', text: DECISION },
                { phase: 'commentary', text: 'Later progress after the final.' },
            ],
            durable,
        );
        const evidence = await f.evidence();
        expect(evidence.text).toContain(DECISION);
        expect(evidence.text).not.toContain('Voy a recuperar');
        expect(evidence.text).not.toContain('IDs no resuelven');
        expect(evidence.text).not.toContain('Later progress');
        expect(evidence.coverage).toContain('provider-declared final answer');
        expect((await f.reader.render(f.served())).episode?.text).toContain('Voy a recuperar');
        expect((await f.reader.render(f.served())).episode?.text).toContain('Later progress');
    });

    it('abstains for commentary-only, and includes all ordered finals or none when their set exceeds the budget', async () => {
        const commentary = await fixture([{ phase: 'commentary', text: `Voy a revisar el margen. ${DECISION}` }]);
        expect(await commentary.evidence()).toMatchObject({ text: '', coverage: expect.stringContaining('has_no_final_answer') });
        const finals = await fixture([
            { phase: 'final_answer', text: 'No. Never enable automatic refunds.' },
            { phase: 'commentary', text: 'Checking a later followup.' },
            { phase: 'final_answer', text: DECISION },
        ]);
        const complete = await finals.evidence();
        expect(complete.text.indexOf('Never enable')).toBeLessThan(complete.text.indexOf(DECISION));
        expect(complete.coverage).toContain('all 2 final messages included');
        const tooSmall = await finals.evidence(QUESTION.length + DECISION.length + 200);
        expect(tooSmall.text).toBe('');
        expect(tooSmall.coverage).toContain('2 final messages excluded');
    });

    it('enriches a historical row only from matching safe source, without writing metadata back', async () => {
        const f = await fixture([
            { phase: 'commentary', text: 'Voy a recuperar.' },
            { phase: 'final_answer', text: DECISION },
        ]);
        f.db.prepare('UPDATE filtered_turns SET assistant_structure = NULL').run();
        expect((await f.evidence()).text).not.toContain('Voy a recuperar');
        expect((await f.evidence()).coverage).toContain('provider-declared final answer');
        expect(f.db.prepare('SELECT assistant_structure FROM filtered_turns').get()).toEqual({ assistant_structure: null });
        f.db
            .prepare('UPDATE sessions SET source_path = ? WHERE id = ?')
            .run(path.join(path.dirname(f.sourcePath), 'missing.jsonl'), f.session.id);
        const missing = await f.evidence();
        expect(missing.text).toContain('Voy a recuperar');
        expect(missing.coverage).toContain('unclassified assistant response');
    });

    it.each([false, true])(
        'keeps phases in the bounded lexical window for current and historical durable rows; historical=%s',
        async (historical) => {
            const f = await fixture([
                { phase: 'commentary', text: 'El margen necesita otra búsqueda; esto es progreso.' },
                { phase: 'final_answer', text: DECISION },
            ]);
            f.db.prepare('UPDATE sessions SET first_prompt_search = NULL WHERE id = ?').run(f.session.id);
            if (historical) f.db.prepare('UPDATE filtered_turns SET assistant_structure = NULL').run();
            const evidence = await f.evidence();
            expect(evidence.text).toContain(DECISION);
            expect(evidence.text).not.toContain('esto es progreso');
            expect(evidence.coverage).toContain('provider-declared final answer');
        },
    );

    it('reports invalid stored spans and retains unclassified fallback instead of trusting forged offsets', async () => {
        const f = await fixture([{ text: DECISION }]);
        f.db
            .prepare('UPDATE sessions SET source_path = ? WHERE id = ?')
            .run(path.join(path.dirname(f.sourcePath), 'missing.jsonl'), f.session.id);
        f.db
            .prepare('UPDATE filtered_turns SET assistant_structure = ?')
            .run(JSON.stringify({ unclassified: false, finals: [[-1, 10000]], omitted: 0 }));
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const evidence = await f.evidence();
            expect(evidence.text).toContain(DECISION);
            expect(evidence.coverage).toContain('unclassified assistant response');
            expect(warning).toHaveBeenCalledWith(expect.stringContaining(`stored session ${f.session.id}`));
        } finally {
            warning.mockRestore();
        }
    });

    it.each(['claude-code', 'opencode'] as const)('keeps existing durable fallback explicitly unclassified for %s', async (tool) => {
        const f = await fixture([{ text: DECISION }]);
        f.db.prepare('UPDATE filtered_turns SET assistant_structure = NULL').run();
        f.db.prepare('UPDATE sessions SET tool = ? WHERE id = ?').run(tool, f.session.id);
        const evidence = await f.evidence();
        expect(evidence.text).toContain(DECISION);
        expect(evidence.coverage).toContain('unclassified assistant response');
    });

    it('maps exact final spans through citation removal, trimming and escaping without searching duplicate text', async () => {
        const final = 'No. Never execute `$(date)` or <<EOF.\n<oai-mem-citation>reference</oai-mem-citation>';
        const f = await fixture([
            { phase: 'commentary', text: `  ${final}` },
            { phase: 'final_answer', text: final },
        ]);
        const row = f.db.prepare('SELECT assistant_response, assistant_structure FROM filtered_turns').get() as {
            assistant_response: string;
            assistant_structure: string;
        };
        const structure = decodeAssistantStructure(row.assistant_structure, row.assistant_response.length)!;
        expect(structure.finals).toHaveLength(1);
        expect(structure.finals[0]![0]).toBeGreaterThan(0);
        expect(structure.finals.map(([start, end]) => row.assistant_response.slice(start, end))).toEqual([
            escapeShellSyntax('No. Never execute `$(date)` or <<EOF.'),
        ]);
        expect((await f.evidence()).text).not.toContain('oai-mem-citation');
    });

    it('accounts compact metadata bytes and invalidates spans when a legacy writer changes captured text', async () => {
        const f = await fixture([{ phase: 'final_answer', text: DECISION }]);
        const exact = () =>
            f.db
                .prepare(
                    `SELECT SUM(length(CAST(user_prompt AS BLOB)) + length(CAST(assistant_response AS BLOB)) + length(CAST(tool_calls AS BLOB)) + COALESCE(length(CAST(assistant_structure AS BLOB)), 0)) AS total_bytes FROM filtered_turns`,
                )
                .get();
        expect(f.db.prepare('SELECT total_bytes FROM durable_capture_usage').get()).toEqual(exact());
        f.db.prepare('UPDATE filtered_turns SET assistant_response = ?').run('A different captured response.');
        expect(f.db.prepare('SELECT assistant_structure FROM filtered_turns').get()).toEqual({ assistant_structure: null });
        expect(f.db.prepare('SELECT total_bytes FROM durable_capture_usage').get()).toEqual(exact());
        expect(f.db.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'different'").all()).toHaveLength(1);
        expect((await f.evidence()).text).not.toContain(DECISION);
        expect((await f.evidence()).coverage).toContain('unclassified assistant response');
    });

    it('never promotes a retained suffix of a final message after durable truncation', async () => {
        const f = await fixture([{ phase: 'final_answer', text: `No. Never ${'execute unsafe operations '.repeat(4000)}for any reason.` }]);
        const row = f.db.prepare('SELECT assistant_response, assistant_structure FROM filtered_turns').get() as {
            assistant_response: string;
            assistant_structure: string;
        };
        expect(row.assistant_response.length).toBeLessThanOrEqual(SESSION_CHAR_BUDGET);
        expect(decodeAssistantStructure(row.assistant_structure, row.assistant_response.length)).toMatchObject({ finals: [], omitted: 1 });
    });

    it('bounds metadata by omitting whole older spans and declares the incomplete final set', async () => {
        const f = await fixture(
            Array.from({ length: ASSISTANT_STRUCTURE_MAX_FINALS + 2 }, (_, index) => ({ phase: 'final_answer', text: `Final ${index}.` })),
        );
        const row = f.db.prepare('SELECT assistant_response, assistant_structure FROM filtered_turns').get() as {
            assistant_response: string;
            assistant_structure: string;
        };
        const structure = decodeAssistantStructure(row.assistant_structure, row.assistant_response.length)!;
        expect(structure.finals).toHaveLength(ASSISTANT_STRUCTURE_MAX_FINALS);
        expect(structure.omitted).toBe(2);
        expect(await f.evidence()).toMatchObject({ text: '', coverage: expect.stringContaining('final_answers_omitted') });
    });

    it('does not fabricate spans when a citation crosses provider message boundaries', () => {
        const parts = ['<oai-mem-citation>commentary', 'final</oai-mem-citation>Real answer'];
        const structure = joinedAssistantStructure(parts, [
            { firstPart: 0, partCount: 1, phase: 'commentary' },
            { firstPart: 1, partCount: 1, phase: 'final_answer' },
        ]);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const projection = filterTurn({
                userMessage: 'Question',
                assistantText: parts.join('\n'),
                assistantStructure: structure,
                toolCalls: [],
                sourcePath: '/fixture/source.jsonl',
            });
            expect(projection.assistantResponse).toBe('Real answer');
            expect(projection.assistantStructure).toBeUndefined();
            expect(warning).toHaveBeenCalledWith(expect.stringContaining('/fixture/source.jsonl'));
        } finally {
            warning.mockRestore();
        }
    });
});
