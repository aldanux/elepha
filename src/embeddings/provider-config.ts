import { EMBEDDING_API_DIMENSIONS, EMBEDDING_LOCAL_DIMENSIONS } from '../config/constants.js';

export const EMBEDDING_LOCAL_MODEL = 'Xenova/multilingual-e5-small';
export const EMBEDDING_LOCAL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const EMBEDDING_API_MODEL = 'text-embedding-3-small';
export const EMBEDDING_API_KEY_ENV = 'OPENAI_API_KEY';

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

// A key selects the external provider only AFTER an explicit "Memory-Plus" opt-in.
// OpenAI receives titles, first-prompt search text, summaries, decisions and pending
// items (and instructions when that field lands). This is a privacy trade-off.
export function embeddingConfiguration(enabled: boolean, env: NodeJS.ProcessEnv = process.env): EmbeddingConfiguration | undefined {
    if (!enabled) {
        return undefined;
    }
    const apiKey = env[EMBEDDING_API_KEY_ENV]?.trim();
    return apiKey
        ? {
              provider: 'openai',
              apiKey,
              model: `openai/${EMBEDDING_API_MODEL}`,
              // OpenAI exposes a model name, not immutable weight revisions.
              revision: `${EMBEDDING_API_MODEL}:codepoint-weighted-chunks-v2`,
              dimensions: EMBEDDING_API_DIMENSIONS,
          }
        : {
              provider: 'local',
              model: EMBEDDING_LOCAL_MODEL,
              revision: `${EMBEDDING_LOCAL_REVISION}:q8:token-weighted-chunks-v2`,
              dimensions: EMBEDDING_LOCAL_DIMENSIONS,
          };
}

// Even importing the native ML runtime is deferred until a confirmed opt-in.
export async function createEmbeddingProvider(
    enabled: boolean,
    env: NodeJS.ProcessEnv = process.env,
): Promise<EmbeddingProvider | undefined> {
    const configuration = embeddingConfiguration(enabled, env);
    if (configuration === undefined) {
        return undefined;
    }
    const { createProvider } = await import('./provider.js');
    return createProvider(configuration);
}
