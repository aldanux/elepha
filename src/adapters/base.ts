// Adapter contract: each AI CLI (Claude Code, Codex) implements this to turn
// its own JSONL session format into a common shape. Keeps tool-specific
// parsing quirks out of the daemon/storage/mcp layers.
//
// This file owns the one piece of logic that must not be duplicated per
// adapter: turn-boundary assembly. A turn is only emitted once provably
// closed (a subsequent turn-opening line was parsed, or the caller asserts
// the file has been idle past its debounce window). Providers with explicit
// turn lifecycle markers must also finish that lifecycle before an idle close.
// Getting this wrong is not self-correcting.

import { createHash } from 'node:crypto';
import { type FileHandle, open, stat } from 'node:fs/promises';
import path from 'node:path';
import {
    ELEPHA_MCP_CALL_ID_MAX_BYTES,
    ELEPHA_MCP_RESULT_MAX_BYTES,
    ELEPHA_MCP_RESULTS_PER_TURN_MAX,
    ELEPHA_MCP_RESULTS_PER_TURN_MAX_BYTES,
    ELEPHA_MCP_UNMATCHED_RESULT_ID_BYTES_MAX,
    ELEPHA_MCP_UNMATCHED_RESULT_IDS_MAX,
    FINGERPRINT_WINDOW_BYTES,
    MAX_JSON_VALUE_DEPTH,
    MAX_JSON_VALUE_NODES,
    MAX_TRANSCRIPT_RECORD_BYTES,
    MAX_UNKNOWN_LINE_DISCRIMINATOR_CHARS,
    TASK_STATE_REPORT_ACK,
    TASK_STATE_REPORT_RESULT_MAX_BYTES,
} from '../config/constants.js';
import { type AssistantMessageBoundary, joinedAssistantStructure } from '../rendering/assistant-structure.js';
import { turnText } from '../security/self-ingestion.js';
import { containsSentinel } from '../security/sentinel.js';
import type {
    ElephaMcpResultReceipt,
    EmptySessionAnalysis,
    OpenTailObservation,
    ParsedToolCall,
    ParsedTurn,
    ParseTurnsOptions,
    ResumeContext,
    ResumeContextDerivation,
    ResumeContextDerivationResult,
    SessionAdapter,
    SessionAdapterTool,
    SessionClassification,
    SourceContextRecord,
    SourceCursorPosition,
    SourceReadBudget,
    TaskStateReport,
    TaskStateReportFailureReason,
    TaskStateReportInput,
} from '../types/index.js';
import {
    parseTaskStateReportInput,
    sameTaskStateReportInput,
    type TaskStateReportRawGuard,
    taskStateReportRawGuard,
} from './task-state-report.js';

const NEWLINE = 0x0a;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;
// Read size while a bounded step finishes the record its allowance ran out in.
const RECORD_OVERRUN_READ_BYTES = 4096;
// Enough recently read bytes to fingerprint a turn that ended within the last
// two chunks without reading its window again.
const RECENT_BYTES_CAPACITY = FINGERPRINT_WINDOW_BYTES + 2 * TRANSCRIPT_READ_CHUNK_BYTES;
const DISCRIMINATOR_DIGEST_HEX_CHARS = 8;
const DISCRIMINATOR_DIGEST_SEPARATOR = '…#';
const UNSAFE_DISCRIMINATOR_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu;

export class TranscriptReadBudgetError extends Error {}

// A parse cannot resume an adapter whose context carries across turns without
// the context issued with its cursor; reconstruct it first.
export class ResumeContextRequiredError extends Error {
    constructor(filePath: string) {
        super(`Resuming ${filePath} requires the resume context issued with its cursor`);
        this.name = 'ResumeContextRequiredError';
    }
}

function discriminatorDigest(value: unknown): string {
    let digestInput: string;
    if (typeof value === 'string') {
        digestInput = value;
    } else {
        try {
            digestInput = JSON.stringify(value) ?? `${typeof value}:${String(value)}`;
        } catch {
            digestInput = `${typeof value}:${Object.prototype.toString.call(value)}`;
        }
    }
    return createHash('sha256').update(digestInput).digest('hex').slice(0, DISCRIMINATOR_DIGEST_HEX_CHARS);
}

// Renders an untrusted line discriminator without copying arbitrary transcript content into diagnostics.
export function safeDiscriminator(value: unknown): string {
    const isString = typeof value === 'string';
    const display = isString ? value : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const sanitized = display.replace(UNSAFE_DISCRIMINATOR_CHARACTERS, '');
    const sanitizedCharacters = [...sanitized];
    const needsDigest = !isString || sanitized !== display || sanitizedCharacters.length > MAX_UNKNOWN_LINE_DISCRIMINATOR_CHARS;

    if (!needsDigest) {
        return sanitized;
    }

    const suffix = `${DISCRIMINATOR_DIGEST_SEPARATOR}${discriminatorDigest(value)}`;
    const prefixLength = MAX_UNKNOWN_LINE_DISCRIMINATOR_CHARS - [...suffix].length;
    return `${sanitizedCharacters.slice(0, prefixLength).join('')}${suffix}`;
}

export interface RawLine {
    text: string;
    // Absolute byte offset of the first byte of this line (including any prior lines).
    byteStart: number;
    // Absolute byte offset of the first byte after this line's trailing newline.
    byteEnd: number;
}

// Tool-specific observations normalized before applying shared empty-session precedence.
export interface EmptySessionSignals {
    assistantContribution?: boolean;
    toolCall?: boolean;
    abortedPrompt?: boolean;
    internalCommand?: boolean;
    internalCommandRollout?: boolean;
    nonInternalUserContent?: boolean;
    userContentSeen?: boolean;
}

interface JsonValueFrame {
    value: unknown;
    depth: number;
    entered: boolean;
    children?: Iterator<unknown>;
}

function* childValues(value: unknown[] | Record<string, unknown>): IterableIterator<unknown> {
    if (Array.isArray(value)) {
        for (const child of value) {
            yield child;
        }
        return;
    }
    for (const key in value) {
        if (Object.hasOwn(value, key)) {
            yield value[key];
        }
    }
}

export function textValues(value: unknown): string[] {
    const strings: string[] = [];
    const stack: JsonValueFrame[] = [{ value, depth: 0, entered: false }];
    let visitedNodes = 0;

    while (stack.length > 0 && visitedNodes < MAX_JSON_VALUE_NODES) {
        const frame = stack.at(-1);
        if (!frame) {
            break;
        }
        if (!frame.entered) {
            frame.entered = true;
            visitedNodes++;
            if (typeof frame.value === 'string') {
                strings.push(frame.value);
                stack.pop();
                continue;
            }
            if (!frame.value || typeof frame.value !== 'object' || frame.depth >= MAX_JSON_VALUE_DEPTH) {
                stack.pop();
                continue;
            }
            frame.children = childValues(frame.value as unknown[] | Record<string, unknown>);
        }

        if (!frame.children) {
            stack.pop();
            continue;
        }
        const child = frame.children.next();
        if (child.done) {
            stack.pop();
        } else {
            stack.push({ value: child.value, depth: frame.depth + 1, entered: false });
        }
    }

    return strings;
}

export const OVERSIZED_TRANSCRIPT_RECORD_REASON = `oversized record exceeds the ${MAX_TRANSCRIPT_RECORD_BYTES}-byte limit`;

export function malformedCompleteRecordsDiagnostic(filePath: string, count: number): string {
    const record = count === 1 ? 'record' : 'records';
    return `[elepha] skipped ${count} malformed complete JSONL ${record} in ${filePath}`;
}

export class OversizedTranscriptRecordError extends Error {
    constructor() {
        super(OVERSIZED_TRANSCRIPT_RECORD_REASON);
        this.name = 'OversizedTranscriptRecordError';
    }
}

export interface BoundedLine {
    text: string;
    // Original byte length including a trailing newline when present.
    byteLength: number;
    terminated: boolean;
}

export interface BoundedLineReadOptions {
    start?: number;
    maxRecordBytes?: number;
    maxReadBytes?: number;
    // Reads from this already-opened file without taking ownership or changing its position.
    handle?: FileHandle;
}

// Reads JSONL records without retaining a pending record beyond the per-record ceiling.
export async function* readBoundedLines(filePath: string, options: BoundedLineReadOptions = {}): AsyncIterable<BoundedLine> {
    const start = options.start ?? 0;
    const maxRecordBytes = options.maxRecordBytes ?? MAX_TRANSCRIPT_RECORD_BYTES;
    if (!Number.isSafeInteger(start) || start < 0) {
        throw new RangeError('start must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 0) {
        throw new RangeError('maxRecordBytes must be a non-negative safe integer');
    }

    const suppliedHandle = options.handle;
    const handle = suppliedHandle ?? (await open(filePath, 'r'));
    let readOffset = start;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;

    try {
        for (;;) {
            const bytesUntilOversized = maxRecordBytes - pendingBytes + 1;
            const remainingBytes = (options.maxReadBytes ?? Number.POSITIVE_INFINITY) - (readOffset - start);
            if (remainingBytes <= 0) {
                throw new TranscriptReadBudgetError('Transcript evidence byte budget reached.');
            }
            const chunk = Buffer.alloc(Math.min(TRANSCRIPT_READ_CHUNK_BYTES, bytesUntilOversized, remainingBytes));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, readOffset);
            if (bytesRead === 0) {
                break;
            }
            readOffset += bytesRead;
            const data = chunk.subarray(0, bytesRead);
            let lineStart = 0;

            for (;;) {
                const newline = data.indexOf(NEWLINE, lineStart);
                if (newline === -1) {
                    const tail = data.subarray(lineStart);
                    if (pendingBytes + tail.length > maxRecordBytes) {
                        throw new OversizedTranscriptRecordError();
                    }
                    if (tail.length > 0) {
                        pendingChunks.push(tail);
                        pendingBytes += tail.length;
                    }
                    break;
                }

                const lineTail = data.subarray(lineStart, newline);
                const recordBytes = pendingBytes + lineTail.length;
                if (recordBytes > maxRecordBytes) {
                    throw new OversizedTranscriptRecordError();
                }
                const record =
                    pendingChunks.length === 0
                        ? data.subarray(lineStart, newline)
                        : Buffer.concat(lineTail.length === 0 ? pendingChunks : [...pendingChunks, lineTail], recordBytes);
                yield { text: record.toString('utf8'), byteLength: recordBytes + 1, terminated: true };
                pendingChunks = [];
                pendingBytes = 0;
                lineStart = newline + 1;
            }
        }

        if (pendingBytes > 0) {
            yield {
                text: Buffer.concat(pendingChunks, pendingBytes).toString('utf8'),
                byteLength: pendingBytes,
                terminated: false,
            };
        }
    } finally {
        if (!suppliedHandle) {
            await handle.close();
        }
    }
}

// Reads a transcript through filesystem APIs and applies the classification
// precedence shared by both JSONL formats. Adapters provide their own line
// signals so format knowledge remains at the adapter boundary.
export async function classifyEmptyJsonlSession(
    filePath: string,
    signalsFor: (line: unknown) => EmptySessionSignals,
): Promise<EmptySessionAnalysis | undefined> {
    const signals: Required<EmptySessionSignals> = {
        assistantContribution: false,
        toolCall: false,
        abortedPrompt: false,
        internalCommand: false,
        internalCommandRollout: false,
        nonInternalUserContent: false,
        userContentSeen: false,
    };
    let malformed = false;

    for await (const { text } of readBoundedLines(filePath)) {
        let line: unknown;
        try {
            line = JSON.parse(text);
        } catch {
            malformed = true;
            continue;
        }

        const lineSignals = signalsFor(line);
        for (const key of Object.keys(signals) as Array<keyof EmptySessionSignals>) {
            signals[key] ||= lineSignals[key] ?? false;
        }
    }

    if (malformed) {
        return undefined;
    }
    if (signals.internalCommandRollout) {
        return { kind: 'internal command' };
    }
    if (signals.assistantContribution || signals.toolCall) {
        return undefined;
    }
    if (signals.abortedPrompt) {
        return { kind: 'aborted prompt' };
    }
    if (signals.userContentSeen && signals.internalCommand && !signals.nonInternalUserContent) {
        return { kind: 'internal command' };
    }
    return { kind: 'no assistant contribution' };
}

// Resolves a possibly-relative path emitted by a tool call to an absolute,
// normalized form. Does not resolve symlinks: the file may already be gone
// by the time we parse the turn, and realpath would throw on that.
export function resolveAbsolute(filePath: string, baseDir: string): string {
    return path.isAbsolute(filePath) ? path.normalize(filePath) : path.normalize(path.resolve(baseDir, filePath));
}

export function normalizeTimestamp(ts: string): string {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}

function parseCursor(cursor: string | undefined): { byteOffset: number; nextTurnIndex: number; fingerprint: string | undefined } {
    if (!cursor) {
        return { byteOffset: 0, nextTurnIndex: 0, fingerprint: undefined };
    }

    // Third segment is optional - an older cursor has
    // only two. Missing means "nothing to verify against", not "verified
    // empty": the rewrite check is skipped for that one scan rather than
    // treated as a mismatch.
    const [offsetStr, indexStr, fingerprint] = cursor.split('|');
    return { byteOffset: Number(offsetStr) || 0, nextTurnIndex: Number(indexStr) || 0, fingerprint: fingerprint || undefined };
}

function formatCursor(byteOffset: number, nextTurnIndex: number, fingerprint: string): string {
    return `${byteOffset}|${nextTurnIndex}|${fingerprint}`;
}

// One canonical order, so equal contexts persist and compare identically.
function orderedContext(records: Iterable<SourceContextRecord>): SourceContextRecord[] {
    return [...records].sort((a, b) => a.offset - b.offset || a.field.localeCompare(b.field));
}

function sourceContextDigest(recordText: string): string {
    return createHash('sha256').update(recordText).digest('hex');
}

// The byte cursor alone cannot tell "nothing new yet" from "this file got
// rewritten out from under me" - a rewrite at the same or larger size lands
// the cursor mid-record with no signal. Fingerprinting a small trailing
// window ending at the cursor, and re-checking that exact window (not the
// whole file) on the next scan, catches a rewrite at a cost that doesn't
// scale with file size.
async function fingerprintWindow(handle: FileHandle, endOffset: number, budget?: SourceReadBudget): Promise<string> {
    const start = Math.max(0, endOffset - FINGERPRINT_WINDOW_BYTES);
    const len = endOffset - start;
    if (len <= 0) {
        return '';
    }
    const chunk = Buffer.alloc(len);
    if (budget !== undefined) {
        chargeRead(budget, len);
    }
    await handle.read(chunk, 0, len, start);
    return windowDigest(chunk);
}

// Not a security boundary - just a reliability check, so a short digest
// (collision risk irrelevant at this scale) keeps the cursor string small.
function windowDigest(window: Buffer): string {
    return createHash('sha256').update(window).digest('hex').slice(0, 16);
}

// Charges a read against the shared allowance before it happens, so the
// caller's bound covers every byte, not only the transcript tail.

// Only a live adapter iterator retains partial records, open turns and decision
// state. Suspending it never manufactures EOF or a durable capture cursor.
// The owner must revalidate the opened snapshot and authority at each checkpoint.

function chargeRead(budget: SourceReadBudget, length: number): void {
    if (length > budget.remaining) {
        throw new TranscriptReadBudgetError('Transcript evidence byte budget reached.');
    }
    budget.remaining -= length;
}

// The most recently read source bytes. A turn's cursor fingerprint covers
// bytes the parse has just read, so it is computed from them rather than read
// again; only a turn end further back than this window costs a fresh read.
class RecentBytes {
    private start = 0;
    private bytes = Buffer.alloc(0);

    constructor(private readonly capacity: number) {}

    append(offset: number, data: Buffer): void {
        if (this.bytes.length > 0 && offset === this.start + this.bytes.length) {
            this.bytes = Buffer.concat([this.bytes, data]);
        } else {
            this.start = offset;
            this.bytes = Buffer.from(data);
        }
        if (this.bytes.length > this.capacity) {
            const drop = this.bytes.length - this.capacity;
            this.bytes = Buffer.from(this.bytes.subarray(drop));
            this.start += drop;
        }
    }

    fingerprint(endOffset: number): string | undefined {
        const from = Math.max(0, endOffset - FINGERPRINT_WINDOW_BYTES);
        if (endOffset <= from) {
            return '';
        }
        if (from < this.start || endOffset > this.start + this.bytes.length) {
            return undefined;
        }
        return windowDigest(this.bytes.subarray(from - this.start, endOffset - this.start));
    }
}

interface ChargedLine {
    text: string;
    byteStart: number;
    byteEnd: number;
}

// Complete records between `start` and `end`, every read charged. With
// `firstRecordOverrun`, the allowance may be exceeded only to finish the first
// record, so a bounded caller still makes progress past a large record.
async function* chargedLines(
    handle: FileHandle,
    options: {
        start: number;
        end: number;
        budget: SourceReadBudget;
        signal?: AbortSignal;
        firstRecordOverrun?: boolean;
        onChunk?: (offset: number, data: Buffer) => void;
        chunkBytes?: number;
    },
): AsyncIterable<ChargedLine> {
    let readOffset = options.start;
    let pendingOffset = options.start;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    let yielded = false;
    while (readOffset < options.end) {
        if (options.signal?.aborted) {
            return;
        }
        // Never read past the byte that proves the pending record oversized.
        const wanted = Math.min(
            options.chunkBytes ?? TRANSCRIPT_READ_CHUNK_BYTES,
            options.end - readOffset,
            MAX_TRANSCRIPT_RECORD_BYTES - pendingBytes + 1,
        );

        let length = Math.min(wanted, options.budget.remaining);
        if (length <= 0) {
            if (!options.firstRecordOverrun || yielded) {
                throw new TranscriptReadBudgetError('Transcript evidence byte budget reached.');
            }
            // Small reads, so finishing the record overshoots it by little.
            length = Math.min(wanted, RECORD_OVERRUN_READ_BYTES);
            options.budget.remaining = 0;
        } else {
            chargeRead(options.budget, length);
        }
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, readOffset);
        if (bytesRead === 0) {
            return;
        }
        const chunkOffset = readOffset;
        readOffset += bytesRead;
        const data = chunk.subarray(0, bytesRead);
        options.onChunk?.(chunkOffset, data);
        let lineStart = 0;
        for (;;) {
            const newline = data.indexOf(NEWLINE, lineStart);
            if (newline === -1) {
                const tail = data.subarray(lineStart);
                if (pendingBytes + tail.length > MAX_TRANSCRIPT_RECORD_BYTES) {
                    throw new OversizedTranscriptRecordError();
                }
                if (tail.length > 0) {
                    pendingChunks.push(tail);
                    pendingBytes += tail.length;
                }
                break;
            }
            const lineTail = data.subarray(lineStart, newline);
            const recordBytes = pendingBytes + lineTail.length;
            if (recordBytes > MAX_TRANSCRIPT_RECORD_BYTES) {
                throw new OversizedTranscriptRecordError();
            }
            const text =
                pendingChunks.length === 0
                    ? data.toString('utf8', lineStart, newline)
                    : Buffer.concat([...pendingChunks, lineTail], recordBytes).toString('utf8');
            const byteStart = pendingOffset;
            const byteEnd = chunkOffset + newline + 1;
            lineStart = newline + 1;
            pendingChunks = [];
            pendingBytes = 0;
            pendingOffset = byteEnd;
            yielded = true;
            yield { text, byteStart, byteEnd };
        }
    }
}

// An adapter decision made from records before any turn boundary, such as
// which Codex record type opens a turn. Its state must be JSON-serializable so
// a bounded reconstruction can resume it.
export interface ParserDecisionTracker {
    initial(): unknown;
    observe(state: unknown, line: unknown): unknown;
    decided(state: unknown): Readonly<Record<string, string>> | undefined;
    valid(decisions: Readonly<Record<string, string>>): boolean;
}

export interface TurnBuilderState {
    userMessageParts: string[];
    assistantTextParts: string[];
    assistantMessageBoundaries: AssistantMessageBoundary[];
    toolCalls: ParsedToolCall[];
    openToolCallIds: Set<string>;
    startedAt: string | undefined;
    endedAt: string | undefined;
    projectPath: string | undefined;
    surface: string | undefined;
    gitBranch: string | undefined;
    aiTitle: string | undefined;
    hasExternalContent: boolean;
    resumeMarkerBefore: boolean;
    elephaMcpCallIds: Set<string>;
    elephaMcpUnmatchedResultIds: Set<string>;
    elephaMcpUnmatchedResultBytes: number;
    elephaMcpUnmatchedCoverageIncomplete: boolean;
    elephaMcpResultReceipts: ElephaMcpResultReceipt[];
    elephaMcpResultBytes: number;
    elephaMcpCoverageFailure?: ElephaMcpCoverageFailureReason;
    // First report_task_state call of the turn. Tracked apart from the
    // elepha MCP sets above so it never forces the Rule 4 whole-turn drop.
    taskStateReport: TaskStateReportObservation | undefined;
    // First reason the turn's report cannot be trusted; it withholds only the report.
    taskStateReportFailure: TaskStateReportFailureReason | undefined;
    taskStateReportRawGuard: TaskStateReportRawGuard;
    explicitLifecycleStarted: boolean;
    explicitLifecycleId: string | undefined;
    explicitLifecycleFinished: boolean;
    explicitLifecycleAborted: boolean;
    explicitLifecycleFailedAt: string | undefined;
    // Set by an adapter whose boundary line was once stored as a turn but
    // now contributes no text. If nothing follows it, the turn still closes
    // as a dropped empty turn so later turns keep their persisted indexes.
    keepsIndexWhenEmpty: boolean;
}

export interface TurnLifecycleSignal {
    phase: 'started' | 'finished' | 'failed' | 'aborted';
    id: string | undefined;
}

export type ElephaMcpCoverageFailureReason =
    | 'missing-call-id'
    | 'oversized-call-id'
    | 'duplicate-call-id'
    | 'incomplete-correlation'
    | 'out-of-order-result'
    | 'oversized-call-set'
    | 'missing-result'
    | 'unsupported-result'
    | 'oversized-result';

export class ElephaMcpCoverageError extends Error {
    constructor(readonly reason: ElephaMcpCoverageFailureReason) {
        super(`Elepha MCP self-ingestion coverage incomplete: ${reason}`);
        this.name = 'ElephaMcpCoverageError';
    }
}

export type BoundedMcpResult =
    | { state: 'complete'; body: string; bytes: number }
    | { state: 'incomplete'; reason: ElephaMcpCoverageFailureReason };

function mcpTextParts(value: unknown): string[] | undefined {
    if (typeof value === 'string') {
        try {
            const decoded = JSON.parse(value) as unknown;
            if (decoded && typeof decoded === 'object' && 'content' in decoded) {
                const content = (decoded as { content: unknown }).content;
                if (Array.isArray(content)) {
                    return mcpTextParts(content);
                }
            }
        } catch {
            // A plain MCP text result is already the receipt body.
        }
        return [value];
    }
    if (!Array.isArray(value)) {
        return undefined;
    }
    const parts: string[] = [];
    for (const block of value) {
        if (!block || typeof block !== 'object') {
            return undefined;
        }
        const candidate = block as { type?: unknown; text?: unknown; content?: unknown };
        if (candidate.type === 'text' && typeof candidate.text === 'string') {
            parts.push(candidate.text);
            continue;
        }
        if (typeof candidate.content === 'string') {
            parts.push(candidate.content);
            continue;
        }
        return undefined;
    }
    return parts;
}

export function boundedMcpResult(value: unknown): BoundedMcpResult {
    // A provider can JSON-encode an MCP envelope inside a string. Enforce
    // the raw bound before JSON.parse allocates decoded objects or strings.
    if (typeof value === 'string' && Buffer.byteLength(value) > ELEPHA_MCP_RESULT_MAX_BYTES) {
        return { state: 'incomplete', reason: 'oversized-result' };
    }
    const parts = mcpTextParts(value);
    if (parts === undefined || parts.length === 0) {
        return { state: 'incomplete', reason: 'unsupported-result' };
    }
    let bytes = 0;
    for (const [index, part] of parts.entries()) {
        bytes += Buffer.byteLength(part) + (index === 0 ? 0 : 1);
        if (bytes > ELEPHA_MCP_RESULT_MAX_BYTES) {
            return { state: 'incomplete', reason: 'oversized-result' };
        }
    }
    return { state: 'complete', body: parts.join('\n'), bytes };
}

export function canonicalTimestamp(...candidates: Array<string | undefined>): string | undefined {
    for (const candidate of candidates) {
        if (candidate === undefined) {
            continue;
        }
        const parsed = new Date(candidate);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
    }
    return undefined;
}

export function rememberUnmatchedElephaMcpResult(state: TurnBuilderState, callId: string): void {
    if (state.elephaMcpUnmatchedResultIds.has(callId)) {
        return;
    }
    const bytes = Buffer.byteLength(callId);
    if (
        state.elephaMcpUnmatchedResultIds.size >= ELEPHA_MCP_UNMATCHED_RESULT_IDS_MAX ||
        state.elephaMcpUnmatchedResultBytes + bytes > ELEPHA_MCP_UNMATCHED_RESULT_ID_BYTES_MAX
    ) {
        state.elephaMcpUnmatchedCoverageIncomplete = true;
        return;
    }
    state.elephaMcpUnmatchedResultIds.add(callId);
    state.elephaMcpUnmatchedResultBytes += bytes;
}

// One provider record shape that can carry a report call or its result.
// Codex writes the same call through a CLI pair and a Desktop item, and the
// two must agree; every other repeat within one envelope is a duplicate.
export type TaskStateReportEnvelope = 'claude-code' | 'codex-cli' | 'codex-desktop' | 'opencode-v2';

export interface TaskStateReportObservation {
    callId: string;
    // Undefined once any envelope carried invalid input; a failure is recorded then.
    input: TaskStateReportInput | undefined;
    callEnvelopes: Set<TaskStateReportEnvelope>;
    resultEnvelopes: Set<TaskStateReportEnvelope>;
}

function failTaskStateReport(state: TurnBuilderState, reason: TaskStateReportFailureReason): void {
    state.taskStateReportFailure ??= reason;
}

export function reportInputDropReason(guard: TaskStateReportRawGuard): 'sentinel' | 'report-input-unscanned' | undefined {
    return guard === 'scan-incomplete' ? 'report-input-unscanned' : guard;
}

function selfIngestionDropReason(turn: ParsedTurn): 'sentinel' | 'report-input-unscanned' | undefined {
    if (turn.droppedReason === 'sentinel' || turn.droppedReason === 'report-input-unscanned') {
        return turn.droppedReason;
    }
    return containsSentinel(turnText(turn)) ? 'sentinel' : undefined;
}

function selfIngestionDropMessage(reason: 'sentinel' | 'report-input-unscanned'): string {
    return reason === 'sentinel' ? 'self-injected content (sentinel)' : 'report input could not be fully scanned within bound';
}

function isTaskStateReportAck(value: unknown): boolean {
    let decoded = value;
    if (typeof value === 'string') {
        if (value.length > TASK_STATE_REPORT_RESULT_MAX_BYTES || Buffer.byteLength(value) > TASK_STATE_REPORT_RESULT_MAX_BYTES) {
            return false;
        }
        if (value === TASK_STATE_REPORT_ACK) {
            return true;
        }
        try {
            decoded = JSON.parse(value);
        } catch {
            return false;
        }
    }
    // Claude and Codex Desktop carry text blocks. Codex CLI can serialize
    // the MCP result envelope into its output string. Neither shape may
    // include extra result fields or error metadata.
    if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) {
        const envelope = decoded as Record<string, unknown>;
        if (Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'content')) {
            return false;
        }
        decoded = envelope.content;
    }
    if (!Array.isArray(decoded) || decoded?.length !== 1) {
        return false;
    }
    const block = decoded[0];
    return (
        block !== null &&
        typeof block === 'object' &&
        !Array.isArray(block) &&
        Object.keys(block).length === 2 &&
        Object.hasOwn(block, 'type') &&
        Object.hasOwn(block, 'text') &&
        block.type === 'text' &&
        block.text === TASK_STATE_REPORT_ACK
    );
}

// A generic elepha call reusing the report's id makes correlation ambiguous.
export function isTaskStateReportCallId(state: TurnBuilderState, callId: string): boolean {
    return state.taskStateReport?.callId === callId;
}

export function observeTaskStateReportCall(
    state: TurnBuilderState,
    envelope: TaskStateReportEnvelope,
    callId: unknown,
    rawInput: unknown,
): void {
    // Raw arguments must remain in Rule 4 coverage even when correlation,
    // shape, or size checks prevent the report from reaching ParsedTurn.
    const rawGuard = taskStateReportRawGuard(rawInput);
    if (rawGuard === 'sentinel' || (rawGuard === 'scan-incomplete' && state.taskStateReportRawGuard === undefined)) {
        state.taskStateReportRawGuard = rawGuard;
    }
    if (typeof callId !== 'string' || callId === '') {
        failTaskStateReport(state, 'missing-call-id');
        return;
    }
    if (Buffer.byteLength(callId) > ELEPHA_MCP_CALL_ID_MAX_BYTES) {
        failTaskStateReport(state, 'oversized-call-id');
        return;
    }
    // Sharing an id with a canonical elepha call is ambiguous correlation of
    // possibly served memory, so the generic Rule 4 coverage fails closed.
    if (state.elephaMcpCallIds.has(callId) || state.elephaMcpResultReceipts.some((receipt) => receipt.callId === callId)) {
        state.elephaMcpCoverageFailure = 'duplicate-call-id';
        return;
    }
    const parsed = parseTaskStateReportInput(rawInput);
    const existing = state.taskStateReport;
    if (existing === undefined) {
        state.taskStateReport = {
            callId,
            input: parsed.state === 'complete' ? parsed.input : undefined,
            callEnvelopes: new Set([envelope]),
            resultEnvelopes: new Set(),
        };
        if (parsed.state === 'incomplete') {
            failTaskStateReport(state, parsed.reason);
        }
        return;
    }
    // A turn states one task state. Two reports would force a guess between them.
    if (existing.callId !== callId) {
        failTaskStateReport(state, 'multiple-reports');
        return;
    }
    if (existing.callEnvelopes.has(envelope)) {
        failTaskStateReport(state, 'duplicate-call-id');
        return;
    }
    existing.callEnvelopes.add(envelope);
    if (parsed.state === 'incomplete') {
        failTaskStateReport(state, parsed.reason);
        return;
    }
    if (existing.input === undefined || !sameTaskStateReportInput(existing.input, parsed.input)) {
        failTaskStateReport(state, 'conflicting-duplicate');
    }
}

// Returns true when the result belongs to the turn's report, so the caller
// must not also treat it as an ordinary or canonical elepha result.
export function consumeTaskStateReportResult(
    state: TurnBuilderState,
    envelope: TaskStateReportEnvelope,
    callId: unknown,
    value: unknown,
    isError: boolean,
): boolean {
    const observation = state.taskStateReport;
    if (typeof callId !== 'string' || observation?.callId !== callId) {
        return false;
    }
    if (observation.resultEnvelopes.has(envelope)) {
        failTaskStateReport(state, 'duplicate-call-id');
        return true;
    }
    observation.resultEnvelopes.add(envelope);
    if (isError || !isTaskStateReportAck(value)) {
        failTaskStateReport(state, 'unexpected-result');
    }
    return true;
}

export type TaskStateReportOutcome = { report: TaskStateReport } | { failure: TaskStateReportFailureReason };

export function taskStateReportOutcome(state: TurnBuilderState): TaskStateReportOutcome | undefined {
    if (state.taskStateReportFailure !== undefined) {
        return { failure: state.taskStateReportFailure };
    }
    const observation = state.taskStateReport;
    if (observation === undefined) {
        return undefined;
    }
    if (observation.input === undefined) {
        return { failure: 'malformed-input' };
    }
    // Every envelope that recorded the call must also record its acknowledgement.
    for (const envelope of observation.callEnvelopes) {
        if (!observation.resultEnvelopes.has(envelope)) {
            return { failure: 'missing-result' };
        }
    }
    return { report: { callId: observation.callId, ...observation.input } };
}

export function createTurnBuilderState(): TurnBuilderState {
    return {
        userMessageParts: [],
        assistantTextParts: [],
        assistantMessageBoundaries: [],
        toolCalls: [],
        openToolCallIds: new Set(),
        startedAt: undefined,
        endedAt: undefined,
        projectPath: undefined,
        surface: undefined,
        gitBranch: undefined,
        aiTitle: undefined,
        hasExternalContent: false,
        resumeMarkerBefore: false,
        elephaMcpCallIds: new Set(),
        elephaMcpUnmatchedResultIds: new Set(),
        elephaMcpUnmatchedResultBytes: 0,
        elephaMcpUnmatchedCoverageIncomplete: false,
        elephaMcpResultReceipts: [],
        elephaMcpResultBytes: 0,
        taskStateReport: undefined,
        taskStateReportFailure: undefined,
        taskStateReportRawGuard: undefined,
        explicitLifecycleStarted: false,
        explicitLifecycleId: undefined,
        explicitLifecycleFinished: false,
        explicitLifecycleAborted: false,
        explicitLifecycleFailedAt: undefined,
        keepsIndexWhenEmpty: false,
    };
}

function isEmptyTurn(state: TurnBuilderState): boolean {
    return (
        state.userMessageParts.every((s) => s.trim() === '') &&
        state.assistantTextParts.every((s) => s.trim() === '') &&
        state.toolCalls.length === 0 &&
        state.taskStateReport === undefined &&
        state.taskStateReportFailure === undefined
    );
}

// Idle close requires a real assistant contribution and, at the call site,
// no unresolved tool call. A lone user message with no reply yet is still
// waiting even past the idle window, so it must stay open.
function hasAssistantContribution(state: TurnBuilderState): boolean {
    return state.assistantTextParts.some((s) => s.trim() !== '');
}

export type LineClass = 'boundary' | 'content' | 'skip';

// Shared turn-assembly engine. Adapters supply the tool-specific line
// classification and folding logic; this class owns byte-offset tracking,
// partial-line discard, and the boundary-vs-idle close rule.
export abstract class JsonlTurnAdapter implements SessionAdapter {
    abstract readonly tool: SessionAdapterTool;
    abstract readonly watchGlobs: string[];

    // Called whenever classify() sees a line shape it doesn't explicitly
    // recognize. The bug this guards against: an adapter's classify() falls
    // through to 'skip' by default, so a wrong or outdated assumption about
    // the source format produces months of silently-empty data with zero
    // signal - exactly what happened with Codex's apply_patch envelope.
    // Defaults to console.warn; the daemon wires this into its own log.
    constructor(protected readonly warnUnknownLine: (message: string) => void = (msg) => console.warn(msg)) {}

    // Dedupes cursor-desync alerts so a frozen session does not emit the same warning on every debounced rescan.
    private readonly desyncAlerted = new Set<string>();

    // Unrecognized records reported by the classify() call in progress.
    // classify() is synchronous, so no other parse sharing this adapter can
    // interleave between resetting and reading this count.
    private unrecognizedInClassify = 0;

    abstract matches(filePath: string): boolean;

    // Derives the native session/thread id from the file's own path (both tools encode it in the filename).
    abstract nativeSessionId(filePath: string): string;

    // Defaults to 'primary'; adapters override where the format exposes a reliable signal.
    async classifySession(_filePath: string): Promise<SessionClassification> {
        return { kind: 'primary' };
    }

    abstract classifyEmptySession(filePath: string): Promise<EmptySessionAnalysis | undefined>;

    // Most transcript formats do not expose a user-set session title.
    async readCustomTitle(_filePath: string, _fromOffset = 0): Promise<{ customTitle?: string; scannedTo: number }> {
        return { scannedTo: 0 };
    }

    // Unknown shapes must call warnUnknownLine() rather than silently returning 'skip'.
    protected abstract classify(line: unknown, filePath: string): LineClass;

    // For a record classify() skips because its shape is unrecognized: warns
    // like warnUnknownLine() and counts the record as unrecognized, so callers
    // can report possibly lost content instead of treating the source as whole.
    protected warnUnrecognizedRecord(message: string): void {
        this.unrecognizedInClassify++;
        this.warnUnknownLine(message);
    }

    // Extracts a cwd from this line, if it carries one. Called on every line regardless of classification.
    protected abstract cwdOf(line: unknown): string | undefined;

    // Extracts this line's timestamp, if any.
    protected abstract timestampOf(line: unknown): string | undefined;

    // Session-surface discriminator on this line, if any (Claude Code:
    // per-line `entrypoint`; Codex: `originator`, only on session_meta).
    // Not abstract - most lines in both formats don't carry it, so the base
    // loop tracks "last seen" exactly like cwdOf, and an adapter that never
    // overrides this just never sets a surface (NULL, not a wrong guess).
    protected surfaceOf(_line: unknown): string | undefined {
        return undefined;
    }

    // Git branch on this line, if any. Per-turn for Claude Code
    // (`gitBranch`), session-constant for Codex (`session_meta.payload.git.branch`; no
    // per-turn equivalent found in the full local corpus).
    protected branchOf(_line: unknown): string | undefined {
        return undefined;
    }

    // True if this raw line is a tool-fetched-external-content call. Checked
    // on every line regardless of classify()'s boundary/content/skip verdict
    // (Codex's web_search_call is itself a 'skip' line under KNOWN_RESPONSE_ITEM_SKIP -
    // this hook still needs to see it, the same way cwdOf sees skip lines).
    protected isExternalFetchLine(_line: unknown): boolean {
        return false;
    }

    // True if this raw line is a Codex resume marker (`<environment_context>`) - a boundary signal
    // only, never content. Checked on every line, independent of classify()'s
    // verdict, the same way isExternalFetchLine is: the marker line itself is
    // classified 'skip' (it's a synthetic role:user response_item, "not
    // something a person typed"), so it never opens or closes a turn on its
    // own - it just sets a pending flag the next turn boundary picks up. Base
    // default false; Claude Code never overrides this (it has per-turn
    // gitBranch and doesn't need it).
    protected isResumeMarkerLine(_line: unknown): boolean {
        return false;
    }

    // Claude Code emits ai-title as standalone metadata between a prompt and its response.
    protected aiTitleOf(_line: unknown): string | undefined {
        return undefined;
    }

    // Some providers record one AI-generated title outside the turn transcript.
    // Read it once per parse and seed every assembled turn so the shared title
    // pipeline remains responsible for choosing it over the prompt fallback.
    protected async readSessionAiTitle(_filePath: string): Promise<string | undefined> {
        return undefined;
    }

    // Updates transient assembly bookkeeping without making a skipped plumbing line part of the turn payload.
    protected observeToolCallState(_state: TurnBuilderState, _line: unknown): void {}

    // Provider adapters inspect only their verified raw call/result envelopes.
    protected observeElephaMcp(_state: TurnBuilderState, _line: unknown): void {}

    // Providers with explicit task lifecycle events can keep a quiet but live
    // turn open until its matching completion or abort event is observed.
    protected turnLifecycleSignal(_line: unknown): TurnLifecycleSignal | undefined {
        return undefined;
    }

    // Folds a 'boundary' or 'content' line's data into the in-progress turn.
    protected abstract fold(state: TurnBuilderState, line: unknown): void;

    cursorPosition(cursor: string): SourceCursorPosition {
        const { byteOffset, nextTurnIndex } = parseCursor(cursor);
        return { byteOffset, nextTurnIndex };
    }

    // The fingerprint covers a small window ending at the cursor, the same
    // check a resumed parse makes before trusting it. An older cursor without
    // a fingerprint has nothing to verify beyond the source length.
    async authenticateCursor(cursor: string, handle: FileHandle, readBudget?: SourceReadBudget): Promise<SourceCursorPosition | undefined> {
        const { byteOffset, nextTurnIndex, fingerprint } = parseCursor(cursor);
        if ((await handle.stat()).size < byteOffset) {
            return undefined;
        }
        if (fingerprint !== undefined && (await fingerprintWindow(handle, byteOffset, readBudget)) !== fingerprint) {
            return undefined;
        }
        return { byteOffset, nextTurnIndex };
    }

    // True when records before a turn's boundary can set its working
    // directory or provenance; see SessionAdapter.carriesContextAcrossTurns.
    readonly carriesContextAcrossTurns: boolean = false;

    private contextValues(line: unknown): Array<[SourceContextRecord['field'], string]> {
        const values: Array<[SourceContextRecord['field'], string]> = [];
        const cwd = this.cwdOf(line);
        if (cwd) {
            values.push(['cwd', cwd]);
        }
        const surface = this.surfaceOf(line);
        if (surface) {
            values.push(['surface', surface]);
        }
        const branch = this.branchOf(line);
        if (branch) {
            values.push(['branch', branch]);
        }
        return values;
    }

    // A decision the adapter makes from records before any turn boundary;
    // undefined when it makes none.
    protected decisionTracker(): ParserDecisionTracker | undefined {
        return undefined;
    }

    // Applies the decisions a parse of `filePath` uses; undefined when none
    // could be made yet.
    protected applyDecisions(_filePath: string, _decisions: Readonly<Record<string, string>> | undefined): void {}

    resumeContextComplete(context: ResumeContext): boolean {
        const tracker = this.decisionTracker();
        return tracker === undefined || (context.decisions !== undefined && tracker.valid(context.decisions));
    }

    // Re-reads each context record from the opened source, charging every
    // read. A record must end at or before `beforeOffset`, start a line, still
    // be one complete record hashing to its digest, and still set its field.
    // The returned values come from those source bytes, never from the stored
    // record.
    private async readResumeContext(
        context: ResumeContext,
        handle: FileHandle,
        beforeOffset: number,
        budget: SourceReadBudget,
    ): Promise<Partial<Record<SourceContextRecord['field'], string>> | undefined> {
        const values: Partial<Record<SourceContextRecord['field'], string>> = {};
        for (const record of context.records) {
            if (record.offset + record.length > beforeOffset || record.length > MAX_TRANSCRIPT_RECORD_BYTES + 1) {
                return undefined;
            }
            const start = Math.max(0, record.offset - 1);
            const length = record.offset + record.length - start;
            chargeRead(budget, length);
            const bytes = Buffer.alloc(length);
            const { bytesRead } = await handle.read(bytes, 0, length, start);
            // The byte before a record ends the previous line.
            if (bytesRead !== length || bytes[length - 1] !== NEWLINE || (record.offset > 0 && bytes[0] !== NEWLINE)) {
                return undefined;
            }
            const text = bytes.toString('utf8', record.offset - start, length - 1);
            if (sourceContextDigest(text) !== record.digest) {
                return undefined;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch {
                return undefined;
            }
            const value = this.contextValues(parsed).find(([field]) => field === record.field)?.[1];
            if (value === undefined) {
                return undefined;
            }
            values[record.field] = value;
        }
        return values;
    }

    async authenticateResumeContext(
        context: ResumeContext,
        handle: FileHandle,
        beforeOffset: number,
        readBudget: SourceReadBudget = { remaining: Number.POSITIVE_INFINITY },
    ): Promise<boolean> {
        return (await this.readResumeContext(context, handle, beforeOffset, readBudget)) !== undefined;
    }

    // Reconstructs, from the source, the resume context for a cursor issued
    // without one: the last record before `endOffset` that set each context
    // field, and the adapter's decisions. Each call is one bounded step that
    // stops at a record boundary when the allowance or the signal runs out,
    // and continues from earlier progress only while the bytes ending at that
    // progress still match their fingerprint; otherwise it starts over.
    async deriveResumeContext(
        handle: FileHandle,
        endOffset: number,
        options: { from?: ResumeContextDerivation; readBudget: SourceReadBudget; signal?: AbortSignal },
    ): Promise<ResumeContextDerivationResult> {
        const tracker = this.decisionTracker();
        let progress: ResumeContextDerivation = {
            endOffset,
            offset: 0,
            fingerprint: '',
            records: [],
            decisionState: tracker?.initial(),
        };
        const recent = new RecentBytes(RECENT_BYTES_CAPACITY);
        const from = options.from;
        if (from !== undefined && from.endOffset === endOffset && from.offset > 0 && from.offset <= endOffset) {
            const windowStart = Math.max(0, from.offset - FINGERPRINT_WINDOW_BYTES);
            const window = Buffer.alloc(from.offset - windowStart);
            chargeRead(options.readBudget, window.length);
            await handle.read(window, 0, window.length, windowStart);
            if (windowDigest(window) === from.fingerprint) {
                progress = from;
                recent.append(windowStart, window);
            }
        }
        const latest = new Map(progress.records.map((record) => [record.field, record]));
        let decisionState = progress.decisionState;
        let offset = progress.offset;
        try {
            for await (const line of chargedLines(handle, {
                start: offset,
                end: endOffset,
                budget: options.readBudget,
                signal: options.signal,
                firstRecordOverrun: true,
                onChunk: (chunkOffset, data) => recent.append(chunkOffset, data),
            })) {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(line.text);
                } catch {
                    parsed = undefined;
                }
                if (parsed !== undefined) {
                    const values = this.contextValues(parsed);
                    if (values.length > 0) {
                        const digest = sourceContextDigest(line.text);
                        for (const [field] of values) {
                            latest.set(field, { field, offset: line.byteStart, length: line.byteEnd - line.byteStart, digest });
                        }
                    }
                    if (tracker !== undefined) {
                        decisionState = tracker.observe(decisionState, parsed);
                    }
                }
                offset = line.byteEnd;
            }
        } catch (error) {
            if (!(error instanceof TranscriptReadBudgetError)) {
                throw error;
            }
        }
        if (offset >= endOffset) {
            const decisions = tracker?.decided(decisionState);
            return {
                state: 'complete',
                context: { records: orderedContext(latest.values()), ...(decisions === undefined ? {} : { decisions }) },
            };
        }
        // Held bytes cover the window unless the record it stopped after was
        // longer than they are; only then is the window read again.
        const fingerprint = recent.fingerprint(offset) ?? (await fingerprintWindow(handle, offset));
        return {
            state: 'partial',
            progress: { endOffset, offset, fingerprint, records: orderedContext(latest.values()), decisionState },
        };
    }

    // Reads records from the start of the source until the adapter's decision
    // is made, charging every read. Undecided at the end of the source leaves
    // the adapter's default in place.
    private async prescanDecisions(
        handle: FileHandle,
        tracker: ParserDecisionTracker,
        end: number,
        budget: SourceReadBudget,
        signal?: AbortSignal,
    ): Promise<Readonly<Record<string, string>> | undefined> {
        let state = tracker.initial();
        // Small reads: the decision usually lies in the first records, and
        // whatever this reads is charged against the parse's own allowance.
        for await (const line of chargedLines(handle, { start: 0, end, budget, signal, chunkBytes: RECORD_OVERRUN_READ_BYTES })) {
            try {
                state = tracker.observe(state, JSON.parse(line.text));
            } catch {
                continue;
            }
            const decided = tracker.decided(state);
            if (decided !== undefined) {
                return decided;
            }
        }
        return tracker.decided(state);
    }

    async *parseTurns(filePath: string, sinceCursor?: string, options?: ParseTurnsOptions): AsyncIterable<ParsedTurn> {
        if (options?.signal?.aborted) {
            return;
        }
        const { byteOffset: startOffset, nextTurnIndex: startTurnIndex, fingerprint: expectedFingerprint } = parseCursor(sinceCursor);
        const suppliedHandle = options?.handle;
        const fileStat = await (suppliedHandle ? suppliedHandle.stat() : stat(filePath)).catch(() => null);
        if (!fileStat) {
            return;
        }
        const readEnd = options?.endByteOffset ?? fileStat.size;
        if (options?.endByteOffset !== undefined && (!Number.isSafeInteger(readEnd) || readEnd < startOffset || readEnd > fileStat.size)) {
            throw new Error('Invalid transcript prefix endpoint');
        }

        // Strictly less than, not <=. size === startOffset is the normal
        // steady-state case (nothing new since the last scan) and must stay
        // silent; only a real shrink - the file got rotated or truncated out
        // from under the cursor - is a bug. Deduped per file: every debounced
        // rescan of a frozen session would otherwise re-alert identically
        // forever.
        if (fileStat.size < startOffset) {
            options?.onDesync?.();
            if (!this.desyncAlerted.has(filePath)) {
                this.desyncAlerted.add(filePath);
                this.warnUnknownLine(
                    `[cursor desync] ${filePath} shrank below its stored cursor (${fileStat.size} < ${startOffset} bytes) - ` +
                        'looks rotated or truncated. Refusing to read until an operator resolves this (see elepha reingest).',
                );
            }
            return;
        }
        if (fileStat.size === startOffset) {
            return;
        }

        const handle = suppliedHandle ?? (await open(filePath, 'r'));
        // One allowance for every read below: cursor and context
        // authentication, the adapter's decision prescan, and the tail.
        const budget = options?.readBudget ?? { remaining: options?.maxReadBytes ?? Number.POSITIVE_INFINITY };
        const recent = new RecentBytes(RECENT_BYTES_CAPACITY);
        try {
            // Before trusting startOffset, re-verify the bytes immediately
            // preceding it still match what was fingerprinted when the cursor
            // was set. A rewrite that grows the file (rotation, compaction)
            // passes the size check above but lands the cursor mid-record -
            // this catches it at the cost of one small re-read, not O(file size).
            if (expectedFingerprint !== undefined) {
                const windowStart = Math.max(0, startOffset - FINGERPRINT_WINDOW_BYTES);
                const window = Buffer.alloc(startOffset - windowStart);
                chargeRead(budget, window.length);
                await handle.read(window, 0, window.length, windowStart);
                recent.append(windowStart, window);
                const actualFingerprint = window.length === 0 ? '' : windowDigest(window);
                if (actualFingerprint !== expectedFingerprint) {
                    options?.onDesync?.();
                    if (!this.desyncAlerted.has(filePath)) {
                        this.desyncAlerted.add(filePath);
                        this.warnUnknownLine(
                            `[cursor desync] ${filePath} was rewritten: content preceding the stored cursor (offset ${startOffset}) no ` +
                                'longer matches (mismatch on the trailing fingerprint). Refusing to read until an operator resolves this ' +
                                '(see elepha reingest).',
                        );
                    }
                    return;
                }
            }

            const sessionId = this.nativeSessionId(filePath);
            const sessionAiTitle = await this.readSessionAiTitle(filePath);
            let currentCwd: string | undefined;
            let currentSurface: string | undefined;
            let currentBranch: string | undefined;
            // Latches true on a resume-marker line, consumed (and reset) by the
            // next turn boundary - it describes what immediately preceded THAT
            // turn, not a running session-wide state like currentBranch.
            let pendingResumeMarker = false;
            let currentTurn: TurnBuilderState | null = null;

            let pendingLifecycleStart: { signal: TurnLifecycleSignal; byteStart: number } | undefined;
            let nextTurnIndex = startTurnIndex;
            let pendingChunks: Buffer[] = [];
            let pendingBytes = 0;
            let pendingOffset = startOffset;
            let readOffset = startOffset;
            let lastCompleteLineEnd: number | undefined;
            let malformedCompleteRecords = 0;
            let unrecognizedRecords = 0;

            // Context records seen so far: those ending at or before an issued
            // cursor are committed into that cursor's resumeContext.
            const tracksContext = this.carriesContextAcrossTurns;
            const committedContext = new Map<SourceContextRecord['field'], SourceContextRecord>();
            let pendingContext: SourceContextRecord[] = [];
            const resumeContext = options?.resumeContext;
            if (tracksContext && startOffset > 0) {
                if (resumeContext === undefined) {
                    throw new ResumeContextRequiredError(filePath);
                }
                const values = await this.readResumeContext(resumeContext, handle, startOffset, budget);
                if (values === undefined) {
                    options?.onDesync?.();
                    if (!this.desyncAlerted.has(filePath)) {
                        this.desyncAlerted.add(filePath);
                        this.warnUnknownLine(
                            `[cursor desync] ${filePath} was rewritten: a record that set this session's context before the stored ` +
                                `cursor (offset ${startOffset}) no longer matches. Refusing to read until an operator resolves this ` +
                                '(see elepha reingest).',
                        );
                    }
                    return;
                }
                for (const record of resumeContext.records) {
                    committedContext.set(record.field, record);
                }
                currentCwd = values.cwd;
                currentSurface = values.surface;
                currentBranch = values.branch;
            }
            // A resumed parse uses the decisions recorded with its cursor; only
            // a parse without them reads from the start, within the allowance.
            const tracker = this.decisionTracker();
            let decisions: Readonly<Record<string, string>> | undefined;
            if (tracker !== undefined) {
                const recorded = startOffset > 0 ? resumeContext?.decisions : undefined;
                decisions =
                    recorded !== undefined && tracker.valid(recorded)
                        ? recorded
                        : await this.prescanDecisions(handle, tracker, fileStat.size, budget, options?.signal);
                if (options?.signal?.aborted) {
                    return;
                }
            }
            this.applyDecisions(filePath, decisions);
            const contextAt = (endOffset: number): ResumeContext => {
                const recorded = decisions === undefined ? {} : { decisions };
                if (!tracksContext) {
                    return { records: [], ...recorded };
                }
                for (const record of pendingContext) {
                    if (record.offset + record.length <= endOffset) {
                        committedContext.set(record.field, record);
                    }
                }
                pendingContext = pendingContext.filter((record) => record.offset + record.length > endOffset);
                return { records: orderedContext(committedContext.values()), ...recorded };
            };

            const parsedTurn = async (state: TurnBuilderState, endOffset: number): Promise<ParsedTurn> => {
                const turnIndex = nextTurnIndex++;
                const turn: ParsedTurn = {
                    tool: this.tool,
                    sessionId,
                    sourcePath: filePath,
                    projectPath: state.projectPath ?? '',
                    turnIndex,
                    startedAt: state.startedAt ?? new Date(0).toISOString(),
                    endedAt: state.endedAt ?? state.startedAt ?? new Date(0).toISOString(),
                    userMessage: state.userMessageParts.join('\n').trim(),
                    aiTitle: state.aiTitle,
                    assistantText: state.assistantTextParts.join('\n').trim(),
                    assistantStructure: joinedAssistantStructure(state.assistantTextParts, state.assistantMessageBoundaries),
                    toolCalls: state.toolCalls,
                    cursor: formatCursor(
                        endOffset,
                        turnIndex + 1,
                        recent.fingerprint(endOffset) ?? (await fingerprintWindow(handle, endOffset, budget)),
                    ),
                    resumeContext: contextAt(endOffset),
                    surface: state.surface,
                    gitBranch: state.gitBranch,
                    hasExternalContent: state.hasExternalContent,
                    resumeMarkerBefore: state.resumeMarkerBefore,
                };
                const rawDropReason = reportInputDropReason(state.taskStateReportRawGuard);
                if (rawDropReason !== undefined) {
                    return {
                        ...turn,
                        userMessage: '',
                        aiTitle: undefined,
                        assistantText: '',
                        assistantStructure: undefined,
                        toolCalls: [],
                        hasExternalContent: false,
                        resumeMarkerBefore: false,
                        droppedReason: rawDropReason,
                    };
                }
                if (
                    state.elephaMcpCallIds.size === 0 &&
                    state.elephaMcpResultReceipts.length === 0 &&
                    state.elephaMcpCoverageFailure === undefined
                ) {
                    // Only a turn free of every other elepha call keeps its
                    // report; the Rule 4 drop below discards it with the turn.
                    const report = taskStateReportOutcome(state);
                    if (report === undefined) {
                        return turn;
                    }
                    if ('failure' in report) {
                        this.warnUnknownLine(
                            `[elepha] withheld task-state report in turn ${turn.turnIndex} of ${sessionId}: ${report.failure}`,
                        );
                        return { ...turn, taskStateReportFailure: report.failure };
                    }
                    return { ...turn, taskStateReport: report.report };
                }
                if (state.elephaMcpCoverageFailure !== undefined) {
                    throw new ElephaMcpCoverageError(state.elephaMcpCoverageFailure);
                }
                if (state.elephaMcpCallIds.size > 0) {
                    throw new ElephaMcpCoverageError('missing-result');
                }
                if (state.elephaMcpResultReceipts.length > ELEPHA_MCP_RESULTS_PER_TURN_MAX) {
                    throw new ElephaMcpCoverageError('oversized-result');
                }
                if (state.elephaMcpResultBytes > ELEPHA_MCP_RESULTS_PER_TURN_MAX_BYTES) {
                    throw new ElephaMcpCoverageError('oversized-result');
                }
                return {
                    ...turn,
                    userMessage: '',
                    aiTitle: undefined,
                    assistantText: '',
                    assistantStructure: undefined,
                    toolCalls: [],
                    hasExternalContent: false,
                    resumeMarkerBefore: false,
                    droppedReason: 'elepha-mcp',
                    elephaMcpResultReceipts: state.elephaMcpResultReceipts,
                };
            };

            while (readOffset < readEnd) {
                if (options?.signal?.aborted) {
                    return;
                }
                if (budget.remaining <= 0) {
                    throw new TranscriptReadBudgetError('Transcript evidence byte budget reached.');
                }
                const chunk = Buffer.alloc(Math.min(TRANSCRIPT_READ_CHUNK_BYTES, readEnd - readOffset, budget.remaining));
                chargeRead(budget, chunk.length);
                const { bytesRead } = await handle.read(chunk, 0, chunk.length, readOffset);
                if (bytesRead === 0) {
                    break;
                }
                const chunkOffset = readOffset;
                readOffset += bytesRead;
                const data = chunk.subarray(0, bytesRead);
                recent.append(chunkOffset, data);

                let lineStart = 0;
                for (;;) {
                    const newline = data.indexOf(NEWLINE, lineStart);
                    if (newline === -1) {
                        const tail = data.subarray(lineStart);
                        if (pendingBytes + tail.length > MAX_TRANSCRIPT_RECORD_BYTES) {
                            throw new OversizedTranscriptRecordError();
                        }
                        if (tail.length > 0) {
                            pendingChunks.push(tail);
                            pendingBytes += tail.length;
                        }
                        break;
                    }
                    const lineTail = data.subarray(lineStart, newline);
                    const recordBytes = pendingBytes + lineTail.length;
                    if (recordBytes > MAX_TRANSCRIPT_RECORD_BYTES) {
                        throw new OversizedTranscriptRecordError();
                    }
                    const line: RawLine = {
                        text:
                            pendingChunks.length === 0
                                ? data.toString('utf8', lineStart, newline)
                                : Buffer.concat(lineTail.length === 0 ? pendingChunks : [...pendingChunks, lineTail], recordBytes).toString(
                                      'utf8',
                                  ),
                        byteStart: pendingOffset,
                        byteEnd: chunkOffset + newline + 1,
                    };
                    lineStart = newline + 1;
                    pendingChunks = [];
                    pendingBytes = 0;
                    pendingOffset = line.byteEnd;
                    lastCompleteLineEnd = line.byteEnd;

                    if (options?.signal?.aborted) {
                        return;
                    }
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(line.text);
                    } catch {
                        // The newline proves this is a complete record rather than
                        // a normal partial tail that may finish on the next scan.
                        // Keep consuming it: refusing to advance would let one
                        // permanently malformed record stall all future ingestion.
                        malformedCompleteRecords++;
                        continue;
                    }

                    if (tracksContext) {
                        const values = this.contextValues(parsed);
                        if (values.length > 0) {
                            const digest = sourceContextDigest(line.text);
                            for (const [field] of values) {
                                const record = { field, offset: line.byteStart, length: line.byteEnd - line.byteStart, digest };
                                const cutoff = pendingLifecycleStart?.byteStart ?? line.byteStart;
                                // A delayed lifecycle boundary needs the latest context on
                                // either side, never every repeated header in an open turn.
                                const previous = pendingContext.filter((item) => item.field === field);
                                const before = previous.reverse().find((item) => item.offset + item.length <= cutoff);
                                pendingContext = pendingContext.filter((item) => item.field !== field);
                                if (before) {
                                    pendingContext.push(before);
                                }
                                pendingContext.push(record);
                            }
                        }
                    }
                    const cwd = this.cwdOf(parsed);
                    if (cwd) {
                        currentCwd = cwd;
                    }
                    const surface = this.surfaceOf(parsed);
                    if (surface) {
                        currentSurface = surface;
                    }
                    const branch = this.branchOf(parsed);
                    if (branch) {
                        currentBranch = branch;
                    }
                    if (currentTurn && this.isExternalFetchLine(parsed)) {
                        currentTurn.hasExternalContent = true;
                    }
                    if (currentTurn) {
                        const aiTitle = this.aiTitleOf(parsed);
                        if (aiTitle !== undefined) {
                            currentTurn.aiTitle = aiTitle;
                        }
                    }
                    if (this.isResumeMarkerLine(parsed)) {
                        pendingResumeMarker = true;
                    }
                    const lifecycle = this.turnLifecycleSignal(parsed);
                    this.unrecognizedInClassify = 0;
                    const cls = this.classify(parsed, filePath);
                    unrecognizedRecords += this.unrecognizedInClassify;
                    if (lifecycle?.phase === 'started') {
                        // Codex writes task_started immediately before its user
                        // boundary. Latch it for the state that boundary opens,
                        // never onto the preceding turn that may still be held.
                        pendingLifecycleStart = { signal: lifecycle, byteStart: line.byteStart };
                    } else if (lifecycle?.phase === 'failed' && currentTurn) {
                        // A provider failure ends one attempt, not the user's
                        // conversational turn. Keep it open even if an older
                        // cursor omitted the matching start marker.
                        const pendingLifecycleMatches =
                            pendingLifecycleStart !== undefined && pendingLifecycleStart.signal.id === lifecycle.id;
                        if (
                            pendingLifecycleMatches ||
                            !currentTurn.explicitLifecycleStarted ||
                            currentTurn.explicitLifecycleId === lifecycle.id
                        ) {
                            currentTurn.explicitLifecycleStarted = true;
                            currentTurn.explicitLifecycleId = lifecycle.id;
                            currentTurn.explicitLifecycleFinished = false;
                            currentTurn.explicitLifecycleAborted = false;
                            currentTurn.explicitLifecycleFailedAt =
                                canonicalTimestamp(this.timestampOf(parsed), currentTurn.endedAt) ?? new Date(0).toISOString();
                            if (pendingLifecycleMatches) {
                                pendingLifecycleStart = undefined;
                            }
                        }
                    } else if ((lifecycle?.phase === 'finished' || lifecycle?.phase === 'aborted') && currentTurn) {
                        const pendingLifecycleMatches =
                            pendingLifecycleStart !== undefined && pendingLifecycleStart.signal.id === lifecycle.id;
                        if (pendingLifecycleMatches) {
                            // A retry can abort before contributing content. Its
                            // lifecycle still belongs to the open user turn.
                            currentTurn.explicitLifecycleStarted = true;
                            currentTurn.explicitLifecycleId = lifecycle.id;
                            currentTurn.explicitLifecycleFinished = true;
                            currentTurn.explicitLifecycleAborted = lifecycle.phase === 'aborted';
                            currentTurn.explicitLifecycleFailedAt = undefined;
                            pendingLifecycleStart = undefined;
                        } else if (
                            currentTurn.explicitLifecycleStarted &&
                            currentTurn.explicitLifecycleId !== undefined &&
                            lifecycle.id === currentTurn.explicitLifecycleId
                        ) {
                            currentTurn.explicitLifecycleFinished = true;
                            currentTurn.explicitLifecycleAborted = lifecycle.phase === 'aborted';
                            currentTurn.explicitLifecycleFailedAt = undefined;
                        }
                    }
                    if (pendingLifecycleStart && currentTurn && cls === 'content') {
                        // An automatic retry starts a new provider attempt with
                        // no user boundary. The first assistant contribution
                        // proves it continues the current conversational turn.
                        currentTurn.explicitLifecycleStarted = true;
                        currentTurn.explicitLifecycleId = pendingLifecycleStart.signal.id;
                        currentTurn.explicitLifecycleFinished = false;
                        currentTurn.explicitLifecycleAborted = false;
                        currentTurn.explicitLifecycleFailedAt = undefined;
                        pendingLifecycleStart = undefined;
                    }
                    if (currentTurn) {
                        this.observeToolCallState(currentTurn, parsed);
                        this.observeElephaMcp(currentTurn, parsed);
                    }

                    if (cls === 'skip') {
                        continue;
                    }

                    if (cls === 'boundary') {
                        const closed = currentTurn;
                        const lifecycleStart = pendingLifecycleStart;
                        currentTurn = createTurnBuilderState();

                        currentTurn.aiTitle = sessionAiTitle;
                        currentTurn.resumeMarkerBefore = pendingResumeMarker;
                        if (lifecycleStart) {
                            currentTurn.explicitLifecycleStarted = true;
                            currentTurn.explicitLifecycleId = lifecycleStart.signal.id;
                            pendingLifecycleStart = undefined;
                        }
                        pendingResumeMarker = false;
                        if (closed && (!isEmptyTurn(closed) || closed.taskStateReportRawGuard !== undefined)) {
                            // task_started belongs to the turn this boundary
                            // opens. Keep it after the previous turn's cursor
                            // so an incremental resume reconstructs the same
                            // explicit lifecycle instead of mistaking it for a
                            // legacy idle-close turn.
                            const turn = await parsedTurn(closed, lifecycleStart?.byteStart ?? line.byteStart);
                            const dropReason = selfIngestionDropReason(turn);
                            if (dropReason !== undefined) {
                                this.warnUnknownLine(
                                    `[elepha] dropped turn ${turn.turnIndex} of ${sessionId}: ${selfIngestionDropMessage(dropReason)}`,
                                );
                                yield { ...turn, droppedReason: dropReason };
                            } else {
                                yield turn;
                            }
                        } else if (closed?.keepsIndexWhenEmpty) {
                            const turn = await parsedTurn(closed, lifecycleStart?.byteStart ?? line.byteStart);
                            yield { ...turn, droppedReason: turn.droppedReason ?? 'empty' };
                        }
                    }

                    if (!currentTurn) {
                        continue;
                    } // content line before any boundary ever seen - drop

                    currentTurn.projectPath = currentCwd;
                    currentTurn.surface = currentSurface;
                    currentTurn.gitBranch = currentBranch;

                    const ts = this.timestampOf(parsed);
                    if (ts) {
                        const normalized = normalizeTimestamp(ts);
                        if (!currentTurn.startedAt) {
                            currentTurn.startedAt = normalized;
                        }
                        currentTurn.endedAt = normalized;
                    }

                    this.fold(currentTurn, parsed);
                }
            }

            if (malformedCompleteRecords > 0) {
                this.warnUnknownLine(malformedCompleteRecordsDiagnostic(filePath, malformedCompleteRecords));
                options?.onMalformedRecords?.(malformedCompleteRecords);
            }
            if (unrecognizedRecords > 0) {
                options?.onUnrecognizedRecords?.(unrecognizedRecords);
            }
            if (pendingBytes > 0) {
            }

            if (
                currentTurn &&
                lastCompleteLineEnd !== undefined &&
                options?.closeTrailingOnIdle &&
                (!currentTurn.explicitLifecycleStarted || currentTurn.explicitLifecycleFinished) &&
                (currentTurn.explicitLifecycleAborted ||
                    (hasAssistantContribution(currentTurn) && currentTurn.openToolCallIds.size === 0) ||
                    (currentTurn.taskStateReport !== undefined && currentTurn.openToolCallIds.size === 0) ||
                    currentTurn.elephaMcpCoverageFailure !== undefined ||
                    currentTurn.elephaMcpCallIds.size > 0 ||
                    currentTurn.taskStateReportRawGuard !== undefined)
            ) {
                const parsed = {
                    ...(await parsedTurn(currentTurn, lastCompleteLineEnd)),
                    ...(!currentTurn.explicitLifecycleStarted ? { provisionalIdle: true as const } : {}),
                };
                const turn =
                    currentTurn.explicitLifecycleAborted &&
                    !hasAssistantContribution(currentTurn) &&
                    currentTurn.toolCalls.length === 0 &&
                    currentTurn.elephaMcpCallIds.size === 0 &&
                    currentTurn.elephaMcpResultReceipts.length === 0 &&
                    currentTurn.taskStateReportRawGuard === undefined &&
                    currentTurn.taskStateReport === undefined &&
                    currentTurn.taskStateReportFailure === undefined
                        ? { ...parsed, droppedReason: 'empty' as const }
                        : parsed;
                const dropReason = selfIngestionDropReason(turn);
                if (dropReason !== undefined) {
                    this.warnUnknownLine(
                        `[elepha] dropped turn ${turn.turnIndex} of ${sessionId}: ${selfIngestionDropMessage(dropReason)}`,
                    );
                    yield { ...turn, droppedReason: dropReason };
                } else {
                    yield turn;
                }
            }

            if (
                currentTurn &&
                lastCompleteLineEnd !== undefined &&
                currentTurn.explicitLifecycleStarted &&
                !currentTurn.explicitLifecycleFinished &&
                currentTurn.explicitLifecycleFailedAt !== undefined &&
                pendingLifecycleStart === undefined &&
                !isEmptyTurn(currentTurn)
            ) {
                let receiptCoverage: OpenTailObservation['receiptCoverage'];
                try {
                    receiptCoverage = { state: 'complete', turn: await parsedTurn(currentTurn, lastCompleteLineEnd) };
                } catch (error) {
                    if (!(error instanceof ElephaMcpCoverageError)) {
                        throw error;
                    }
                    const candidate = await (async (): Promise<ParsedTurn> => ({
                        tool: this.tool,
                        sessionId,
                        sourcePath: filePath,
                        projectPath: currentTurn?.projectPath ?? '',
                        turnIndex: nextTurnIndex - 1,
                        startedAt: currentTurn?.startedAt ?? new Date(0).toISOString(),
                        endedAt: currentTurn?.endedAt ?? currentTurn?.startedAt ?? new Date(0).toISOString(),
                        userMessage: currentTurn?.userMessageParts.join('\n').trim() ?? '',
                        aiTitle: currentTurn?.aiTitle,
                        assistantText: currentTurn?.assistantTextParts.join('\n').trim() ?? '',
                        assistantStructure: currentTurn
                            ? joinedAssistantStructure(currentTurn.assistantTextParts, currentTurn.assistantMessageBoundaries)
                            : undefined,
                        toolCalls: currentTurn?.toolCalls ?? [],
                        cursor: formatCursor(lastCompleteLineEnd, nextTurnIndex, await fingerprintWindow(handle, lastCompleteLineEnd)),
                        surface: currentTurn?.surface,
                        gitBranch: currentTurn?.gitBranch,
                        hasExternalContent: currentTurn?.hasExternalContent ?? false,
                        resumeMarkerBefore: currentTurn?.resumeMarkerBefore ?? false,
                    }))();
                    receiptCoverage = { state: 'incomplete', reason: error.reason, turn: candidate };
                }
                const dropReason =
                    reportInputDropReason(currentTurn.taskStateReportRawGuard) ?? selfIngestionDropReason(receiptCoverage.turn);
                if (dropReason !== undefined) {
                    this.warnUnknownLine(
                        `[elepha] dropped turn ${receiptCoverage.turn.turnIndex} of ${sessionId}: ${selfIngestionDropMessage(dropReason)}`,
                    );
                    return;
                }
                options?.onOpenTail?.({
                    kind: 'failed-eof',
                    anchorCursor: sinceCursor,
                    candidateCursor: receiptCoverage.turn.cursor,
                    failedAt: currentTurn.explicitLifecycleFailedAt,
                    receiptCoverage,
                });
            }
        } finally {
            if (!suppliedHandle) {
                await handle.close();
            }
        }
    }
}
