import { EMBEDDING_API_DIMENSIONS } from '../../src/config/constants.js';
import { EMBEDDING_API_MODEL, type EmbeddingConfiguration } from '../../src/embeddings/provider-config.js';

// Explicit API configuration for provider tests and the persisted pre-local-only format.
// OpenAI exposes a model name, not immutable weight revisions.
export const openaiEmbeddingConfiguration = {
    provider: 'openai',
    apiKey: 'test-key',
    model: `openai/${EMBEDDING_API_MODEL}`,
    revision: `${EMBEDDING_API_MODEL}:codepoint-weighted-chunks-v2`,
    dimensions: EMBEDDING_API_DIMENSIONS,
} satisfies EmbeddingConfiguration;
