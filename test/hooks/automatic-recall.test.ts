import { mkdirSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptReadBudgetError } from '../../src/adapters/base.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import {
    AUTOMATIC_RECALL_MAX_CANDIDATES,
    AUTOMATIC_RECALL_MAX_CONTEXT_CHARS,
    AUTOMATIC_RECALL_MAX_PER_CHAT,
    AUTOMATIC_RECALL_MAX_PROMPT_CHARS,
    AUTOMATIC_RECALL_MIN_SIMILARITY,
    DURABLE_CAPTURE_FILTER_VERSION,
    HOOK_WATCHDOG_TIMEOUT_MS,
    SEMANTIC_RECALL_MAX_HITS,
    SESSION_EVIDENCE_SOURCE_MAX_BYTES,
} from '../../src/config/constants.js';
import { setSetting } from '../../src/config/settings.js';
import * as providers from '../../src/embeddings/provider-config.js';
import type { HookTool } from '../../src/hooks/common.js';
import { runUserPromptSubmit, type UserPromptSubmitDependencies } from '../../src/hooks/user-prompt-submit.js';
import { ElephaMcpService } from '../../src/mcp/tools.js';
import { joinedAssistantStructure } from '../../src/rendering/assistant-structure.js';
import { filterTurn } from '../../src/rendering/filtered-turn.js';
import { containsSentinel } from '../../src/security/sentinel.js';
import * as automatic from '../../src/serving/automatic-recall.js';
import {
    AUTOMATIC_RECALL_INSTRUCTIONS,
    automaticContextInstructions,
    dataBlockClose,
    dataBlockOpen,
} from '../../src/serving/instructions.js';
import * as semantic from '../../src/serving/semantic-recall.js';
import { selectSessionEvidence } from '../../src/serving/session-evidence.js';
import { publicSessionId } from '../../src/serving/session-id.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { DurableCaptureStore } from '../../src/storage/durable-capture-store.js';
import { EmbeddingStore, lockedEmbedding } from '../../src/storage/embedding-store.js';
import { firstPromptSearch } from '../../src/storage/first-prompt-search.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { withMemoryReadGeneration } from '../../src/storage/paranoid-gate.js';
import * as readModel from '../../src/storage/session-read-model.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';

const configuration: providers.EmbeddingConfiguration = { provider: 'local', model: 'fixture', revision: 'v1', dimensions: 2 };
const NOW = Date.parse('2026-09-14T12:00:00Z');

function fixture(similarity = 1) {
    const f = createTestDb('automatic-recall-');
    vi.stubEnv('ELEPHA_HOME', f.directory);
    const configPath = path.join(f.directory, 'config.json');
    const project = seedProject(f);
    mkdirSync(project.path, { recursive: true });
    seedConsentRoot(f, { path: project.path });
    const session = seedSession(f, {
        project,
        title: 'Payment recovery',
        nativeId: 'payment-recovery',
        surface: 'cli',
        startedAt: '2026-09-14T00:00:00Z',
        lastTurnAt: '2026-09-14T00:00:00Z',
    });
    setSetting('memory-plus', 'true', configPath);
    const embeddings = new EmbeddingStore(f.db, configPath);
    const seeded = new Set<number>();
    const writeVector = (target = session, score = similarity) => {
        if (!seeded.has(target.id)) {
            seedRollup(f, {
                project,
                session: target,
                decisions: [{ what: 'Preserve recovery receipts.', why: 'Retries must remain idempotent.' }],
            });
            seeded.add(target.id);
        }
        return embeddings.write(
            embeddings.source(target.id)!,
            configuration,
            [score, Math.sqrt(1 - score ** 2)],
            withMemoryReadGeneration(f.db, lockedEmbedding, (token) => token),
        );
    };
    writeVector();
    const provider: providers.EmbeddingProvider = {
        configuration,
        embed: vi.fn(async () => [1, 0]),
        dispose: vi.fn(async () => {}),
    };
    const factory = vi.spyOn(providers, 'createEmbeddingProvider').mockResolvedValue(provider);
    const open = vi.fn();
    function openDatabase(dbPath: ':memory:'): ReturnType<typeof openUnmanagedDb>;
    function openDatabase(dbPath?: string): Promise<ReturnType<typeof openUnmanagedDb>>;
    function openDatabase(dbPath?: string) {
        open();
        const db = openUnmanagedDb(dbPath);
        return dbPath === ':memory:' ? db : Promise.resolve(db);
    }
    const log = vi.fn();
    const run = (
        prompt = '以前の支払い復旧の判断を踏まえて実装して',
        tool: HookTool = 'codex',
        chat = 'current',
        extra: UserPromptSubmitDependencies = {},
    ) =>
        runUserPromptSubmit(
            JSON.stringify({
                session_id: chat,
                cwd: project.path,
                hook_event_name: 'UserPromptSubmit',
                prompt,
                model: 'fixture',
                permission_mode: 'default',
            }),
            tool,
            { dbPath: f.dbPath, configPath, openDatabase, now: () => NOW, log, ...extra },
        );
    return { ...f, configPath, project, session, embeddings, provider, factory, open, log, run, writeVector };
}

function context(result: Awaited<ReturnType<typeof runUserPromptSubmit>>) {
    if (!('output' in result)) throw new Error(result.reason);
    expect(result.output).toEqual({
        continue: true,
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.any(String) },
    });
    return (result.output.hookSpecificOutput as { additionalContext: string }).additionalContext;
}

function candidatePool() {
    const f = fixture();
    for (let index = 0; index < AUTOMATIC_RECALL_MAX_PER_CHAT; index++) {
        f.writeVector(seedSession(f, { project: f.project, nativeId: `candidate-${index}`, title: `Candidate ${index}` }));
    }
    return f;
}

async function capChat(f: ReturnType<typeof candidatePool>) {
    context(await f.run());
    expect(await f.run()).toEqual({ reason: 'not_command' });
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('automatic Memory-Plus candidates', () => {
    it.each([false, true])('injects production-sized finals completely or abstains above the cap; oversized=%s', async (oversized) => {
        const f = fixture(0.929);
        const question =
            '¿Por qué descartamos usar la diferencia entre el primer y el segundo resultado para decidir el recuerdo automático?';
        const commentary =
            'Voy a recuperar la decisión y contrastar la evidencia. Los IDs no resuelven la pregunta por sí solos. ' +
            'Seguimos comprobando la fuente histórica. '.repeat(6);
        const final =
            'Porque el margen top1 - top2 no tenía poder discriminativo real:\n\n- Con el recuerdo correcto indexado, margen mediano: 0.0053.\n- Sin el recuerdo correcto, margen mediano: 0.0049.\n- Usando margen >= 0.01, aceptábamos 5 casos correctos y 6 incorrectos.\n\nLas distribuciones se solapaban casi por completo. Dos resultados malos pueden estar separados y un resultado bueno puede quedar cerca de un duplicado.';
        const followup =
            'El margen compara candidatos entre sí, sin verificar la relevancia del primero. Un duplicado puede acercarse al candidato correcto; eliminarlo cambia la distancia sin mejorar la evidencia disponible.\n'.repeat(
                oversized ? 14 : 6,
            );
        const parts = [commentary, final, followup];
        f.db.prepare('DELETE FROM session_rollups WHERE session_id = ?').run(f.session.id);
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
        f.writeVector();
        if (oversized) {
            expect(question.length + final.length + followup.length).toBeGreaterThan(AUTOMATIC_RECALL_MAX_CONTEXT_CHARS);
            expect(await f.run(question)).toEqual({ reason: 'not_command' });
            expect(f.log).toHaveBeenCalledWith(expect.stringContaining('first_interaction_exceeds_evidence_budget'));
            expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
            expect(f.store.countInjectionBodyPrefix('codex', 'current', automatic.AUTOMATIC_RECALL_BODY_PREFIX)).toBe(0);
            return;
        }
        const output = context(await f.run(question));
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
        expect(output.length).toBeLessThanOrEqual(AUTOMATIC_RECALL_MAX_CONTEXT_CHARS);
    });

    it.each(['after evidence', 'before transaction'] as const)('revalidates adjudicator eligibility %s', async (when) => {
        const f = fixture();
        const select = await import('../../src/serving/session-evidence.js');
        const original = select.selectSessionEvidence;
        let evidenceRead = false;
        vi.spyOn(select, 'selectSessionEvidence').mockImplementation(async (...args) => {
            const evidence = await original(...args);
            evidenceRead = true;
            if (when === 'after evidence') {
                f.db.prepare("UPDATE sessions SET kind = 'adjudicator' WHERE id = ?").run(f.session.id);
            }
            return evidence;
        });
        const read = readModel.readSessionById;
        let changed = false;
        vi.spyOn(readModel, 'readSessionById').mockImplementation((db, id) => {
            const result = read(db, id);
            if (when === 'before transaction' && evidenceRead && !changed && !db.inTransaction) {
                // The outer check saw an eligible row. Its transaction must
                // independently reject the same identity after reclassification.
                f.db.prepare("UPDATE sessions SET kind = 'adjudicator' WHERE id = ?").run(f.session.id);
                changed = true;
            }
            return result;
        });
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(evidenceRead).toBe(true);
        if (when === 'before transaction') expect(changed).toBe(true);
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
        expect(f.db.prepare('SELECT session_id FROM session_embeddings').all()).toEqual([{ session_id: f.session.id }]);
    });

    it('retains both historical options with a deictic answer and abstains when the complete pair cannot fit', async () => {
        const f = fixture(0.929);
        f.db.prepare('DELETE FROM session_rollups WHERE session_id = ?').run(f.session.id);
        const question = 'Option A: discard payment receipts.\n\nOption B: retain payment receipts.\n\nWhich option did we choose?';
        const answer = 'The second option, because retries need the original payment identity.';
        const first = seedMemory(f, { project: f.project, session: f.session, userMessage: question, assistantText: answer });
        seedMemory(f, { project: f.project, session: f.session, turnIndex: 1 });
        f.db
            .prepare(`INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, tool_calls,
            omitted_tool_call_count, dropped_tool_ref_count, omitted_before_chars, filter_version, captured_at)
            VALUES (?, 1, ?, ?, '[]', 0, 0, 0, ?, '2026-09-15')`)
            .run(first.id, question, answer, DURABLE_CAPTURE_FILTER_VERSION);
        f.writeVector();
        const output = context(await f.run('Which option did we choose for payment receipts?'));
        expect(output).toContain(question);
        expect(output).toContain(answer);
        expect(output.length).toBeLessThanOrEqual(AUTOMATIC_RECALL_MAX_CONTEXT_CHARS);
        const oversizedQuestion = `${'Scope and qualifiers for both options. '.repeat(100)}\n${question}`;
        f.db.prepare('UPDATE filtered_turns SET user_prompt = ? WHERE memory_id = ?').run(oversizedQuestion, first.id);
        f.db.prepare('UPDATE sessions SET first_prompt_search = ? WHERE id = ?').run(firstPromptSearch(oversizedQuestion), f.session.id);
        f.writeVector();
        expect(await f.run('Which option did we choose?', 'codex', 'pair-too-large')).toEqual({ reason: 'not_command' });
        expect(f.log).toHaveBeenCalledWith(expect.stringContaining('first_interaction_exceeds_evidence_budget'));
        expect(f.store.injectionsForSession('codex', 'pair-too-large', new Date(NOW).toISOString())).toEqual([]);
    });

    it.each(['durable', 'provider'] as const)(
        'injects the first interaction rationale before later repeated mentions, also for a nonlexical paraphrase: %s',
        async (source) => {
            const f = fixture(0.929);
            const question = '¿Por qué descartamos la diferencia entre el primer y el segundo resultado?';
            const decision =
                'Descartamos el margen porque no separaba respuestas correctas de ruido: 0.0053 frente a 0.0049; con margen >= 0.01 hubo 5 correctos frente a 6 incorrectos.';
            const answer = `${decision}\n\n${'Detalle posterior sobre margen y resultados. '.repeat(100)}`;
            // Remove only this fixture's rollup: exercise the exact indexed
            // first-prompt source rather than the normal rollup route.
            f.db.prepare('DELETE FROM session_rollups WHERE session_id = ?').run(f.session.id);
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
            f.writeVector();
            const noise = seedSession(f, { project: f.project, nativeId: 'noise', title: 'Matching title without response evidence' });
            f.embeddings.write(
                f.embeddings.source(noise.id)!,
                configuration,
                [0.843, Math.sqrt(1 - 0.843 ** 2)],
                withMemoryReadGeneration(f.db, lockedEmbedding, (token) => token),
            );
            // The mocked vector fixes already-tested semantic ranking. This
            // proves selection is language-independent, not embedding quality.
            const prompt = 'Explain the rejected confidence heuristic and its measured failure.';
            const output = context(await f.run(prompt));
            expect(output).toContain(decision);
            expect(output).not.toContain('Late margin mention');
            expect(output).not.toContain(publicSessionId(noise));
            expect(output).toContain('get_session is optional expansion');
            expect(output).toContain('later evidence units omitted');
            expect(output.length).toBeLessThanOrEqual(AUTOMATIC_RECALL_MAX_CONTEXT_CHARS);
            const body = f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString()).at(-1)!.body;
            expect(body.length).toBeLessThanOrEqual(AUTOMATIC_RECALL_MAX_CONTEXT_CHARS);
            expect(f.store.countInjectionBodyPrefix('codex', 'current', automatic.AUTOMATIC_RECALL_BODY_PREFIX)).toBe(1);
            const expanded = await new ElephaMcpService(f.db).getSession({ id: publicSessionId(f.session), query: prompt });
            expect(JSON.stringify(expanded.content)).toContain(decision);
        },
    );

    it('reads the first paired interaction of a nonzero native Codex segment and abstains at the streaming ceiling', async () => {
        const f = fixture(0);
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
        f.embeddings.write(
            f.embeddings.source(target.id)!,
            configuration,
            [1, 0],
            withMemoryReadGeneration(f.db, lockedEmbedding, (token) => token),
        );
        const reader = new SessionReader(f.db);
        const session = reader.sessionById(target.id)!;
        const evidence = await selectSessionEvidence(reader, session, undefined, 1500);
        expect(evidence.text).toContain(question);
        expect(evidence.text).toContain(answer);
        expect(evidence.text).not.toMatch(/prior|Later receipt/i);
        expect(evidence.coverage).toContain('provider transcript interaction, stored turn index 2');
        const output = context(await f.run('What was our receipt choice?', 'codex', 'segmented-current'));
        expect(output).toContain(question);
        expect(output).toContain(answer);
        expect(output).not.toMatch(/prior|Later receipt/i);
        expect(output.length).toBeLessThanOrEqual(AUTOMATIC_RECALL_MAX_CONTEXT_CHARS);

        // A fixed 5 MiB record exceeds the serving read ceiling independently
        // of the implementation constant. Its end must never be read/parsed.
        const oversized = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', padding: 'x'.repeat(5 * 1024 * 1024) } });
        writeFileSync(sourcePath, `${[header, ...batches.slice(0, 2), oversized, ...batches.slice(2)].join('\n')}\n`);
        const unavailable = await selectSessionEvidence(reader, session, undefined, 1500);
        expect(unavailable.text).toBe('');
        expect(unavailable.coverage).toContain('evidence_source_byte_budget');
        expect(await f.run('What was our receipt choice?', 'codex', 'segmented-bounded')).toEqual({ reason: 'not_command' });
        expect(f.log).toHaveBeenCalledWith(expect.stringContaining('evidence_source_byte_budget'));
        expect(f.store.injectionsForSession('codex', 'segmented-bounded', new Date(NOW).toISOString())).toEqual([]);

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
            expect(Math.max(...readEnds)).toBe(SESSION_EVIDENCE_SOURCE_MAX_BYTES);
        } finally {
            await handle.close();
        }
    });

    it.each(['revoke', 'incognito'] as const)('does not emit first-interaction evidence if %s changes during its read', async (action) => {
        const f = fixture();
        const select = await import('../../src/serving/session-evidence.js');
        const original = select.selectSessionEvidence;
        vi.spyOn(select, 'selectSessionEvidence').mockImplementation(async (...args) => {
            const evidence = await original(...args);
            if (action === 'revoke') f.store.consent.revoke(f.project.path);
            else f.store.recordIncognitoTranscript(f.session.tool, f.session.native_id);
            return evidence;
        });
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
    });

    it('exposes the irrelevant first hit and relevant second hit together, with individual deduplication and remaining budget', async () => {
        const f = fixture();
        f.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Unrelated deployment configuration', f.session.id);
        f.writeVector();
        const relevant = seedSession(f, { project: f.project, nativeId: 'second', title: 'Actual refund recovery decision' });
        f.writeVector(relevant, 0.98);
        const first = context(await f.run('What refund recovery decision preserved receipts?'));
        expect(first).toContain(`Session: ${publicSessionId(f.session)}`);
        expect(first).toContain(`Session: ${publicSessionId(relevant)}`);
        expect(f.store.countInjectionBodyPrefix('codex', 'current', automatic.AUTOMATIC_RECALL_BODY_PREFIX)).toBe(2);
        const third = seedSession(f, { project: f.project, nativeId: 'third', title: 'Third option' });
        const fourth = seedSession(f, { project: f.project, nativeId: 'fourth', title: 'Fourth option' });
        f.writeVector(third, 0.97);
        f.writeVector(fourth, 0.96);
        const followup = context(await f.run());
        expect(followup).toContain(publicSessionId(third));
        expect(followup).not.toContain(publicSessionId(f.session));
        expect(followup).not.toContain(publicSessionId(relevant));
        expect(followup).not.toContain(publicSessionId(fourth));
        expect(f.store.countInjectionBodyPrefix('codex', 'current', automatic.AUTOMATIC_RECALL_BODY_PREFIX)).toBe(3);
        expect(await f.run()).toEqual({ reason: 'not_command' });
    });

    it('enforces the aggregate sanitized budget and rolls back every receipt when the shared injection fails', async () => {
        const f = candidatePool();
        context(await f.run());
        const rows = f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString());
        const shared = rows.filter((row) => !row.body.startsWith(automatic.AUTOMATIC_RECALL_BODY_PREFIX));
        expect(shared).toHaveLength(1);
        expect(shared[0].body.length).toBeLessThanOrEqual(AUTOMATIC_RECALL_MAX_CONTEXT_CHARS);
        expect(rows.filter((row) => row.body.startsWith(automatic.AUTOMATIC_RECALL_BODY_PREFIX))).toHaveLength(3);
        expect(
            await f.run(undefined, 'codex', 'failed-chat', {
                writeInjection: (store, input) =>
                    input.body.startsWith(automatic.AUTOMATIC_RECALL_BODY_PREFIX) ? store.recordInjection(input) : false,
            }),
        ).toEqual({ reason: 'injection_record_failed' });
        expect(f.store.injectionsForSession('codex', 'failed-chat', new Date(NOW).toISOString())).toEqual([]);
    });

    it('returns the exact off result without opening the database, constructing a provider, embedding or scanning', async () => {
        const f = fixture();
        setSetting('memory-plus', 'false', f.configPath);
        vi.stubEnv('OPENAI_API_KEY', 'present-but-must-not-be-used');
        const scan = vi.spyOn(EmbeddingStore.prototype, 'scan');
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(f.open).not.toHaveBeenCalled();
        expect(f.factory).not.toHaveBeenCalled();
        expect(f.provider.embed).not.toHaveBeenCalled();
        expect(scan).not.toHaveBeenCalled();
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
    });

    it.each(['codex', 'claude-code', 'opencode'] as const)(
        'injects one small framed candidate with a usable MCP pointer: %s',
        async (tool) => {
            const f = fixture(0.98);
            const output = context(await f.run(undefined, tool));
            const nonce = output.match(/\[\[elepha-data ([a-f0-9-]+)\]\]/)![1];
            expect(output).toContain(automaticContextInstructions(nonce));
            expect(output).toContain(AUTOMATIC_RECALL_INSTRUCTIONS);
            expect(output).toContain(`${dataBlockOpen(nonce)}\nTitle: Payment recovery`);
            expect(output).toContain(`Date: 2026-09-14\nSession: ${publicSessionId(f.session)}\nDecision:`);
            expect(output).toContain(dataBlockClose(nonce));
            expect(output).toContain(`Session: ${publicSessionId(f.session)}`);
            expect(output).toContain(`Project: ${f.project.display_name}`);
            expect(output).toContain('Tool/surface: Codex CLI');
            expect(output).toContain(semantic.semanticDiscovery(0.98));
            expect(containsSentinel(output)).toBe(true);
            const injections = f.store.injectionsForSession(tool, 'current', new Date(NOW).toISOString());
            expect(injections).toHaveLength(2);
            expect(injections[1].body.length).toBeLessThanOrEqual(AUTOMATIC_RECALL_MAX_CONTEXT_CHARS);
            expect(f.provider.dispose).toHaveBeenCalledOnce();
        },
    );

    it('abstains below the floor, and at the exact floor', async () => {
        const f = fixture(AUTOMATIC_RECALL_MIN_SIMILARITY - 0.01);
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(f.provider.embed).toHaveBeenCalledOnce();
        vi.spyOn(semantic, 'semanticRecall').mockResolvedValue({
            candidates: [{ sessionId: f.session.id, similarity: AUTOMATIC_RECALL_MIN_SIMILARITY }],
        });
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
    });

    it('injects a candidate at 0.86 similarity between the old and new floors', async () => {
        const f = fixture(0.86);
        expect(context(await f.run())).toContain(`Session: ${publicSessionId(f.session)}`);
        expect(f.store.countInjectionBodyPrefix('codex', 'current', automatic.AUTOMATIC_RECALL_BODY_PREFIX)).toBe(1);
    });

    it.each([false, true])('caps automatic candidates per chat with explicit recall recorded first: %s', async (explicitFirst) => {
        const f = candidatePool();
        if (explicitFirst) {
            expect(context(await f.run('elepha:query payment'))).toContain(f.session.title);
            const injections = f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString());
            expect(injections).toHaveLength(1);
            expect(injections[0].body.startsWith(automatic.AUTOMATIC_RECALL_BODY_PREFIX)).toBe(false);
        }
        await capChat(f);
        for (let index = 0; index < AUTOMATIC_RECALL_MAX_PER_CHAT + 2; index++) {
            expect(await f.run(`Continue payment recovery, step ${index}`)).toEqual({ reason: 'not_command' });
        }
        const injections = f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString());
        const candidates = injections.filter((row) => row.body.startsWith(automatic.AUTOMATIC_RECALL_BODY_PREFIX));
        expect(candidates).toHaveLength(AUTOMATIC_RECALL_MAX_PER_CHAT);
        expect(new Set(candidates.map((row) => row.body.split('\n')[0])).size).toBe(AUTOMATIC_RECALL_MAX_PER_CHAT);
        expect(injections).toHaveLength(AUTOMATIC_RECALL_MAX_PER_CHAT + 1 + Number(explicitFirst));
    });

    it.each([
        ['codex', 'another-chat'],
        ['claude-code', 'current'],
        ['opencode', 'current'],
    ] as const)('keeps the cap scoped to the receiving tool and native chat: %s / %s', async (tool, chat) => {
        const f = candidatePool();
        await capChat(f);
        context(await f.run(undefined, tool, chat));
        expect(f.store.countInjectionBodyPrefix(tool, chat, automatic.AUTOMATIC_RECALL_BODY_PREFIX)).toBe(AUTOMATIC_RECALL_MAX_PER_CHAT);
        expect(await f.run()).toEqual({ reason: 'not_command' });
    });

    it('keeps explicit recall unfiltered after the automatic chat cap', async () => {
        const f = candidatePool();
        await capChat(f);
        const belowFloor = seedSession(f, { project: f.project, nativeId: 'explicit-only', title: 'Explicit-only discovery' });
        f.writeVector(belowFloor, 0.5);
        const output = context(await f.run('elepha:query unrelatedword'));
        expect(output).toContain(belowFloor.title);
        expect(f.store.shownSessionLists.forChat('codex', 'current')).toContain(belowFloor.id);
        expect(await f.run()).toEqual({ reason: 'not_command' });
    });

    it('short-circuits a capped chat before provider construction, embedding or vector scanning', async () => {
        const f = candidatePool();
        await capChat(f);
        f.factory.mockClear();
        vi.mocked(f.provider.embed).mockClear();
        const scan = vi.spyOn(EmbeddingStore.prototype, 'scan');
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(f.factory).not.toHaveBeenCalled();
        expect(f.provider.embed).not.toHaveBeenCalled();
        expect(scan).not.toHaveBeenCalled();
    });

    it('deduplicates across turns while preserving resume numbering and allowing another chat or changed source', async () => {
        const f = fixture();
        f.store.shownSessionLists.replace('codex', 'current', [f.session.id, f.session.id]);
        context(await f.run());
        expect(await f.run('Continue the payment recovery change')).toEqual({ reason: 'not_command' });
        expect(f.store.shownSessionLists.forChat('codex', 'current')).toEqual([f.session.id, f.session.id]);
        context(await f.run(undefined, 'codex', 'another-chat'));
        context(await f.run(undefined, 'claude-code'));
        f.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Revised payment recovery', f.session.id);
        // Source mismatch abstains until the manual regeneration path writes it.
        expect(await f.run()).toEqual({ reason: 'not_command' });
        f.writeVector();
        expect(context(await f.run())).toContain('Revised payment recovery');
    });

    it('stays silent across prompts when an indexed corpus has no qualifying candidate', async () => {
        const f = fixture(0.5);
        for (let index = 0; index < SEMANTIC_RECALL_MAX_HITS; index++) {
            f.writeVector(seedSession(f, { project: f.project, nativeId: `irrelevant-${index}`, title: `Irrelevant ${index}` }), 0.5);
        }
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(await f.run('Continue the change')).toEqual({ reason: 'not_command' });
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
    });

    it('qualifies emitted candidates with relevant shortlist cap loss and stays silent once the chat is capped', async () => {
        const f = fixture();
        for (let index = 0; index < SEMANTIC_RECALL_MAX_HITS; index++) {
            f.writeVector(seedSession(f, { project: f.project, nativeId: `relevant-${index}`, title: `Relevant ${index}` }), 1);
        }
        f.writeVector(seedSession(f, { project: f.project, nativeId: 'irrelevant', title: 'Irrelevant' }), 0.5);
        const output = context(await f.run());
        expect(output).toContain(AUTOMATIC_RECALL_INSTRUCTIONS);
        expect(output).toContain(semantic.semanticHitCapTruncation(1));
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(await f.run('Continue the change')).toEqual({ reason: 'not_command' });
        expect(f.store.countInjectionBodyPrefix('codex', 'current', automatic.AUTOMATIC_RECALL_BODY_PREFIX)).toBe(
            AUTOMATIC_RECALL_MAX_PER_CHAT,
        );
    });

    it.each(['rows', 'time'] as const)(
        'never emits a standalone %s scan notice for an empty or self-only shortlist',
        async (truncation) => {
            const f = fixture();
            const recall = vi.spyOn(semantic, 'semanticRecall').mockResolvedValue({ candidates: [], truncation });
            expect(await f.run()).toEqual({ reason: 'not_command' });
            recall.mockResolvedValue({ candidates: [{ sessionId: f.session.id, similarity: 1 }], truncation });
            expect(await f.run(undefined, 'codex', f.session.native_id)).toEqual({ reason: 'not_command' });
            expect(await f.run(undefined, 'codex', f.session.native_id)).toEqual({ reason: 'not_command' });
            expect(f.store.injectionsForSession('codex', f.session.native_id, new Date(NOW).toISOString())).toEqual([]);
            expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
            const output = context(await f.run(undefined, 'codex', 'notice-chat'));
            expect(output).toContain(publicSessionId(f.session));
            expect(output).toContain(semantic.semanticScanTruncation(truncation));
            expect(await f.run(undefined, 'codex', 'notice-chat')).toEqual({ reason: 'not_command' });
        },
    );

    it.each(['revoke', 'incognito'] as const)('rechecks after vector scan: %s', async (action) => {
        const f = fixture();
        const scan = EmbeddingStore.prototype.scan;
        vi.spyOn(EmbeddingStore.prototype, 'scan').mockImplementation(function (this: EmbeddingStore, ...args) {
            const result = scan.apply(this, args);
            if (action === 'revoke') f.store.consent.revoke(f.project.path);
            else f.store.recordIncognitoTranscript(f.session.tool, f.session.native_id);
            return result;
        });
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
    });

    it('rechecks consent immediately before emission after the deduplication lookup', async () => {
        const f = fixture();
        vi.spyOn(MemoryStore.prototype, 'hasInjectionBodyPrefix').mockImplementation(() => {
            f.store.consent.revoke(f.project.path);
            return false;
        });
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
    });

    it.each(['codex', 'claude-code', 'opencode'] as const)(
        'rechecks final eligibility when a candidate becomes incognito after the shortlist check: %s',
        async (tool) => {
            const f = fixture();
            const candidate = vi.spyOn(automatic, 'automaticRecallCandidate');
            const deduplicate = vi.spyOn(MemoryStore.prototype, 'hasInjectionBodyPrefix');
            const isIncognito = MemoryStore.prototype.isTranscriptIncognito;
            const eligibility = vi.spyOn(MemoryStore.prototype, 'isTranscriptIncognito').mockImplementation(function (
                this: MemoryStore,
                ...args
            ) {
                const incognito = isIncognito.apply(this, args);
                if (deduplicate.mock.calls.length > 0 && !incognito) {
                    // Return the real shortlist decision, then change eligibility
                    // on another connection before the final use-time recheck.
                    f.store.recordIncognitoTranscript(f.session.tool, f.session.native_id);
                }
                return incognito;
            });

            const result = await f.run(undefined, tool);

            // The shortlist accepted the hydrated candidate; only the final
            // recheck can now prevent its private title and pointer being emitted.
            expect(candidate).toHaveBeenCalledOnce();
            expect(candidate.mock.results[0].value.body).toContain(`Title: ${f.session.title}`);
            expect(candidate.mock.results[0].value.body).toContain(publicSessionId(f.session));
            expect(deduplicate).toHaveBeenCalledOnce();
            expect.soft(eligibility.mock.results.map((result) => result.value)).toEqual([false, true]);
            expect(f.store.isTranscriptIncognito(f.session.tool, f.session.native_id)).toBe(true);
            expect(f.db.prepare('SELECT id FROM sessions WHERE id = ?').get(f.session.id)).toBeDefined();
            expect(f.db.prepare('SELECT session_id FROM session_embeddings').all()).toEqual([]);
            const output = 'output' in result ? JSON.stringify(result.output) : '';
            expect(output).not.toContain(f.session.title);
            expect(output).not.toContain(publicSessionId(f.session));
            expect(output).toBe('');
            expect(result).toEqual({ reason: 'not_command' });
            expect(f.store.injectionsForSession(tool, 'current', new Date(NOW).toISOString())).toEqual([]);
        },
    );

    it('skips a candidate made incognito during deduplication and serves the eligible fallback', async () => {
        const f = fixture();
        const fallback = seedSession(f, { project: f.project, nativeId: 'eligible-fallback', title: 'Eligible fallback' });
        f.writeVector(fallback, 0.98);
        const lookup = MemoryStore.prototype.hasInjectionBodyPrefix;
        vi.spyOn(MemoryStore.prototype, 'hasInjectionBodyPrefix').mockImplementation(function (this: MemoryStore, ...args) {
            const duplicate = lookup.apply(this, args);
            f.store.recordIncognitoTranscript(f.session.tool, f.session.native_id);
            return duplicate;
        });
        const output = context(await f.run());
        expect(output).toContain(publicSessionId(fallback));
        expect(output).not.toContain(publicSessionId(f.session));
        expect(output).not.toContain(f.session.title);
        expect(f.store.countInjectionBodyPrefix('codex', 'current', automatic.AUTOMATIC_RECALL_BODY_PREFIX)).toBe(1);
    });

    it('does not recall the receiving chat or a different project', async () => {
        const f = fixture();
        expect(await f.run(undefined, 'codex', f.session.native_id)).toEqual({ reason: 'not_command' });
        const other = seedProject(f, { path: path.join(f.directory, 'other') });
        mkdirSync(other.path);
        seedConsentRoot(f, { path: other.path });
        f.project.path = other.path;
        expect(await f.run()).toEqual({ reason: 'not_command' });
    });

    describe.each(['self', 'injected'] as const)('ranked fallback after a %s candidate', (top) => {
        async function competition() {
            const f = fixture(0.99);
            const chat = top === 'self' ? f.session.native_id : 'current';
            if (top === 'injected') context(await f.run(undefined, 'codex', chat));
            const historical = seedSession(f, {
                project: f.project,
                nativeId: 'historical-recovery',
                title: 'Historical recovery decision',
                startedAt: '2026-09-13T00:00:00Z',
                lastTurnAt: '2026-09-13T00:00:00Z',
            });
            f.writeVector(historical, 0.98);
            return { ...f, historical, chat };
        }

        it('serves the next qualifying historical session and then deduplicates it', async () => {
            const f = await competition();
            const output = context(await f.run(undefined, 'codex', f.chat));
            expect(output).toContain(`Session: ${publicSessionId(f.historical)}`);
            expect(output).not.toContain(`Session: ${publicSessionId(f.session)}`);
            const count = f.store.injectionsForSession('codex', f.chat, new Date(NOW).toISOString()).length;
            expect(await f.run(undefined, 'codex', f.chat)).toEqual({ reason: 'not_command' });
            expect(f.store.injectionsForSession('codex', f.chat, new Date(NOW).toISOString())).toHaveLength(count);
        });

        it.each(['below floor', 'at floor', 'incognito'] as const)('abstains when the fallback is %s', async (rejection) => {
            const f = await competition();
            // Establish that this exact ranked competition can serve the fallback
            // before changing its eligibility; silence alone cannot detect early exit.
            expect(context(await f.run(undefined, 'codex', f.chat))).toContain(publicSessionId(f.historical));
            f.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Changed historical decision', f.historical.id);
            f.writeVector(f.historical, 0.98);
            const count = f.store.injectionsForSession('codex', f.chat, new Date(NOW).toISOString()).length;
            const recall = vi.spyOn(semantic, 'semanticRecall').mockImplementation(async () => {
                // Return an inference result that predates the eligibility change.
                if (rejection === 'incognito') f.store.recordIncognitoTranscript(f.historical.tool, f.historical.native_id);
                return {
                    candidates: [
                        { sessionId: f.session.id, similarity: 0.99 },
                        {
                            sessionId: f.historical.id,
                            similarity:
                                rejection === 'incognito'
                                    ? 0.98
                                    : AUTOMATIC_RECALL_MIN_SIMILARITY - (rejection === 'below floor' ? 0.01 : 0),
                        },
                    ],
                };
            });
            expect(await f.run(undefined, 'codex', f.chat)).toEqual({ reason: 'not_command' });
            expect(recall).toHaveBeenCalledOnce();
            expect(f.store.injectionsForSession('codex', f.chat, new Date(NOW).toISOString())).toHaveLength(count);
        });
    });

    it('serves at the candidate budget boundary but never walks beyond it', async () => {
        const f = fixture(0.99);
        const historical = seedSession(f, { project: f.project, nativeId: 'bounded-history', title: 'Bounded historical decision' });
        f.writeVector(historical, 0.98);
        const skipped = { sessionId: f.session.id, similarity: 0.99 };
        const fallback = { sessionId: historical.id, similarity: 0.98 };
        const recall = vi
            .spyOn(semantic, 'semanticRecall')
            .mockResolvedValue({ candidates: [...Array.from({ length: AUTOMATIC_RECALL_MAX_CANDIDATES - 1 }, () => skipped), fallback] });
        expect(context(await f.run(undefined, 'codex', f.session.native_id))).toContain(publicSessionId(historical));
        f.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Fresh bounded historical decision', historical.id);
        recall.mockResolvedValue({ candidates: [...Array.from({ length: AUTOMATIC_RECALL_MAX_CANDIDATES }, () => skipped), fallback] });
        const hydrate = vi.spyOn(semantic, 'currentRecallHits');
        expect(await f.run(undefined, 'codex', f.session.native_id)).toEqual({ reason: 'not_command' });
        expect(hydrate).toHaveBeenCalledOnce();
        expect(hydrate.mock.calls[0][2]).toHaveLength(AUTOMATIC_RECALL_MAX_CANDIDATES);
        expect(hydrate.mock.calls[0][2]).not.toContain(historical.id);
        expect(f.store.countInjectionBodyPrefix('codex', f.session.native_id, automatic.AUTOMATIC_RECALL_BODY_PREFIX)).toBe(1);
    });

    it('does no model work for empty, oversized or explicit command prompts', async () => {
        const f = fixture();
        expect(await f.run(' ')).toEqual({ reason: 'not_command' });
        expect(await f.run('x'.repeat(AUTOMATIC_RECALL_MAX_PROMPT_CHARS + 1))).toEqual({ reason: 'not_command' });
        context(await f.run('elepha:help'));
        context(await f.run('elepha:invalid'));
        expect(f.factory).not.toHaveBeenCalled();
    });

    it('reports provider failure without injecting and disposes it', async () => {
        const f = fixture();
        vi.mocked(f.provider.embed).mockRejectedValue(new Error('unavailable'));
        expect(await f.run()).toEqual({ reason: 'hook_error' });
        expect(f.provider.dispose).toHaveBeenCalledOnce();
        expect(f.log).toHaveBeenCalledWith(expect.stringContaining('reason=hook_error'));
    });

    it('discards inference that finishes after the automatic deadline', async () => {
        const f = fixture();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
        vi.mocked(f.provider.embed).mockImplementation(async () => {
            clock.mockReturnValue(NOW + HOOK_WATCHDOG_TIMEOUT_MS);
            return [1, 0];
        });
        expect(await f.run()).toEqual({ reason: 'hook_error' });
        expect(f.provider.dispose).toHaveBeenCalledOnce();
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
    });

    it('does not inject when Memory-Plus is disabled during inference', async () => {
        const f = fixture();
        vi.mocked(f.provider.embed).mockImplementation(async () => {
            setSetting('memory-plus', 'false', f.configPath);
            return [1, 0];
        });
        expect(await f.run()).toEqual({ reason: 'hook_error' });
        expect(f.provider.dispose).toHaveBeenCalledOnce();
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
    });

    it('does not mark a failed output recording as shown', async () => {
        const f = fixture();
        expect(await f.run(undefined, 'codex', 'current', { writeInjection: () => false })).toEqual({ reason: 'injection_record_failed' });
        context(await f.run());
    });
});
