import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSetting } from '../../src/config/settings.js';
import * as providers from '../../src/embeddings/provider-config.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import * as currentChat from '../../src/serving/current-chat-evidence.js';
import * as semantic from '../../src/serving/semantic-recall.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { createTestDb, seedConsentRoot, seedProject } from '../helpers/db.js';

// Automatic natural-language recall belongs to Memory-Plus alone. Continuation
// or "as we discussed" phrasing in any language gets no provider-free branch.
const FORMER_CUES = ['Continue.', '¿Qué sigue?', 'As we discussed earlier in this chat, keep the receipt format.', '続けて'];

function fixture(memoryPlus: boolean) {
    const f = createTestDb('current-chat-hook-');
    const project = seedProject(f);
    mkdirSync(project.path, { recursive: true });
    seedConsentRoot(f, { path: project.path });
    const configPath = path.join(f.directory, 'config.json');
    setSetting('memory-plus', memoryPlus ? 'true' : 'false', configPath);
    const open = vi.fn();
    function openDatabase(dbPath: ':memory:'): ReturnType<typeof openUnmanagedDb>;
    function openDatabase(dbPath?: string): Promise<ReturnType<typeof openUnmanagedDb>>;
    function openDatabase(dbPath?: string) {
        open();
        const db = openUnmanagedDb(dbPath);
        return dbPath === ':memory:' ? db : Promise.resolve(db);
    }
    const run = (prompt: string) =>
        runUserPromptSubmit(
            JSON.stringify({
                session_id: 'live-chat',
                cwd: project.path,
                hook_event_name: 'UserPromptSubmit',
                prompt,
                model: 'test',
                permission_mode: 'default',
            }),
            'codex',
            { dbPath: f.dbPath, configPath, openDatabase, log: vi.fn() },
        );
    return { ...f, open, run };
}

afterEach(() => vi.restoreAllMocks());

describe('no automatic current-chat branch in the prompt hook', () => {
    it.each(FORMER_CUES)('stays inert with Memory-Plus off: %s', async (prompt) => {
        const f = fixture(false);
        const read = vi.spyOn(currentChat, 'currentChatEvidence');
        const provider = vi.spyOn(providers, 'createEmbeddingProvider');
        expect(await f.run(prompt)).toEqual({ reason: 'not_command' });
        expect(f.open).not.toHaveBeenCalled();
        expect(provider).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
    });

    it.each(FORMER_CUES)('routes to historical semantic recall only with Memory-Plus on: %s', async (prompt) => {
        const f = fixture(true);
        const read = vi.spyOn(currentChat, 'currentChatEvidence');
        const recall = vi.spyOn(semantic, 'semanticRecall').mockRejectedValue(new Error('stop after routing'));
        expect('output' in (await f.run(prompt))).toBe(false);
        expect(recall).toHaveBeenCalledWith(expect.anything(), expect.anything(), prompt, expect.anything());
        expect(read).not.toHaveBeenCalled();
        expect(f.store.injectionsForSession('codex', 'live-chat', new Date().toISOString())).toHaveLength(0);
    });
});
