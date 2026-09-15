import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    AUTOMATIC_RECALL_MAX_CANDIDATES,
    AUTOMATIC_RECALL_MAX_CONTEXT_CHARS,
    AUTOMATIC_RECALL_MAX_PER_CHAT,
    AUTOMATIC_RECALL_MAX_PROMPT_CHARS,
    AUTOMATIC_RECALL_MIN_SIMILARITY,
    HOOK_WATCHDOG_TIMEOUT_MS,
    SEMANTIC_RECALL_MAX_HITS,
} from '../../src/config/constants.js';
import { setSetting } from '../../src/config/settings.js';
import * as providers from '../../src/embeddings/provider-config.js';
import type { HookTool } from '../../src/hooks/common.js';
import { runUserPromptSubmit, type UserPromptSubmitDependencies } from '../../src/hooks/user-prompt-submit.js';
import { containsSentinel } from '../../src/security/sentinel.js';
import * as automatic from '../../src/serving/automatic-recall.js';
import { AUTOMATIC_RECALL_INSTRUCTIONS, dataBlockClose, dataBlockOpen, servedContextInstructions } from '../../src/serving/instructions.js';
import * as semantic from '../../src/serving/semantic-recall.js';
import { publicSessionId } from '../../src/serving/session-id.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { EmbeddingStore, lockedEmbedding } from '../../src/storage/embedding-store.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { withMemoryReadGeneration } from '../../src/storage/paranoid-gate.js';
import { createTestDb, seedConsentRoot, seedProject, seedSession } from '../helpers/db.js';

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
    const writeVector = (target = session, score = similarity) =>
        embeddings.write(
            embeddings.source(target.id)!,
            configuration,
            [score, Math.sqrt(1 - score ** 2)],
            withMemoryReadGeneration(f.db, lockedEmbedding, (token) => token),
        );
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
    for (let index = 0; index < AUTOMATIC_RECALL_MAX_PER_CHAT; index++) {
        context(await f.run());
    }
    expect(await f.run()).toEqual({ reason: 'not_command' });
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('automatic Memory-Plus candidates', () => {
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
            expect(output).toContain(servedContextInstructions(nonce));
            expect(output).toContain(AUTOMATIC_RECALL_INSTRUCTIONS);
            expect(output).toContain(`${dataBlockOpen(nonce)}\nTitle: Payment recovery`);
            expect(output).toContain(`Date: 2026-09-14\nSession: ${publicSessionId(f.session)}\n${dataBlockClose(nonce)}`);
            expect(output).toContain(`get_session({"id":"${publicSessionId(f.session)}"})`);
            expect(output).toContain(`Project: ${f.project.display_name}`);
            expect(output).toContain('Tool/surface: Codex CLI');
            expect(output).toContain(semantic.semanticDiscovery(0.98));
            expect(containsSentinel(output)).toBe(true);
            const injections = f.store.injectionsForSession(tool, 'current', new Date(NOW).toISOString());
            expect(injections).toHaveLength(1);
            expect(injections[0].body.length).toBeLessThanOrEqual(AUTOMATIC_RECALL_MAX_CONTEXT_CHARS);
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
        expect(context(await f.run())).toContain(`get_session({"id":"${publicSessionId(f.session)}"})`);
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toHaveLength(1);
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
        expect(injections).toHaveLength(AUTOMATIC_RECALL_MAX_PER_CHAT + Number(explicitFirst));
    });

    it.each([
        ['codex', 'another-chat'],
        ['claude-code', 'current'],
        ['opencode', 'current'],
    ] as const)('keeps the cap scoped to the receiving tool and native chat: %s / %s', async (tool, chat) => {
        const f = candidatePool();
        await capChat(f);
        context(await f.run(undefined, tool, chat));
        expect(f.store.injectionsForSession(tool, chat, new Date(NOW).toISOString())).toHaveLength(1);
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
        for (let index = 0; index < AUTOMATIC_RECALL_MAX_PER_CHAT; index++) {
            const output = context(await f.run());
            expect(output).toContain('get_session(');
            expect(output).toContain(semantic.semanticHitCapTruncation(1));
        }
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(await f.run('Continue the change')).toEqual({ reason: 'not_command' });
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toHaveLength(AUTOMATIC_RECALL_MAX_PER_CHAT);
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
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toHaveLength(1);
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
            expect(output).toContain(`get_session({"id":"${publicSessionId(f.historical)}"})`);
            expect(output).not.toContain(`get_session({"id":"${publicSessionId(f.session)}"})`);
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
        expect(f.store.injectionsForSession('codex', f.session.native_id, new Date(NOW).toISOString())).toHaveLength(1);
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
