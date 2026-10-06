import type { Database } from 'better-sqlite3-multiple-ciphers';
import { TURN_EMBEDDING_PASS_MAX_ROWS, TURN_EMBEDDING_RECENT_PASS_ROWS } from '../config/constants.js';
import type { SessionReader } from '../serving/session-reader.js';
import {
    type TurnEmbeddingRefreshDiagnostic,
    TurnEmbeddingSourceChangedError,
    TurnEmbeddingStore,
} from '../storage/turn-embedding-store.js';
import { generateTurnEmbeddings, type TurnEmbeddingGenerationResult } from './generate-turns.js';
import { type createEmbeddingProvider, embeddingConfiguration } from './provider-config.js';

// Called only in the isolated refresh worker. A small newest-end pass handles
// active chats while the remaining budget advances the durable backfill cursor.
export async function refreshTurnEmbeddings(
    db: Database,
    options: {
        configPath?: string;
        createProvider?: typeof createEmbeddingProvider;
        reader?: Pick<SessionReader, 'indexedTurnEvidence'>;
        progress?: () => void;
        report?: (message: string) => void;
    } = {},
): Promise<TurnEmbeddingGenerationResult | undefined> {
    const store = new TurnEmbeddingStore(db, options.configPath);
    if (!store.enabled()) {
        return;
    }
    const model = embeddingConfiguration(true);
    if (model?.provider !== 'local') {
        throw new Error('Turn embeddings require the local Memory-Plus provider.');
    }
    options.progress?.();
    const state = store.refreshState(model);
    const shared = {
        configPath: options.configPath,
        createProvider: options.createProvider,
        reader: options.reader,
        progress: options.progress,
    };
    const recent = await generateTurnEmbeddings(db, { ...shared, maxRows: TURN_EMBEDDING_RECENT_PASS_ROWS });
    const historicalCursor = state.beforeMemoryId ?? recent.nextCursor?.beforeMemoryId;
    const historical =
        recent.truncated && historicalCursor !== undefined
            ? await generateTurnEmbeddings(db, {
                  ...shared,
                  maxRows: TURN_EMBEDDING_PASS_MAX_ROWS - TURN_EMBEDDING_RECENT_PASS_ROWS,
                  cursor: {
                      beforeMemoryId: historicalCursor,
                      model: model.model,
                      revision: model.revision,
                      dimensions: model.dimensions,
                  },
              })
            : undefined;
    const result: TurnEmbeddingGenerationResult = {
        disabled: recent.disabled,
        generated: recent.generated + (historical?.generated ?? 0),
        current: recent.current + (historical?.current ?? 0),
        sourceChanged: recent.sourceChanged + (historical?.sourceChanged ?? 0),
        unavailable: recent.unavailable + (historical?.unavailable ?? 0),
        failed: recent.failed + (historical?.failed ?? 0),

        scanned: recent.scanned + (historical?.scanned ?? 0),
        truncated: historical?.truncated ?? false,
        issueKeys: [...recent.issueKeys, ...(historical?.issueKeys ?? [])],
        nextCursor: historical?.nextCursor,
    };
    options.progress?.();
    if (result.disabled) {
        return result;
    }
    let diagnostic: TurnEmbeddingRefreshDiagnostic | undefined;
    try {
        diagnostic = store.saveRefreshState(model, state.authorityHash, state.authorityEpoch, result.nextCursor?.beforeMemoryId, {
            unavailable: result.unavailable,
            sourceChanged: result.sourceChanged,
            failed: result.failed,
            keys: result.issueKeys,
        });
    } catch (error) {
        if (!(error instanceof TurnEmbeddingSourceChangedError)) {
            throw error;
        }
        // A consent or project change invalidates this page's cursor. The
        // next tick restarts at the newest candidate under the new authority.
        return result;
    }

    if (diagnostic !== undefined) {
        const issues = [
            ...(diagnostic.unavailable > 0 ? [`${diagnostic.unavailable} unavailable checks`] : []),
            ...(diagnostic.changed > 0 ? [`${diagnostic.changed} changed checks`] : []),
            ...(diagnostic.failed > 0 ? [`${diagnostic.failed} failed checks`] : []),
        ];
        options.report?.(`Turn indexing sweep: ${issues.join(', ')}; affected candidates retry on a later sweep.`);
    }
    return result;
}
