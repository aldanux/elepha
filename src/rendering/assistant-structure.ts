import { ASSISTANT_STRUCTURE_MAX_FINALS } from '../config/constants.js';

// Offsets identify complete provider-declared final messages in the existing
// assistant text. Missing metadata never proves that the text is a conclusion.
export interface AssistantStructure {
    unclassified: boolean;
    finals: Array<[number, number]>;
    omitted: number;
}

export interface AssistantMessageBoundary {
    firstPart: number;
    partCount: number;
    phase: 'commentary' | 'final_answer' | 'unclassified';
}

export function joinedAssistantStructure(parts: string[], messages: AssistantMessageBoundary[]): AssistantStructure | undefined {
    if (messages.length === 0) {
        return undefined;
    }
    const offsets = [0];
    for (const part of parts) {
        offsets.push((offsets.at(-1) ?? 0) + part.length + 1);
    }
    const joined = parts.join('\n');
    const trimStart = joined.length - joined.trimStart().length;
    const trimEnd = joined.trimEnd().length;
    const finals: Array<[number, number]> = [];
    for (const message of messages) {
        if (message.phase !== 'final_answer' || message.partCount === 0) {
            continue;
        }
        const start = Math.max(trimStart, offsets[message.firstPart] ?? 0);
        const end = Math.min(trimEnd, (offsets[message.firstPart + message.partCount] ?? 1) - 1);
        if (end > start) {
            finals.push([start - trimStart, end - trimStart]);
        }
    }
    return { unclassified: messages.some((message) => message.phase === 'unclassified'), finals, omitted: 0 };
}

// Map boundaries by transforming disjoint structural pieces, never by finding
// repeated text. The whole transform remains authoritative: syntax spanning
// a message boundary may prevent mapping, in which case metadata is unknown.
export function transformAssistantStructure(
    original: string,
    structure: AssistantStructure | undefined,
    transform: (text: string) => string,
    trim = false,
): AssistantStructure | undefined {
    if (structure === undefined) {
        return undefined;
    }
    const transformed = transform(original);
    const parts: string[] = [];
    const finals: Array<[number, number]> = [];
    let cursor = 0;
    let offset = 0;
    for (const [start, end] of structure.finals) {
        const before = transform(original.slice(cursor, start));
        const final = transform(original.slice(start, end));
        parts.push(before, final);
        offset += before.length;
        finals.push([offset, offset + final.length]);
        offset += final.length;
        cursor = end;
    }
    parts.push(transform(original.slice(cursor)));
    if (parts.join('') !== transformed) {
        return undefined;
    }
    const trimStart = trim ? transformed.length - transformed.trimStart().length : 0;
    const trimEnd = trim ? transformed.trimEnd().length : transformed.length;
    return {
        ...structure,
        finals: finals.flatMap(([start, end]) => {
            const boundedStart = Math.max(start, trimStart);
            const boundedEnd = Math.min(end, trimEnd);
            return boundedEnd > boundedStart ? [[boundedStart - trimStart, boundedEnd - trimStart] as [number, number]] : [];
        }),
    };
}

export function decodeAssistantStructure(value: string | null, textLength: number): AssistantStructure | undefined {
    if (value === null) {
        return undefined;
    }
    const parsed: unknown = JSON.parse(value);
    if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('unclassified' in parsed) ||
        typeof parsed.unclassified !== 'boolean' ||
        !('omitted' in parsed) ||
        !Number.isSafeInteger(parsed.omitted) ||
        (parsed.omitted as number) < 0 ||
        !('finals' in parsed) ||
        !Array.isArray(parsed.finals) ||
        parsed.finals.length > ASSISTANT_STRUCTURE_MAX_FINALS
    ) {
        throw new Error('Invalid assistant phase metadata');
    }
    let previousEnd = 0;
    for (const span of parsed.finals) {
        if (
            !Array.isArray(span) ||
            span.length !== 2 ||
            !Number.isSafeInteger(span[0]) ||
            !Number.isSafeInteger(span[1]) ||
            span[0] < previousEnd ||
            span[1] <= span[0] ||
            span[1] > textLength
        ) {
            throw new Error('Invalid assistant final-answer span');
        }
        previousEnd = span[1];
    }
    return { unclassified: parsed.unclassified, finals: parsed.finals, omitted: parsed.omitted as number };
}
