import { MAX_TRANSCRIPT_RECORD_BYTES } from '../config/constants.js';
import type { ResumeContext, SourceContextRecord } from '../types/index.js';

// Persisted form of an adapter's resume context. The records only say which
// source records to re-read; the adapter re-verifies them against the source
// and derives every value from those bytes before resuming.

const SOURCE_CONTEXT_FIELDS = ['cwd', 'surface', 'branch'] as const;
const SOURCE_CONTEXT_DIGEST = /^[0-9a-f]{64}$/;
const DECISION_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const DECISION_VALUE_MAX_CHARS = 64;
const DECISIONS_MAX = 8;

export function encodeResumeContext(context: ResumeContext | undefined): string | null {
    if (context === undefined) {
        return null;
    }
    const records = context.records.map(({ field, offset, length, digest }) => ({ field, offset, length, digest }));
    return JSON.stringify(context.decisions === undefined ? { records } : { records, decisions: context.decisions });
}

function decodeRecords(value: unknown): SourceContextRecord[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const records: SourceContextRecord[] = [];
    for (const item of value) {
        const record = item as Partial<SourceContextRecord> | null;
        if (
            record === null ||
            typeof record !== 'object' ||
            !SOURCE_CONTEXT_FIELDS.includes(record.field as SourceContextRecord['field']) ||
            !Number.isSafeInteger(record.offset) ||
            (record.offset as number) < 0 ||
            !Number.isSafeInteger(record.length) ||
            (record.length as number) < 1 ||
            (record.length as number) > MAX_TRANSCRIPT_RECORD_BYTES + 1 ||
            typeof record.digest !== 'string' ||
            !SOURCE_CONTEXT_DIGEST.test(record.digest)
        ) {
            return undefined;
        }
        records.push({
            field: record.field as SourceContextRecord['field'],
            offset: record.offset as number,
            length: record.length as number,
            digest: record.digest,
        });
    }
    return records;
}

function decodeDecisions(value: unknown): Record<string, string> | undefined | false {
    if (value === undefined) {
        return undefined;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const entries = Object.entries(value);
    if (
        entries.length > DECISIONS_MAX ||
        entries.some(
            ([key, decision]) => !DECISION_KEY.test(key) || typeof decision !== 'string' || decision.length > DECISION_VALUE_MAX_CHARS,
        )
    ) {
        return false;
    }
    return Object.fromEntries(entries) as Record<string, string>;
}

// Rejects anything but well-formed values; an invalid stored value is treated
// as absent, so the context is reconstructed from the source again. A bare
// record list, written before decisions were recorded, carries no decisions.
export function decodeResumeContext(text: string | null | undefined): ResumeContext | undefined {
    if (typeof text !== 'string') {
        return undefined;
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (Array.isArray(value)) {
        const records = decodeRecords(value);
        return records === undefined ? undefined : { records };
    }
    if (value === null || typeof value !== 'object') {
        return undefined;
    }
    const { records: rawRecords, decisions: rawDecisions, ...rest } = value as Record<string, unknown>;
    const records = decodeRecords(rawRecords);
    const decisions = decodeDecisions(rawDecisions);
    if (records === undefined || decisions === false || Object.keys(rest).length > 0) {
        return undefined;
    }
    return decisions === undefined ? { records } : { records, decisions };
}
