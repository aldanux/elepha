import { randomUUID } from 'node:crypto';
import { SESSION_EVIDENCE_EXCERPT_CHARS, SESSION_EVIDENCE_MAX_CONTEXT_CHARS } from '../config/constants.js';
import type { FilteredTurnProjection } from '../rendering/filtered-turn.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import type { ServedSession } from '../storage/session-read-model.js';
import { dataBlockClose, dataBlockOpen, servedContextInstructions } from './instructions.js';
import type { RecallQuery } from './lexical-recall.js';
import type { EvidenceWindow, SessionReader } from './session-reader.js';

export const SESSION_EVIDENCE_SCOPE =
    'Coverage: selected historical evidence, not a complete episode. Source selection follows stored rollups or the indexed first interaction; other excerpts use lexical matching only, not multilingual matching. A miss is inconclusive.';
export const EVIDENCE_EXCERPT_START_OMITTED = '[Earlier text omitted from this turn.]';
export const EVIDENCE_EXCERPT_END_OMITTED = '[Later text omitted from this turn.]';

export interface SessionEvidence {
    text: string;
    coverage: string;
}

function matches(text: string, query: RecallQuery | undefined): boolean {
    const folded = text.normalize('NFKC').toLowerCase();
    return query?.components.some((component) => folded.includes(component.toLowerCase())) ?? false;
}

// Keep an introductory clause attached to its list even across blank lines.
// A partial sentence or a list without its governing negation is not evidence.
function semanticUnits(text: string): string[] {
    const units: string[] = [];
    for (const part of text.trim().split(/\n\s*\n|(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ])/u)) {
        if (!part.trim()) {
            continue;
        }
        const previous = units.at(-1);
        if (previous?.trimEnd().endsWith(':') || /^\s*(?:[-*]|\d+[.)])\s/.test(part)) {
            if (previous !== undefined) {
                units[units.length - 1] = `${previous}\n\n${part}`;
                continue;
            }
        }
        units.push(part);
    }
    return units;
}

function pack(units: string[], source: string, maxChars: number, omittedBefore = false): SessionEvidence | undefined {
    const selected: string[] = [];
    const render = (): SessionEvidence => ({
        text: [
            ...(omittedBefore ? [EVIDENCE_EXCERPT_START_OMITTED] : []),
            ...selected,
            ...(selected.length < units.length ? [EVIDENCE_EXCERPT_END_OMITTED] : []),
        ].join('\n\n'),
        coverage: `Coverage: ${source}; ${units.length - selected.length} later evidence units omitted; other session material excluded; relevance unverified.`,
    });
    for (const unit of units) {
        selected.push(escapeShellSyntax(unit));
        const value = render();
        if (value.text.length + value.coverage.length + 1 > maxChars) {
            selected.pop();
            break;
        }
    }
    return selected.length === 0 ? undefined : render();
}

function rollupUnits(session: ServedSession): { units: string[]; malformed: number } {
    const units: string[] = [];
    let malformed = 0;
    const array = (value: string | null | undefined): unknown[] => {
        if (value == null) {
            return [];
        }
        try {
            const decoded: unknown = JSON.parse(value);
            if (Array.isArray(decoded)) {
                return decoded;
            }
        } catch {
            // Count the malformed stored field, never echo parser input.
        }
        malformed++;
        return [];
    };
    for (const item of array(session.rollup_decisions)) {
        if (
            item &&
            typeof item === 'object' &&
            'what' in item &&
            'why' in item &&
            typeof item.what === 'string' &&
            typeof item.why === 'string'
        ) {
            units.push(`Decision: ${item.what}\nWhy: ${item.why}`);
        } else {
            malformed++;
        }
    }
    for (const item of array(session.rollup_pending_items)) {
        if (typeof item === 'string') {
            units.push(`Pending: ${item}`);
        } else {
            malformed++;
        }
    }
    return { units, malformed };
}

function responseUnits(projection: FilteredTurnProjection): { units: string[]; source: string; final: boolean; omitted: number } {
    const structure = projection.assistantStructure;
    if (structure !== undefined && (structure.finals.length > 0 || !structure.unclassified || structure.omitted > 0)) {
        return {
            units: structure.finals.map(([start, end]) => projection.assistantResponse.slice(start, end)),
            source: 'provider-declared final answer',
            final: true,
            omitted: structure.omitted,
        };
    }
    return { units: semanticUnits(projection.assistantResponse), source: 'unclassified assistant response', final: false, omitted: 0 };
}

// Several provider finals may answer followups inside one parsed interaction.
// Keep the complete ordered set; choosing its first or last message would
// manufacture a pairing with the indexed prompt.
function finalResponseEvidence(
    projection: FilteredTurnProjection,
    response: ReturnType<typeof responseUnits>,
    source: string,
    maxChars: number,
): SessionEvidence | undefined {
    if (response.units.length === 0 || response.omitted > 0) {
        return undefined;
    }
    const text = escapeShellSyntax(`User prompt:\n${projection.userPrompt}\n\nAssistant response:\n${response.units.join('\n\n')}`);
    const coverage = `Coverage: ${source}, ${response.source}; all ${response.units.length} final messages included; other session material excluded; relevance unverified.`;
    return text.length + coverage.length + 1 <= maxChars ? { text, coverage } : undefined;
}

// Both automatic delivery and query-aware expansion use this source selection.
// First-prompt candidates retain their paired response regardless of query
// language; lexical matching must never move them to a later repeated mention.
export async function selectSessionEvidence(
    reader: SessionReader,
    session: ServedSession,
    query: RecallQuery | undefined,
    maxChars: number,
    signal?: AbortSignal,
    lastN?: number,
): Promise<SessionEvidence> {
    const rollup = rollupUnits(session);
    const ordered = [...rollup.units.filter((unit) => matches(unit, query)), ...rollup.units.filter((unit) => !matches(unit, query))];
    const rollupEvidence = pack(ordered, `stored rollup; ${rollup.malformed} malformed fields/items excluded`, maxChars);
    if (rollupEvidence !== undefined) {
        return rollupEvidence;
    }

    if (session.first_prompt_search !== null) {
        const first = await reader.firstInteraction(session, signal);
        if (first.projection !== undefined) {
            const response = responseUnits(first.projection);
            if (response.final) {
                return (
                    finalResponseEvidence(
                        first.projection,
                        response,
                        `${first.source}, stored turn index ${first.turnIndex}`,
                        maxChars,
                    ) ?? {
                        text: '',
                        coverage: `Evidence unavailable: ${response.omitted > 0 ? 'first_interaction_final_answers_omitted' : response.units.length === 0 ? 'first_interaction_has_no_final_answer' : 'first_interaction_exceeds_evidence_budget'}. ${response.units.length + response.omitted} final messages excluded; no final-answer evidence returned.`,
                    }
                );
            }
            // The prompt supplies antecedents such as option names and scope.
            // Never detach a deictic response from that historical context.
            const pair = `User prompt:\n${first.projection.userPrompt}\n\nAssistant response:\n${response.units[0]}`;
            const evidence = pack(
                [pair, ...response.units.slice(1)],
                `${first.source}, stored turn index ${first.turnIndex}, indexed first prompt and paired ${response.source}`,
                maxChars,
            );
            if (evidence !== undefined) {
                return evidence;
            }
        }
        return {
            text: '',
            coverage: `Evidence unavailable: ${first.reason ?? 'first_interaction_exceeds_evidence_budget'}. No response evidence returned.`,
        };
    }

    const read = await reader.evidenceWindow(session, lastN, signal);
    if (read.projections === undefined) {
        return { text: '', coverage: `Evidence unavailable: ${read.reason ?? 'transcript_missing'}. No transcript evidence returned.` };
    }
    return windowEvidence(read, query, maxChars);
}

function windowEvidence(episode: EvidenceWindow, query: RecallQuery | undefined, maxChars: number): SessionEvidence {
    const projections = episode.projections ?? [];
    for (let index = projections.length - 1; index >= 0; index--) {
        const projection = projections[index];
        const response = responseUnits(projection);
        const units = response.units;
        const match = units.findIndex((unit) => matches(unit, query));
        if (match < 0) {
            continue;
        }
        if (response.final) {
            const evidence = finalResponseEvidence(
                projection,
                response,
                `lexical match, rendered turn ${episode.omitted + index + 1}; Window: ${episode.returned} of ${episode.total} turns; ${episode.omitted} older turns omitted`,
                Math.min(maxChars, SESSION_EVIDENCE_EXCERPT_CHARS),
            );
            if (evidence !== undefined) {
                return evidence;
            }
            continue;
        }
        const start = Math.max(0, match - 1);
        const pair = `User prompt:\n${projection.userPrompt}\n\nAssistant response:\n${units[start]}`;
        const evidence = pack(
            [pair, ...units.slice(start + 1)],
            `lexical ${response.source} excerpt, rendered turn ${episode.omitted + index + 1}; Window: ${episode.returned} of ${episode.total} turns; ${episode.omitted} older turns omitted`,
            Math.min(maxChars, SESSION_EVIDENCE_EXCERPT_CHARS),
            start > 0,
        );
        if (evidence !== undefined) {
            return evidence;
        }
    }
    return {
        text: '',
        coverage: `No matching evidence returned. Window: ${episode.returned} of ${episode.total}; ${episode.omitted} older turns omitted.`,
    };
}

export function sessionEvidence(evidence: SessionEvidence, id: string, nonce: string = randomUUID()): string {
    const rendered = escapeShellSyntax(
        [
            servedContextInstructions(nonce),
            `Session: ${id}`,
            SESSION_EVIDENCE_SCOPE,
            evidence.coverage,
            dataBlockOpen(nonce),
            evidence.text || 'No answer evidence returned.',
            dataBlockClose(nonce),
        ].join('\n'),
    );
    return rendered.length <= SESSION_EVIDENCE_MAX_CONTEXT_CHARS
        ? rendered
        : `${SESSION_EVIDENCE_SCOPE}\nEvidence unavailable: response budget exceeded. No evidence returned.`;
}

export function sessionEvidenceBudget(id: string, nonce: string): number {
    return SESSION_EVIDENCE_MAX_CONTEXT_CHARS - sessionEvidence({ text: '', coverage: '' }, id, nonce).length;
}
