import { mkdirSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptReadBudgetError } from '../../src/adapters/base.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import {
    DURABLE_CAPTURE_FILTER_VERSION,
    SESSION_EVIDENCE_MAX_CONTEXT_CHARS,
    SESSION_EVIDENCE_SOURCE_MAX_BYTES,
} from '../../src/config/constants.js';
import { ElephaMcpService } from '../../src/mcp/tools.js';
import { joinedAssistantStructure } from '../../src/rendering/assistant-structure.js';
import { filterTurn } from '../../src/rendering/filtered-turn.js';
import { selectSessionEvidence } from '../../src/serving/session-evidence.js';
import { publicSessionId } from '../../src/serving/session-id.js';
import { SessionReader, STORED_EVIDENCE_REASONS } from '../../src/serving/session-reader.js';
import { DurableCaptureStore } from '../../src/storage/durable-capture-store.js';
import { firstPromptSearch } from '../../src/storage/first-prompt-search.js';
import { createTestDb, seedConsentRoot, seedCopyCoverage, seedMemory, seedProject, seedSession } from '../helpers/db.js';

const NOW = Date.parse('2026-09-14T12:00:00Z');

function fixture() {
    const f = createTestDb('paired-session-evidence-');
    const project = seedProject(f);
    mkdirSync(project.path, { recursive: true });
    seedConsentRoot(f, { path: project.path });
    const session = seedSession(f, { project, nativeId: 'payment-recovery', title: 'Payment recovery', surface: 'cli' });
    return { ...f, project, session, service: new ElephaMcpService(f.db) };
}

function text(result: Awaited<ReturnType<ElephaMcpService['getSession']>>) {
    return result.content
        .filter((entry) => entry.type === 'text')
        .map((entry) => entry.text)
        .join('\n');
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('paired historical session evidence', () => {
    it.each([false, true])('serves production-sized finals completely or abstains above the cap; oversized=%s', async (oversized) => {
        const f = fixture();
        const question =
            '¿Por qué descartamos usar la diferencia entre el primer y el segundo resultado para decidir el recuerdo automático?';
        const commentary =
            'Voy a recuperar la decisión y contrastar la evidencia. Los IDs no resuelven la pregunta por sí solos. ' +
            'Seguimos comprobando la fuente histórica. '.repeat(6);
        const final =
            'Porque el margen top1 - top2 no tenía poder discriminativo real:\n\n- Con el recuerdo correcto indexado, margen mediano: 0.0053.\n- Sin el recuerdo correcto, margen mediano: 0.0049.\n- Usando margen >= 0.01, aceptábamos 5 casos correctos y 6 incorrectos.\n\nLas distribuciones se solapaban casi por completo. Dos resultados malos pueden estar separados y un resultado bueno puede quedar cerca de un duplicado.';
        const followup =
            'El margen compara candidatos entre sí, sin verificar la relevancia del primero. Un duplicado puede acercarse al candidato correcto; eliminarlo cambia la distancia sin mejorar la evidencia disponible.\n'.repeat(
                oversized ? 20 : 6,
            );
        const parts = [commentary, final, followup];
        const first = seedMemory(f, { project: f.project, session: f.session, userMessage: question, assistantText: parts.join('\n') });
        seedMemory(f, { project: f.project, session: f.session, turnIndex: 1 });
        new DurableCaptureStore(f.db).record(
            first.id,
            f.session.id,
            filterTurn({
                userMessage: question,
                assistantText: parts.join('\n'),
                assistantStructure: joinedAssistantStructure(parts, [
                    { firstPart: 0, partCount: 1, phase: 'commentary' },
                    { firstPart: 1, partCount: 1, phase: 'final_answer' },
                    { firstPart: 2, partCount: 1, phase: 'final_answer' },
                ]),
                toolCalls: [],
            }),
            '2026-09-15',
        );
        seedCopyCoverage(f, first.id);
        if (oversized) {
            expect(question.length + final.length + followup.length).toBeGreaterThan(SESSION_EVIDENCE_MAX_CONTEXT_CHARS);
            expect(text(await f.service.getSession({ id: publicSessionId(f.session), query: question }))).toContain(
                'first_interaction_exceeds_evidence_budget',
            );
            return;
        }
        const output = text(await f.service.getSession({ id: publicSessionId(f.session), query: question }));
        expect(output).toContain(question);
        expect(output).toContain(final);
        expect(output).toContain(followup.trimEnd());
        expect(output.indexOf(final)).toBeLessThan(output.indexOf(followup.trimEnd()));
        for (const fact of ['0.0053', '0.0049', '>= 0.01', '5 casos correctos', '6 incorrectos']) {
            expect(output).toContain(fact);
        }
        expect(output).not.toContain('Voy a recuperar');
        expect(output).not.toContain('IDs no resuelven');
        expect(output).toContain('provider-declared final answer');
        expect(output.length).toBeGreaterThan(2_500);
        expect(output.length).toBeLessThanOrEqual(SESSION_EVIDENCE_MAX_CONTEXT_CHARS);
    });

    it('retains both historical options with a deictic answer and abstains when the complete pair cannot fit', async () => {
        const f = fixture();
        const question = 'Option A: discard payment receipts.\n\nOption B: retain payment receipts.\n\nWhich option did we choose?';
        const answer = 'The second option, because retries need the original payment identity.';
        const first = seedMemory(f, { project: f.project, session: f.session, userMessage: question, assistantText: answer });
        seedMemory(f, { project: f.project, session: f.session, turnIndex: 1 });
        f.db
            .prepare(`INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, tool_calls,
            omitted_tool_call_count, dropped_tool_ref_count, omitted_before_chars, filter_version, captured_at)
            VALUES (?, 1, ?, ?, '[]', 0, 0, 0, ?, '2026-09-15')`)
            .run(first.id, question, answer, DURABLE_CAPTURE_FILTER_VERSION);
        seedCopyCoverage(f, first.id);
        const output = text(
            await f.service.getSession({ id: publicSessionId(f.session), query: 'Which option did we choose for payment receipts?' }),
        );
        expect(output).toContain(question);
        expect(output).toContain(answer);
        expect(output.length).toBeLessThanOrEqual(SESSION_EVIDENCE_MAX_CONTEXT_CHARS);
        const oversizedQuestion = `${'Scope and qualifiers for both options. '.repeat(100)}\n${question}`;
        f.db.prepare('UPDATE filtered_turns SET user_prompt = ? WHERE memory_id = ?').run(oversizedQuestion, first.id);
        f.db.prepare('UPDATE sessions SET first_prompt_search = ? WHERE id = ?').run(firstPromptSearch(oversizedQuestion), f.session.id);
        expect(text(await f.service.getSession({ id: publicSessionId(f.session), query: 'Which option did we choose?' }))).toContain(
            'first_interaction_exceeds_evidence_budget',
        );
    });

    it.each(['durable', 'provider'] as const)(
        'serves the first interaction rationale before later repeated mentions, also for a nonlexical paraphrase: %s',
        async (source) => {
            const f = fixture();
            const question = '¿Por qué descartamos la diferencia entre el primer y el segundo resultado?';
            const decision =
                'Descartamos el margen porque no separaba respuestas correctas de ruido: 0.0053 frente a 0.0049; con margen >= 0.01 hubo 5 correctos frente a 6 incorrectos.';
            const answer = `${decision}\n\n${'Detalle posterior sobre margen y resultados. '.repeat(100)}`;
            const first = seedMemory(f, { project: f.project, session: f.session, userMessage: question, assistantText: answer });
            seedMemory(f, {
                project: f.project,
                session: f.session,
                turnIndex: 1,
                userMessage: 'Revisit margin results',
                assistantText: 'Late margin mention without the measurements.',
            });
            if (source === 'durable') {
                f.db
                    .prepare(`INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, tool_calls,
                    omitted_tool_call_count, dropped_tool_ref_count, omitted_before_chars, filter_version, captured_at)
                    VALUES (?, 1, ?, ?, '[]', 0, 0, 0, ?, '2026-09-15')`)
                    .run(first.id, question, answer, DURABLE_CAPTURE_FILTER_VERSION);
                seedCopyCoverage(f, first.id);
            } else {
                vi.stubEnv('CODEX_HOME', path.join(f.directory, 'codex'));
                const root = path.join(f.directory, 'codex', 'sessions');
                mkdirSync(root, { recursive: true });
                const sourcePath = path.join(root, 'rollout-00000000-0000-4000-8000-000000000001.jsonl');
                writeFileSync(
                    sourcePath,
                    `${[
                        { type: 'event_msg', payload: { type: 'user_message', message: question } },
                        {
                            type: 'response_item',
                            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] },
                        },
                        { type: 'event_msg', payload: { type: 'user_message', message: 'Revisit margin results' } },
                        {
                            type: 'response_item',
                            payload: {
                                type: 'message',
                                role: 'assistant',
                                content: [{ type: 'output_text', text: 'Late margin mention without the measurements.' }],
                            },
                        },
                    ]
                        .map((record) => JSON.stringify(record))
                        .join('\n')}\n`,
                );
                f.db.prepare('UPDATE sessions SET source_path = ? WHERE id = ?').run(sourcePath, f.session.id);
            }
            // A selected session can answer a query in another language
            // without moving its indexed rationale to a later lexical mention.
            const prompt = 'Explain the rejected confidence heuristic and its measured failure.';
            if (source === 'provider') {
                // Source-only content cannot supply response evidence;
                // expansion names the retained gap instead.
                const expanded = await new ElephaMcpService(f.db).getSession({ id: publicSessionId(f.session), query: prompt });
                expect(JSON.stringify(expanded.content)).toContain(STORED_EVIDENCE_REASONS.missing);
                expect(JSON.stringify(expanded.content)).not.toContain(decision);
                return;
            }
            const output = text(await f.service.getSession({ id: publicSessionId(f.session), query: prompt }));
            expect(output).toContain(decision);
            expect(output).not.toContain('Late margin mention');
            expect(output).toContain('later evidence units omitted');
            expect(output.length).toBeLessThanOrEqual(SESSION_EVIDENCE_MAX_CONTEXT_CHARS);
        },
    );

    it('reads the retained first pair of a nonzero native Codex segment independently of the source ceiling', async () => {
        const f = fixture();
        const priorProject = seedProject(f, { path: path.join(f.directory, 'prior-project') });
        mkdirSync(priorProject.path, { recursive: true });
        seedConsentRoot(f, { path: priorProject.path });
        vi.stubEnv('CODEX_HOME', path.join(f.directory, 'codex'));
        const root = path.join(f.directory, 'codex', 'sessions');
        mkdirSync(root, { recursive: true });
        const nativeId = '00000000-0000-4000-8000-000000000002';
        const sourcePath = path.join(root, `rollout-${nativeId}.jsonl`);
        const question = 'Option A: remove the receipt. Option B: keep the receipt. Which option did we choose?';
        const answer = 'The second option, because retries need the original payment identity.';
        const interactions = [
            { cwd: priorProject.path, question: 'Prior project: choose a deployment host.', answer: 'Use the prior deployment host.' },
            { cwd: priorProject.path, question: 'Prior project: choose a cache.', answer: 'Use the prior cache.' },
            { cwd: f.project.path, question, answer },
            { cwd: f.project.path, question: 'Revisit receipt choices.', answer: 'Later receipt mention without the original rationale.' },
        ];
        const header = JSON.stringify({
            timestamp: '2026-09-14T00:00:00.000Z',
            type: 'session_meta',
            payload: { id: nativeId, cwd: priorProject.path, originator: 'codex-tui', source: 'cli' },
        });
        const batches = interactions.map((interaction, index) => {
            const turnId = `native-turn-${index}`;
            const records = [
                { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
                { type: 'turn_context', payload: { turn_id: turnId, cwd: interaction.cwd } },
                {
                    type: 'response_item',
                    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: interaction.question }] },
                },
                { type: 'event_msg', payload: { type: 'user_message', message: interaction.question } },
                {
                    type: 'response_item',
                    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: interaction.answer }] },
                },
                { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: interaction.answer } },
            ];
            return records
                .map((record, offset) => JSON.stringify({ timestamp: new Date(NOW + index * 10_000 + offset).toISOString(), ...record }))
                .join('\n');
        });
        writeFileSync(sourcePath, `${[header, ...batches].join('\n')}\n`);

        // Derive indexes and project transitions from the real adapter, then
        // persist exactly those turns through the production segment writer.
        const ingested = [];
        let previousProject: string | undefined;
        for await (const turn of new CodexAdapter().parseTurns(sourcePath, undefined, { closeTrailingOnIdle: true })) {
            const result = f.store.recordIngestedTurn(
                turn,
                { surface: 'cli' },
                previousProject !== undefined && previousProject !== turn.projectPath,
                { decisions: [], pending_items: [], status: 'ok' },
                true,
            );
            expect(result?.inserted).toBe(true);
            ingested.push({ turn, session: result!.session });
            previousProject = turn.projectPath;
        }
        expect(ingested.map(({ turn, session }) => [turn.turnIndex, session.segment_index, turn.projectPath])).toEqual([
            [0, 0, priorProject.path],
            [1, 0, priorProject.path],
            [2, 1, f.project.path],
            [3, 1, f.project.path],
        ]);
        const target = ingested[2].session;
        expect(f.store.listMemoriesForSession(target.id).map((memory) => memory.turn_index)).toEqual([2, 3]);
        const reader = new SessionReader(f.db);
        const session = reader.sessionById(target.id)!;
        const evidence = await selectSessionEvidence(reader, session, undefined, 1500);
        expect(evidence.text).toContain(question);
        expect(evidence.text).toContain(answer);
        expect(evidence.text).not.toMatch(/prior|Later receipt/i);
        expect(evidence.coverage).toContain('durable stored interaction, stored turn index 2');
        const output = text(await f.service.getSession({ id: publicSessionId(target), query: 'What was our receipt choice?' }));
        expect(output).toContain(question);
        expect(output).toContain(answer);
        expect(output).not.toMatch(/prior|Later receipt/i);
        expect(output.length).toBeLessThanOrEqual(SESSION_EVIDENCE_MAX_CONTEXT_CHARS);

        // A fixed 5 MiB record exceeds the serving read ceiling independently
        // of the implementation constant. Its end must never be read/parsed.
        const oversized = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', padding: 'x'.repeat(5 * 1024 * 1024) } });
        writeFileSync(sourcePath, `${[header, ...batches.slice(0, 2), oversized, ...batches.slice(2)].join('\n')}\n`);
        expect(await selectSessionEvidence(reader, session, undefined, 1500)).toEqual(evidence);
        expect(text(await f.service.getSession({ id: publicSessionId(target), query: 'What was our receipt choice?' }))).toContain(answer);

        const handle = await open(sourcePath, 'r');
        const reads = vi.spyOn(handle, 'read');
        const emittedIndexes: number[] = [];
        try {
            await expect(async () => {
                for await (const turn of new CodexAdapter().parseTurns(sourcePath, undefined, {
                    handle,
                    closeTrailingOnIdle: true,
                    maxReadBytes: SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                })) {
                    emittedIndexes.push(turn.turnIndex);
                }
            }).rejects.toBeInstanceOf(TranscriptReadBudgetError);
            expect(emittedIndexes).toEqual([0]);
            const readEnds = reads.mock.calls.map((call) => {
                const args = call as unknown[];
                expect(typeof args[2]).toBe('number');
                expect(typeof args[3]).toBe('number');
                return (args[2] as number) + (args[3] as number);
            });
            // The ceiling bounds every read the parse makes, including the
            // adapter's user-boundary prescan: together they use it exactly,
            // and nothing past it is read.
            const readLengths = reads.mock.calls.map((call) => (call as unknown[])[2] as number);
            expect(readLengths.reduce((total, length) => total + length, 0)).toBe(SESSION_EVIDENCE_SOURCE_MAX_BYTES);
            expect(Math.max(...readEnds)).toBeLessThanOrEqual(SESSION_EVIDENCE_SOURCE_MAX_BYTES);
        } finally {
            await handle.close();
        }
    });
});
