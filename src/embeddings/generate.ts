import type { Database } from 'better-sqlite3-multiple-ciphers';
import { EMBEDDING_SESSION_PAGE_SIZE } from '../config/constants.js';
import { getSetting } from '../config/settings.js';
import {
    EMBEDDING_SOURCE_CHANGED,
    EmbeddingSourceChangedError,
    EmbeddingStore,
    lockedEmbedding,
    MEMORY_PLUS_DISABLED,
} from '../storage/embedding-store.js';
import { withMemoryReadGeneration } from '../storage/paranoid-gate.js';
import { readEmbeddingSessionIds } from '../storage/session-read-model.js';
import { errorMessage } from '../util/error.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './provider-config.js';
import { MalformedEmbeddingSourceError } from './source.js';

export interface GenerationResult {
    generated: number;
    current: number;
    ineligibleOrEmpty: number;
    sourceChanged: number;
    failed: number;
}

// Batch consumers only: foreground CLI commands and the isolated refresh worker.
// Hooks, MCP and the daemon's ingestion event loop do not import this module.
export async function generateEmbeddings(
    db: Database,
    options: {
        configPath?: string;
        rebuild?: boolean;
        createProvider?: typeof createEmbeddingProvider;
        progress?: (result: GenerationResult) => void;
        report?: (message: string) => void;
    } = {},
): Promise<GenerationResult> {
    if (!getSetting('memory-plus', {}, options.configPath).value) {
        throw new Error(MEMORY_PLUS_DISABLED);
    }
    const generation = withMemoryReadGeneration(db, lockedEmbedding, (token) => token);
    const store = new EmbeddingStore(db, options.configPath);
    const result: GenerationResult = { generated: 0, current: 0, ineligibleOrEmpty: 0, sourceChanged: 0, failed: 0 };
    const report = options.report ?? console.warn;
    const consent = store.generationConsent(generation);
    const checkPass = () => {
        if (store.generationConsent(generation) !== consent) {
            throw new Error(EMBEDDING_SOURCE_CHANGED);
        }
    };
    let provider: EmbeddingProvider | undefined;
    let before = Number.MAX_SAFE_INTEGER;
    try {
        while (true) {
            checkPass();
            const ids = withMemoryReadGeneration(
                db,
                lockedEmbedding,
                () => readEmbeddingSessionIds(db, before, EMBEDDING_SESSION_PAGE_SIZE),
                generation,
            );
            if (ids.length === 0) {
                return result;
            }
            for (const id of ids) {
                before = id;
                try {
                    checkPass();
                    const source = store.source(id, generation);
                    if (source === undefined) {
                        result.ineligibleOrEmpty++;
                    } else {
                        provider ??= await (options.createProvider ?? createEmbeddingProvider)(true);
                        if (provider === undefined) {
                            throw new Error(MEMORY_PLUS_DISABLED);
                        }
                        const check = () => {
                            checkPass();
                            store.assertCurrent(source, generation);
                        };
                        check();
                        if (!options.rebuild && store.current(source, provider.configuration, generation)) {
                            result.current++;
                        } else {
                            const vector = await provider.embed(source.text, check);
                            checkPass();
                            store.write(source, provider.configuration, vector, generation);
                            result.generated++;
                        }
                    }
                } catch (caught) {
                    // Authorization loss wins even when source parsing failed.
                    // Only known source errors are local; provider, storage and
                    // cancellation failures abort rather than being hidden.
                    let error = caught;
                    try {
                        checkPass();
                    } catch (authorityError) {
                        error = authorityError;
                    }
                    if (error instanceof EmbeddingSourceChangedError) {
                        result.sourceChanged++;
                        report(`Session ${id}: source changed during generation; skipped, retry next pass.`);
                    } else if (error instanceof MalformedEmbeddingSourceError) {
                        // Parsing precedes provider creation on every pass: an
                        // unchanged malformed source never incurs model cost.
                        result.failed++;
                        report(`Session ${id}: ${error.message} Skipped; source validation will retry without inference.`);
                    } else {
                        throw new Error(
                            `Session ${id}: ${errorMessage(error)} (${result.generated} generated, ${result.sourceChanged} changed, ${result.failed} failed, ${result.ineligibleOrEmpty} ineligible or empty before abort).`,
                            { cause: error },
                        );
                    }
                }
                options.progress?.({ ...result });
            }
        }
    } finally {
        await provider?.dispose();
    }
}
