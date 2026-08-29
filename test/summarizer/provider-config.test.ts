import { describe, expect, it } from 'vitest';
import { createConfiguredSynthesisProviders, synthesisProviderName } from '../../src/summarizer/provider-config.js';

describe('synthesis provider configuration', () => {
    it('is absent without an explicit API key', () => {
        expect(synthesisProviderName({})).toBeUndefined();
        expect(synthesisProviderName({ ANTHROPIC_API_KEY: '   ' })).toBeUndefined();
        expect(createConfiguredSynthesisProviders({})).toBeUndefined();
    });

    it('configures both synthesis jobs when the API key is explicit', () => {
        const providers = createConfiguredSynthesisProviders({ ANTHROPIC_API_KEY: 'test-key' });

        expect(providers?.name).toBe('Anthropic');
        expect(providers?.turnExtraction.summarize).toBeTypeOf('function');
        expect(providers?.rollupMerge.rollup).toBeTypeOf('function');
        expect(providers?.rollupMerge.merge).toBeTypeOf('function');
    });
});
