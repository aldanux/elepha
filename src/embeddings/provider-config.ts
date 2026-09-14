import { EMBEDDING_LOCAL_DIMENSIONS } from '../config/constants.js';

export const EMBEDDING_LOCAL_MODEL = 'Xenova/multilingual-e5-small';
export const EMBEDDING_LOCAL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const EMBEDDING_API_MODEL = 'text-embedding-3-small';

export interface EmbeddingModel {
    model: string;
    revision: string;
    dimensions: number;
}

export type EmbeddingConfiguration = EmbeddingModel & ({ provider: 'local' } | { provider: 'openai'; apiKey: string });

export interface EmbeddingProvider {
    readonly configuration: EmbeddingConfiguration;
    embed(text: string, beforeUse: () => void, purpose?: 'passage' | 'query'): Promise<number[]>;
    dispose(): Promise<void>;
}

// Memory-Plus selects only the bundled local model. External providers require
// an explicit configuration passed to createProvider, never ambient credentials.
export function embeddingConfiguration(enabled: boolean): EmbeddingConfiguration | undefined {
    if (!enabled) {
        return undefined;
    }
    return {
        provider: 'local',
        model: EMBEDDING_LOCAL_MODEL,
        revision: `${EMBEDDING_LOCAL_REVISION}:q8:token-weighted-chunks-v2`,
        dimensions: EMBEDDING_LOCAL_DIMENSIONS,
    };
}

// Even importing the native ML runtime is deferred until a confirmed opt-in.
export async function createEmbeddingProvider(enabled: boolean): Promise<EmbeddingProvider | undefined> {
    const configuration = embeddingConfiguration(enabled);
    if (configuration === undefined) {
        return undefined;
    }
    const { createProvider } = await import('./provider.js');
    return createProvider(configuration);
}
