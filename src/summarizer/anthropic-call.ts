import Anthropic from '@anthropic-ai/sdk';
import type { SummarizerStatus } from '../types/index.js';
import { errorMessage } from '../util/error.js';
import { type SummarizerCallLog, type SummarizerCallLogEntry, sanitizeErrorMessage } from './call-log.js';

export const FENCE_RE = /```(?:json)?\s*([\s\S]*?)\s*```/;

export function extractText(message: Anthropic.Message): string {
    return message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
}

// Returns direct, fenced, then outermost-brace candidates in the established fallback order.
export function extractJsonCandidate(raw: string): string[] {
    const candidates = [raw.trim()];
    const fenced = raw.match(FENCE_RE);
    if (fenced) {
        candidates.push(fenced[1].trim());
    }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
        candidates.push(raw.slice(start, end + 1));
    }
    return candidates;
}

export interface AnthropicJsonCall<T> {
    status: SummarizerStatus;
    output?: T;
    rawText?: string;
    truncated: boolean;
}

interface CallAnthropicJsonOptions<T> {
    client: Anthropic;
    model: string;
    callLog: SummarizerCallLog;
    system: Anthropic.MessageCreateParamsNonStreaming['system'];
    user: string;
    maxTokens: number;
    parse: (raw: string) => T | undefined;
    job: SummarizerCallLogEntry['job'];
    attempt: number;
}

export async function callAnthropicJson<T>({
    client,
    model,
    callLog,
    system,
    user,
    maxTokens,
    parse,
    job,
    attempt,
}: CallAnthropicJsonOptions<T>): Promise<AnthropicJsonCall<T>> {
    const startedAt = Date.now();
    try {
        const message = await client.messages.create({
            model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content: user }],
        });
        const rawText = extractText(message);
        const output = parse(rawText);
        const status: SummarizerStatus = output ? 'ok' : 'parse_error';
        const truncated = message.stop_reason === 'max_tokens';
        callLog.append({
            timestamp: new Date().toISOString(),
            job,
            latencyMs: Date.now() - startedAt,
            inputTokens: message.usage.input_tokens,
            cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
            outputTokens: message.usage.output_tokens,
            attempt,
            rateLimited: false,
            // Truncation and malformed output need different fixes (bigger
            // budget vs. better prompt), so they must not log identically.
            // "ran out of output budget" and "emitted something unparseable"
            // need to be told apart: one is fixed by raising max_tokens, the
            // other by changing the prompt.
            error: !output && truncated ? `output truncated at max_tokens (${maxTokens})` : null,
            status,
        });
        return { status, output, rawText, truncated };
    } catch (err) {
        const rateLimited = err instanceof Anthropic.APIError && err.status === 429;
        callLog.append({
            timestamp: new Date().toISOString(),
            job,
            latencyMs: Date.now() - startedAt,
            inputTokens: null,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
            outputTokens: null,
            attempt,
            rateLimited,
            error: sanitizeErrorMessage(errorMessage(err)),
            status: 'api_error',
        });
        return { status: 'api_error', truncated: false };
    }
}
