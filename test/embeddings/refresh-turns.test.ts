import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TURN_EMBEDDING_PASS_MAX_ROWS, TURN_EMBEDDING_RECENT_PASS_ROWS } from '../../src/config/constants.js';
import { setSetting } from '../../src/config/settings.js';
import { type EmbeddingProvider, embeddingConfiguration } from '../../src/embeddings/provider-config.js';
import { refreshTurnEmbeddings } from '../../src/embeddings/refresh-turns.js';
import { filterTurn } from '../../src/rendering/filtered-turn.js';
import type { IndexedTurnEvidence } from '../../src/serving/session-reader.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { TURN_EMBEDDING_REFRESH_STATE_TABLE, TURN_EMBEDDINGS_TABLE } from '../../src/storage/turn-embeddings.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const summary = { decisions: [], pending_items: [], status: 'not_configured' as const };

function fixture() {
    const directory = withGrantableTestDir('elepha-turn-refresh-');
    const databasePath = path.join(directory, 'memory.db');
    const db = openUnmanagedDb(databasePath);
    const store = new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null });
    store.consent.grant(directory);
    const configPath = path.join(directory, 'config.json');
    const makeTurn = (turnIndex: number): ParsedTurn => ({
        tool: 'codex',
        sessionId: 'turn-refresh',
        sourcePath: path.join(directory, 'missing.jsonl'),
        projectPath: directory,
        turnIndex,
        startedAt: '2026-09-27T00:00:00.000Z',
        endedAt: '2026-09-27T00:00:01.000Z',
        userMessage: `Question ${turnIndex}`,
        assistantText: `Answer ${turnIndex}`,
        toolCalls: [],
        cursor: `${turnIndex}:1:abc`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    });
    const ingest = (count: number, start = 0) => {
        for (let index = start; index < start + count; index++) {
            expect(store.recordIngestedTurn(makeTurn(index), {}, false, summary, true)?.inserted).toBe(true);
        }
    };
    const reader = {
        indexedTurnEvidence: vi.fn(async (_session: unknown, turnIndex: number): Promise<IndexedTurnEvidence> => {
            if (turnIndex > 0) {
                return { state: 'unavailable', reason: 'indexed_turn_source_unavailable' };
            }
            return { state: 'available', turnIndex, projection: filterTurn(makeTurn(turnIndex)), source: 'transcript' };
        }),
    };
    const model = embeddingConfiguration(true)!;
    const provider: EmbeddingProvider = {
        configuration: model,
        embed: vi.fn(async (_text, beforeUse) => {
            beforeUse();
            return Array(model.dimensions).fill(0.25);
        }),
        dispose: vi.fn(async () => {}),
    };
    const createProvider = vi.fn(async () => provider);
    const report = vi.fn();
    const state = () =>
        db.prepare(`SELECT * FROM ${TURN_EMBEDDING_REFRESH_STATE_TABLE} WHERE id = 1`).get() as
            | { before_memory_id: number | null; authority_epoch: number; model_revision: string }
            | undefined;
    return { directory, databasePath, db, store, configPath, makeTurn, ingest, reader, provider, createProvider, report, state };
}

describe('isolated turn refresh sweep', () => {
    it('does no provider or cursor work while Memory-Plus is off', async () => {
        const f = fixture();
        try {
            f.ingest(1);
            expect(await refreshTurnEmbeddings(f.db, f)).toBeUndefined();
            expect(f.reader.indexedTurnEvidence).not.toHaveBeenCalled();
            expect(f.createProvider).not.toHaveBeenCalled();
            expect(f.state()).toBeUndefined();
        } finally {
            f.db.close();
        }
    });

    it('passes 32 unavailable newest turns, persists progress across reopen, and does not repeat diagnostics', async () => {
        const f = fixture();
        f.ingest(TURN_EMBEDDING_PASS_MAX_ROWS + 1);
        setSetting('memory-plus', 'true', f.configPath);
        try {
            const first = await refreshTurnEmbeddings(f.db, f);
            expect(first).toMatchObject({
                scanned: TURN_EMBEDDING_PASS_MAX_ROWS,
                unavailable: TURN_EMBEDDING_PASS_MAX_ROWS,
                truncated: true,
            });
            expect(f.state()?.before_memory_id).toBe(first?.nextCursor?.beforeMemoryId);
            expect(f.createProvider).not.toHaveBeenCalled();
            expect(f.report).not.toHaveBeenCalled();
            f.db.close();

            const reopened = openUnmanagedDb(f.databasePath);
            try {
                const second = await refreshTurnEmbeddings(reopened, f);
                expect(second).toMatchObject({ scanned: TURN_EMBEDDING_RECENT_PASS_ROWS + 1, generated: 1, truncated: false });
                expect(reopened.prepare(`SELECT memory_id FROM ${TURN_EMBEDDINGS_TABLE}`).all()).toHaveLength(1);
                expect(f.report).toHaveBeenCalledOnce();
                const third = await refreshTurnEmbeddings(reopened, f);
                expect(third).toMatchObject({ scanned: TURN_EMBEDDING_PASS_MAX_ROWS, unavailable: TURN_EMBEDDING_PASS_MAX_ROWS });
                expect(f.report).toHaveBeenCalledOnce();
            } finally {
                reopened.close();
            }
        } finally {
            if (f.db.open) f.db.close();
        }
    });

    it('resets a persisted cursor on consent changes even if the final grant is identical', async () => {
        const f = fixture();
        f.ingest(TURN_EMBEDDING_PASS_MAX_ROWS + 1);
        setSetting('memory-plus', 'true', f.configPath);
        try {
            await refreshTurnEmbeddings(f.db, f);
            const epoch = f.state()?.authority_epoch;
            f.store.consent.revoke(f.directory);
            f.store.consent.grant(f.directory);
            expect(f.state()?.before_memory_id).toBeNull();
            expect(f.state()?.authority_epoch).toBeGreaterThan(epoch ?? 0);
            expect(await refreshTurnEmbeddings(f.db, f)).toMatchObject({ scanned: TURN_EMBEDDING_PASS_MAX_ROWS, generated: 0 });
            expect(f.createProvider).not.toHaveBeenCalled();
        } finally {
            f.db.close();
        }
    });

    it('reports a new unavailable candidate after a prior identical issue without repeating stable sweeps', async () => {
        const f = fixture();
        f.ingest(1, 1);
        setSetting('memory-plus', 'true', f.configPath);
        try {
            expect(await refreshTurnEmbeddings(f.db, f)).toMatchObject({ unavailable: 1, truncated: false });
            expect(f.report).toHaveBeenCalledOnce();
            await refreshTurnEmbeddings(f.db, f);
            expect(f.report).toHaveBeenCalledOnce();
            f.ingest(1, 2);
            expect(await refreshTurnEmbeddings(f.db, f)).toMatchObject({ unavailable: 2, truncated: false });
            expect(f.report).toHaveBeenCalledTimes(2);
        } finally {
            f.db.close();
        }
    });

    it('does not reset the historical cursor for a project last-seen timestamp touch', async () => {
        const f = fixture();
        f.ingest(TURN_EMBEDDING_PASS_MAX_ROWS + 1);
        setSetting('memory-plus', 'true', f.configPath);
        try {
            await refreshTurnEmbeddings(f.db, f);
            const before = f.state();
            f.db.prepare('UPDATE projects SET last_seen_at = ?').run('2026-09-27T12:00:00.000Z');
            expect(f.state()).toMatchObject({ before_memory_id: before?.before_memory_id, authority_epoch: before?.authority_epoch });
            expect(await refreshTurnEmbeddings(f.db, f)).toMatchObject({ generated: 1 });
        } finally {
            f.db.close();
        }
    });

    it('returns to the newest end after a sweep and picks up turns added while the cursor was older', async () => {
        const f = fixture();
        f.ingest(TURN_EMBEDDING_PASS_MAX_ROWS * 2 + 1);
        setSetting('memory-plus', 'true', f.configPath);
        try {
            await refreshTurnEmbeddings(f.db, f);
            const newIndex = TURN_EMBEDDING_PASS_MAX_ROWS * 2 + 1;
            f.ingest(1, newIndex);
            f.reader.indexedTurnEvidence.mockImplementation(async (_session, turnIndex) =>
                turnIndex === newIndex
                    ? { state: 'available', turnIndex, projection: filterTurn(f.makeTurn(turnIndex)), source: 'transcript' }
                    : { state: 'unavailable', reason: 'indexed_turn_source_unavailable' },
            );
            expect(await refreshTurnEmbeddings(f.db, f)).toMatchObject({ generated: 1, truncated: true });
            expect(f.reader.indexedTurnEvidence).toHaveBeenCalledWith(expect.anything(), newIndex);
        } finally {
            f.db.close();
        }
    });

    it('rejects a cursor saved after an awaited consent change', async () => {
        const f = fixture();
        f.ingest(TURN_EMBEDDING_PASS_MAX_ROWS + 1);
        setSetting('memory-plus', 'true', f.configPath);
        f.reader.indexedTurnEvidence.mockImplementationOnce(async () => {
            f.store.consent.revoke(f.directory);
            f.store.consent.grant(f.directory);
            return { state: 'unavailable', reason: 'indexed_turn_source_unavailable' };
        });
        try {
            expect(await refreshTurnEmbeddings(f.db, f)).toMatchObject({ scanned: TURN_EMBEDDING_PASS_MAX_ROWS });
            expect(f.state()?.before_memory_id).toBeNull();
            expect(await refreshTurnEmbeddings(f.db, f)).toMatchObject({ scanned: TURN_EMBEDDING_PASS_MAX_ROWS, generated: 0 });
        } finally {
            f.db.close();
        }
    });

    it('restarts at the newest turn when the stored model revision changes', async () => {
        const f = fixture();
        f.ingest(TURN_EMBEDDING_PASS_MAX_ROWS + 1);
        setSetting('memory-plus', 'true', f.configPath);
        try {
            await refreshTurnEmbeddings(f.db, f);
            f.db.prepare(`UPDATE ${TURN_EMBEDDING_REFRESH_STATE_TABLE} SET model_revision = 'prior-revision' WHERE id = 1`).run();
            expect(await refreshTurnEmbeddings(f.db, f)).toMatchObject({ scanned: TURN_EMBEDDING_PASS_MAX_ROWS, generated: 0 });
            expect(f.state()?.model_revision).toBe(embeddingConfiguration(true)?.revision);
        } finally {
            f.db.close();
        }
    });

    it('does not persist a partial cursor when cancellation arrives during source replay', async () => {
        const f = fixture();
        f.ingest(TURN_EMBEDDING_PASS_MAX_ROWS + 1);
        setSetting('memory-plus', 'true', f.configPath);
        const stopped = new Error('stopped');
        let cancelled = false;
        f.reader.indexedTurnEvidence.mockImplementationOnce(async () => {
            cancelled = true;
            return { state: 'unavailable', reason: 'indexed_turn_source_unavailable' };
        });
        try {
            await expect(
                refreshTurnEmbeddings(f.db, {
                    ...f,
                    progress: () => {
                        if (cancelled) throw stopped;
                    },
                }),
            ).rejects.toBe(stopped);
            expect(f.state()?.before_memory_id).toBeNull();
            expect(f.report).not.toHaveBeenCalled();
        } finally {
            f.db.close();
        }
    });

    it('aborts on the first local inference failure without trying later turns or advancing its cursor', async () => {
        const f = fixture();
        f.ingest(TURN_EMBEDDING_PASS_MAX_ROWS + 1);
        setSetting('memory-plus', 'true', f.configPath);
        f.reader.indexedTurnEvidence.mockImplementation(async (_session, turnIndex) => ({
            state: 'available',
            turnIndex,
            projection: filterTurn(f.makeTurn(turnIndex)),
            source: 'transcript',
        }));
        vi.mocked(f.provider.embed).mockRejectedValueOnce(new Error('local inference failed'));
        try {
            await expect(refreshTurnEmbeddings(f.db, f)).rejects.toThrow('local inference failed');
            expect(f.provider.embed).toHaveBeenCalledTimes(1);
            expect(f.state()?.before_memory_id).toBeNull();
            expect(f.db.prepare(`SELECT memory_id FROM ${TURN_EMBEDDINGS_TABLE}`).all()).toEqual([]);
        } finally {
            f.db.close();
        }
    });
});
