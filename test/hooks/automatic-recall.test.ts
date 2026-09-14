import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    AUTOMATIC_RECALL_MAX_CONTEXT_CHARS,
    AUTOMATIC_RECALL_MAX_PROMPT_CHARS,
    AUTOMATIC_RECALL_MIN_SIMILARITY,
    HOOK_WATCHDOG_TIMEOUT_MS,
} from '../../src/config/constants.js';
import { setSetting } from '../../src/config/settings.js';
import * as providers from '../../src/embeddings/provider-config.js';
import type { HookTool } from '../../src/hooks/common.js';
import { runUserPromptSubmit, type UserPromptSubmitDependencies } from '../../src/hooks/user-prompt-submit.js';
import { containsSentinel } from '../../src/security/sentinel.js';
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
    const writeVector = () =>
        embeddings.write(
            embeddings.source(session.id)!,
            configuration,
            [similarity, Math.sqrt(1 - similarity ** 2)],
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

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('automatic Memory Plus candidates', () => {
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
        const f = fixture(0.94);
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(f.provider.embed).toHaveBeenCalledOnce();
        vi.spyOn(semantic, 'semanticRecall').mockResolvedValue([{ sessionId: f.session.id, similarity: AUTOMATIC_RECALL_MIN_SIMILARITY }]);
        expect(await f.run()).toEqual({ reason: 'not_command' });
        expect(f.store.injectionsForSession('codex', 'current', new Date(NOW).toISOString())).toEqual([]);
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

    it('does not recall the receiving chat or a different project', async () => {
        const f = fixture();
        expect(await f.run(undefined, 'codex', f.session.native_id)).toEqual({ reason: 'not_command' });
        const other = seedProject(f, { path: path.join(f.directory, 'other') });
        mkdirSync(other.path);
        seedConsentRoot(f, { path: other.path });
        f.project.path = other.path;
        expect(await f.run()).toEqual({ reason: 'not_command' });
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

    it('does not inject when Memory Plus is disabled during inference', async () => {
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
