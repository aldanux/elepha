import type { ParsedTurn } from '../types/index.js';

// Complete textual surface used by both Rule 4 guards.
export function turnText(turn: Pick<ParsedTurn, 'userMessage' | 'assistantText' | 'toolCalls'>): string {
    return [turn.userMessage, turn.assistantText, ...turn.toolCalls.map((call) => JSON.stringify(call))].join('\n');
}

export function normalizeForNearVerbatim(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function shingles(text: string, size = 8): Set<string> {
    if (text.length < size) {
        return new Set();
    }
    const out = new Set<string>();
    for (let index = 0; index <= text.length - size; index++) {
        out.add(text.slice(index, index + size));
    }
    return out;
}

// Rule 4 quote-back threshold: an exact long injected line, or at least 60%
// of the body's distinct normalized 8-grams. Short/empty bodies cannot match
// through shingles because their denominator would not be meaningful.
export function isNearVerbatim(turn: string, injection: string): boolean {
    const normalizedTurn = normalizeForNearVerbatim(turn);
    const normalizedInjection = normalizeForNearVerbatim(injection);
    if (normalizedTurn === '' || normalizedInjection === '') {
        return false;
    }

    for (const line of injection.split(/\r?\n/)) {
        const normalizedLine = normalizeForNearVerbatim(line);
        if (normalizedLine.length >= 40 && normalizedTurn.includes(normalizedLine)) {
            return true;
        }
    }

    const injectionShingles = shingles(normalizedInjection);
    if (injectionShingles.size === 0) {
        return false;
    }
    const turnShingles = shingles(normalizedTurn);
    const present = [...injectionShingles].filter((shingle) => turnShingles.has(shingle)).length;
    return present / injectionShingles.size >= 0.6;
}
