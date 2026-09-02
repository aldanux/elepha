// Haiku-backed session rollup generation. The model wraps JSON in Markdown
// fences regardless of instructions, so output is extracted defensively.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
    DECISION_PROVENANCE_OVERLAP_THRESHOLD,
    DEFAULT_ANTHROPIC_MODEL,
    ROLLUP_MAX_TOKENS,
    ROLLUP_RETRY_MAX_TOKENS,
} from '../config/constants.js';
import type { SummarizerStatus } from '../types/index.js';
import { callAnthropicJson, extractJsonCandidate } from './anthropic-call.js';
import { SummarizerCallLog } from './call-log.js';
import { cacheableSystemPrompt } from './prompt-cache.js';
import {
    buildRollupMergeUserContent,
    buildRollupUserContent,
    type PreviousRollup,
    ROLLUP_MERGE_SYSTEM_PROMPT,
    ROLLUP_SYSTEM_PROMPT,
    type RollupTurnInput,
} from './rollup-prompt.js';

// A decision with an empty/whitespace `why` is a contract violation, not a
// tolerable value - the reason IS the reusable part. It is dropped rather than
// stored as an empty string, and COUNTED so the loss is visible
// (RollupOutput.droppedDecisions). It is deliberately no longer a hard schema
// failure: making one bad decision fail the whole rollup traded a small,
// reportable loss for a total one.
export interface ParsedDecision {
    what: string;
    why: string;
    turn_index?: number;
}

// `turn_index` arrives as a STRING from this model - `"turn_index": "0"` -
// despite the prompt asking for a number, in fixed-sampling runs, reproducibly.
//
// The first version of this field was `z.number().int().optional()`, whose
// comment claimed optionality meant "a model that ignores the instruction
// still parses". It does not: `optional()` tolerates an ABSENT key, not a
// wrong-typed one, so every rollup failed to parse and a rebuild died on
// its first three sessions. Textbook instance of this codebase's own
// "format instructions in a prompt are a suggestion, not a contract" - added
// while fixing a different instance of the same rule.
function coerceTurnIndex(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
        return Number(value.trim());
    }
    return undefined;
}

// One decision, or undefined if it is unusable.
//
// Nothing here can fail the enclosing rollup. A malformed or hollow decision
// costs that decision; it must never cost the title, the summary, the pending
// items and every other decision in the session, which is what a strict
// element schema inside `z.array()` does.
function coerceDecision(raw: unknown): ParsedDecision | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const rec = raw as Record<string, unknown>;
    const what = typeof rec.what === 'string' ? rec.what.trim() : '';
    // A decision with no reason is dropped, per the prompt contract ("omit
    // that decision entirely rather than emitting a hollow one"). Counted and
    // reported by the caller rather than dropped silently - see
    // RollupResult.droppedDecisions.
    const why = typeof rec.why === 'string' ? rec.why.trim() : '';
    if (what === '' || why === '') {
        return undefined;
    }
    return { what, why, turn_index: coerceTurnIndex(rec.turn_index) };
}

const rollupSchema = z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    decisions: z.array(z.unknown()),
    pending_items: z.array(z.unknown()),
});

export interface RollupOutput {
    title: string;
    summary: string;
    decisions: ParsedDecision[];
    pending_items: string[];
    // Decisions the model emitted that were unusable (no `what`, or no `why`).
    // Reported rather than dropped silently: a rollup that quietly loses half
    // its decisions to a prompt regression must be distinguishable from a
    // session that genuinely made few.
    droppedDecisions: number;
}

const EMPTY_ROLLUP: RollupOutput = { title: '', summary: '', decisions: [], pending_items: [], droppedDecisions: 0 };

function tryParse(candidate: string): RollupOutput | undefined {
    try {
        const result = rollupSchema.safeParse(JSON.parse(candidate));
        if (!result.success) {
            return undefined;
        }
        const decisions: ParsedDecision[] = [];
        let droppedDecisions = 0;
        for (const raw of result.data.decisions) {
            const decision = coerceDecision(raw);
            if (decision) {
                decisions.push(decision);
            } else {
                droppedDecisions++;
            }
        }
        return {
            title: result.data.title,
            summary: result.data.summary,
            decisions,
            pending_items: result.data.pending_items.filter((p): p is string => typeof p === 'string' && p.trim() !== ''),
            droppedDecisions,
        };
    } catch {
        return undefined;
    }
}

export function parseRollup(raw: string): RollupOutput | undefined {
    for (const candidate of extractJsonCandidate(raw)) {
        const parsed = tryParse(candidate);
        if (parsed) {
            return parsed;
        }
    }

    return undefined;
}

export interface RollupResult {
    output: RollupOutput;
    status: SummarizerStatus;
}

const STOPWORDS = new Set(
    'the a an to for and or with by as at is are was were be been it its this that from into use used using in on of'.split(' '),
);

function tokens(s: string): Set<string> {
    return new Set(
        s
            .toLowerCase()
            .replace(/[^a-z0-9_./-]+/g, ' ')
            .split(/\s+/)
            .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    );
}

function overlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) {
        return 0;
    }
    let shared = 0;
    for (const t of a) {
        if (b.has(t)) {
            shared++;
        }
    }
    return shared / Math.min(a.size, b.size);
}

// Assigns each returned decision a turn of origin, IN CODE.
//
// The prompt asks for `turn_index`, but the whole reason this exists is that
// the merge model does not reliably follow ordering instructions - trusting it
// to self-report provenance would rebuild the bug one level up. So:
//
// 1. Accept the model's `turn_index` only when it names a turn that was
//    actually in this batch. Anything else is discarded silently-as-data, not
//    silently-as-failure: the next steps still produce a value.
// 2. Otherwise, match the decision text against the batch's own per-turn
//    decision strings and take the best-overlapping turn.
// 3. Otherwise, fall back to the batch's LAST turn index. The decision came
//    out of this batch, so its true origin is somewhere in it; biasing the
//    fallback newest keeps an unplaceable decision visible in the brief
//    instead of sinking it to the bottom, which is the failure mode being
//    fixed. Over-attributing recency is recoverable; under-attributing it is
//    the bug.
export function attributeDecisions(
    decisions: RollupOutput['decisions'],
    batch: RollupTurnInput[],
): Array<{ what: string; why: string; turnIndex?: number; at?: string }> {
    if (batch.length === 0) {
        return decisions.map((d) => ({ what: d.what, why: d.why }));
    }

    const byIndex = new Map(batch.map((t) => [t.turnIndex, t]));
    const lastTurn = batch[batch.length - 1];
    const turnTokens = batch.map((t) => ({ turn: t, toks: tokens(t.decisions.join(' ')) }));

    return decisions.map((d) => {
        const claimed = d.turn_index !== undefined ? byIndex.get(d.turn_index) : undefined;
        if (claimed) {
            return { what: d.what, why: d.why, turnIndex: claimed.turnIndex, at: claimed.startedAt };
        }

        const dt = tokens(d.what);
        let best: { turn: RollupTurnInput; score: number } | undefined;
        for (const candidate of turnTokens) {
            const score = overlap(dt, candidate.toks);
            if (score >= DECISION_PROVENANCE_OVERLAP_THRESHOLD && (best === undefined || score > best.score)) {
                best = { turn: candidate.turn, score };
            }
        }
        const resolved = best?.turn ?? lastTurn;
        return { what: d.what, why: d.why, turnIndex: resolved.turnIndex, at: resolved.startedAt };
    });
}

export interface RollupProvider {
    rollup(turns: RollupTurnInput[]): Promise<RollupResult>;
    merge(previous: PreviousRollup, newTurns: RollupTurnInput[]): Promise<RollupResult>;
}

export class HaikuRollupProvider implements RollupProvider {
    private readonly client: Anthropic;
    private readonly model: string;
    private readonly callLog: SummarizerCallLog;

    constructor(options: { apiKey?: string; model?: string; callLog?: SummarizerCallLog } = {}) {
        this.client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
        this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
        this.callLog = options.callLog ?? new SummarizerCallLog();
    }

    rollup(turns: RollupTurnInput[]): Promise<RollupResult> {
        if (turns.length === 0) {
            return Promise.resolve({ output: EMPTY_ROLLUP, status: 'empty_turn' });
        }
        return this.call(ROLLUP_SYSTEM_PROMPT, buildRollupUserContent(turns));
    }

    merge(previous: PreviousRollup, newTurns: RollupTurnInput[]): Promise<RollupResult> {
        if (newTurns.length === 0) {
            return Promise.resolve({ output: EMPTY_ROLLUP, status: 'empty_turn' });
        }
        return this.call(ROLLUP_MERGE_SYSTEM_PROMPT, buildRollupMergeUserContent(previous, newTurns));
    }

    // One rollup request, retried ONCE at a larger output budget if the first
    // attempt ran out of room mid-JSON.
    //
    // A same-budget retry risks the same truncation, so it is pure waste.
    // The only thing worth changing is the budget - the input was never the
    // problem. (A malformed-but-complete response is a different failure and
    // is not retried here: rollups are recomputed from turn rows on the next
    // pass, and the watermark deliberately does not advance on failure.)
    private async call(system: string, userContent: string): Promise<RollupResult> {
        const first = await this.callOnce(system, userContent, ROLLUP_MAX_TOKENS, 1);
        if (first.status === 'ok' || !first.truncated) {
            return { output: first.output, status: first.status };
        }
        const retried = await this.callOnce(system, userContent, ROLLUP_RETRY_MAX_TOKENS, 2);
        return { output: retried.output, status: retried.status };
    }

    private async callOnce(
        system: string,
        userContent: string,
        maxTokens: number,
        attempt: number,
    ): Promise<RollupResult & { truncated: boolean }> {
        // A session rollup is far larger than a per-turn summary: a 17-turn session
        // produced enough decisions to blow straight through 1024 tokens and truncate
        // mid-JSON, which surfaced only as an unexplained parse_error. Sized with
        // headroom, and truncation is now reported distinctly rather than looking like
        // a malformed response.
        const result = await callAnthropicJson({
            client: this.client,
            model: this.model,
            callLog: this.callLog,
            system: cacheableSystemPrompt(system),
            user: userContent,
            maxTokens,
            parse: parseRollup,
            job: 'rollup_merge',
            attempt,
        });
        return { output: result.output ?? EMPTY_ROLLUP, status: result.status, truncated: result.truncated };
    }
}
