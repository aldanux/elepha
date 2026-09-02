import type { SummarizationProvider } from '../types/index.js';
import { HaikuSummarizationProvider } from './haiku-provider.js';
import { HaikuRollupProvider, type RollupProvider } from './rollup-provider.js';

export const ANTHROPIC_PROVIDER_NAME = 'Anthropic';

export interface ConfiguredSynthesisProviders {
    name: string;
    turnExtraction: SummarizationProvider;
    rollupMerge: RollupProvider;
}

// An API key is the current explicit provider configuration boundary.
// Merely constructing an SDK client is not configuration: without a key the
// daemon must stay capture-only and make no attempted provider calls.
export function synthesisProviderName(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return env.ANTHROPIC_API_KEY?.trim() ? ANTHROPIC_PROVIDER_NAME : undefined;
}

// Creates both provider jobs together; provider selection can split per job when another implementation lands.
export function createConfiguredSynthesisProviders(env: NodeJS.ProcessEnv = process.env): ConfiguredSynthesisProviders | undefined {
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
        return undefined;
    }

    const model = env.ANTHROPIC_MODEL?.trim() || undefined;
    return {
        name: ANTHROPIC_PROVIDER_NAME,
        turnExtraction: new HaikuSummarizationProvider({ apiKey, model }),
        rollupMerge: new HaikuRollupProvider({ apiKey, model }),
    };
}
