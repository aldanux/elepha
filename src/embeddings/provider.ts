import {
    EMBEDDING_API_RESPONSE_BYTES,
    EMBEDDING_API_TIMEOUT_MS,
    EMBEDDING_CHUNK_CHARACTERS,
    EMBEDDING_LOCAL_MAX_TOKENS,
} from '../config/constants.js';
import { elephaPaths } from '../config/paths.js';
import { detectShellSyntax } from '../security/sanitize.js';
import { type FeatureExtractionPipeline, loadLocalRuntime } from './local-runtime.js';
import {
    EMBEDDING_API_MODEL,
    EMBEDDING_LOCAL_MODEL,
    EMBEDDING_LOCAL_REVISION,
    type EmbeddingConfiguration,
    type EmbeddingProvider,
} from './provider-config.js';

export function validateEmbedding(vector: unknown, dimensions: number): asserts vector is number[] {
    if (
        !Array.isArray(vector) ||
        vector.length !== dimensions ||
        !vector.every((value) => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
        !vector.some((value) => value !== 0)
    ) {
        throw new Error('Embedding provider returned an invalid vector.');
    }
}

// Split without dropping either end or cutting a Unicode code point. Long
// material is embedded in bounded chunks, then mean-pooled and normalized.
function* textChunks(text: string): Generator<string> {
    let chunk = '';
    let length = 0;
    for (const character of text) {
        chunk += character;
        length++;
        if (length === EMBEDDING_CHUNK_CHARACTERS) {
            yield chunk;
            chunk = '';
            length = 0;
        }
    }
    if (chunk) {
        yield chunk;
    }
}

function* localChunks(text: string, extractor: FeatureExtractionPipeline, purpose: 'passage' | 'query'): Generator<string> {
    if (extractor.tokenizer.encode(`${purpose}: ${text}`).length <= EMBEDDING_LOCAL_MAX_TOKENS) {
        yield text;
        return;
    }
    const characters = Array.from(text);
    const middle = Math.floor(characters.length / 2);
    if (middle === 0) {
        throw new Error('Embedding tokenizer cannot fit a single character.');
    }
    yield* localChunks(characters.slice(0, middle).join(''), extractor, purpose);
    yield* localChunks(characters.slice(middle).join(''), extractor, purpose);
}

async function responseJson(response: Response): Promise<unknown> {
    if (!response.ok) {
        await response.body?.cancel();
        // Never echo a provider body: it can include session input or credentials.
        throw new Error(`OpenAI embeddings request failed (HTTP ${response.status}).`);
    }
    if (response.body === null) {
        throw new Error('OpenAI embeddings response was empty.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            bytes += value.byteLength;
            if (bytes > EMBEDDING_API_RESPONSE_BYTES) {
                throw new Error('OpenAI embeddings response exceeded its byte limit.');
            }
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
}

export function createProvider(configuration: EmbeddingConfiguration): EmbeddingProvider {
    // One reusable loader per manual invocation, with a rejected load evicted so
    // a retry can actually retry. No model is loaded merely by creating a provider.
    let loaded: Promise<FeatureExtractionPipeline> | undefined;
    async function localModel(beforeUse: () => void): Promise<FeatureExtractionPipeline> {
        if (loaded === undefined) {
            loaded = (async () => {
                beforeUse();
                const { pipeline, env } = loadLocalRuntime();
                beforeUse();
                env.allowLocalModels = false;
                return pipeline('feature-extraction', EMBEDDING_LOCAL_MODEL, {
                    revision: EMBEDDING_LOCAL_REVISION,
                    dtype: 'q8',
                    device: 'cpu',
                    cache_dir: elephaPaths().embeddingModels,
                });
            })().catch((error: unknown) => {
                loaded = undefined;
                throw error;
            });
        }
        return loaded;
    }
    return {
        configuration,
        async embed(text, beforeUse, purpose = 'passage') {
            beforeUse();
            if (!text.trim() || detectShellSyntax(text)) {
                throw new Error('Embedding input must be nonempty, sanitized stored text.');
            }
            const extractor = configuration.provider === 'local' ? await localModel(beforeUse) : undefined;
            beforeUse();
            const total = Array<number>(configuration.dimensions).fill(0);
            for (const chunk of textChunks(text)) {
                const pieces = extractor === undefined ? [chunk] : localChunks(chunk, extractor, purpose);
                for (const piece of pieces) {
                    beforeUse();
                    let vector: unknown;
                    if (extractor !== undefined) {
                        vector = Array.from((await extractor(`${purpose}: ${piece}`, { pooling: 'mean', normalize: true })).data);
                    } else if (configuration.provider === 'openai') {
                        const response = await fetch('https://api.openai.com/v1/embeddings', {
                            method: 'POST',
                            redirect: 'error',
                            headers: { Authorization: `Bearer ${configuration.apiKey}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ model: EMBEDDING_API_MODEL, input: piece, encoding_format: 'float' }),
                            signal: AbortSignal.timeout(EMBEDDING_API_TIMEOUT_MS),
                        });
                        const body = (await responseJson(response)) as {
                            model?: unknown;
                            data?: Array<{ embedding?: unknown; index?: unknown }>;
                        };
                        if (body?.model !== EMBEDDING_API_MODEL || body.data?.length !== 1 || body.data[0]?.index !== 0) {
                            throw new Error('OpenAI embeddings response did not match the requested model/input.');
                        }
                        vector = body.data[0].embedding;
                    }
                    beforeUse();
                    validateEmbedding(vector, configuration.dimensions);
                    for (let index = 0; index < total.length; index++) {
                        total[index] += vector[index];
                    }
                }
            }
            const norm = Math.hypot(...total);
            const vector = total.map((value) => value / norm);
            validateEmbedding(vector, configuration.dimensions);
            return vector;
        },
        async dispose() {
            const previous = loaded;
            loaded = undefined;
            if (previous !== undefined) {
                await (await previous).dispose();
            }
        },
    };
}
