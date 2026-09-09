import { realpathSync } from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import { isWithinProviderStore } from '../config/paths.js';
import { turnText } from '../security/self-ingestion.js';
import { containsSentinel } from '../security/sentinel.js';
import type {
    OpenedSessionRow,
    ParsedToolCall,
    ParsedTurn,
    ParseTurnsOptions,
    SessionClassification,
    SqliteSourceAdapter,
} from '../types/index.js';
import { resolveAbsolute, safeDiscriminator } from './base.js';

interface SessionRow {
    id: unknown;
    directory: unknown;
    title: unknown;
    version: unknown;
    parent_id: unknown;
    time_updated: unknown;
}

interface MessageRow {
    id: unknown;
    time_created: unknown;
    data: unknown;
}

interface PartRow {
    message_id: unknown;
    data: unknown;
}

interface OpenCodeMessage {
    id: string;
    role: 'user' | 'assistant';
    timeCreated: number;
    timestamp: string;
}

interface OpenCodePart {
    type: 'text' | 'reasoning' | 'step-start' | 'step-finish' | 'tool';
    data: Record<string, unknown>;
}

interface OpenTurn {
    turnIndex: number;
    startedAt: string;
    endedAt: string;
    userMessageParts: string[];
    assistantTextParts: string[];
    toolCalls: ParsedToolCall[];
    hasExternalContent: boolean;
    lastMessage: Pick<OpenCodeMessage, 'id' | 'timeCreated'>;
}

const FILE_PATH_INPUT_KEYS = ['filePath', 'file_path', 'path'] as const;
const EXTERNAL_FETCH_TOOLS = new Set(['webfetch', 'websearch', 'web_fetch', 'web_search', 'web-fetch', 'web-search']);
// OpenCode creates sessions with this placeholder, then replaces it asynchronously with an AI title.
const OPENCODE_PLACEHOLDER_TITLE_PATTERN = /^New session - \d{4}-\d{2}-\d{2}T/;

export function opencodeSessionAiTitle(title: string | undefined): string | undefined {
    return title === undefined || OPENCODE_PLACEHOLDER_TITLE_PATTERN.test(title) ? undefined : title;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function isoTimestamp(value: unknown, fallback: number): string {
    const candidate = typeof value === 'number' || typeof value === 'string' ? new Date(value) : new Date(fallback);
    return Number.isNaN(candidate.getTime()) ? new Date(0).toISOString() : candidate.toISOString();
}

function cursorParts(cursor: string | undefined): { timeCreated: number; id: string } | undefined {
    if (cursor === undefined) {
        return undefined;
    }
    const separator = cursor.indexOf('|');
    const timeCreated = Number(cursor.slice(0, separator));
    const id = cursor.slice(separator + 1);
    if (separator <= 0 || !Number.isSafeInteger(timeCreated) || timeCreated < 0 || id.length === 0) {
        throw new Error('Invalid OpenCode cursor');
    }
    return { timeCreated, id };
}

function isAtOrBeforeCursor(message: Pick<OpenCodeMessage, 'id' | 'timeCreated'>, cursor: { timeCreated: number; id: string }): boolean {
    return message.timeCreated < cursor.timeCreated || (message.timeCreated === cursor.timeCreated && message.id <= cursor.id);
}

function toolInput(data: Record<string, unknown>): Record<string, unknown> | undefined {
    const state = isRecord(data.state) ? data.state : undefined;
    return state && isRecord(state.input) ? state.input : undefined;
}

function toolInputText(input: Record<string, unknown> | undefined): string | undefined {
    if (!input) {
        return undefined;
    }
    if (typeof input.command === 'string') {
        return input.command;
    }
    return JSON.stringify(input);
}

function toolFilePaths(input: Record<string, unknown> | undefined, directory: string): string[] {
    if (!input) {
        return [];
    }
    const paths = new Set<string>();
    for (const key of FILE_PATH_INPUT_KEYS) {
        const value = input[key];
        if (typeof value === 'string' && value.length > 0) {
            paths.add(resolveAbsolute(value, directory));
        }
    }
    return [...paths];
}

function parsedTurn(dbPath: string, session: OpenedSessionRow, turn: OpenTurn): ParsedTurn {
    return {
        tool: 'opencode',
        sessionId: session.sessionId,
        sourcePath: dbPath,
        projectPath: session.directory,
        turnIndex: turn.turnIndex,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        userMessage: turn.userMessageParts.join('\n').trim(),
        assistantText: turn.assistantTextParts.join('\n').trim(),
        aiTitle: opencodeSessionAiTitle(session.title),
        toolCalls: turn.toolCalls,
        surface: undefined,
        gitBranch: undefined,
        hasExternalContent: turn.hasExternalContent,
        resumeMarkerBefore: false,
        cursor: `${turn.lastMessage.timeCreated}|${turn.lastMessage.id}`,
    };
}

function hasContent(turn: OpenTurn): boolean {
    return (
        turn.userMessageParts.some((text) => text.trim() !== '') ||
        turn.assistantTextParts.some((text) => text.trim() !== '') ||
        turn.toolCalls.length > 0
    );
}

function hasAssistantContribution(turn: OpenTurn): boolean {
    return turn.assistantTextParts.some((text) => text.trim() !== '');
}

export function openOpencodeDbReadonly(dbPath: string): Database.Database {
    let physicalPath: string;
    try {
        physicalPath = realpathSync(dbPath);
    } catch {
        throw new Error('Cannot open OpenCode database: path does not resolve to an existing file');
    }
    if (!isWithinProviderStore('opencode', physicalPath)) {
        throw new Error('Refusing to open OpenCode database outside the OpenCode data store');
    }
    return new Database(physicalPath, { readonly: true, fileMustExist: true });
}

export class OpencodeAdapter implements SqliteSourceAdapter {
    readonly tool = 'opencode' as const;

    constructor(private readonly warnUnknownLine: (message: string) => void = (message) => console.warn(message)) {}

    private withSentinelDrop(turn: ParsedTurn): ParsedTurn {
        if (!containsSentinel(turnText(turn))) {
            return turn;
        }
        this.warnUnknownLine(`[elepha] dropped turn ${turn.turnIndex} of ${turn.sessionId}: self-injected content (sentinel)`);
        return { ...turn, droppedReason: 'sentinel' };
    }

    dirtySessions(db: Database.Database, sinceWatermark?: number): OpenedSessionRow[] {
        const rows = (
            sinceWatermark === undefined
                ? db
                      .prepare(
                          'SELECT id, directory, title, version, parent_id, time_updated FROM session ORDER BY time_updated ASC, id ASC',
                      )
                      .all()
                : db
                      .prepare(
                          'SELECT id, directory, title, version, parent_id, time_updated FROM session WHERE time_updated > ? ORDER BY time_updated ASC, id ASC',
                      )
                      .all(sinceWatermark)
        ) as SessionRow[];

        const sessions: OpenedSessionRow[] = [];
        for (const row of rows) {
            if (
                typeof row.id !== 'string' ||
                typeof row.directory !== 'string' ||
                typeof row.time_updated !== 'number' ||
                !Number.isSafeInteger(row.time_updated)
            ) {
                this.warnUnknownLine('OpencodeAdapter: discarded malformed session row');
                continue;
            }
            sessions.push({
                sessionId: row.id,
                directory: row.directory,
                title: typeof row.title === 'string' ? row.title : undefined,
                version: typeof row.version === 'string' ? row.version : undefined,
                parentId: typeof row.parent_id === 'string' && row.parent_id.length > 0 ? row.parent_id : undefined,
                timeUpdated: row.time_updated,
            });
        }
        return sessions;
    }

    *parseSessionTurns(
        db: Database.Database,
        session: OpenedSessionRow,
        sinceCursor?: string,
        options?: Pick<ParseTurnsOptions, 'closeTrailingOnIdle'>,
    ): IterableIterator<ParsedTurn> {
        const resumeAfter = cursorParts(sinceCursor);
        const messageRows = db
            .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC')
            .all(session.sessionId) as MessageRow[];
        const partRows = db
            .prepare('SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC')
            .all(session.sessionId) as PartRow[];

        const partsByMessage = new Map<string, OpenCodePart[]>();
        for (const row of partRows) {
            if (typeof row.message_id !== 'string') {
                this.warnUnknownLine('OpencodeAdapter: discarded part with malformed message_id');
                continue;
            }
            const data = parseJsonRecord(row.data);
            if (!data) {
                this.warnUnknownLine(`OpencodeAdapter: discarded malformed part data in ${db.name}`);
                continue;
            }
            const type = data.type;
            if (type !== 'text' && type !== 'reasoning' && type !== 'step-start' && type !== 'step-finish' && type !== 'tool') {
                this.warnUnknownLine(`OpencodeAdapter: unrecognized part.data.type "${safeDiscriminator(type)}" in ${db.name}`);
                continue;
            }
            const parts = partsByMessage.get(row.message_id) ?? [];
            parts.push({ type, data });
            partsByMessage.set(row.message_id, parts);
        }

        const messages: OpenCodeMessage[] = [];
        for (const row of messageRows) {
            if (typeof row.id !== 'string' || typeof row.time_created !== 'number' || !Number.isSafeInteger(row.time_created)) {
                this.warnUnknownLine('OpencodeAdapter: discarded malformed message row');
                continue;
            }
            const data = parseJsonRecord(row.data);
            if (!data) {
                this.warnUnknownLine(`OpencodeAdapter: discarded malformed message data in ${db.name}`);
                continue;
            }
            if (data.role !== 'user' && data.role !== 'assistant') {
                this.warnUnknownLine(`OpencodeAdapter: unrecognized message.data.role "${safeDiscriminator(data.role)}" in ${db.name}`);
                continue;
            }
            const time = isRecord(data.time) ? data.time : undefined;
            const createdAt = isoTimestamp(time?.created, row.time_created);
            const completed = time?.completed;
            // Injection fires mid-generation, after message creation; quote-back needs the assistant's completion time.
            const timestamp =
                data.role === 'assistant' &&
                typeof completed === 'number' &&
                Number.isFinite(completed) &&
                completed >= Date.parse(createdAt) &&
                !Number.isNaN(new Date(completed).getTime())
                    ? new Date(completed).toISOString()
                    : createdAt;
            messages.push({
                id: row.id,
                role: data.role,
                timeCreated: row.time_created,
                timestamp,
            });
        }

        let turnIndex = resumeAfter
            ? messages.filter((message) => message.role === 'user' && isAtOrBeforeCursor(message, resumeAfter)).length
            : 0;
        let openTurn: OpenTurn | undefined;
        for (const message of messages) {
            if (resumeAfter && isAtOrBeforeCursor(message, resumeAfter)) {
                continue;
            }

            if (message.role === 'user') {
                if (openTurn) {
                    if (hasContent(openTurn)) {
                        yield this.withSentinelDrop(parsedTurn(db.name, session, openTurn));
                    }
                    turnIndex++;
                }
                openTurn = {
                    turnIndex,
                    startedAt: message.timestamp,
                    endedAt: message.timestamp,
                    userMessageParts: [],
                    assistantTextParts: [],
                    toolCalls: [],
                    hasExternalContent: false,
                    lastMessage: message,
                };
            }
            if (!openTurn) {
                continue;
            }

            openTurn.endedAt = message.timestamp;
            openTurn.lastMessage = message;
            for (const part of partsByMessage.get(message.id) ?? []) {
                if (part.type === 'text') {
                    if (typeof part.data.text !== 'string') {
                        this.warnUnknownLine(`OpencodeAdapter: discarded malformed text part in ${db.name}`);
                    } else if (message.role === 'user') {
                        openTurn.userMessageParts.push(part.data.text);
                    } else {
                        openTurn.assistantTextParts.push(part.data.text);
                    }
                    continue;
                }
                if (part.type === 'reasoning' || part.type === 'step-start' || part.type === 'step-finish') {
                    continue;
                }

                const name = typeof part.data.tool === 'string' ? part.data.tool : 'unknown';
                if (name === 'unknown') {
                    this.warnUnknownLine(`OpencodeAdapter: malformed tool name "${safeDiscriminator(part.data.tool)}" in ${db.name}`);
                }
                const input = toolInput(part.data);
                openTurn.toolCalls.push({
                    name,
                    filePaths: toolFilePaths(input, session.directory),
                    text: toolInputText(input),
                });
                if (EXTERNAL_FETCH_TOOLS.has(name.toLowerCase())) {
                    openTurn.hasExternalContent = true;
                }
            }
        }

        if (openTurn && options?.closeTrailingOnIdle && hasAssistantContribution(openTurn)) {
            yield this.withSentinelDrop(parsedTurn(db.name, session, openTurn));
        }
    }

    classifySession(session: OpenedSessionRow): SessionClassification {
        return session.parentId ? { kind: 'subagent', parentNativeId: session.parentId } : { kind: 'primary' };
    }
}
