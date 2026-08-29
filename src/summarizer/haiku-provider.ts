// Haiku-backed SummarizationProvider. Sole implementation for this phase -
// kept behind the SummarizationProvider interface (see ../types) so a local
// provider (e.g. Ollama) can be added later without touching call sites.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { DEFAULT_ANTHROPIC_MODEL, TURN_SUMMARIZATION_MAX_TOKENS, TURN_SUMMARIZATION_RETRY_MAX_TOKENS } from '../config/constants.js';
import type { SummarizationInput, SummarizationOutput, SummarizationProvider, SummarizerStatus } from '../types/index.js';
import { callAnthropicJson, extractJsonCandidate } from './anthropic-call.js';
import { SummarizerCallLog } from './call-log.js';
import { buildRepairUserContent, buildSummarizationUserContent, SUMMARIZATION_SYSTEM_PROMPT } from './prompt.js';
import { cacheableSystemPrompt } from './prompt-cache.js';

// Decisions are {what, why} now, but the schema also accepts a bare string.
// That is not laxity: format instructions are a suggestion, not a contract.
// This model demonstrably reverts to the older shape,
// and every already-stored row uses it. A bare string means "no reason given",
// which is exactly what `why: null` encodes.
const decisionSchema = z.union([
    z.string().transform((what) => ({ what, why: null as string | null })),
    z.object({
        what: z.string().min(1),
        // An empty or whitespace `why` is the model padding rather than
        // answering; normalize it to null so "no reason recorded" has one
        // representation instead of three.
        why: z
            .string()
            .nullish()
            .transform((w) => (w && w.trim() !== '' ? w : null)),
    }),
]);

const outputSchema = z.object({
    decisions: z.array(decisionSchema),
    pending_items: z.array(z.string()),
});
type RawOutput = z.infer<typeof outputSchema>;

const EMPTY_OUTPUT: SummarizationOutput = { decisions: [], pending_items: [], status: 'empty_turn' };
// Per-turn extraction is small by design, but 512 was tight enough that dense
// turns truncated mid-JSON and lost the extraction entirely - and the retry
// re-requested at the same ceiling, so it truncated again. Both numbers matter:
// the first keeps the common case cheap, the second gives a truncated call room
// to actually finish on the retry.

function tryParse(candidate: string): RawOutput | undefined {
    try {
        const result = outputSchema.safeParse(JSON.parse(candidate));
        return result.success ? result.data : undefined;
    } catch {
        return undefined;
    }
}

/** Tries the raw text as-is, then a fenced block if present, then the outermost {...} span - cheap, local, no API call. Exported for direct unit testing - see test/summarizer/haiku-provider.test.ts. */
// Model output body extraction is deliberately over-tolerant, not because the
// prompt is ambiguous (it explicitly says "no markdown fences, no
// commentary") but because Haiku wraps output in a ```json fence anyway on
// every observed call - confirmed live in fixed-sampling runs, 100% reproduction.
// This is a contract mismatch between what we ask for and what the model
// reliably does, not a stochastic glitch, so a plain identical retry never
// recovers it - see the repair-pass fallback in summarize() below.
export function parseOutput(raw: string): RawOutput | undefined {
    for (const candidate of extractJsonCandidate(raw)) {
        const parsed = tryParse(candidate);
        if (parsed) {
            return parsed;
        }
    }
    return undefined;
}

export interface HaikuSummarizationProviderOptions {
    apiKey?: string;
    model?: string;
    callLog?: SummarizerCallLog;
}

export class HaikuSummarizationProvider implements SummarizationProvider {
    private readonly client: Anthropic;
    private readonly model: string;
    private readonly callLog: SummarizerCallLog;

    constructor(options: HaikuSummarizationProviderOptions = {}) {
        this.client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
        this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
        this.callLog = options.callLog ?? new SummarizerCallLog();
    }

    async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
        if (input.userMessage.trim() === '' && input.assistantText.trim() === '') {
            return EMPTY_OUTPUT;
        }

        const userContent = buildSummarizationUserContent(input.userMessage, input.assistantText);

        // Attempt 1: the real request. Attempt 2 only fires if attempt 1
        // failed, and its shape depends on WHY attempt 1 failed - see below.
        // Resending identical input after a deterministic formatting
        // failure never recovers it, so attempt 2 is never a plain repeat.
        const first = await this.call(1, userContent, TURN_SUMMARIZATION_MAX_TOKENS);
        if (first.status === 'ok') {
            return first.output;
        }

        if (first.status === 'api_error') {
            // Stochastic failure (network blip, 429, transient 5xx) - a plain
            // retry of the same request is the correct response here.
            const retry = await this.call(2, userContent, TURN_SUMMARIZATION_MAX_TOKENS);
            return retry.output;
        }

        if (first.truncated) {
            // The model ran out of output budget mid-JSON. The input was fine
            // and the output was on its way to being valid, so the repair
            // prompt is the wrong tool: re-request the SAME thing with room to
            // finish. Retrying at the same budget just truncates again, which
            // is exactly what was happening - two attempts, both capped, both
            // discarded.
            const bigger = await this.call(2, userContent, TURN_SUMMARIZATION_RETRY_MAX_TOKENS);
            return bigger.output;
        }

        // parse_error with a complete response: the content didn't parse. Don't
        // resend the same prompt - send the model its own broken output and
        // ask it to fix it. Meaningfully different input, so it can actually
        // recover instead of reproducing the same fence-wrapped failure.
        const repair = await this.call(2, buildRepairUserContent(first.rawText ?? ''), TURN_SUMMARIZATION_RETRY_MAX_TOKENS);
        return repair.output;
    }

    private async call(
        attempt: number,
        userContent: string,
        maxTokens: number,
    ): Promise<{ status: SummarizerStatus; output: SummarizationOutput; rawText?: string; truncated?: boolean }> {
        const result = await callAnthropicJson({
            client: this.client,
            model: this.model,
            callLog: this.callLog,
            system: cacheableSystemPrompt(SUMMARIZATION_SYSTEM_PROMPT),
            user: userContent,
            maxTokens,
            parse: parseOutput,
            job: 'turn_extraction',
            attempt,
        });
        if (result.output) {
            return { status: result.status, output: { ...result.output, status: result.status } };
        }
        if (result.status === 'api_error') {
            return { status: result.status, output: { ...EMPTY_OUTPUT, status: result.status } };
        }
        return {
            status: result.status,
            output: { ...EMPTY_OUTPUT, status: result.status },
            rawText: result.rawText,
            truncated: result.truncated,
        };
    }
}
