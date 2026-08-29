// Prompt for the per-turn summarization call. Model only judges decisions and
// pending_items - files_touched is computed deterministically from toolCalls
// upstream (see memory-store.recordTurn) and never asked of the model.

import { MAX_SUMMARIZATION_FIELD_CHARS } from '../config/constants.js';

export const SUMMARIZATION_SYSTEM_PROMPT = `You extract structured memory from one turn of a coding-AI session (a user
request and the assistant's reply). Output strict JSON only, matching:
{"decisions": [{"what": string, "why": string|null}], "pending_items": string[]}

decisions — concrete choices, conclusions, or approvals made in this turn
(e.g. "chose SQLite over Postgres for local storage", "user approved schema
X"). Omit vague or purely exploratory statements. Empty array if none.

"what" is the choice. "why" is the reason it was made, IF the turn actually
gives one — quote the substance of the reason, do not restate "what" in other
words. If the turn states a choice without giving a reason, set "why" to null.
Never invent a rationale: null is a correct and useful answer, and a plausible
guess is worse than nothing because a later reader cannot tell them apart.

pending_items — unresolved questions, explicit TODOs, or next steps stated
or clearly implied by this turn. Empty array if the turn was fully resolved.

Rules: JSON only, no markdown fences, no commentary. Never invent facts not
present in the input. If the turn has no substantive content (slash command,
one-word ack), return {"decisions": [], "pending_items": []}.`;

function truncate(text: string): string {
    if (text.length <= MAX_SUMMARIZATION_FIELD_CHARS) {
        return text;
    }
    const head = Math.floor(MAX_SUMMARIZATION_FIELD_CHARS / 3);
    const tail = MAX_SUMMARIZATION_FIELD_CHARS - head;
    const omitted = text.length - head - tail;
    return `${text.slice(0, head)}\n…[${omitted} chars omitted]…\n${text.slice(-tail)}`;
}

export function buildSummarizationUserContent(userMessage: string, assistantText: string): string {
    return `<user_message>${truncate(userMessage)}</user_message>\n<assistant_reply>${truncate(assistantText)}</assistant_reply>`;
}

/**
 * Repair-pass prompt: sends the model its own malformed output back and asks
 * for a fix. Deliberately NOT a resend of the original request - retrying
 * identical input against a deterministic formatting failure just
 * reproduces the same failure. This is meaningfully different input, so it
 * can actually recover a call the first attempt garbled.
 */
export function buildRepairUserContent(malformedOutput: string): string {
    return `Your previous response did not parse as JSON:\n${truncate(malformedOutput)}\n\nReturn ONLY the corrected JSON matching {"decisions": [{"what": string, "why": string|null}], "pending_items": string[]}. No markdown code fences, no commentary, just the raw JSON object.`;
}
