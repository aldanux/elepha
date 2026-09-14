import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_API_RESPONSE_BYTES, EMBEDDING_CHUNK_CHARACTERS, EMBEDDING_LOCAL_MAX_TOKENS } from '../../src/config/constants.js';
import { elephaPaths } from '../../src/config/paths.js';
import {
    createEmbeddingProvider,
    EMBEDDING_API_MODEL,
    EMBEDDING_LOCAL_MODEL,
    EMBEDDING_LOCAL_REVISION,
} from '../../src/embeddings/provider-config.js';

const model = vi.hoisted(() => {
    const extractor = Object.assign(
        vi.fn(async (_text: string) => ({ data: Float32Array.from({ length: 384 }, () => 0.25) })),
        {
            tokenizer: { encode: (text: string, _options?: { add_special_tokens?: boolean }) => Array.from(text, (_, index) => index) },
            dispose: vi.fn(async () => {}),
        },
    );
    return { extractor, pipeline: vi.fn(async () => extractor), env: { allowLocalModels: true } };
});
vi.mock('../../src/embeddings/local-runtime.js', () => ({ loadLocalRuntime: () => model }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function axis(dimensions: number, index: number): number[] {
    return Array.from({ length: dimensions }, (_, position) => Number(position === index));
}

function contentTokenizer(large: string) {
    vi.spyOn(model.extractor.tokenizer, 'encode').mockImplementation((text, options) => {
        const content = text.replace(/^(passage|query): /, '');
        const count = content === large ? 100 : content.trim() ? 1 : 0;
        const prefixTokens = content === text ? 0 : 2;
        return Array(count + prefixTokens + (options?.add_special_tokens === false ? 0 : 2)).fill(1);
    });
}

describe('embedding model runtime', () => {
    it.each(['passage', 'query'] as const)('weights %s chunks by content tokens, excluding prefix and special tokens', async (purpose) => {
        const large = 'a'.repeat(EMBEDDING_CHUNK_CHARACTERS);
        contentTokenizer(large);
        model.extractor
            .mockResolvedValueOnce({ data: Float32Array.from(axis(384, 0)) })
            .mockResolvedValueOnce({ data: Float32Array.from(axis(384, 1)) });
        const provider = (await createEmbeddingProvider(true, {}))!;
        const vector = await provider.embed(`${large} SQL`, () => {}, purpose);
        expect(model.extractor.mock.calls.map(([text]) => text)).toEqual([`${purpose}: ${large}`, `${purpose}:  SQL`]);
        expect(vector[0]).toBeCloseTo(100 / Math.hypot(100, 1), 10);
        expect(vector[1]).toBeCloseTo(1 / Math.hypot(100, 1), 10);
        expect(vector.slice(2)).toEqual(Array(382).fill(0));
        await provider.dispose();
    });

    it.each(['\n', ' \t\n\u00a0\u2003', ' '.repeat(EMBEDDING_CHUNK_CHARACTERS)])(
        'does not embed whitespace-only remainder %j',
        async (remainder) => {
            const large = 'a'.repeat(EMBEDDING_CHUNK_CHARACTERS);
            contentTokenizer(large);
            const provider = (await createEmbeddingProvider(true, {}))!;
            const original = await provider.embed(large, () => {});
            model.extractor.mockClear();
            expect(await provider.embed(large + remainder, () => {})).toEqual(original);
            expect(model.extractor).toHaveBeenCalledExactlyOnceWith(`passage: ${large}`, { pooling: 'mean', normalize: true });
            await provider.dispose();
        },
    );

    it('weights pieces after recursive token-limit splitting', async () => {
        const large = 'a'.repeat(EMBEDDING_CHUNK_CHARACTERS);
        model.extractor
            .mockResolvedValueOnce({ data: Float32Array.from(axis(384, 0)) })
            .mockResolvedValueOnce({ data: Float32Array.from(axis(384, 0)) })
            .mockResolvedValueOnce({ data: Float32Array.from(axis(384, 1)) });
        const provider = (await createEmbeddingProvider(true, {}))!;
        const vector = await provider.embed(`${large}z`, () => {});
        expect(model.extractor).toHaveBeenCalledTimes(3);
        expect(vector[0]).toBeCloseTo(large.length / Math.hypot(large.length, 1), 10);
        expect(vector[1]).toBeCloseTo(1 / Math.hypot(large.length, 1), 10);
        await provider.dispose();
    });

    it('does not embed whitespace-only pieces produced by token-limit splitting', async () => {
        const content = 'a'.repeat(EMBEDDING_CHUNK_CHARACTERS / 2);
        const provider = (await createEmbeddingProvider(true, {}))!;
        await provider.embed(content + ' '.repeat(EMBEDDING_CHUNK_CHARACTERS / 2), () => {});
        expect(model.extractor).toHaveBeenCalledExactlyOnceWith(`passage: ${content}`, { pooling: 'mean', normalize: true });
        await provider.dispose();
    });

    it('does not embed a non-whitespace remainder with zero content tokens', async () => {
        const large = 'a'.repeat(EMBEDDING_CHUNK_CHARACTERS);
        contentTokenizer(large);
        vi.mocked(model.extractor.tokenizer.encode).mockImplementation((text, options) => {
            const content = text.replace(/^passage: /, '');
            return Array((content === large ? 100 : 0) + (options?.add_special_tokens === false ? 0 : 4)).fill(1);
        });
        const provider = (await createEmbeddingProvider(true, {}))!;
        await provider.embed(`${large}\u200b`, () => {});
        expect(model.extractor).toHaveBeenCalledExactlyOnceWith(`passage: ${large}`, { pooling: 'mean', normalize: true });
        await provider.dispose();
    });

    it('weights API chunks by Unicode code points without loading local ML', async () => {
        const large = '😀'.repeat(EMBEDDING_CHUNK_CHARACTERS);
        const request = vi.fn(async (_url: string, options: RequestInit) => {
            const { input } = JSON.parse(options.body as string) as { input: string };
            return new Response(
                JSON.stringify({ model: EMBEDDING_API_MODEL, data: [{ index: 0, embedding: axis(1536, input === large ? 0 : 1) }] }),
            );
        });
        vi.stubGlobal('fetch', request);
        const provider = (await createEmbeddingProvider(true, { OPENAI_API_KEY: 'test-key' }))!;
        const vector = await provider.embed(`${large}z`, () => {});
        expect(request).toHaveBeenCalledTimes(2);
        expect(vector[0]).toBeCloseTo(EMBEDDING_CHUNK_CHARACTERS / Math.hypot(EMBEDDING_CHUNK_CHARACTERS, 1), 10);
        expect(vector[1]).toBeCloseTo(1 / Math.hypot(EMBEDDING_CHUNK_CHARACTERS, 1), 10);
        expect(model.pipeline).not.toHaveBeenCalled();
    });

    it('does not send whitespace-only remainders to the API', async () => {
        const request = vi.fn(
            async () => new Response(JSON.stringify({ model: EMBEDDING_API_MODEL, data: [{ index: 0, embedding: axis(1536, 0) }] })),
        );
        vi.stubGlobal('fetch', request);
        const provider = (await createEmbeddingProvider(true, { OPENAI_API_KEY: 'test-key' }))!;
        await provider.embed(`${'a'.repeat(EMBEDDING_CHUNK_CHARACTERS)} \n\t`, () => {});
        expect(request).toHaveBeenCalledOnce();
    });

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
