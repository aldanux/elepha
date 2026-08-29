// Haiku 4.5 pricing, USD per token. Update if the model/pricing changes -
// used only for dogfooding cost reporting (elepha reingest, elepha status),
// never in the ingestion hot path.
import { ANTHROPIC_INPUT_USD_PER_TOKEN, ANTHROPIC_OUTPUT_USD_PER_TOKEN } from '../config/constants.js';

export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
    return inputTokens * ANTHROPIC_INPUT_USD_PER_TOKEN + outputTokens * ANTHROPIC_OUTPUT_USD_PER_TOKEN;
}
