import type { ParsedTurn } from '../types/index.js';

// Complete textual surface used by both Rule 4 guards. A task-state report
// is included so injected context cannot be laundered through it. Its text
// stays raw, not JSON: escaping would split quoted lines and weaken
// quote-back matching.
export function turnText(turn: Pick<ParsedTurn, 'userMessage' | 'assistantText' | 'toolCalls' | 'taskStateReport'>): string {
    const report = turn.taskStateReport;
    const reportItems = report
        ? [report.objective, ...report.decisions, ...report.constraints, ...report.pending_items].filter(
              (item): item is NonNullable<typeof item> => item !== null,
          )
        : [];
    return [
        turn.userMessage,
        turn.assistantText,
        ...turn.toolCalls.map((call) => JSON.stringify(call)),
        ...reportItems.flatMap((item) => [item.text, ...(item.sources?.map((source) => source.quote) ?? [])]),
    ].join('\n');
}

export function normalizeForNearVerbatim(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

const SHINGLE_SIZE = 8;
const DEADLINE_CHECK_INTERVAL = 1024;

export type NearVerbatimStatus = 'match' | 'no-match' | 'incomplete';

export interface NearVerbatimOptions {
    deadline?: number;
    now?: () => number;
}

// Rule 4 quote-back threshold: an exact long injected line, or at least
// 60% of the body's distinct normalized 8-grams. Short or empty bodies
// cannot match through shingles because their denominator is not useful.
export function isNearVerbatim(turn: string, injection: string): boolean {
    return isNearVerbatimNormalized(normalizeForNearVerbatim(turn), injection);
}

export function isNearVerbatimNormalized(normalizedTurn: string, injection: string): boolean {
    return nearVerbatimStatusNormalized(normalizedTurn, injection) === 'match';
}

export function nearVerbatimStatusNormalized(
    normalizedTurn: string,
    injection: string,
    options: NearVerbatimOptions = {},
): NearVerbatimStatus {
    const now = options.now ?? Date.now;
    const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
    const expired = (): boolean => now() >= deadline;

    if (expired()) {
        return 'incomplete';
    }
    const normalizedInjection = normalizeForNearVerbatim(injection);
    if (expired()) {
        return 'incomplete';
    }
    if (normalizedTurn === '' || normalizedInjection === '') {
        return 'no-match';
    }
    for (const line of injection.split(/\r?\n/)) {
        if (expired()) {
            return 'incomplete';
        }
        const normalizedLine = normalizeForNearVerbatim(line);
        if (normalizedLine.length >= 40) {
            const includes = normalizedTurn.includes(normalizedLine);
            if (expired()) {
                return 'incomplete';
            }
            if (includes) {
                return 'match';
            }
        }
    }
    if (normalizedInjection.length < SHINGLE_SIZE) {
        return 'no-match';
    }
    const injectionShingles = new Set<string>();
    for (let index = 0; index <= normalizedInjection.length - SHINGLE_SIZE; index++) {
        if (index % DEADLINE_CHECK_INTERVAL === 0) {
            if (expired()) {
                return 'incomplete';
            }
        }
        injectionShingles.add(normalizedInjection.slice(index, index + SHINGLE_SIZE));
    }
    if (injectionShingles.size === 0) {
        return 'no-match';
    }
    const required = Math.ceil(injectionShingles.size * 0.6);
    let present = 0;
    for (let index = 0; index <= normalizedTurn.length - SHINGLE_SIZE; index++) {
        if (index % DEADLINE_CHECK_INTERVAL === 0) {
            if (expired()) {
                return 'incomplete';
            }
        }
        if (injectionShingles.delete(normalizedTurn.slice(index, index + SHINGLE_SIZE))) {
            present++;
            if (present >= required) {
                return 'match';
            }
        }
    }
    return 'no-match';
}
