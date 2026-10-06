import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TURN_EMBEDDING_MAX_TEXT_CHARS, TURN_EMBEDDING_PASS_MAX_ROWS } from '../../src/config/constants.js';
import { setSetting } from '../../src/config/settings.js';
import { generateTurnEmbeddings } from '../../src/embeddings/generate-turns.js';
import { type EmbeddingProvider, embeddingConfiguration } from '../../src/embeddings/provider-config.js';
import { filterTurn } from '../../src/rendering/filtered-turn.js';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import type { IndexedTurnEvidence } from '../../src/serving/session-reader.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { TurnEmbeddingSourceChangedError, TurnEmbeddingStore } from '../../src/storage/turn-embedding-store.js';
import { TURN_EMBEDDINGS_TABLE } from '../../src/storage/turn-embeddings.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const summary = { decisions: [], pending_items: [], status: 'not_configured' as const };

function fixture() {
    const projectPath = withGrantableTestDir('elepha-turn-embedding-generation-');
    const db = openUnmanagedDb(':memory:');
    const store = new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null });
    store.consent.grant(projectPath);
    const configPath = path.join(projectPath, 'config.json');
    const makeTurn = (turnIndex = 0, overrides: Partial<ParsedTurn> = {}): ParsedTurn => ({
        tool: 'codex',
        sessionId: 'turn-embedding-generation',
        sourcePath: path.join(projectPath, 'session.jsonl'),
        projectPath,
        turnIndex,
        startedAt: '2026-09-27T00:00:00.000Z',
        endedAt: '2026-09-27T00:00:01.000Z',
        userMessage: `user prompt ${turnIndex}`,
        assistantText: `assistant reply ${turnIndex}`,
        toolCalls: [],
        cursor: `${turnIndex}:1:abc`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
        ...overrides,
    });
    const ingest = (turn: ParsedTurn) => {
        expect(store.recordIngestedTurn(turn, {}, false, summary, true)?.inserted).toBe(true);
    };
    const rows = () => db.prepare(`SELECT * FROM ${TURN_EMBEDDINGS_TABLE} ORDER BY memory_id`).all() as Array<Record<string, unknown>>;
    const reader = {
        indexedTurnEvidence: vi.fn(
            async (_session: unknown, turnIndex: number): Promise<IndexedTurnEvidence> => ({
                state: 'available',
                turnIndex,
                projection: filterTurn(makeTurn(turnIndex)),
                source: 'transcript',
            }),
        ),
    };
    const configuration = embeddingConfiguration(true)!;
    const provider: EmbeddingProvider = {
        configuration,
        embed: vi.fn(async (_text, beforeUse) => {
            beforeUse();
            return Array(configuration.dimensions).fill(0.25);
        }),
        dispose: vi.fn(async () => {}),
    };
    const createProvider = vi.fn(async () => provider);
    return { projectPath, db, store, configPath, makeTurn, ingest, rows, reader, provider, createProvider };
}

function enable(configPath: string): void {
    setSetting('memory-plus', 'true', configPath);
}

describe('offline turn embedding generation', () => {
    it('is zero-cost when Memory-Plus is off', async () => {
        const f = fixture();
        f.ingest(f.makeTurn());

        const result = await generateTurnEmbeddings(f.db, f);

        expect(result).toMatchObject({ disabled: true, generated: 0, scanned: 0 });
        expect(f.reader.indexedTurnEvidence).not.toHaveBeenCalled();
        expect(f.createProvider).not.toHaveBeenCalled();
        expect(f.rows()).toEqual([]);
        f.db.close();
    });

    it('uses the unified reader to embed exact filtered durable text without a provider transcript', async () => {
        const f = fixture();
        enable(f.configPath);
        const project = f.store.upsertProject(f.projectPath);
        const session = f.store.upsertSession('codex', 'turn-embedding-generation', project.id, path.join(f.projectPath, 'missing.jsonl'));
        const parsed = f.makeTurn(0, { sourcePath: session.source_path, userMessage: 'Keep the signed receipt' });
        expect(f.store.recordTurn(parsed, session.id, project.id, summary, true)).toBe(true);

        const result = await generateTurnEmbeddings(f.db, { configPath: f.configPath, createProvider: f.createProvider });

        expect(result).toMatchObject({ generated: 1, unavailable: 0, failed: 0 });
        expect(vi.mocked(f.provider.embed).mock.calls[0]?.[0]).toContain('Keep the signed receipt');
        expect(f.rows()).toHaveLength(1);
        f.db.close();
    });

    it('does not bind stale durable text to a new source digest after reingest', async () => {
        const f = fixture();
        enable(f.configPath);
        const project = f.store.upsertProject(f.projectPath);
        const session = f.store.upsertSession('codex', 'turn-embedding-generation', project.id, path.join(f.projectPath, 'missing.jsonl'));
        const original = f.makeTurn(0, { sourcePath: session.source_path, userMessage: 'Old durable text' });
        expect(f.store.recordTurn(original, session.id, project.id, summary, true)).toBe(true);
        f.store.reingestTurn(
            f.makeTurn(0, { sourcePath: session.source_path, userMessage: 'New source text' }),
            session.id,
            project.id,
            summary,
        );

        const result = await generateTurnEmbeddings(f.db, { configPath: f.configPath, createProvider: f.createProvider });

        // Without a retained replacement the turn loses its coverage row, so it
        // is no longer an embedding candidate at all.
        expect(result).toMatchObject({ generated: 0, scanned: 0 });
        expect(f.createProvider).not.toHaveBeenCalled();
        expect(f.rows()).toEqual([]);
        f.db.close();
    });

    it('records unusable stored evidence as unavailable without loading the model', async () => {
        const f = fixture();
        enable(f.configPath);
        // The uncaptured first turn leaves the session with a capture gap, so
        // the indexed second turn's stored evidence cannot be served.
        expect(f.store.recordIngestedTurn(f.makeTurn(0), {}, false, summary)?.inserted).toBe(true);
        f.ingest(f.makeTurn(1));

        const result = await generateTurnEmbeddings(f.db, { configPath: f.configPath, createProvider: f.createProvider });

        expect(result).toMatchObject({ generated: 0, unavailable: 1, failed: 0 });
        expect(f.createProvider).not.toHaveBeenCalled();
        expect(f.rows()).toEqual([]);
        f.db.close();
    });

    it('stores a sanitized bounded vector once, then skips an unchanged source without creating another provider', async () => {
        const f = fixture();
        enable(f.configPath);
        const turn = f.makeTurn(0, { assistantText: `older ${'x'.repeat(TURN_EMBEDDING_MAX_TEXT_CHARS)} newest-marker $(touch file)` });
        f.ingest(turn);
        f.reader.indexedTurnEvidence.mockResolvedValue({
            state: 'available',
            turnIndex: 0,
            projection: filterTurn(turn),
            source: 'transcript',
        });

        const first = await generateTurnEmbeddings(f.db, f);
        const stored = f.rows()[0];
        const embedded = vi.mocked(f.provider.embed).mock.calls[0]?.[0];

        expect(first).toMatchObject({ generated: 1, current: 0, failed: 0, scanned: 1 });
        expect(f.rows()).toHaveLength(1);
        expect(stored).toMatchObject({ source_digest: expect.any(String), text_hash: expect.any(String), dimensions: 384 });
        expect(stored).not.toHaveProperty('text');
        expect(embedded).toContain('newest-marker');
        expect(embedded).not.toContain('older');
        expect(embedded?.length).toBeLessThanOrEqual(TURN_EMBEDDING_MAX_TEXT_CHARS);
        expect(detectShellSyntax(embedded ?? '')).toBe(false);
        const second = await generateTurnEmbeddings(f.db, { ...f, createProvider: vi.fn() });
        expect(second).toMatchObject({ generated: 0, current: 1, scanned: 1 });
        expect(vi.mocked(f.provider.embed)).toHaveBeenCalledTimes(1);
        f.db.close();
    });

    it('invalidates and regenerates after a reingest', async () => {
        const f = fixture();
        enable(f.configPath);
        const first = f.makeTurn();
        f.ingest(first);
        await generateTurnEmbeddings(f.db, f);
        const oldHash = f.rows()[0]?.text_hash;
        const session = f.store.findSession(first.tool, first.sessionId);
        const replacement = f.makeTurn(0, { userMessage: 'rewritten question about a different module' });
        expect(f.store.reingestTurn(replacement, session?.id ?? -1, session?.project_id ?? -1, summary, false, true)).toBe(true);
        expect(f.rows()).toEqual([]);
        f.reader.indexedTurnEvidence.mockResolvedValue({
            state: 'available',
            turnIndex: 0,
            projection: filterTurn(replacement),
            source: 'transcript',
        });

        expect(await generateTurnEmbeddings(f.db, f)).toMatchObject({ generated: 1, current: 0 });
        expect(f.rows()[0]?.text_hash).not.toBe(oldHash);
        f.db.close();
    });

    it.each([
        ['missing source', 'indexed_turn_source_unavailable', 'unavailable'],
        ['digest mismatch', 'indexed_turn_source_changed', 'sourceChanged'],
    ] as const)('records %s without model cost', async (_label, reason, counter) => {
        const f = fixture();
        enable(f.configPath);
        f.ingest(f.makeTurn());
        f.reader.indexedTurnEvidence.mockResolvedValue({ state: 'unavailable', reason });

        const result = await generateTurnEmbeddings(f.db, f);

        expect(result[counter]).toBe(1);
        expect(f.createProvider).not.toHaveBeenCalled();
        expect(f.rows()).toEqual([]);
        f.db.close();
    });

    it('aborts when the exact reader reports lost checkout authorization', async () => {
        const f = fixture();
        enable(f.configPath);
        f.ingest(f.makeTurn(0));
        f.ingest(f.makeTurn(1));
        f.reader.indexedTurnEvidence.mockResolvedValue({ state: 'unavailable', reason: 'checkout_not_consented' });

        await expect(generateTurnEmbeddings(f.db, f)).rejects.toThrow(TurnEmbeddingSourceChangedError);
        expect(f.reader.indexedTurnEvidence).toHaveBeenCalledTimes(1);
        expect(f.createProvider).not.toHaveBeenCalled();
        expect(f.rows()).toEqual([]);
        f.db.close();
    });

    it('aborts a failed local inference without storing a partial vector', async () => {
        const f = fixture();
        enable(f.configPath);
        f.ingest(f.makeTurn());
        vi.mocked(f.provider.embed).mockRejectedValueOnce(new Error('local inference failed'));

        await expect(generateTurnEmbeddings(f.db, f)).rejects.toThrow('local inference failed');
        expect(f.rows()).toEqual([]);
        f.db.close();
    });

    it('aborts provider creation before attempting another turn', async () => {
        const f = fixture();
        enable(f.configPath);
        f.ingest(f.makeTurn(0));
        f.ingest(f.makeTurn(1));
        const createProvider = vi.fn(async () => {
            throw new Error('local model could not load');
        });

        await expect(generateTurnEmbeddings(f.db, { ...f, createProvider })).rejects.toThrow('local model could not load');
        expect(createProvider).toHaveBeenCalledOnce();
        expect(f.reader.indexedTurnEvidence).toHaveBeenCalledTimes(1);
        expect(f.rows()).toEqual([]);
        f.db.close();
    });

    it('aborts a vector write failure before attempting another turn', async () => {
        const f = fixture();
        enable(f.configPath);
        f.ingest(f.makeTurn(0));
        f.ingest(f.makeTurn(1));
        const write = vi.spyOn(TurnEmbeddingStore.prototype, 'write').mockImplementation(() => {
            throw new Error('vector storage unavailable');
        });
        try {
            await expect(generateTurnEmbeddings(f.db, f)).rejects.toThrow('vector storage unavailable');
            expect(write).toHaveBeenCalledOnce();
            expect(f.provider.embed).toHaveBeenCalledTimes(1);
            expect(f.rows()).toEqual([]);
        } finally {
            write.mockRestore();
            f.db.close();
        }
    });

    it('never sends turn text to an injected non-local provider', async () => {
        const f = fixture();
        enable(f.configPath);
        f.ingest(f.makeTurn());
        const remote: EmbeddingProvider = {
            configuration: { provider: 'openai', apiKey: 'unused', model: 'remote', revision: 'remote', dimensions: 384 },
            embed: vi.fn(async () => Array(384).fill(0.25)),
            dispose: vi.fn(async () => {}),
        };

        await expect(generateTurnEmbeddings(f.db, { ...f, createProvider: async () => remote })).rejects.toThrow(
            'Turn embeddings require the local Memory-Plus provider.',
        );
        expect(remote.embed).not.toHaveBeenCalled();
        expect(f.rows()).toEqual([]);
        f.db.close();
    });

    it('does not persist a vector when consent is revoked during inference', async () => {
        const f = fixture();
        enable(f.configPath);
        f.ingest(f.makeTurn());
        vi.mocked(f.provider.embed).mockImplementation(async () => {
            f.store.consent.revoke(f.projectPath);
            return Array(f.provider.configuration.dimensions).fill(0.25);
        });

        await expect(generateTurnEmbeddings(f.db, f)).rejects.toThrow(TurnEmbeddingSourceChangedError);
        expect(f.rows()).toEqual([]);
        f.db.close();
    });

    it('does not persist a vector when the source digest changes during inference', async () => {
        const f = fixture();
        enable(f.configPath);
        const original = f.makeTurn();
        f.ingest(original);
        vi.mocked(f.provider.embed).mockImplementation(async () => {
            const session = f.store.findSession(original.tool, original.sessionId);
            expect(
                f.store.reingestTurn(
                    f.makeTurn(0, { userMessage: 'changed while embedding' }),
                    session?.id ?? -1,
                    session?.project_id ?? -1,
                    summary,
                ),
            ).toBe(true);
            return Array(f.provider.configuration.dimensions).fill(0.25);
        });

        await expect(generateTurnEmbeddings(f.db, f)).rejects.toThrow(TurnEmbeddingSourceChangedError);
        expect(f.rows()).toEqual([]);
        f.db.close();
    });

    it('visits only the newest per-pass cap and reports that older rows were deferred', async () => {
        const f = fixture();
        enable(f.configPath);
        for (let index = 0; index < TURN_EMBEDDING_PASS_MAX_ROWS + 1; index++) {
            f.ingest(f.makeTurn(index));
        }

        const result = await generateTurnEmbeddings(f.db, f);

        expect(result).toMatchObject({ generated: TURN_EMBEDDING_PASS_MAX_ROWS, scanned: TURN_EMBEDDING_PASS_MAX_ROWS, truncated: true });
        expect(f.rows()).toHaveLength(TURN_EMBEDDING_PASS_MAX_ROWS);
        expect(f.reader.indexedTurnEvidence).not.toHaveBeenCalledWith(expect.anything(), 0);
        expect(f.createProvider).toHaveBeenCalledTimes(1);
        f.db.close();
    });

    it('resumes below permanently unavailable newest rows instead of starving older turns', async () => {
        const f = fixture();
        enable(f.configPath);
        for (let index = 0; index < TURN_EMBEDDING_PASS_MAX_ROWS + 1; index++) {
            f.ingest(f.makeTurn(index));
        }
        f.reader.indexedTurnEvidence.mockImplementation(async (_session, turnIndex) =>
            turnIndex === 0
                ? { state: 'available', turnIndex, projection: filterTurn(f.makeTurn(turnIndex)), source: 'transcript' }
                : { state: 'unavailable', reason: 'indexed_turn_source_unavailable' },
        );

        const first = await generateTurnEmbeddings(f.db, f);
        expect(first).toMatchObject({ scanned: TURN_EMBEDDING_PASS_MAX_ROWS, unavailable: TURN_EMBEDDING_PASS_MAX_ROWS, truncated: true });
        expect(first.nextCursor).toBeDefined();

        const second = await generateTurnEmbeddings(f.db, { ...f, cursor: first.nextCursor });
        expect(second).toMatchObject({ scanned: 1, generated: 1, truncated: false });
        expect(f.reader.indexedTurnEvidence).toHaveBeenCalledWith(expect.anything(), 0);
        expect(f.rows()).toHaveLength(1);
        f.db.close();
    });

    it('restarts at newest rows when a resume cursor belongs to another model revision', async () => {
        const f = fixture();
        enable(f.configPath);
        for (let index = 0; index < TURN_EMBEDDING_PASS_MAX_ROWS + 1; index++) {
            f.ingest(f.makeTurn(index));
        }
        const first = await generateTurnEmbeddings(f.db, f);
        expect(first.nextCursor).toBeDefined();
        f.reader.indexedTurnEvidence.mockClear();

        const second = await generateTurnEmbeddings(f.db, {
            ...f,
            cursor: { ...first.nextCursor!, revision: 'previous-local-revision' },
        });

        expect(second).toMatchObject({ scanned: TURN_EMBEDDING_PASS_MAX_ROWS, current: TURN_EMBEDDING_PASS_MAX_ROWS, truncated: true });
        expect(f.reader.indexedTurnEvidence).toHaveBeenCalledWith(expect.anything(), TURN_EMBEDDING_PASS_MAX_ROWS);
        expect(f.reader.indexedTurnEvidence).not.toHaveBeenCalledWith(expect.anything(), 0);
        f.db.close();
    });
});
