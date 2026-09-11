import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DEEPSEEK_MAX_SESSION_GENERATION } from '../config/constants.js';
import { dshSessionsRoot, isWithin, samePath } from '../config/paths.js';
import { openProviderTranscript, validateOpenedProviderTranscriptIdentitySync } from '../security/provider-transcript.js';
import { containsSentinel } from '../security/sentinel.js';
import type { EmptySessionAnalysis, ParsedTurn, ParseTurnsOptions, SessionAdapter, SessionClassification } from '../types/index.js';
import { malformedCompleteRecordsDiagnostic, readBoundedLines, safeDiscriminator } from './base.js';
import {
    type DeepSeekEncoding,
    deepSeekHeaderHash,
    hasZstdMagic,
    readDeepSeekZstdHeaderLine,
    readDeepSeekZstdLines,
} from './deepseek-zstd.js';

const CANONICAL_SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;
const KNOWN_NON_CONVERSATIONAL = new Set([
    'permission/preset',
    'sandbox/mode',
    'approval/policy',
    'agent/inbox/spliced',
    'step/start',
    'step/end',
    'system/message',
    'request/header',
    'request/footer',
    'response/usage',
    'assistant/attempt',
    'assistant/message.stream',
    'session/end',
    'request/context',
    'session/title-llm-request',
    'model/selection',
    'deliverables/presented',
    'hook/invoked',
    'hook/result',
    'tool/call',
    'tool/result',
]);
const KNOWN_IGNORED_BLOCKS = new Set(['reasoning', 'tool', 'tool_call', 'tool_result', 'tool-call', 'tool-result', 'file', 'image']);

interface GenerationFile {
    filePath: string;
    generation: number;
    encoding: DeepSeekEncoding;
}

interface DeepSeekHeader {
    id: string;
    cwd: string;
    version: number;
    timestamp: string;
    isSeeded: boolean;
    line: string;
}

interface DeepSeekCursor {
    sessionId: string;
    generation: number;
    encoding: DeepSeekEncoding;
    headerHash: string;
    lastTurnEndSeq: number;
    resumeFrameStart: number;
    lastTurnHash: string;
}

// DeepSeek Harness (session.v3) nests every event's payload under `data`, while
// `type`, `seq`, `time`, and `surfaceOp` stay at the top level. A `user/message`
// carries its text and author under `data` directly; an `assistant/message` wraps
// them one level deeper under `data.message`; `session/title` carries its title
// and author under `data`. Read from these paths, never the top level.
interface DeepSeekMessageBody {
    source?: { kind?: unknown };
    content?: unknown;
}

interface DeepSeekRecord {
    type?: unknown;
    seq?: unknown;
    time?: unknown;
    surfaceOp?: unknown;
    required?: unknown;
    data?: {
        title?: unknown;
        inherited?: unknown;
        source?: { kind?: unknown };
        content?: unknown;
        message?: DeepSeekMessageBody;
    };
}

interface RecordLine {
    text: string;
    resumeOffset: number;
}

interface TurnState {
    startedAt: string;
    resumeOffset: number;
    userParts: string[];
    assistantParts: string[];
    sentinel: boolean;
}

function generationFile(filePath: string): GenerationFile | undefined {
    const match = CANONICAL_SESSION_FILE.exec(path.basename(filePath));
    if (!match) {
        return undefined;
    }
    const generation = match[1] === undefined ? 0 : Number(match[1]);
    if (!Number.isSafeInteger(generation)) {
        return undefined;
    }
    return { filePath, generation, encoding: match[2] ? 'zstd' : 'raw' };
}

function isStructuralSessionPath(filePath: string): boolean {
    const relative = path.relative(dshSessionsRoot(), filePath);
    const parts = relative.split(path.sep);
    return (
        isWithin(dshSessionsRoot(), filePath) &&
        parts.length === 3 &&
        parts[1]?.startsWith('session-') === true &&
        generationFile(filePath) !== undefined
    );
}

function generationFiles(sessionDir: string): GenerationFile[] {
    return readdirSync(sessionDir, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isFile() && !entry.isSymbolicLink()) {
            return [];
        }
        const candidate = generationFile(path.join(sessionDir, entry.name));
        return candidate ? [candidate] : [];
    });
}

export function deepSeekEventSource(filePath: string): string | undefined {
    if (!isStructuralSessionPath(filePath)) {
        return undefined;
    }
    let files: GenerationFile[];
    try {
        files = generationFiles(path.dirname(filePath));
    } catch {
        return undefined;
    }
    const highest = files.reduce<GenerationFile | undefined>((current, candidate) => {
        if (!current || candidate.generation > current.generation) {
            return candidate;
        }
        if (candidate.generation === current.generation && candidate.filePath.localeCompare(current.filePath) < 0) {
            return candidate;
        }
        return current;
    }, undefined);
    return highest?.filePath;
}

function selectGeneration(filePath: string): GenerationFile {
    const files = generationFiles(path.dirname(filePath));
    if (files.length === 0) {
        throw new Error(`DeepSeek session has no canonical generation: ${path.dirname(filePath)}`);
    }
    const encodings = new Set(files.map((file) => file.encoding));
    if (encodings.size !== 1) {
        throw new Error(`DeepSeek session contains mixed raw and Zstandard encodings: ${path.dirname(filePath)}`);
    }
    const byGeneration = new Map<number, GenerationFile>();
    for (const file of files) {
        if (byGeneration.has(file.generation)) {
            throw new Error(`DeepSeek session contains duplicate generation ${file.generation}: ${path.dirname(filePath)}`);
        }
        byGeneration.set(file.generation, file);
    }
    const selected = files.reduce((current, candidate) => (candidate.generation > current.generation ? candidate : current));
    if (selected.generation > DEEPSEEK_MAX_SESSION_GENERATION) {
        throw new Error(
            `DeepSeek session generation ${selected.generation} is newer than supported generation ${DEEPSEEK_MAX_SESSION_GENERATION}: ${selected.filePath}`,
        );
    }
    if (!samePath(selected.filePath, filePath)) {
        throw new Error(`DeepSeek capture selected generation ${selected.generation} instead of ${path.basename(filePath)}`);
    }
    return selected;
}

function parseTimestamp(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') {
        return undefined;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function sessionIdFor(filePath: string): string {
    return path.basename(path.dirname(filePath));
}

function parseHeader(line: string, filePath: string, generation: number): DeepSeekHeader {
    let value: DeepSeekRecord & { id?: unknown; cwd?: unknown; version?: unknown; isSeeded?: unknown };
    try {
        value = JSON.parse(line);
    } catch {
        throw new Error(`DeepSeek session header is malformed JSON: ${filePath}`);
    }
    const expectedId = sessionIdFor(filePath);
    if (value.type !== 'session' || value.id !== expectedId || value.version !== generation) {
        throw new Error(`DeepSeek session header identity/version does not match ${path.basename(filePath)}`);
    }
    if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) {
        throw new Error(`DeepSeek session cwd is missing or not absolute: ${filePath}`);
    }
    return {
        id: expectedId,
        cwd: value.cwd,
        version: generation,
        timestamp: parseTimestamp(value.time) ?? '',
        isSeeded: value.isSeeded === true,
        line,
    };
}

async function rawHeaderLine(filePath: string, handle: FileHandle): Promise<string | undefined> {
    for await (const line of readBoundedLines(filePath, { handle })) {
        if (!line.terminated) {
            return undefined;
        }
        return line.text;
    }
    return undefined;
}

async function readHeader(file: GenerationFile, handle: FileHandle): Promise<DeepSeekHeader> {
    const compressed = await hasZstdMagic(handle);
    if (file.encoding === 'zstd' && !compressed) {
        throw new Error(`DeepSeek .jsonl.zstd generation does not start with Zstandard magic: ${file.filePath}`);
    }
    if (file.encoding === 'raw' && compressed) {
        throw new Error(`DeepSeek raw .jsonl generation contains Zstandard data: ${file.filePath}`);
    }
    const line = file.encoding === 'zstd' ? await readDeepSeekZstdHeaderLine(handle) : await rawHeaderLine(file.filePath, handle);
    if (line === undefined) {
        throw new Error(`DeepSeek session header is incomplete: ${file.filePath}`);
    }
    return parseHeader(line, file.filePath, file.generation);
}

async function* rawRecordLines(filePath: string, handle: FileHandle, start = 0): AsyncIterable<RecordLine> {
    let offset = start;
    for await (const line of readBoundedLines(filePath, { handle, start })) {
        if (!line.terminated) {
            return;
        }
        yield { text: line.text, resumeOffset: offset };
        offset += line.byteLength;
    }
}

function recordLines(file: GenerationFile, handle: FileHandle, start = 0): AsyncIterable<RecordLine> {
    return file.encoding === 'zstd' ? readDeepSeekZstdLines(handle, start) : rawRecordLines(file.filePath, handle, start);
}

function parseCursor(value: string | undefined): DeepSeekCursor | undefined {
    if (!value) {
        return undefined;
    }
    let cursor: Partial<DeepSeekCursor>;
    try {
        cursor = JSON.parse(value);
    } catch {
        throw new Error('DeepSeek cursor is malformed');
    }
    if (
        typeof cursor.sessionId !== 'string' ||
        !Number.isSafeInteger(cursor.generation) ||
        (cursor.generation ?? -1) < 0 ||
        (cursor.encoding !== 'raw' && cursor.encoding !== 'zstd') ||
        typeof cursor.headerHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(cursor.headerHash) ||
        !Number.isSafeInteger(cursor.lastTurnEndSeq) ||
        (cursor.lastTurnEndSeq ?? -1) < 0 ||
        !Number.isSafeInteger(cursor.resumeFrameStart) ||
        (cursor.resumeFrameStart ?? -1) < 0 ||
        typeof cursor.lastTurnHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(cursor.lastTurnHash)
    ) {
        throw new Error('DeepSeek cursor is malformed');
    }
    return cursor as DeepSeekCursor;
}

function textBlocks(value: unknown, warn: (message: string) => void, filePath: string): string | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const output: string[] = [];
    for (const block of value) {
        if (block && typeof block === 'object') {
            const typed = block as { type?: unknown; text?: unknown };
            if (typed.type === 'text' && typeof typed.text === 'string') {
                output.push(typed.text);
                continue;
            }
            if (KNOWN_IGNORED_BLOCKS.has(String(typed.type))) {
                continue;
            }
            warn(`[elepha] unknown DeepSeek message block ${safeDiscriminator(typed.type)}: ${filePath}`);
            continue;
        }
        warn(`[elepha] unknown DeepSeek message block ${safeDiscriminator(block)}: ${filePath}`);
    }
    return output.join('');
}

function turnHash(turn: Pick<ParsedTurn, 'startedAt' | 'endedAt' | 'userMessage' | 'assistantText' | 'droppedReason'>): string {
    return createHash('sha256')
        .update(JSON.stringify([turn.startedAt, turn.endedAt, turn.userMessage, turn.assistantText, turn.droppedReason]))
        .digest('hex');
}

function seqOf(record: DeepSeekRecord): number | undefined {
    return typeof record.seq === 'number' && Number.isSafeInteger(record.seq) && record.seq >= 0 ? record.seq : undefined;
}

function assertUniqueSessionDirectory(sessionId: string): void {
    const root = dshSessionsRoot();
    if (!existsSync(root)) {
        return;
    }
    const locations = readdirSync(root, { withFileTypes: true }).filter((entry) => {
        try {
            return statSync(path.join(root, entry.name, sessionId)).isDirectory();
        } catch {
            return false;
        }
    });
    if (locations.length > 1) {
        throw new Error(`DeepSeek session id ${sessionId} appears in ${locations.length} project directories`);
    }
}

async function lastSeedBoundary(file: GenerationFile, handle: FileHandle): Promise<number | undefined> {
    let last: number | undefined;
    for await (const line of recordLines(file, handle)) {
        let record: DeepSeekRecord;
        try {
            record = JSON.parse(line.text);
        } catch {
            continue;
        }
        if (record.type === 'session/end-seed' && record.data?.inherited === true) {
            const seq = seqOf(record);
            if (seq === undefined) {
                throw new Error(`DeepSeek inherited end-seed boundary has no valid sequence: ${file.filePath}`);
            }
            last = seq;
        }
    }
    return last;
}

export async function readDeepSeekSessionHeader(
    filePath: string,
    suppliedHandle?: FileHandle,
): Promise<{ cwd: string; timestamp: string } | undefined> {
    const file = selectGeneration(filePath);
    const opened = suppliedHandle ? undefined : await openProviderTranscript('deepseek', file.filePath);
    if (opened && 'reason' in opened) {
        throw new Error(`Cannot open DeepSeek session: ${file.filePath} (${opened.reason})`);
    }
    const handle = suppliedHandle ?? opened?.handle;
    if (!handle) {
        return undefined;
    }
    try {
        const header = await readHeader(file, handle);
        assertUniqueSessionDirectory(header.id);
        return { cwd: header.cwd, timestamp: header.timestamp };
    } finally {
        if (!suppliedHandle) {
            await handle.close();
        }
    }
}

export class DeepSeekHarnessAdapter implements SessionAdapter {
    readonly tool = 'deepseek' as const;
    readonly watchGlobs = ['*/*/session.jsonl', '*/*/session.v*.jsonl', '*/*/session.v*.jsonl.zstd'];

    constructor(private readonly warn: (message: string) => void = console.warn) {}

    matches(filePath: string): boolean {
        const source = deepSeekEventSource(filePath);
        return source !== undefined && samePath(source, filePath);
    }

    eventSourcePath(filePath: string): string | undefined {
        return deepSeekEventSource(filePath);
    }

    nativeSessionId(filePath: string): string {
        return sessionIdFor(filePath);
    }

    async classifySession(filePath: string, options?: Pick<ParseTurnsOptions, 'handle'>): Promise<SessionClassification> {
        const file = selectGeneration(filePath);
        const opened = options?.handle ? undefined : await openProviderTranscript(this.tool, file.filePath);
        if (opened && 'reason' in opened) {
            throw new Error(`Cannot open DeepSeek session: ${file.filePath} (${opened.reason})`);
        }
        const handle = options?.handle ?? opened?.handle;
        if (!handle) {
            throw new Error(`Cannot open DeepSeek session: ${file.filePath}`);
        }
        try {
            const header = await readHeader(file, handle);
            assertUniqueSessionDirectory(header.id);
            return { kind: 'primary' };
        } finally {
            if (!options?.handle) {
                await handle.close();
            }
        }
    }

    async classifyEmptySession(): Promise<EmptySessionAnalysis> {
        return { kind: 'no assistant contribution' };
    }

    async readSourceMetadata(filePath: string): Promise<
        | {
              cwd: string;
              timestamp: string;
              title?: string;
              customTitle?: string;
              titleKind?: 'ai' | 'custom';
              validate: () => boolean;
          }
        | undefined
    > {
        const file = selectGeneration(filePath);
        const opened = await openProviderTranscript(this.tool, file.filePath);
        if ('reason' in opened) {
            throw new Error(`Cannot open DeepSeek session metadata: ${file.filePath} (${opened.reason})`);
        }
        try {
            const header = await readHeader(file, opened.handle);
            assertUniqueSessionDirectory(header.id);
            let title: string | undefined;
            let customTitle: string | undefined;
            let titleKind: 'ai' | 'custom' | undefined;
            let malformed = 0;
            for await (const line of recordLines(file, opened.handle)) {
                let record: DeepSeekRecord;
                try {
                    record = JSON.parse(line.text);
                } catch {
                    malformed++;
                    continue;
                }
                if (record.type !== 'session/title') {
                    continue;
                }
                const titleText = record.data?.title;
                const titleSource = record.data?.source?.kind;
                if (typeof titleText !== 'string' || typeof titleSource !== 'string') {
                    malformed++;
                    continue;
                }
                if (titleSource === 'user') {
                    customTitle = titleText;
                    title = undefined;
                    titleKind = 'custom';
                } else {
                    title = titleText;
                    customTitle = undefined;
                    titleKind = 'ai';
                }
            }
            if (malformed > 0) {
                this.warn(malformedCompleteRecordsDiagnostic(file.filePath, malformed));
                throw new Error(`DeepSeek metadata withheld after ${malformed} malformed records: ${file.filePath}`);
            }
            const validate = () => {
                if ('reason' in validateOpenedProviderTranscriptIdentitySync(this.tool, file.filePath, opened)) {
                    return false;
                }
                const current = statSync(file.filePath);
                return current.size === opened.stat.size && current.mtimeMs === opened.stat.mtimeMs;
            };
            if (!validate()) {
                throw new Error(`DeepSeek session changed while reading metadata: ${file.filePath}`);
            }
            return { cwd: header.cwd, timestamp: header.timestamp, title, customTitle, titleKind, validate };
        } finally {
            await opened.handle.close();
        }
    }

    async *parseTurns(filePath: string, sinceCursor?: string, options: ParseTurnsOptions = {}): AsyncIterable<ParsedTurn> {
        const file = selectGeneration(filePath);
        const opened = options.handle ? undefined : await openProviderTranscript(this.tool, file.filePath);
        if (opened && 'reason' in opened) {
            throw new Error(`Cannot open DeepSeek session: ${file.filePath} (${opened.reason})`);
        }
        const handle = options.handle ?? opened?.handle;
        if (!handle) {
            return;
        }
        try {
            const header = await readHeader(file, handle);
            assertUniqueSessionDirectory(header.id);
            const headerHash = deepSeekHeaderHash(header.line);
            const prior = parseCursor(sinceCursor);
            if (prior && prior.sessionId !== header.id) {
                throw new Error(`DeepSeek cursor session id does not match ${header.id}`);
            }
            if (prior && prior.generation > file.generation) {
                throw new Error(`DeepSeek session generation regressed from ${prior.generation} to ${file.generation}`);
            }
            if (prior && prior.encoding !== file.encoding) {
                throw new Error(`DeepSeek session encoding changed from ${prior.encoding} to ${file.encoding}`);
            }
            if (prior && prior.generation === file.generation && prior.headerHash !== headerHash) {
                throw new Error(`DeepSeek session header changed within generation ${file.generation}`);
            }

            const inheritedEndSeq = header.isSeeded && !prior ? await lastSeedBoundary(file, handle) : undefined;
            if (header.isSeeded && !prior && inheritedEndSeq === undefined) {
                throw new Error(`DeepSeek seeded session has no inherited end-seed boundary: ${file.filePath}`);
            }
            let inherited = inheritedEndSeq !== undefined;
            let waitingForPrior = prior !== undefined;
            const start = prior && prior.generation === file.generation ? prior.resumeFrameStart : 0;
            let turn: TurnState | undefined;
            let malformed = 0;
            const seen = new Map<number, string>();
            let lastCompletedSeq = -1;
            let sawHeaderRecord = start > 0;

            for await (const line of recordLines(file, handle, start)) {
                if (options.signal?.aborted) {
                    return;
                }
                if (turn && containsSentinel(line.text)) {
                    turn.sentinel = true;
                }
                let record: DeepSeekRecord;
                try {
                    record = JSON.parse(line.text);
                } catch {
                    malformed++;
                    continue;
                }
                if (!record || typeof record !== 'object' || typeof record.type !== 'string') {
                    malformed++;
                    continue;
                }
                if (record.type === 'session') {
                    if (sawHeaderRecord || line.resumeOffset !== 0) {
                        malformed++;
                    }
                    sawHeaderRecord = true;
                    continue;
                }
                if (inherited) {
                    if (record.type === 'session/end-seed' && record.data?.inherited === true && seqOf(record) === inheritedEndSeq) {
                        inherited = false;
                    }
                    continue;
                }
                if (record.type === 'turn/start') {
                    if (turn) {
                        throw new Error(`DeepSeek turn/start arrived before the open turn ended: ${file.filePath}`);
                    }
                    const startedAt = parseTimestamp(record.time);
                    if (!startedAt) {
                        malformed++;
                        continue;
                    }
                    turn = {
                        startedAt,
                        resumeOffset: line.resumeOffset,
                        userParts: [],
                        assistantParts: [],
                        sentinel: containsSentinel(line.text),
                    };
                    continue;
                }
                if (record.type === 'user/message' || record.type === 'assistant/message') {
                    if (record.surfaceOp === 'replace') {
                        continue;
                    }
                    if (!turn || record.surfaceOp !== 'append') {
                        malformed++;
                        continue;
                    }
                    // user/message keeps content and author directly under data;
                    // assistant/message wraps them under data.message.
                    const body: DeepSeekMessageBody | undefined = record.type === 'user/message' ? record.data : record.data?.message;
                    if (record.type === 'user/message' && body?.source?.kind !== 'user') {
                        continue;
                    }
                    const text = textBlocks(body?.content, this.warn, file.filePath);
                    if (text === undefined) {
                        malformed++;
                        continue;
                    }
                    if (record.type === 'user/message') {
                        turn.userParts.push(text);
                    } else {
                        turn.assistantParts.push(text);
                    }
                    continue;
                }
                if (record.type === 'turn/end') {
                    if (!turn) {
                        malformed++;
                        continue;
                    }
                    const endedAt = parseTimestamp(record.time);
                    const endSeq = seqOf(record);
                    if (!endedAt || endSeq === undefined) {
                        malformed++;
                        turn = undefined;
                        continue;
                    }
                    const userMessage = turn.userParts.join('\n');
                    const assistantText = turn.assistantParts.join('\n');
                    const droppedReason = turn.sentinel ? 'sentinel' : !assistantText.trim() ? 'empty' : undefined;
                    const parsed: ParsedTurn = {
                        tool: this.tool,
                        sessionId: header.id,
                        sourcePath: file.filePath,
                        projectPath: header.cwd,
                        turnIndex: endSeq,
                        startedAt: turn.startedAt,
                        endedAt,
                        userMessage,
                        assistantText,
                        toolCalls: [],
                        surface: 'cli',
                        hasExternalContent: false,
                        resumeMarkerBefore: false,
                        sourceKey: `${header.id}:${endSeq}`,
                        droppedReason,
                        cursor: '',
                    };
                    const hash = turnHash(parsed);
                    const previousHash = seen.get(endSeq);
                    if (previousHash !== undefined && previousHash !== hash) {
                        throw new Error(`DeepSeek turn/end sequence ${endSeq} identifies different turn content`);
                    }
                    if (previousHash === undefined && endSeq <= lastCompletedSeq) {
                        throw new Error(`DeepSeek turn/end sequence ${endSeq} is not strictly increasing`);
                    }
                    seen.set(endSeq, hash);
                    lastCompletedSeq = Math.max(lastCompletedSeq, endSeq);
                    const cursor: DeepSeekCursor = {
                        sessionId: header.id,
                        generation: file.generation,
                        encoding: file.encoding,
                        headerHash,
                        lastTurnEndSeq: endSeq,
                        resumeFrameStart: turn.resumeOffset,
                        lastTurnHash: hash,
                    };
                    parsed.cursor = JSON.stringify(cursor);
                    turn = undefined;

                    if (waitingForPrior) {
                        if (endSeq === prior?.lastTurnEndSeq) {
                            if (prior.lastTurnHash !== hash) {
                                throw new Error(`DeepSeek stored turn/end sequence ${endSeq} no longer identifies the same content`);
                            }
                            waitingForPrior = false;
                        }
                        continue;
                    }
                    if (previousHash === undefined) {
                        yield parsed;
                    }
                    continue;
                }
                if (record.type === 'session/end-seed' || record.type === 'session/title') {
                    continue;
                }
                if (!KNOWN_NON_CONVERSATIONAL.has(record.type)) {
                    if (record.required === true) {
                        throw new Error(`Unsupported required DeepSeek event ${safeDiscriminator(record.type)}: ${file.filePath}`);
                    }
                    this.warn(`[elepha] unknown DeepSeek record ${safeDiscriminator(record.type)}: ${file.filePath}`);
                }
            }
            if (waitingForPrior) {
                throw new Error(`DeepSeek stored turn/end sequence ${prior?.lastTurnEndSeq} is no longer present`);
            }
            if (malformed > 0) {
                this.warn(malformedCompleteRecordsDiagnostic(file.filePath, malformed));
                throw new Error(`DeepSeek capture withheld after ${malformed} malformed records: ${file.filePath}`);
            }
        } finally {
            if (!options.handle) {
                await handle.close();
            }
        }
    }
}
