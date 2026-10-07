import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSetting } from '../../src/config/settings.js';
import * as providers from '../../src/embeddings/provider-config.js';
import type { HookTool } from '../../src/hooks/common.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import * as currentChat from '../../src/serving/current-chat-evidence.js';
import * as semantic from '../../src/serving/semantic-recall.js';
import { openDb, type openUnmanagedDb } from '../../src/storage/db.js';
import { EmbeddingStore, lockedEmbedding } from '../../src/storage/embedding-store.js';
import { withMemoryReadGeneration } from '../../src/storage/paranoid-gate.js';
import { createTestDb, seedConsentRoot, seedProject, seedRollup, seedSession } from '../helpers/db.js';

function fixture(memoryPlus: boolean) {
    const f = createTestDb('current-chat-hook-');
    const project = seedProject(f);
    mkdirSync(project.path, { recursive: true });
    seedConsentRoot(f, { path: project.path });
    const configPath = path.join(f.directory, 'config.json');
    setSetting('memory-plus', memoryPlus ? 'true' : 'false', configPath);
    const databaseOpen = vi.fn();
    function openDatabase(dbPath: ':memory:'): ReturnType<typeof openUnmanagedDb>;
    function openDatabase(dbPath?: string): ReturnType<typeof openDb>;
    function openDatabase(dbPath?: string) {
        databaseOpen(dbPath);
        return dbPath === ':memory:' ? openDb(dbPath) : openDb(dbPath);
    }
    const run = (prompt: string, tool: HookTool = 'codex', dbPath = f.dbPath) =>
        runUserPromptSubmit(
            JSON.stringify({
                session_id: 'live-chat',
                cwd: project.path,
                hook_event_name: 'UserPromptSubmit',
                prompt,
                model: 'test',
                permission_mode: 'default',
            }),
            tool,
            { dbPath, configPath, openDatabase, log: vi.fn() },
        );
    return { ...f, project, configPath, databaseOpen, run };
}

afterEach(() => vi.restoreAllMocks());

describe('host-directed memory retrieval', () => {
    it.each(['codex', 'opencode'] as const)(
        'does no database or memory work for an ordinary %s prompt with Memory-Plus enabled',
        async (tool) => {
            const f = fixture(true);
            const session = seedSession(f, { project: f.project, title: 'Dispatch agreement' });
            seedRollup(f, {
                project: f.project,
                session,
                decisions: [{ what: 'Use batch_limit:17.', why: 'Initial dispatch agreement.' }],
            });
            const configuration = { provider: 'local', model: 'fixture', revision: 'v1', dimensions: 2 } as const;
            const embeddings = new EmbeddingStore(f.db, f.configPath);
            embeddings.write(
                embeddings.source(session.id)!,
                configuration,
                [1, 0],
                withMemoryReadGeneration(f.db, lockedEmbedding, (token) => token),
            );
            const read = vi.spyOn(currentChat, 'currentChatEvidence');
            const recall = vi.spyOn(semantic, 'semanticRecall');
            const embed = vi.fn(async () => [1, 0]);
            const provider = vi.spyOn(providers, 'createEmbeddingProvider').mockResolvedValue({
                configuration,
                embed,
                dispose: async () => {},
            });
            const scan = vi.spyOn(EmbeddingStore.prototype, 'scan');
            const prompt = 'Write unrelated.txt containing only the decimal result of 23 + 48 and a newline. Change no other files.';

            expect(await f.run(prompt, tool)).toEqual({ reason: 'not_command' });
            expect(f.databaseOpen).not.toHaveBeenCalled();
            expect(await f.run(prompt, tool, path.join(f.directory, 'missing.db'))).toEqual({ reason: 'not_command' });
            expect(recall).not.toHaveBeenCalled();
            expect(provider).not.toHaveBeenCalled();
            expect(embed).not.toHaveBeenCalled();
            expect(scan).not.toHaveBeenCalled();
            expect(read).not.toHaveBeenCalled();
            expect(f.store.injectionsForSession(tool, 'live-chat', new Date().toISOString())).toEqual([]);
        },
    );

    it('does no database or memory work for a Claude prompt without a transcript path', async () => {
        const f = fixture(true);
        const read = vi.spyOn(currentChat, 'currentChatEvidence');
        const provider = vi.spyOn(providers, 'createEmbeddingProvider');
        expect(await f.run('続けて', 'claude-code')).toEqual({ reason: 'not_command' });
        expect(f.databaseOpen).not.toHaveBeenCalled();
        expect(await f.run('続けて', 'claude-code', path.join(f.directory, 'missing.db'))).toEqual({ reason: 'not_command' });
        expect(provider).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        expect(f.store.injectionsForSession('claude-code', 'live-chat', new Date().toISOString())).toEqual([]);
    });
});
