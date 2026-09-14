import type { Database } from 'better-sqlite3-multiple-ciphers';
import { EMBEDDING_SESSION_PAGE_SIZE } from '../config/constants.js';
import { getSetting } from '../config/settings.js';
import { EmbeddingStore, lockedEmbedding, MEMORY_PLUS_DISABLED } from '../storage/embedding-store.js';
import { withMemoryReadGeneration } from '../storage/paranoid-gate.js';
import { readEmbeddingSessionIds } from '../storage/session-read-model.js';
import { errorMessage } from '../util/error.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './provider-config.js';

export interface GenerationResult {
    generated: number;
    current: number;
    ineligibleOrEmpty: number;
}

// Explicit batch consumer only. Hooks, MCP and the daemon do not import this module.
export async function generateEmbeddings(
    db: Database,
    options: {
        configPath?: string;
        environment?: NodeJS.ProcessEnv;
        rebuild?: boolean;
        createProvider?: typeof createEmbeddingProvider;
        progress?: (result: GenerationResult) => void;
    } = {},
): Promise<GenerationResult> {
    if (!getSetting('memory-plus', {}, options.configPath).value) {
        throw new Error(MEMORY_PLUS_DISABLED);
    }
    const generation = withMemoryReadGeneration(db, lockedEmbedding, (token) => token);
    const store = new EmbeddingStore(db, options.configPath);
    const result: GenerationResult = { generated: 0, current: 0, ineligibleOrEmpty: 0 };
    let provider: EmbeddingProvider | undefined;
    let before = Number.MAX_SAFE_INTEGER;
    try {
        while (true) {
            store.assertEnabled();
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
                    const source = store.source(id, generation);
                    if (source === undefined) {
                        result.ineligibleOrEmpty++;
                        continue;
                    }
                    provider ??= await (options.createProvider ?? createEmbeddingProvider)(true, options.environment);
                    if (provider === undefined) {
                        throw new Error(MEMORY_PLUS_DISABLED);
                    }
                    const check = () => store.assertCurrent(source, generation);
                    check();
                    if (!options.rebuild && store.current(source, provider.configuration, generation)) {
                        result.current++;
                    } else {
                        const vector = await provider.embed(source.text, check);
                        store.write(source, provider.configuration, vector, generation);
                        result.generated++;
                    }
                    options.progress?.({ ...result });
                } catch (error) {
                    throw new Error(`Session ${id}: ${errorMessage(error)}`, { cause: error });
                }
            }
        }
    } finally {
        await provider?.dispose();
    }
}
