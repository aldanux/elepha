import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_API_RESPONSE_BYTES, EMBEDDING_LOCAL_MAX_TOKENS } from '../../src/config/constants.js';
import { elephaPaths } from '../../src/config/paths.js';
import {
    createEmbeddingProvider,
    EMBEDDING_API_MODEL,
    EMBEDDING_LOCAL_MODEL,
    EMBEDDING_LOCAL_REVISION,
} from '../../src/embeddings/provider-config.js';

const model = vi.hoisted(() => {
    const extractor = Object.assign(
        vi.fn(async () => ({ data: Float32Array.from({ length: 384 }, () => 0.25) })),
        {
            tokenizer: { encode: (text: string) => Array.from(text) },
            dispose: vi.fn(async () => {}),
        },
    );
    return { extractor, pipeline: vi.fn(async () => extractor), env: { allowLocalModels: true } };
});
vi.mock('../../src/embeddings/local-runtime.js', () => ({ loadLocalRuntime: () => model }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('embedding model runtime', () => {
    it.each([{}, { OPENAI_API_KEY: 'unused' }])('does not load a model or call HTTP while off (%j)', async (environment) => {
        const request = vi.fn();
        vi.stubGlobal('fetch', request);
        expect(await createEmbeddingProvider(false, environment)).toBeUndefined();
        expect(model.pipeline).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    it('lazily reuses the pinned q8 CPU model and chunks without silent token truncation', async () => {
        const provider = (await createEmbeddingProvider(true, {}))!;
        expect(model.pipeline).not.toHaveBeenCalled();
        const check = vi.fn();
        const text = 'Unicode 日本語 مرحبا 😀 '.repeat(120);
        const vector = await provider.embed(text, check);
        expect(model.pipeline).toHaveBeenCalledExactlyOnceWith('feature-extraction', EMBEDDING_LOCAL_MODEL, {
            revision: EMBEDDING_LOCAL_REVISION,
            dtype: 'q8',
            device: 'cpu',
            cache_dir: elephaPaths().embeddingModels,
        });
        const pieces = vi.mocked(model.extractor).mock.calls.map((call) => (call as unknown as [string])[0]);
        expect(pieces.every((piece) => model.extractor.tokenizer.encode(piece).length <= EMBEDDING_LOCAL_MAX_TOKENS)).toBe(true);
        expect(pieces.map((piece) => piece.slice('passage: '.length)).join('')).toBe(text);
        expect(vector.length).toBe(384);
        expect(Math.hypot(...vector)).toBeCloseTo(1);
        await provider.embed('second call', check);
        expect(model.pipeline).toHaveBeenCalledTimes(1);
        await provider.dispose();
        expect(model.extractor.dispose).toHaveBeenCalledOnce();
    });

    it('does not use session input after authorization changes while loading the model', async () => {
        const provider = (await createEmbeddingProvider(true, {}))!;
        let permitted = true;
        model.pipeline.mockImplementationOnce(async () => {
            permitted = false;
            return model.extractor;
        });
        await expect(
            provider.embed('private session', () => {
                if (!permitted) throw new Error('revoked');
            }),
        ).rejects.toThrow('revoked');
        expect(model.extractor).not.toHaveBeenCalled();
        await provider.dispose();
    });

    it('embeds retrieval queries with the E5 query prefix and preserves all chunks', async () => {
        const provider = (await createEmbeddingProvider(true, {}))!;
        const text = 'recover earlier decisions '.repeat(80);
        await provider.embed(text, () => {}, 'query');
        const pieces = model.extractor.mock.calls.map((call) => (call as unknown as [string])[0]);
        expect(pieces.every((piece) => piece.startsWith('query: '))).toBe(true);
        expect(pieces.every((piece) => model.extractor.tokenizer.encode(piece).length <= EMBEDDING_LOCAL_MAX_TOKENS)).toBe(true);
        expect(pieces.map((piece) => piece.slice('query: '.length)).join('')).toBe(text);
        await provider.dispose();
    });

    it('uses the OpenAI HTTP contract without loading local ML', async () => {
        const request = vi.fn(
            async () =>
                new Response(JSON.stringify({ model: EMBEDDING_API_MODEL, data: [{ index: 0, embedding: Array(1536).fill(0.25) }] })),
        );
        vi.stubGlobal('fetch', request);
        const provider = (await createEmbeddingProvider(true, { OPENAI_API_KEY: 'test-key' }))!;
        const vector = await provider.embed('stored text', () => {});
        expect(vector.length).toBe(1536);
        expect(request).toHaveBeenCalledWith(
            'https://api.openai.com/v1/embeddings',
            expect.objectContaining({
                method: 'POST',
                redirect: 'error',
                headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: EMBEDDING_API_MODEL, input: 'stored text', encoding_format: 'float' }),
            }),
        );
        expect(model.pipeline).not.toHaveBeenCalled();
    });

    it.each([
        { model: 'wrong-model', data: [{ index: 0, embedding: Array(1536).fill(1) }] },
        { model: EMBEDDING_API_MODEL, data: [{ index: 0, embedding: [1, 2] }] },
        { model: EMBEDDING_API_MODEL, data: [{ index: 0, embedding: Array(1536).fill(0) }] },
        { model: EMBEDDING_API_MODEL, data: [{ index: 1, embedding: Array(1536).fill(1) }] },
    ])('rejects a malformed provider response', async (body) => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify(body))),
        );
        const provider = (await createEmbeddingProvider(true, { OPENAI_API_KEY: 'key' }))!;
        await expect(provider.embed('text', () => {})).rejects.toThrow();
    });

    it('bounds a streamed response and does not echo error bodies', async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(new Response('private echoed session', { status: 401 }))
            .mockResolvedValueOnce(new Response('x'.repeat(EMBEDDING_API_RESPONSE_BYTES + 1)));
        vi.stubGlobal('fetch', request);
        const provider = (await createEmbeddingProvider(true, { OPENAI_API_KEY: 'key' }))!;
        await expect(provider.embed('text', () => {})).rejects.toThrow('OpenAI embeddings request failed (HTTP 401).');
        await expect(provider.embed('text', () => {})).rejects.toThrow('byte limit');
    });
});
