// Adapter contract: each AI CLI (Claude Code, Codex) implements this to turn
// its own JSONL session format into a common shape. Keeps tool-specific
// parsing quirks out of the daemon/storage/mcp layers.
//
// This file owns the one piece of logic that must not be duplicated per
// adapter: turn-boundary assembly. A turn is only emitted once provably
// closed (a subsequent turn-opening line was parsed, or the caller asserts
// the file has been idle past its debounce window). Getting this wrong is
// not self-correcting.

import { createHash } from 'node:crypto';
import { type FileHandle, open, stat } from 'node:fs/promises';
import path from 'node:path';
import {
    FINGERPRINT_WINDOW_BYTES,
    MAX_JSON_VALUE_DEPTH,
    MAX_JSON_VALUE_NODES,
    MAX_TRANSCRIPT_RECORD_BYTES,
    MAX_UNKNOWN_LINE_DISCRIMINATOR_CHARS,
} from '../config/constants.js';
import { turnText } from '../security/self-ingestion.js';
import { containsSentinel } from '../security/sentinel.js';
import type {
    EmptySessionAnalysis,
    ParsedToolCall,
    ParsedTurn,
    ParseTurnsOptions,
    SessionAdapter,
    SessionClassification,
    ToolName,
} from '../types/index.js';

const NEWLINE = 0x0a;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;
const DISCRIMINATOR_DIGEST_HEX_CHARS = 8;
const DISCRIMINATOR_DIGEST_SEPARATOR = '…#';
const UNSAFE_DISCRIMINATOR_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu;

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
            const chunk = Buffer.alloc(Math.min(TRANSCRIPT_READ_CHUNK_BYTES, bytesUntilOversized));
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

function normalizeTimestamp(ts: string): string {
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

// The byte cursor alone cannot tell "nothing new yet" from "this file got
// rewritten out from under me" - a rewrite at the same or larger size lands
// the cursor mid-record with no signal. Fingerprinting a small trailing
// window ending at the cursor, and re-checking that exact window (not the
// whole file) on the next scan, catches a rewrite at a cost that doesn't
// scale with file size.
async function fingerprintWindow(handle: FileHandle, endOffset: number): Promise<string> {
    const start = Math.max(0, endOffset - FINGERPRINT_WINDOW_BYTES);
    const len = endOffset - start;
    if (len <= 0) {
        return '';
    }
    const chunk = Buffer.alloc(len);
    await handle.read(chunk, 0, len, start);
    // Not a security boundary - just a reliability check, so a short digest
    // (collision risk irrelevant at this scale) keeps the cursor string small.
    return createHash('sha256').update(chunk).digest('hex').slice(0, 16);
}

export interface TurnBuilderState {
    userMessageParts: string[];
    assistantTextParts: string[];
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
}

function freshState(): TurnBuilderState {
    return {
        userMessageParts: [],
        assistantTextParts: [],
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
    };
}

function isEmptyTurn(state: TurnBuilderState): boolean {
    return (
        state.userMessageParts.every((s) => s.trim() === '') &&
        state.assistantTextParts.every((s) => s.trim() === '') &&
        state.toolCalls.length === 0
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
    abstract readonly tool: ToolName;
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

    // Updates transient assembly bookkeeping without making a skipped plumbing line part of the turn payload.
    protected observeToolCallState(_state: TurnBuilderState, _line: unknown): void {}

    // Folds a 'boundary' or 'content' line's data into the in-progress turn.
    protected abstract fold(state: TurnBuilderState, line: unknown): void;

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

        // Strictly less than, not <=. size === startOffset is the normal
        // steady-state case (nothing new since the last scan) and must stay
        // silent; only a real shrink - the file got rotated or truncated out
        // from under the cursor - is a bug. Deduped per file: every debounced
        // rescan of a frozen session would otherwise re-alert identically
        // forever.
        if (fileStat.size < startOffset) {
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
        try {
            // Before trusting startOffset, re-verify the bytes immediately
            // preceding it still match what was fingerprinted when the cursor
            // was set. A rewrite that grows the file (rotation, compaction)
            // passes the size check above but lands the cursor mid-record -
            // this catches it at the cost of one small re-read, not O(file size).
            if (expectedFingerprint !== undefined) {
                const actualFingerprint = await fingerprintWindow(handle, startOffset);
                if (actualFingerprint !== expectedFingerprint) {
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
            let currentCwd: string | undefined;
            let currentSurface: string | undefined;
            let currentBranch: string | undefined;
            // Latches true on a resume-marker line, consumed (and reset) by the
            // next turn boundary - it describes what immediately preceded THAT
            // turn, not a running session-wide state like currentBranch.
            let pendingResumeMarker = false;
            let currentTurn: TurnBuilderState | null = null;
            let nextTurnIndex = startTurnIndex;
            let pendingChunks: Buffer[] = [];
            let pendingBytes = 0;
            let pendingOffset = startOffset;
            let readOffset = startOffset;
            let lastCompleteLineEnd: number | undefined;
            let malformedCompleteRecords = 0;

            const parsedTurn = async (state: TurnBuilderState, endOffset: number): Promise<ParsedTurn> => {
                const turnIndex = nextTurnIndex++;
                return {
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
                    toolCalls: state.toolCalls,
                    cursor: formatCursor(endOffset, turnIndex + 1, await fingerprintWindow(handle, endOffset)),
                    surface: state.surface,
                    gitBranch: state.gitBranch,
                    hasExternalContent: state.hasExternalContent,
                    resumeMarkerBefore: state.resumeMarkerBefore,
                };
            };

            while (readOffset < fileStat.size) {
                if (options?.signal?.aborted) {
                    return;
                }
                const chunk = Buffer.alloc(Math.min(TRANSCRIPT_READ_CHUNK_BYTES, fileStat.size - readOffset));
                const { bytesRead } = await handle.read(chunk, 0, chunk.length, readOffset);
                if (bytesRead === 0) {
                    break;
                }
                const chunkOffset = readOffset;
                readOffset += bytesRead;
                const data = chunk.subarray(0, bytesRead);

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
                    if (currentTurn) {
                        this.observeToolCallState(currentTurn, parsed);
                    }

                    const cls = this.classify(parsed, filePath);
                    if (cls === 'skip') {
                        continue;
                    }

                    if (cls === 'boundary') {
                        const closed = currentTurn;
                        currentTurn = freshState();
                        currentTurn.resumeMarkerBefore = pendingResumeMarker;
                        pendingResumeMarker = false;
                        if (closed && !isEmptyTurn(closed)) {
                            const turn = await parsedTurn(closed, line.byteStart);
                            if (containsSentinel(turnText(turn))) {
                                this.warnUnknownLine(
                                    `[elepha] dropped turn ${turn.turnIndex} of ${sessionId}: self-injected content (sentinel)`,
                                );
                                yield { ...turn, droppedReason: 'sentinel' };
                            } else {
                                yield turn;
                            }
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
            }

            if (
                currentTurn &&
                lastCompleteLineEnd !== undefined &&
                options?.closeTrailingOnIdle &&
                hasAssistantContribution(currentTurn) &&
                currentTurn.openToolCallIds.size === 0
            ) {
                const turn = await parsedTurn(currentTurn, lastCompleteLineEnd);
                if (containsSentinel(turnText(turn))) {
                    this.warnUnknownLine(`[elepha] dropped turn ${turn.turnIndex} of ${sessionId}: self-injected content (sentinel)`);
                    yield { ...turn, droppedReason: 'sentinel' };
                } else {
                    yield turn;
                }
            }
        } finally {
            if (!suppliedHandle) {
                await handle.close();
            }
        }
    }
}
