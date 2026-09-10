import { type FileHandle, realpath } from 'node:fs/promises';
import path from 'node:path';
import { KIMI_MAX_MODEL_ALIASES, KIMI_OMITTED_TEXT, KIMI_TURN_TEXT_CHARS } from '../config/constants.js';
import { isWithin, kimiSessionDir, kimiSessionsRoot, kimiSessionWirePath } from '../config/paths.js';
import { openProviderTranscript } from '../security/provider-transcript.js';
import { containsSentinel } from '../security/sentinel.js';
import type { EmptySessionAnalysis, ParsedTurn, ParseTurnsOptions, SessionAdapter, SessionClassification } from '../types/index.js';
import { malformedCompleteRecordsDiagnostic, readBoundedLines, safeDiscriminator } from './base.js';
import { kimiTimestamp, readKimiMetadata } from './kimi-metadata.js';
import { checkpointMatches, type SourceCheckpoint, sourceCheckpoint } from './source-checkpoint.js';

const NON_CONVERSATIONAL = new Set([
    'config.update',
    'permission.set_mode',
    'plugin.session_start',
    'llm.request',
    'llm.tools_snapshot',
    'token_counting.turn_recorded',
    'token_counting.measured',
    'usage.record',
    'profile.bind',
    'runtime.set_binding',
    'metadata',
    'prompt.accepted',
    'turn.step.interrupted',
    'turn.step.retrying',
    'interaction.request',
    'interaction.resolved',
    'permission.record_approval_result',
]);
const LOOP_PLUMBING = new Set(['step.begin', 'step.end', 'tool.call', 'tool.result']);

function textParts(value: unknown): string {
    if (!Array.isArray(value)) {
        return '';
    }
    return value.flatMap((part) => (part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('');
}

interface KimiCursor {
    index: number;
    key: string;
    checkpoint: SourceCheckpoint;
    protocol: string;
    model?: string;
    cwd: string;
    forked: boolean;
}

function parseCursor(value: string | undefined): KimiCursor | undefined {
    if (!value) {
        return undefined;
    }
    try {
        const cursor = JSON.parse(value) as KimiCursor;
        return cursor?.checkpoint &&
            Number.isSafeInteger(cursor.index) &&
            cursor.index >= 0 &&
            typeof cursor.protocol === 'string' &&
            typeof cursor.key === 'string'
            ? cursor
            : undefined;
    } catch {
        return undefined;
    }
}

interface KimiRecord {
    type: string;
    agentId?: string;
    protocol_version?: unknown;
    modelAlias?: unknown;
    promptId?: unknown;
    input?: unknown;
    origin?: { kind?: unknown };
    time?: unknown;
    finishedAt?: unknown;
    turnId?: string | number;
    reason?: unknown;
    event?: { type: string; turnId?: string | number; part?: { type?: string; text?: unknown } };
}

interface TurnState {
    promptId: string;
    turnId?: string;
    user: string;
    answer: string;
    startedAt: string;
    endedAt?: string;
    failed: boolean;
    sentinel: boolean;
    omitted: boolean;
    models: string[];
}

// Like Codex rollout reduction, this consumes events, not duplicate context messages.
export class KimiCodeAdapter implements SessionAdapter {
    readonly tool = 'kimi' as const;
    readonly watchGlobs = ['*/*/agents/main/wire.jsonl'];
    readonly retractable = true;
    readonly readSourceMetadata = readKimiMetadata;

    constructor(private readonly warn: (message: string) => void = console.warn) {}

    matches(filePath: string): boolean {
        return (
            isWithin(kimiSessionsRoot(), filePath) &&
            path.relative(kimiSessionsRoot(), filePath).split(path.sep).length === 5 &&
            filePath.endsWith(path.join('agents', 'main', 'wire.jsonl'))
        );
    }

    eventSourcePath(filePath: string): string | undefined {
        if (path.basename(filePath) !== 'state.json') {
            return undefined;
        }
        const wire = kimiSessionWirePath(path.dirname(filePath));
        return this.matches(wire) ? wire : undefined;
    }

    nativeSessionId(filePath: string): string {
        return path.basename(kimiSessionDir(filePath));
    }

    async classifySession(filePath: string): Promise<SessionClassification> {
        if (!this.matches(await realpath(filePath))) {
            throw new Error(`Kimi capture excludes non-main agent sources: ${filePath}`);
        }
        return { kind: 'primary' };
    }

    async classifyEmptySession(): Promise<EmptySessionAnalysis> {
        return { kind: 'no assistant contribution' };
    }

    async needsReconciliation(filePath: string, sinceCursor: string | undefined, handle: FileHandle): Promise<boolean> {
        const cursor = parseCursor(sinceCursor);
        const metadata = await readKimiMetadata(filePath);
        return (
            !cursor ||
            !metadata ||
            cursor.cwd !== metadata.cwd ||
            cursor.forked !== metadata.forked ||
            !(await checkpointMatches(handle, cursor.checkpoint))
        );
    }

    async *parseTurns(filePath: string, sinceCursor?: string, options: ParseTurnsOptions = {}): AsyncIterable<ParsedTurn> {
        filePath = await realpath(filePath);
        if (!this.matches(filePath)) {
            throw new Error(`Kimi capture excludes non-main agent sources: ${filePath}`);
        }
        const metadata = await readKimiMetadata(filePath);
        if (!metadata) {
            throw new Error(`Kimi session cwd unavailable: ${filePath}`);
        }
        const opened = options.handle ? undefined : await openProviderTranscript('kimi', filePath);
        if (opened && 'reason' in opened) {
            throw new Error(`Cannot open Kimi wire: ${filePath} (${opened.reason})`);
        }
        const handle = options.handle ?? (opened && 'handle' in opened ? opened.handle : undefined);
        if (!handle) {
            return;
        }
        const prior = parseCursor(sinceCursor);
        const cursor =
            prior && prior.cwd === metadata.cwd && prior.forked === metadata.forked && (await checkpointMatches(handle, prior.checkpoint))
                ? prior
                : undefined;
        let turn: TurnState | undefined;
        let model: string | undefined = cursor?.model;
        let protocol = cursor?.protocol ?? 'unknown';
        let inherited = cursor ? false : metadata.forked;
        let nextIndex = cursor ? cursor.index + 1 : 0;
        let offset = cursor?.checkpoint.offset ?? 0;
        let malformed = 0;
        const finish = async (endOffset = offset): Promise<ParsedTurn | undefined> => {
            if (!turn?.endedAt) {
                return undefined;
            }
            const index = nextIndex++;
            const key = `${turn.promptId}:${turn.turnId ?? 'unknown'}`;
            return {
                tool: this.tool,
                sessionId: this.nativeSessionId(filePath),
                sourcePath: filePath,
                projectPath: metadata.cwd,
                turnIndex: index,
                startedAt: turn.startedAt,
                endedAt: turn.endedAt,
                userMessage: turn.failed ? '' : turn.user,
                assistantText: turn.failed ? '' : `${turn.omitted ? `${KIMI_OMITTED_TEXT}\n` : ''}${turn.answer}`,
                toolCalls: [],
                aiTitle: metadata.title,
                surface: 'cli',
                hasExternalContent: false,
                resumeMarkerBefore: false,
                sourceKey: key,
                // The ordinal and prompt identity are monotonic inside this verified file generation.
                // Replacement, shrink, or overlap mismatch triggers reconciliation before tailing.
                cursor: JSON.stringify({
                    index,
                    key,
                    checkpoint: await sourceCheckpoint(handle, endOffset),
                    protocol,
                    model,
                    cwd: metadata.cwd,
                    forked: metadata.forked,
                } satisfies KimiCursor),
                provenance: { protocolVersion: protocol, producerVersion: 'unknown', modelAliases: turn.models },
                droppedReason: turn.sentinel ? 'sentinel' : turn.failed || !turn.answer.trim() ? 'empty' : undefined,
            };
        };
        const addModel = () => {
            if (turn && model && !turn.models.includes(model)) {
                if (turn.models.length === KIMI_MAX_MODEL_ALIASES) {
                    turn.models.shift();
                    this.warn(`[elepha] dropped oldest Kimi model alias at retention limit: ${filePath}`);
                }
                turn.models.push(model);
            }
        };
        try {
            for await (const line of readBoundedLines(filePath, { handle, start: offset })) {
                if (options.signal?.aborted) {
                    return;
                }
                if (!line.terminated) {
                    break;
                }
                offset += line.byteLength;
                let record: KimiRecord;
                try {
                    record = JSON.parse(line.text);
                } catch {
                    malformed++;
                    continue;
                }
                if (!record || typeof record !== 'object') {
                    malformed++;
                    continue;
                }
                if (record.agentId !== undefined && record.agentId !== 'main') {
                    continue;
                }
                if (turn && containsSentinel(line.text)) {
                    turn.sentinel = true;
                }
                if (record.type === 'metadata' && typeof record.protocol_version === 'string') {
                    protocol = record.protocol_version;
                }
                if (['profile.bind', 'config.update', 'llm.request'].includes(record.type) && typeof record.modelAlias === 'string') {
                    model = record.modelAlias;
                    addModel();
                }
                if (record.type === 'forked') {
                    inherited = false;
                    turn = undefined;
                    continue;
                }
                if (inherited) {
                    continue;
                }
                if (record.type === 'turn.prompt') {
                    const previous = await finish(offset - line.byteLength);
                    if (previous) {
                        yield previous;
                    }
                    turn = undefined;
                    if (record.origin?.kind !== 'user') {
                        continue;
                    }
                    const startedAt = kimiTimestamp(record.time);
                    if (typeof record.promptId !== 'string' || !startedAt || !Array.isArray(record.input)) {
                        malformed++;
                        continue;
                    }
                    const user = textParts(record.input);
                    turn = {
                        promptId: record.promptId,
                        user: user.slice(-KIMI_TURN_TEXT_CHARS),
                        answer: '',
                        startedAt,
                        failed: false,
                        sentinel: containsSentinel(line.text),
                        omitted: user.length > KIMI_TURN_TEXT_CHARS,
                        models: [],
                    };
                    addModel();
                } else if (record.type === 'context.append_message') {
                    // Inspect the entire record before origin filtering: a brief in injection-origin
                    // context still poisons the whole turn; a stripped echo is checked by the store.
                    if (turn && containsSentinel(line.text)) {
                        turn.sentinel = true;
                    }
                } else if (record.type === 'context.append_loop_event') {
                    const event = record.event;
                    if (!event || typeof event !== 'object') {
                        malformed++;
                        continue;
                    }
                    if (turn && (typeof event.turnId === 'string' || typeof event.turnId === 'number')) {
                        turn.turnId ??= String(event.turnId);
                        if (turn.turnId !== String(event.turnId)) {
                            malformed++;
                            continue;
                        }
                    }
                    if (event.type === 'content.part') {
                        const part = event.part;
                        if (turn && containsSentinel(line.text)) {
                            turn.sentinel = true;
                        }
                        if (part?.type === 'text' && typeof part.text === 'string' && turn) {
                            const text = turn.answer + part.text;
                            turn.omitted ||= text.length > KIMI_TURN_TEXT_CHARS;
                            turn.answer = text.slice(-KIMI_TURN_TEXT_CHARS);
                        } else if (
                            part?.type !== 'think' &&
                            part?.type !== 'tool_call' &&
                            !(part?.type === 'text' && typeof part.text === 'string')
                        ) {
                            this.warn(`[elepha] unknown Kimi content part ${safeDiscriminator(part?.type)}: ${filePath}`);
                        }
                    } else if (!LOOP_PLUMBING.has(event.type)) {
                        this.warn(`[elepha] unknown Kimi loop event ${safeDiscriminator(event.type)}: ${filePath}`);
                    }
                } else if (record.type === 'turn.ended' && turn) {
                    if (record.turnId === undefined || (turn.turnId !== undefined && turn.turnId !== String(record.turnId))) {
                        malformed++;
                        continue;
                    }
                    turn.turnId = String(record.turnId);
                    turn.failed = record.reason === 'failed';
                    turn.endedAt = kimiTimestamp(record.time);
                } else if (record.type === 'prompt.completed' && turn) {
                    if (record.promptId !== turn.promptId) {
                        malformed++;
                        continue;
                    }
                    turn.failed ||= record.reason === 'failed';
                    turn.endedAt = kimiTimestamp(record.finishedAt) ?? kimiTimestamp(record.time) ?? turn.endedAt;
                    const completed = await finish();
                    if (completed) {
                        yield completed;
                    }
                    turn = undefined;
                } else if (!NON_CONVERSATIONAL.has(record.type) && record.type !== 'turn.ended' && record.type !== 'prompt.completed') {
                    this.warn(`[elepha] unknown Kimi record ${safeDiscriminator(record.type)}: ${filePath}`);
                }
            }
            const completed = await finish();
            if (completed) {
                yield completed;
            }
            if (inherited) {
                throw new Error(`Kimi fork has no forked boundary; inherited content withheld: ${filePath}`);
            }
            if (malformed > 0) {
                this.warn(malformedCompleteRecordsDiagnostic(filePath, malformed));
                // A corrupt reduction cannot prove a retraction. Wait for provider repair.
                throw new Error(`Kimi reconciliation withheld after ${malformed} malformed records: ${filePath}`);
            }
        } finally {
            if (!options.handle) {
                await handle.close();
            }
        }
    }
}
