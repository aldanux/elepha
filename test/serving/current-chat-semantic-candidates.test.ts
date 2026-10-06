import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DURABLE_CAPTURE_FILTER_VERSION } from '../../src/config/constants.js';
import { setSetting } from '../../src/config/settings.js';
import { boundedEmbeddingText } from '../../src/embeddings/generate-turns.js';
import { type EmbeddingProvider, embeddingConfiguration } from '../../src/embeddings/provider-config.js';
import { currentChatSemanticCandidates } from '../../src/serving/current-chat-semantic-candidates.js';
import { TURN_EMBEDDINGS_TABLE } from '../../src/storage/turn-embeddings.js';
import { TURN_SEARCH_INDEX_TABLE } from '../../src/storage/turn-search-index.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedSession } from '../helpers/db.js';

function fixture() {
    const f = createTestDb('current-chat-semantic-');
    const checkout = path.join(f.directory, 'checkout');
    mkdirSync(checkout);
    const project = seedProject(f, { path: checkout });
    seedConsentRoot(f, { path: checkout });
    const configPath = path.join(f.directory, 'config.json');
    const model = embeddingConfiguration(true)!;
    const provider: EmbeddingProvider = {
        configuration: model,
        embed: vi.fn(async (_text, check) => {
            check();
            return Array(model.dimensions).fill(0.25);
        }),
        dispose: vi.fn(async () => {}),
    };
    const createProvider = vi.fn(async () => provider);
    const capture = (
        nativeId: string,
        turnIndex: number,
        user: string,
        assistant: string,
        sourceDigest = 'a'.repeat(64),
        existingSession?: ReturnType<typeof seedSession>,
        tool: 'codex' | 'opencode' = 'codex',
    ) => {
        const session = existingSession ?? seedSession(f, { project, nativeId, tool });
        const memory = seedMemory(f, { project, session, turnIndex, userMessage: user, assistantText: assistant, durableCapture: true });
        f.db
            .prepare(`INSERT INTO durable_capture_status (session_id, state, filter_version, updated_at)
            VALUES (?, 'complete', ?, '2026-09-27')
            ON CONFLICT(session_id) DO UPDATE SET state = 'complete', filter_version = excluded.filter_version`)
            .run(session.id, DURABLE_CAPTURE_FILTER_VERSION);
        f.db
            .prepare(`UPDATE ${TURN_SEARCH_INDEX_TABLE} SET coverage = 'included', locator = 'available',
            source_cursor = '0', source_digest = ?, filter_version = ? WHERE memory_id = ?`)
            .run(sourceDigest, DURABLE_CAPTURE_FILTER_VERSION, memory.id);
        const textHash = boundedEmbeddingText(user, assistant, DURABLE_CAPTURE_FILTER_VERSION, sourceDigest).hash;
        const vector = Buffer.alloc(model.dimensions * 4);
        for (let index = 0; index < model.dimensions; index++) vector.writeFloatLE(0.25, index * 4);
        f.db
            .prepare(`INSERT INTO ${TURN_EMBEDDINGS_TABLE}
            (memory_id, project_id, source_digest, text_hash, model, model_revision, dimensions, vector, computed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-09-27')`)
            .run(memory.id, project.id, sourceDigest, textHash, model.model, model.revision, model.dimensions, vector);
        return { session, memory };
    };
    return { ...f, checkout, project, configPath, provider, createProvider, capture };
}

describe('same-native-chat semantic candidates', () => {
    it('requires Memory-Plus before provider use and returns only filtered evidence from the exact chat', async () => {
        const f = fixture();
        f.capture('current-chat', 0, 'Keep the signed receipt', 'Agreed.');
        f.capture('adjacent-chat', 0, 'Private adjacent instruction', 'Do not expose.');
        const input = { tool: 'codex' as const, nativeSessionId: 'current-chat', cwd: f.checkout, query: 'recibo firmado' };
        expect(await currentChatSemanticCandidates(f.db, input, f)).toEqual({ state: 'unavailable', reason: 'memory_plus_disabled' });
        expect(f.createProvider).not.toHaveBeenCalled();
        setSetting('memory-plus', 'true', f.configPath);
        const result = await currentChatSemanticCandidates(f.db, input, f);
        expect(result.state).toBe('available');
        if (result.state !== 'available') return;
        expect(result.candidates).toMatchObject([{ userPrompt: 'Keep the signed receipt', assistantResponse: 'Agreed.' }]);
        expect(result.candidates[0]?.similarity).toBeGreaterThan(0);
        expect(JSON.stringify(result)).not.toContain('Private adjacent instruction');
        f.db.close();
    });

    it('rejects a stale vector and rechecks consent after query inference', async () => {
        const f = fixture();
        const item = f.capture('current-chat', 0, 'Keep the signed receipt', 'Agreed.');
        setSetting('memory-plus', 'true', f.configPath);
        const input = { tool: 'codex' as const, nativeSessionId: 'current-chat', cwd: f.checkout, query: 'recibo firmado' };
        f.db.prepare(`UPDATE ${TURN_EMBEDDINGS_TABLE} SET text_hash = ? WHERE memory_id = ?`).run('b'.repeat(64), item.memory.id);
        expect(await currentChatSemanticCandidates(f.db, input, f)).toMatchObject({
            state: 'unavailable',
            reason: 'stale_or_invalid_vectors',
        });
        vi.mocked(f.provider.embed).mockImplementation(async (_text, check) => {
            check();
            f.store.consent.revoke(f.checkout);
            return Array(f.provider.configuration.dimensions).fill(0.25);
        });
        expect(await currentChatSemanticCandidates(f.db, input, f)).toEqual({
            state: 'unavailable',
            reason: 'current_chat_authorization_changed',
        });
        f.db.close();
    });

    it('skips oversized ranked evidence and continues to a smaller turn', async () => {
        const f = fixture();
        const first = f.capture('current-chat', 0, 'Keep the signed receipt', 'Agreed.');
        f.capture('current-chat', 1, 'x'.repeat(2_000), 'y'.repeat(2_000), 'b'.repeat(64), first.session);
        setSetting('memory-plus', 'true', f.configPath);
        const result = await currentChatSemanticCandidates(
            f.db,
            { tool: 'codex', nativeSessionId: 'current-chat', cwd: f.checkout, query: 'receipt' },
            f,
        );
        expect(result).toMatchObject({
            state: 'available',
            partialCoverage: true,
            candidates: [{ turnIndex: 0, userPrompt: 'Keep the signed receipt' }],
        });
        f.db.close();
    });

    it('orders different scores without dropping a lower-scored candidate', async () => {
        const f = fixture();
        const first = f.capture('current-chat', 0, 'Earlier decision', 'Keep it.');
        const second = f.capture('current-chat', 1, 'Later decision', 'Also keep it.', 'b'.repeat(64), first.session);
        const vector = Buffer.alloc(f.provider.configuration.dimensions * 4);
        for (let index = 0; index < f.provider.configuration.dimensions; index++) {
            vector.writeFloatLE(index % 2 === 0 ? 0.25 : -0.25, index * 4);
        }
        f.db.prepare(`UPDATE ${TURN_EMBEDDINGS_TABLE} SET vector = ? WHERE memory_id = ?`).run(vector, second.memory.id);
        setSetting('memory-plus', 'true', f.configPath);
        const result = await currentChatSemanticCandidates(
            f.db,
            { tool: 'codex', nativeSessionId: 'current-chat', cwd: f.checkout, query: 'decision' },
            f,
        );
        expect(result.state).toBe('available');
        if (result.state !== 'available') return;
        expect(result.candidates.map((candidate) => candidate.turnIndex)).toEqual([0, 1]);
        expect(result.candidates[0]!.similarity).toBeGreaterThan(result.candidates[1]!.similarity);
        expect(result.candidates.map((candidate) => candidate.evidenceSource)).toEqual(['durable', 'durable']);
        f.db.close();
    });

    it('reports missing turn vectors as unavailable coverage', async () => {
        const f = fixture();
        const item = f.capture('current-chat', 0, 'Unembedded decision', 'Keep it.');
        f.db.prepare(`DELETE FROM ${TURN_EMBEDDINGS_TABLE} WHERE memory_id = ?`).run(item.memory.id);
        setSetting('memory-plus', 'true', f.configPath);
        const result = await currentChatSemanticCandidates(
            f.db,
            { tool: 'codex', nativeSessionId: 'current-chat', cwd: f.checkout, query: 'decision' },
            f,
        );
        expect(result).toEqual({ state: 'unavailable', reason: 'turn_vectors_missing' });
        expect(f.createProvider).not.toHaveBeenCalled();
        f.db.close();
    });

    it('disposes a provider that finishes loading after the lookup deadline', async () => {
        const f = fixture();
        f.capture('current-chat', 0, 'Keep the decision', 'Agreed.');
        setSetting('memory-plus', 'true', f.configPath);
        const controller = new AbortController();
        let resolveProvider: (provider: EmbeddingProvider) => void = () => {};
        const loading = new Promise<EmbeddingProvider>((resolve) => {
            resolveProvider = resolve;
        });
        const createProvider = vi.fn(async () => loading);
        const lookup = currentChatSemanticCandidates(
            f.db,
            { tool: 'codex', nativeSessionId: 'current-chat', cwd: f.checkout, query: 'decision' },
            { ...f, createProvider, signal: controller.signal },
        );
        await vi.waitFor(() => expect(createProvider).toHaveBeenCalledOnce());
        controller.abort();
        expect(await lookup).toEqual({ state: 'unavailable', reason: 'deadline' });
        resolveProvider(f.provider);
        await vi.waitFor(() => expect(f.provider.dispose).toHaveBeenCalledOnce());
        expect(f.provider.embed).not.toHaveBeenCalled();
        f.db.close();
    });

    it('excludes OpenCode V1 sessions while allowing V2 durable evidence', async () => {
        const f = fixture();
        const item = f.capture('opencode-chat', 0, 'Keep the V2 decision', 'Agreed.', 'a'.repeat(64), undefined, 'opencode');
        setSetting('memory-plus', 'true', f.configPath);
        const input = { tool: 'opencode' as const, nativeSessionId: 'opencode-chat', cwd: f.checkout, query: 'decision' };
        expect(await currentChatSemanticCandidates(f.db, input, f)).toEqual({
            state: 'unavailable',
            reason: 'current_chat_checkout_mismatch',
        });
        expect(f.createProvider).not.toHaveBeenCalled();
        f.db.prepare("UPDATE sessions SET source_format = 'opencode-v2' WHERE id = ?").run(item.session.id);
        expect(await currentChatSemanticCandidates(f.db, input, f)).toMatchObject({ state: 'available', candidates: [{ turnIndex: 0 }] });
        f.db.close();
    });
});
