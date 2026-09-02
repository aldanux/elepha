// Prompts for session-level rollups. Two shapes: a fresh rollup over a whole
// session, and an incremental merge that folds newly-arrived turns into an
// existing rollup without re-reading the turns already accounted for.

import { MAX_ROLLUP_BATCH_CHARS, MAX_ROLLUP_CARRY_CHARS } from '../config/constants.js';

// Per-call budget for the turns half of a rollup or merge prompt. Turns are
// Callers chunk turns to fit this budget; they never truncate the batch.
//
// This file used to end with `truncate(renderTurns(turns), 12000)`, which cut
// from the END: on any large session the newest turns never reached the model
// at all. That was the mechanical half of the merge-loss bug (24 of 29
// merge-capable rollups missing decisions their own turn rows contain), and it
// demonstrates why a bound must drop the oldest and say so: the wrong
// behaviour is what `slice` gives you for free.

// Marker emitted whenever a genuine ceiling binds. Deliberately visible to the
// model and greppable in logs: a silent drop is indistinguishable from a turn
// that had nothing to say.
function omittedMarker(n: number, what: string): string {
    return `[${n} earlier ${what} omitted - batch budget]`;
}

// `why` is the entire point of the decisions array: "decided against animating
// borderRadius" is useless without "because the scroll lock resets
// ScrollTrigger; pause/resume instead". A decision whose reason isn't in the
// transcript must be dropped rather than padded with a restatement of `what` -
// the caller treats a missing `why` as a summarizer failure, not as an empty
// string to be tolerated.
const DECISIONS_CONTRACT = `decisions — array of {"what": string, "why": string}. "what" is the choice made;
"why" is the reason it was made, drawn from the transcript. Never restate "what"
as "why", and never invent a rationale: if the transcript does not give a reason
for a choice, omit that decision entirely rather than emitting a hollow one.`;

export const ROLLUP_SYSTEM_PROMPT = `You summarize one complete session of a coding-AI transcript into a durable
record another AI will later read to regain context. Output strict JSON only:
{"title": string, "summary": string, "decisions": [{"what": string, "why": string}], "pending_items": string[]}

title — one short line, scannable in a list of sessions. Name the actual work,
not the tool ("Fix ScrollTrigger reset on modal open", not "Debugging session").

summary — 2-3 sentences: what was worked on, what state it ended in.

${DECISIONS_CONTRACT}
Include "turn_index" on every decision, copied from the <turn index="…"> it came
from. Omit it only if you genuinely cannot tell.

pending_items — what was still unresolved when the session ended. Empty if
everything was concluded.

Rules: JSON only, no markdown fences, no commentary. Never invent facts absent
from the input.`;

// Ordering contract. Measured cause of the merge-loss bug, in the ~17% of it
// the model was actually responsible for (the other ~83% was end-truncation,
// fixed in code above): asked to "carry forward and add", the model reliably
// re-emitted the previous decisions and stopped, treating the new turns as
// already covered.
//
// This instruction is a HINT, not the mechanism. `attributeDecisions` in
// rollup-provider.ts assigns provenance in code and the store sorts by it, so
// a model that ignores every word below still cannot bury the new decisions -
// which is the point, because it already ignored a politer version.
const ORDERING_CONTRACT = `Ordering: the returned "decisions" array must END with the decisions established
by the NEW turns, in the order they occurred. Never drop a decision from the new
turns to make room for an older one — if something must be dropped, drop the
oldest. Include "turn_index" on every decision, copied from the <turn index="…">
it came from; use the previous rollup's own turn_index for decisions carried
forward, and omit it only if you genuinely cannot tell.`;

export const ROLLUP_MERGE_SYSTEM_PROMPT = `You are updating an existing session summary because the session was reopened
and new turns were appended. You receive the previous rollup and only the NEW
turns. Produce the updated rollup for the session as a whole. Output strict JSON
only:
{"title": string, "summary": string, "decisions": [{"what": string, "why": string, "turn_index": number}], "pending_items": string[]}

Carry forward everything from the previous rollup that is still accurate. Add
what the new turns establish. Crucially: DROP any pending_item the new turns
resolved, and do not duplicate a decision that is already present.

${ORDERING_CONTRACT}

${DECISIONS_CONTRACT}

Rules: JSON only, no markdown fences, no commentary. Never invent facts absent
from the input.`;

export interface RollupTurnInput {
    turnIndex: number;
    startedAt: string;
    decisions: string[];
    pendingItems: string[];
    filesTouched: string[];
}

export function renderTurn(t: RollupTurnInput): string {
    return [
        `<turn index="${t.turnIndex}" at="${t.startedAt}">`,
        t.decisions.length ? `decisions: ${t.decisions.join(' | ')}` : '',
        t.pendingItems.length ? `pending: ${t.pendingItems.join(' | ')}` : '',
        t.filesTouched.length ? `files: ${t.filesTouched.join(', ')}` : '',
        '</turn>',
    ]
        .filter(Boolean)
        .join('\n');
}

function renderTurns(turns: RollupTurnInput[]): string {
    return turns.map(renderTurn).join('\n');
}

// Reduces ONE turn that is on its own too large for a batch. This is the only
// irreducible case - a batch of one cannot be split further - so it is the one
// place a genuine ceiling still binds.
//
// It binds from the OLDEST end (decisions and pending items are dropped from
// the front) and leaves a visible marker. `filesTouched` is dropped wholesale
// first: it is
// the cheapest content per character and is recomputed deterministically from
// the turn rows anyway, so the model losing sight of it costs nothing.
export function shrinkOversizedTurn(turn: RollupTurnInput, maxChars: number): { turn: RollupTurnInput; omitted: number } {
    let candidate: RollupTurnInput = { ...turn, filesTouched: [] };
    if (renderTurn(candidate).length <= maxChars) {
        return { turn: candidate, omitted: 0 };
    }

    let omitted = 0;
    // Drop from the front - oldest first - one item at a time, alternating so a
    // turn heavy on one list does not lose the other entirely.
    while (renderTurn(candidate).length > maxChars && candidate.decisions.length + candidate.pendingItems.length > 1) {
        if (candidate.pendingItems.length >= candidate.decisions.length && candidate.pendingItems.length > 0) {
            candidate = { ...candidate, pendingItems: candidate.pendingItems.slice(1) };
        } else {
            candidate = { ...candidate, decisions: candidate.decisions.slice(1) };
        }
        omitted++;
    }

    if (omitted > 0) {
        candidate = { ...candidate, decisions: [omittedMarker(omitted, 'items in this turn'), ...candidate.decisions] };
    }
    return { turn: candidate, omitted };
}

export interface TurnBatch {
    turns: RollupTurnInput[];
    // Items dropped from oversized single turns in this batch. Zero on the normal path.
    omitted: number;
}

// Splits turns into batches that each render within `maxChars`, IN ORDER, with
// no turn ever discarded. This replaces end-truncation: a 204-turn session
// becomes 20 sequential merge calls instead of one call that saw the first 15
// turns and nothing else.
//
// A session at or below the budget - the overwhelming majority, given Codex
// median 6 turns and Claude Code median 1 - yields exactly one batch and one
// model call, so the normal path is unchanged.
export function chunkTurns(turns: RollupTurnInput[], maxChars: number = MAX_ROLLUP_BATCH_CHARS): TurnBatch[] {
    const batches: TurnBatch[] = [];
    let current: RollupTurnInput[] = [];
    let currentChars = 0;
    let currentOmitted = 0;

    const flush = () => {
        if (current.length > 0) {
            batches.push({ turns: current, omitted: currentOmitted });
            current = [];
            currentChars = 0;
            currentOmitted = 0;
        }
    };

    for (const turn of turns) {
        let entry = turn;
        let omitted = 0;
        let size = renderTurn(entry).length + 1;

        if (size > maxChars) {
            const shrunk = shrinkOversizedTurn(turn, maxChars);
            entry = shrunk.turn;
            omitted = shrunk.omitted;
            size = renderTurn(entry).length + 1;
        }

        if (currentChars + size > maxChars && current.length > 0) {
            flush();
        }
        current.push(entry);
        currentChars += size;
        currentOmitted += omitted;
    }
    flush();

    return batches.length > 0 ? batches : [{ turns: [], omitted: 0 }];
}

export function buildRollupUserContent(turns: RollupTurnInput[]): string {
    // No truncation: callers pass a batch that chunkTurns() already bounded.
    return renderTurns(turns);
}

export interface PreviousRollup {
    title: string;
    summary: string;
    decisions: Array<{ what: string; why: string }>;
    pendingItems: string[];
}

// Renders the carried rollup within MAX_CARRY_CHARS.
//
// This is a genuine ceiling (the carried rollup grows without bound as a
// session runs), so it gets the same treatment as the brief one layer up:
// keep the NEWEST decisions, shorten the summary before dropping any decision,
// and mark what went. The previous version char-truncated the whole block from
// the end, which cut the newest decisions and the pending list off entirely -
// feeding the merge model an input that had already lost the thing the merge
// was supposed to preserve.
export function renderPreviousRollup(previous: PreviousRollup, maxChars: number = MAX_ROLLUP_CARRY_CHARS): string {
    const render = (summary: string, decisions: PreviousRollup['decisions'], dropped: number): string =>
        [
            '<previous_rollup>',
            `title: ${previous.title}`,
            `summary: ${summary}`,
            `decisions: ${
                [
                    ...(dropped > 0 ? [omittedMarker(dropped, 'decisions')] : []),
                    ...decisions.map((d) => `${d.what} (because ${d.why})`),
                ].join(' | ') || '(none)'
            }`,
            `pending_items: ${previous.pendingItems.join(' | ') || '(none)'}`,
            '</previous_rollup>',
        ].join('\n');

    let summary = previous.summary;
    let decisions = previous.decisions;
    let dropped = 0;

    if (render(summary, decisions, dropped).length <= maxChars) {
        return render(summary, decisions, dropped);
    }

    // 1. Shorten the summary first - it is prose, and losing half a sentence
    //   costs less than losing a decision with its rationale.
    if (summary.length > 240) {
        summary = `${summary.slice(0, 240)}…`;
    }

    // 2. Then drop decisions from the OLDEST end, never the newest.
    while (render(summary, decisions, dropped).length > maxChars && decisions.length > 1) {
        decisions = decisions.slice(1);
        dropped++;
    }

    return render(summary, decisions, dropped);
}

export function buildRollupMergeUserContent(previous: PreviousRollup, newTurns: RollupTurnInput[]): string {
    return `${renderPreviousRollup(previous)}\n<new_turns>\n${renderTurns(newTurns)}\n</new_turns>`;
}
