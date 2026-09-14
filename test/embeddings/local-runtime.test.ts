import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryPlusPackagePath } from '../../src/embeddings/dependency.js';
import { loadLocalRuntime, MEMORY_PLUS_INSTALL_HINT } from '../../src/embeddings/local-runtime.js';
import { createEmbeddingProvider } from '../../src/embeddings/provider-config.js';
import { withTempDir } from '../helpers/tmp.js';

beforeEach(() => vi.stubEnv('ELEPHA_HOME', withTempDir('memory-plus-runtime-')));
afterEach(() => vi.unstubAllEnvs());

function packageFixture(source: string) {
    const root = memoryPlusPackagePath();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: './runtime.cjs' }));
    writeFileSync(path.join(root, 'runtime.cjs'), source);
}

describe('managed local runtime loading', () => {
    it('loads the managed package entry point lazily and executes inference', async () => {
        packageFixture(`module.exports = { env: {}, pipeline: async () => Object.assign(
            async () => ({ data: Array(384).fill(0.25) }),
            { tokenizer: { encode: () => [1] }, dispose: async () => {} }) };`);
        const provider = (await createEmbeddingProvider(true, {}))!;
        expect(await provider.embed('synthetic test', () => {})).toHaveLength(384);
        await provider.dispose();
    });

    it('reports missing managed installation and permits retry after repair', async () => {
        const provider = (await createEmbeddingProvider(true, {}))!;
        await expect(provider.embed('synthetic test', () => {})).rejects.toThrow(MEMORY_PLUS_INSTALL_HINT);
        await provider.dispose();
        packageFixture('module.exports = { env: {}, pipeline: async () => {} };');
        expect(loadLocalRuntime().pipeline).toBeTypeOf('function');
    });

    it('reports a broken installed module with the repair command', () => {
        packageFixture('throw new Error("native binding missing");');
        expect(loadLocalRuntime).toThrow(MEMORY_PLUS_INSTALL_HINT);
    });
});
