// Validates report_task_state input recorded in a provider transcript. A
// provider may JSON-encode arguments; malformed reports are withheld whole.
import {
    TASK_STATE_REPORT_INPUT_MAX_BYTES,
    TASK_STATE_REPORT_ITEM_MAX_CHARS,
    TASK_STATE_REPORT_LIST_MAX_ITEMS,
    TASK_STATE_REPORT_MODES,
    TASK_STATE_REPORT_SOURCE_MAX_ITEMS,
    TASK_STATE_REPORT_SOURCE_QUOTE_MAX_CHARS,
    TASK_STATE_REQUEST_ID_PATTERN,
} from '../config/constants.js';
import { OPEN } from '../security/sentinel.js';
import type {
    TaskStateReportFailureReason,
    TaskStateReportInput,
    TaskStateReportItem,
    TaskStateReportMode,
    TaskStateReportSource,
} from '../types/index.js';

const REPORT_KEYS = new Set(['mode', 'request_id', 'objective', 'decisions', 'constraints', 'pending_items']);
const ITEM_KEYS = new Set(['text', 'sources']);
const SOURCE_KEYS = new Set(['role', 'quote']);

export type TaskStateReportInputResult =
    | { state: 'complete'; input: TaskStateReportInput }
    | { state: 'incomplete'; reason: Extract<TaskStateReportFailureReason, 'malformed-input' | 'oversized-input'> };

type Failure = 'malformed-input' | 'oversized-input';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: Set<string>, required: number): boolean {
    return Object.keys(value).length === required && Object.keys(value).every((key) => keys.has(key));
}

function isMode(value: unknown): value is TaskStateReportMode {
    return typeof value === 'string' && (TASK_STATE_REPORT_MODES as readonly string[]).includes(value);
}

function boundedText(value: unknown, maxChars: number): { value: string } | Failure {
    if (typeof value !== 'string' || value.trim() === '') {
        return 'malformed-input';
    }
    return value.length > maxChars ? 'oversized-input' : { value };
}

function source(value: unknown): TaskStateReportSource | Failure {
    if (!isRecord(value) || !exactKeys(value, SOURCE_KEYS, 2) || (value.role !== 'user' && value.role !== 'assistant')) {
        return 'malformed-input';
    }
    const quote = boundedText(value.quote, TASK_STATE_REPORT_SOURCE_QUOTE_MAX_CHARS);
    return typeof quote === 'string' ? quote : { role: value.role, quote: quote.value };
}

function item(value: unknown, mode: TaskStateReportMode): TaskStateReportItem | Failure {
    if (!isRecord(value) || !exactKeys(value, ITEM_KEYS, mode === 'precompact_manifest' ? 2 : 1)) {
        return 'malformed-input';
    }
    const text = boundedText(value.text, TASK_STATE_REPORT_ITEM_MAX_CHARS);
    if (typeof text === 'string') {
        return text;
    }
    if (mode === 'postcompact_retained') {
        return { text: text.value };
    }
    if (!Array.isArray(value.sources) || value.sources.length === 0) {
        return 'malformed-input';
    }
    if (value.sources.length > TASK_STATE_REPORT_SOURCE_MAX_ITEMS) {
        return 'oversized-input';
    }
    const sources: TaskStateReportSource[] = [];
    for (const entry of value.sources) {
        const parsed = source(entry);
        if (typeof parsed === 'string') {
            return parsed;
        }
        sources.push(parsed);
    }
    return { text: text.value, sources };
}

function list(value: unknown, mode: TaskStateReportMode): TaskStateReportItem[] | Failure {
    if (!Array.isArray(value)) {
        return 'malformed-input';
    }
    if (value.length > TASK_STATE_REPORT_LIST_MAX_ITEMS) {
        return 'oversized-input';
    }
    const items: TaskStateReportItem[] = [];
    for (const entry of value) {
        const parsed = item(entry, mode);
        if (typeof parsed === 'string') {
            return parsed;
        }
        items.push(parsed);
    }
    return items;
}

// Scan before correlation or validation can return early. Unicode escapes
// may hide a sentinel in JSON-encoded arguments. The rolling window keeps
// scan memory constant for input within the report byte ceiling.
function stringContainsReportSentinel(value: string): boolean {
    let window = '';
    for (let index = 0; index < value.length; index++) {
        let character = value.charAt(index);
        if (character === '\\' && value[index + 1] === 'u' && /^[0-9a-fA-F]{4}$/.test(value.slice(index + 2, index + 6))) {
            character = String.fromCharCode(Number.parseInt(value.slice(index + 2, index + 6), 16));
            index += 5;
        }
        window = (window + character).slice(-OPEN.length);
        if (window === OPEN) {
            return true;
        }
    }
    return false;
}

export type TaskStateReportRawGuard = 'sentinel' | 'scan-incomplete' | undefined;

export function taskStateReportRawGuard(value: unknown): TaskStateReportRawGuard {
    if (typeof value === 'string') {
        // A report that cannot be scanned within its own byte ceiling cannot
        // be allowed through the Rule 4 exception, whether or not a marker
        // appears after the bound.
        if (value.length > TASK_STATE_REPORT_INPUT_MAX_BYTES || Buffer.byteLength(value) > TASK_STATE_REPORT_INPUT_MAX_BYTES) {
            return 'scan-incomplete';
        }
        return stringContainsReportSentinel(value) ? 'sentinel' : undefined;
    }
    const pending: unknown[] = [value];
    const seen = new Set<object>();
    let visited = 0;
    let bytes = 0;
    while (pending.length > 0) {
        if (++visited > TASK_STATE_REPORT_INPUT_MAX_BYTES || ++bytes > TASK_STATE_REPORT_INPUT_MAX_BYTES) {
            return 'scan-incomplete';
        }
        const current = pending.pop();
        if (typeof current === 'string') {
            if (current.length > TASK_STATE_REPORT_INPUT_MAX_BYTES - bytes) {
                return 'scan-incomplete';
            }
            bytes += Buffer.byteLength(current);
            if (bytes > TASK_STATE_REPORT_INPUT_MAX_BYTES) {
                return 'scan-incomplete';
            }
            if (stringContainsReportSentinel(current)) {
                return 'sentinel';
            }
        } else if (current !== null && typeof current === 'object' && !seen.has(current)) {
            seen.add(current);
            const record = current as Record<string, unknown>;
            for (const key in current) {
                if (!Object.hasOwn(current, key)) {
                    continue;
                }
                if (key.length > TASK_STATE_REPORT_INPUT_MAX_BYTES - bytes) {
                    return 'scan-incomplete';
                }
                if (!Array.isArray(current)) {
                    bytes += Buffer.byteLength(key);
                    if (bytes > TASK_STATE_REPORT_INPUT_MAX_BYTES) {
                        return 'scan-incomplete';
                    }
                }
                if (stringContainsReportSentinel(key)) {
                    return 'sentinel';
                }
                pending.push(record[key]);
                if (visited + pending.length > TASK_STATE_REPORT_INPUT_MAX_BYTES) {
                    return 'scan-incomplete';
                }
            }
        }
    }
    return undefined;
}

export function parseTaskStateReportInput(value: unknown): TaskStateReportInputResult {
    let decoded = value;
    if (typeof value === 'string') {
        if (Buffer.byteLength(value) > TASK_STATE_REPORT_INPUT_MAX_BYTES) {
            return { state: 'incomplete', reason: 'oversized-input' };
        }
        try {
            decoded = JSON.parse(value);
        } catch {
            return { state: 'incomplete', reason: 'malformed-input' };
        }
    }
    if (!isRecord(decoded) || !exactKeys(decoded, REPORT_KEYS, 6) || !isMode(decoded.mode)) {
        return { state: 'incomplete', reason: 'malformed-input' };
    }
    if (typeof decoded.request_id !== 'string' || !TASK_STATE_REQUEST_ID_PATTERN.test(decoded.request_id)) {
        return { state: 'incomplete', reason: 'malformed-input' };
    }
    const mode = decoded.mode;
    const request_id = decoded.request_id;
    const objective = decoded.objective === null ? null : item(decoded.objective, mode);
    if (typeof objective === 'string') {
        return { state: 'incomplete', reason: objective };
    }
    const decisions = list(decoded.decisions, mode);
    if (typeof decisions === 'string') {
        return { state: 'incomplete', reason: decisions };
    }
    const constraints = list(decoded.constraints, mode);
    if (typeof constraints === 'string') {
        return { state: 'incomplete', reason: constraints };
    }
    const pending_items = list(decoded.pending_items, mode);
    if (typeof pending_items === 'string') {
        return { state: 'incomplete', reason: pending_items };
    }
    if (objective === null && (decisions.length > 0 || constraints.length > 0 || pending_items.length > 0)) {
        return { state: 'incomplete', reason: 'malformed-input' };
    }
    // item() enforces the source shape for the selected mode before this cast.
    const input = { mode, request_id, objective, decisions, constraints, pending_items } as TaskStateReportInput;
    if (Buffer.byteLength(JSON.stringify(input)) > TASK_STATE_REPORT_INPUT_MAX_BYTES) {
        return { state: 'incomplete', reason: 'oversized-input' };
    }
    return { state: 'complete', input };
}

function sameItem(left: TaskStateReportItem, right: TaskStateReportItem): boolean {
    return (
        left.text === right.text &&
        (left.sources === undefined) === (right.sources === undefined) &&
        (left.sources?.length ?? 0) === (right.sources?.length ?? 0) &&
        (left.sources?.every(
            (source, index) => source.role === right.sources?.[index]?.role && source.quote === right.sources[index]?.quote,
        ) ??
            true)
    );
}

function sameList(left: TaskStateReportItem[], right: TaskStateReportItem[]): boolean {
    return left.length === right.length && left.every((entry, index) => right[index] !== undefined && sameItem(entry, right[index]));
}

// Two envelopes of one call agree only when their validated reports are identical.
export function sameTaskStateReportInput(left: TaskStateReportInput, right: TaskStateReportInput): boolean {
    return (
        left.mode === right.mode &&
        left.request_id === right.request_id &&
        (left.objective === null ? right.objective === null : right.objective !== null && sameItem(left.objective, right.objective)) &&
        sameList(left.decisions, right.decisions) &&
        sameList(left.constraints, right.constraints) &&
        sameList(left.pending_items, right.pending_items)
    );
}
