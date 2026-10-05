import { realpathSync } from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import {
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    CURRENT_CHAT_OPENCODE_MAX_INDEX_ROWS,
    CURRENT_CHAT_OPENCODE_MAX_MESSAGE_ROWS,
    CURRENT_CHAT_OPENCODE_MAX_SOURCE_ROWS,
    MAX_TRANSCRIPT_RECORD_BYTES,
    OPENCODE_ELEPHA_MCP_PREFIX,
    OPENCODE_V2_HANDOFF_MAX_ID_BYTES,
    TASK_STATE_REPORT_TOOL,
} from '../config/constants.js';
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
import {
    consumeTaskStateReportResult,
    createTurnBuilderState,
    observeTaskStateReportCall,
    reportInputDropReason,
    resolveAbsolute,
    safeDiscriminator,
    TranscriptReadBudgetError,
    type TurnBuilderState,
    taskStateReportOutcome,
} from './base.js';

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

export interface OpencodeV2Session extends OpenedSessionRow {
    schema: 'v2';
}

export interface OpencodeV2ParseProgress {
    hasMore: boolean;
    pending: boolean;
    omittedPrefix: boolean;
    skippedClosedCursor?: string;
}

export interface OpencodeV2OverlapSession extends OpencodeV2Session {
    v1TimeUpdated: number;
    // False when the V1 and V2 rows disagree on the parent session, which
    // would silently reclassify a child as primary or the reverse.
    sameParent: boolean;
}

export type OpencodeV2HandoffBoundary =
    | { status: 'ready'; startCursor: string; boundarySeq: number; boundaryId: string }
    | { status: 'awaiting-user' }
    | { status: 'abstain'; reason: string };

interface OverlapSessionRow extends SessionRow {
    page_key: unknown;
    v1_time_updated: unknown;
    same_parent: unknown;
}

const OVERLAP_METADATA_BYTES = `COALESCE(length(CAST(v.id AS BLOB)), 0) + COALESCE(length(CAST(v.directory AS BLOB)), 0)
    + COALESCE(length(CAST(v.title AS BLOB)), 0) + COALESCE(length(CAST(v.version AS BLOB)), 0)
    + COALESCE(length(CAST(v.parent_id AS BLOB)), 0)`;
const OVERLAP_SESSION_SELECT = `SELECT CASE WHEN length(CAST(v.id AS BLOB)) <= ? THEN v.id END AS page_key,
    CASE WHEN ${OVERLAP_METADATA_BYTES} <= ? THEN v.id END AS id,
    CASE WHEN ${OVERLAP_METADATA_BYTES} <= ? THEN v.directory END AS directory,
    CASE WHEN ${OVERLAP_METADATA_BYTES} <= ? THEN v.title END AS title,
    CASE WHEN ${OVERLAP_METADATA_BYTES} <= ? THEN v.version END AS version,
    CASE WHEN ${OVERLAP_METADATA_BYTES} <= ? THEN v.parent_id END AS parent_id,
    v.time_updated, s.time_updated AS v1_time_updated,
    CASE WHEN COALESCE(v.parent_id, '') = COALESCE(s.parent_id, '') THEN 1 ELSE 0 END AS same_parent
    FROM session_v2 v JOIN session s ON s.id = v.id`;

function overlapBudgetParameters(): number[] {
    return Array.from({ length: 6 }, () => CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES);
}

const V2_MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9_-]+$/;

function isV2Position(row: { seq: unknown; id: unknown }): row is { seq: number; id: string } {
    return (
        typeof row.seq === 'number' &&
        Number.isSafeInteger(row.seq) &&
        row.seq >= 0 &&
        typeof row.id === 'string' &&
        V2_MESSAGE_ID_PATTERN.test(row.id)
    );
}

interface V2MessageRow {
    id: unknown;
    type: unknown;
    seq: unknown;
    time_created: unknown;
    data: unknown;
}

// This is a watermark namespace, never a path opened or passed to consent.
export function opencodeV2WatermarkKey(dbPath: string): string {
    return `${dbPath}#session_v2`;
}

// Id-keyset position of the same-ID V1/V2 overlap cycle; never opened as a path.
export function opencodeV2OverlapKey(dbPath: string): string {
    return `${dbPath}#session_v2_overlap`;
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
    v2ReportState?: TurnBuilderState;
    v2OtherElephaMcp?: boolean;
}

const FILE_PATH_INPUT_KEYS = ['filePath', 'file_path', 'path'] as const;
const EXTERNAL_FETCH_TOOLS = new Set(['webfetch', 'websearch', 'web_fetch', 'web_search', 'web-fetch', 'web-search']);
const V2_NON_TURN_TYPES = new Set([
    'agent-switched',
    'model-switched',
    'location-switched',
    'synthetic',
    'system',
    'skill',
    'shell',
    'compaction',
]);
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

function v2CursorParts(cursor: string): { sequence: number; id: string } {
    const match = /^v2:(\d+)\|msg_[A-Za-z0-9_-]+$/.exec(cursor);
    const sequence = match === null ? Number.NaN : Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error('Invalid OpenCode V2 cursor');
    }
    return { sequence, id: cursor.slice(cursor.indexOf('|') + 1) };
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
        turn.toolCalls.length > 0 ||
        turn.v2ReportState?.taskStateReport !== undefined ||
        turn.v2ReportState?.taskStateReportFailure !== undefined ||
        turn.v2ReportState?.taskStateReportRawGuard !== undefined ||
        turn.v2OtherElephaMcp === true
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

    private withV2Report(turn: ParsedTurn, openTurn: OpenTurn, session: OpencodeV2Session): ParsedTurn {
        const state = openTurn.v2ReportState;
        const rawDropReason = state === undefined ? undefined : reportInputDropReason(state.taskStateReportRawGuard);
        if (rawDropReason !== undefined || openTurn.v2OtherElephaMcp) {
            // V2 direct tools have no durable result receipt. Keep this
            // reason distinct so the store can advance a verified closed
            // turn without inventing the receipt required by JSONL sources.
            const reason = rawDropReason ?? 'opencode-v2-elepha-mcp';
            this.warnUnknownLine(`[elepha] dropped turn ${turn.turnIndex} of ${session.sessionId}: ${reason}`);
            return {
                ...turn,
                userMessage: '',
                aiTitle: undefined,
                assistantText: '',
                toolCalls: [],
                hasExternalContent: false,
                droppedReason: reason,
            };
        }
        const checked = this.withSentinelDrop(turn);
        if (
            checked.droppedReason !== undefined ||
            state === undefined ||
            (state.taskStateReport === undefined && state.taskStateReportFailure === undefined)
        ) {
            return checked;
        }
        if (session.parentId !== undefined) {
            this.warnUnknownLine(`[elepha] withheld task-state report in turn ${turn.turnIndex} of ${session.sessionId}: non-root-session`);
            return { ...checked, taskStateReportFailure: 'non-root-session' };
        }
        const outcome = taskStateReportOutcome(state);
        if (outcome === undefined) {
            return checked;
        }
        if ('failure' in outcome) {
            this.warnUnknownLine(
                `[elepha] withheld task-state report in turn ${turn.turnIndex} of ${session.sessionId}: ${outcome.failure}`,
            );
            return { ...checked, taskStateReportFailure: outcome.failure };
        }
        return { ...checked, taskStateReport: outcome.report };
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

    // V2 has independent chronology and an independent watermark. Same-ID
    // V1/V2 sessions are excluded here and discovered by overlappingSessionsV2,
    // so a migration projection can never create duplicate memories.
    dirtySessionsV2(
        db: Database.Database,
        cursor?: { watermark: number; cursorId?: string },
    ): { sessions: OpencodeV2Session[]; hasMore: boolean } {
        const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get();
        if (present === undefined) {
            return { sessions: [], hasMore: false };
        }
        const metadataBytes = `COALESCE(length(CAST(v.id AS BLOB)), 0) + COALESCE(length(CAST(v.directory AS BLOB)), 0)
            + COALESCE(length(CAST(v.title AS BLOB)), 0) + COALESCE(length(CAST(v.version AS BLOB)), 0)
            + COALESCE(length(CAST(v.parent_id AS BLOB)), 0)`;
        const rows = db
            .prepare(`SELECT CASE WHEN ${metadataBytes} <= ? THEN v.id END AS id,
            CASE WHEN ${metadataBytes} <= ? THEN v.directory END AS directory,
            CASE WHEN ${metadataBytes} <= ? THEN v.title END AS title,
            CASE WHEN ${metadataBytes} <= ? THEN v.version END AS version,
            CASE WHEN ${metadataBytes} <= ? THEN v.parent_id END AS parent_id,
            v.time_updated
            FROM session_v2 v WHERE NOT EXISTS (SELECT 1 FROM session s WHERE s.id = v.id)
            AND (? IS NULL OR v.time_updated > ? OR (v.time_updated = ? AND (? IS NULL OR v.id > ?)))
            ORDER BY v.time_updated ASC, v.id ASC LIMIT ?`)
            .all(
                CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
                CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
                CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
                CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
                CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
                cursor?.watermark ?? null,
                cursor?.watermark ?? null,
                cursor?.watermark ?? null,
                cursor?.cursorId ?? null,
                cursor?.cursorId ?? null,
                CURRENT_CHAT_OPENCODE_MAX_SOURCE_ROWS + 1,
            ) as SessionRow[];
        const sessions: OpencodeV2Session[] = [];
        for (const row of rows.slice(0, CURRENT_CHAT_OPENCODE_MAX_SOURCE_ROWS)) {
            if (
                typeof row.id !== 'string' ||
                typeof row.directory !== 'string' ||
                typeof row.time_updated !== 'number' ||
                !Number.isSafeInteger(row.time_updated) ||
                (row.parent_id !== null && typeof row.parent_id !== 'string')
            ) {
                this.warnUnknownLine(`OpencodeAdapter: discarded malformed V2 session metadata in ${db.name}`);
                throw new TranscriptReadBudgetError('OpenCode V2 session metadata is malformed or oversized');
            }
            sessions.push({
                schema: 'v2',
                sessionId: row.id,
                directory: row.directory,
                title: typeof row.title === 'string' ? row.title : undefined,
                version: typeof row.version === 'string' ? row.version : undefined,
                parentId: typeof row.parent_id === 'string' && row.parent_id.length > 0 ? row.parent_id : undefined,
                timeUpdated: row.time_updated,
            });
        }
        return { sessions, hasMore: rows.length > CURRENT_CHAT_OPENCODE_MAX_SOURCE_ROWS };
    }

    v2SessionById(db: Database.Database, sessionId: string): OpencodeV2Session | undefined {
        const metadataBytes = `COALESCE(length(CAST(id AS BLOB)), 0) + COALESCE(length(CAST(directory AS BLOB)), 0)
            + COALESCE(length(CAST(title AS BLOB)), 0) + COALESCE(length(CAST(version AS BLOB)), 0)
            + COALESCE(length(CAST(parent_id AS BLOB)), 0)`;
        const row = db
            .prepare(`SELECT CASE WHEN ${metadataBytes} <= ? THEN id END AS id,
                CASE WHEN ${metadataBytes} <= ? THEN directory END AS directory,
                CASE WHEN ${metadataBytes} <= ? THEN title END AS title,
                CASE WHEN ${metadataBytes} <= ? THEN version END AS version,
                CASE WHEN ${metadataBytes} <= ? THEN parent_id END AS parent_id,
                time_updated FROM session_v2
                WHERE id = ? AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = session_v2.id)`)
            .get(
                CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
                CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
                CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
                CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
                CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
                sessionId,
            ) as SessionRow | undefined;
        if (row === undefined) {
            return undefined;
        }
        if (
            typeof row.id !== 'string' ||
            typeof row.directory !== 'string' ||
            typeof row.time_updated !== 'number' ||
            !Number.isSafeInteger(row.time_updated) ||
            (row.parent_id !== null && typeof row.parent_id !== 'string')
        ) {
            throw new TranscriptReadBudgetError('OpenCode V2 pending session metadata is malformed or oversized');
        }
        return {
            schema: 'v2',
            sessionId: row.id,
            directory: row.directory,
            title: typeof row.title === 'string' ? row.title : undefined,
            version: typeof row.version === 'string' ? row.version : undefined,
            parentId: typeof row.parent_id === 'string' && row.parent_id.length > 0 ? row.parent_id : undefined,
            timeUpdated: row.time_updated,
        };
    }

    // Same-ID V1/V2 sessions are paged by id alone. The migration projects a
    // V1 session into session_v2 with its historical time_updated, i.e. behind
    // the ordinary V2 watermark, so that watermark can never discover it.
    overlappingSessionsV2(
        db: Database.Database,
        afterId: string | undefined,
        limit: number,
    ): { sessions: OpencodeV2OverlapSession[]; hasMore: boolean; lastId?: string } {
        const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get();
        if (present === undefined) {
            return { sessions: [], hasMore: false };
        }
        const rows = db
            .prepare(`${OVERLAP_SESSION_SELECT} WHERE (? IS NULL OR v.id > ?) ORDER BY v.id ASC LIMIT ?`)
            .all(...overlapBudgetParameters(), afterId ?? null, afterId ?? null, limit + 1) as OverlapSessionRow[];
        const sessions: OpencodeV2OverlapSession[] = [];
        let lastId: string | undefined;
        for (const row of rows.slice(0, limit)) {
            if (typeof row.page_key !== 'string') {
                throw new TranscriptReadBudgetError('OpenCode V2 overlap session id is malformed or oversized');
            }
            lastId = row.page_key;
            const session = this.overlapSession(db, row);
            if (session !== undefined) {
                sessions.push(session);
            }
        }
        return { sessions, hasMore: rows.length > limit, lastId };
    }

    overlappingSessionV2ById(db: Database.Database, sessionId: string): OpencodeV2OverlapSession | undefined {
        const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get();
        if (present === undefined) {
            return undefined;
        }
        const row = db.prepare(`${OVERLAP_SESSION_SELECT} WHERE v.id = ?`).get(...overlapBudgetParameters(), sessionId) as
            | OverlapSessionRow
            | undefined;
        return row === undefined ? undefined : this.overlapSession(db, row);
    }

    // A malformed overlap row cannot be handed off; it is reported with its
    // source and excluded, never guessed into a session.
    private overlapSession(db: Database.Database, row: OverlapSessionRow): OpencodeV2OverlapSession | undefined {
        if (
            typeof row.id !== 'string' ||
            typeof row.directory !== 'string' ||
            typeof row.time_updated !== 'number' ||
            !Number.isSafeInteger(row.time_updated) ||
            typeof row.v1_time_updated !== 'number' ||
            !Number.isSafeInteger(row.v1_time_updated) ||
            (row.parent_id !== null && typeof row.parent_id !== 'string')
        ) {
            this.warnUnknownLine(`OpencodeAdapter: discarded malformed V1/V2 overlap session metadata in ${db.name}`);
            return undefined;
        }
        return {
            schema: 'v2',
            sessionId: row.id,
            directory: row.directory,
            title: typeof row.title === 'string' ? row.title : undefined,
            version: typeof row.version === 'string' ? row.version : undefined,
            parentId: typeof row.parent_id === 'string' && row.parent_id.length > 0 ? row.parent_id : undefined,
            timeUpdated: row.time_updated,
            v1TimeUpdated: row.v1_time_updated,
            sameParent: row.same_parent === 1,
        };
    }

    // Verifies the migration-shaped boundary between stored V1 history and the
    // first V2-native user. The OpenCode V1 migration keeps V1 message rows,
    // reuses V1 message ids for projected user rows, and writes no idle row
    // into the migrated prefix. Every missing, changed, ambiguous, or
    // oversized piece of evidence returns an explicit reason, never a guess.
    v2HandoffBoundary(db: Database.Database, sessionId: string, storedV1Cursor: string | null): OpencodeV2HandoffBoundary {
        const abstain = (reason: string): OpencodeV2HandoffBoundary => ({ status: 'abstain', reason });
        let anchor: { timeCreated: number; id: string } | undefined;
        try {
            anchor = cursorParts(storedV1Cursor ?? undefined);
        } catch {
            return abstain('stored V1 cursor is malformed');
        }
        if (anchor === undefined) {
            return abstain('no stored V1 cursor anchors the V1 history');
        }
        const anchorRow = db.prepare('SELECT time_created FROM message WHERE id = ? AND session_id = ?').get(anchor.id, sessionId) as
            | { time_created: unknown }
            | undefined;
        if (anchorRow === undefined) {
            return abstain('stored V1 cursor anchor is missing from the V1 source');
        }
        if (anchorRow.time_created !== anchor.timeCreated) {
            return abstain('stored V1 cursor anchor changed in the V1 source');
        }
        const v1Suffix = db
            .prepare(`SELECT 1 FROM message WHERE session_id = ?
                AND (time_created > ? OR (time_created = ? AND id > ?)) LIMIT 1`)
            .get(sessionId, anchor.timeCreated, anchor.timeCreated, anchor.id);
        if (v1Suffix !== undefined) {
            return abstain('uncaptured V1 messages follow the stored V1 cursor');
        }
        const lastV1User = db
            .prepare(`SELECT id FROM message WHERE session_id = ?
                AND (CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END) = 'user'
                ORDER BY time_created DESC, id DESC LIMIT 1`)
            .get(sessionId) as { id: unknown } | undefined;
        if (typeof lastV1User?.id !== 'string') {
            return abstain('V1 source has no user message to anchor the migrated prefix');
        }
        const firstNew = db
            .prepare(`SELECT seq, CASE WHEN length(CAST(id AS BLOB)) <= ? THEN id END AS id FROM session_message sm
                WHERE sm.session_id = ? AND sm.type = 'user'
                AND NOT EXISTS (SELECT 1 FROM message m WHERE m.id = sm.id AND m.session_id = sm.session_id)
                ORDER BY sm.seq ASC LIMIT 1`)
            .get(OPENCODE_V2_HANDOFF_MAX_ID_BYTES, sessionId) as { seq: unknown; id: unknown } | undefined;
        if (firstNew === undefined) {
            return { status: 'awaiting-user' };
        }
        if (!isV2Position(firstNew)) {
            return abstain('first new V2 user row is malformed or oversized');
        }
        const migratedLastUser = db
            .prepare('SELECT seq, type FROM session_message WHERE session_id = ? AND id = ?')
            .get(sessionId, lastV1User.id) as { seq: unknown; type: unknown } | undefined;
        if (
            migratedLastUser?.type !== 'user' ||
            typeof migratedLastUser.seq !== 'number' ||
            !Number.isSafeInteger(migratedLastUser.seq) ||
            migratedLastUser.seq >= firstNew.seq
        ) {
            return abstain('migrated V2 prefix does not contain the last V1 user before the first new user');
        }
        const prefixIdle = db
            .prepare("SELECT 1 FROM session_message WHERE session_id = ? AND seq < ? AND type = 'idle' LIMIT 1")
            .get(sessionId, firstNew.seq);
        if (prefixIdle !== undefined) {
            return abstain('an idle row precedes the first new V2 user, so the migrated prefix is ambiguous');
        }
        const prefixTypes = ['user', 'assistant', ...V2_NON_TURN_TYPES];
        const unknownPrefix = db
            .prepare(`SELECT 1 FROM session_message WHERE session_id = ? AND seq < ?
                AND type NOT IN (${prefixTypes.map(() => '?').join(',')}) LIMIT 1`)
            .get(sessionId, firstNew.seq, ...prefixTypes);
        if (unknownPrefix !== undefined) {
            return abstain('migrated V2 prefix contains an unrecognized row type');
        }
        const laterV1 = db
            .prepare(`SELECT 1 FROM session_message sm WHERE sm.session_id = ? AND sm.seq > ?
                AND EXISTS (SELECT 1 FROM message m WHERE m.id = sm.id AND m.session_id = sm.session_id) LIMIT 1`)
            .get(sessionId, firstNew.seq);
        if (laterV1 !== undefined) {
            return abstain('a V1-projected row follows the first new V2 user');
        }
        const predecessor = db
            .prepare(`SELECT seq, CASE WHEN length(CAST(id AS BLOB)) <= ? THEN id END AS id FROM session_message
                WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1`)
            .get(OPENCODE_V2_HANDOFF_MAX_ID_BYTES, sessionId, firstNew.seq) as { seq: unknown; id: unknown } | undefined;
        if (predecessor === undefined || !isV2Position(predecessor)) {
            return abstain('the row before the first new V2 user is malformed or oversized');
        }
        const rowBytes = `COALESCE(length(CAST(id AS BLOB)), 0) + COALESCE(length(CAST(type AS BLOB)), 0)
            + COALESCE(length(CAST(data AS BLOB)), 0)`;
        const boundary = db
            .prepare(`SELECT time_created, CASE WHEN ${rowBytes} <= ? THEN data END AS data
                FROM session_message WHERE session_id = ? AND seq = ?`)
            .get(MAX_TRANSCRIPT_RECORD_BYTES, sessionId, firstNew.seq) as { time_created: unknown; data: unknown } | undefined;
        const data = parseJsonRecord(boundary?.data);
        if (
            boundary === undefined ||
            data === undefined ||
            typeof data.text !== 'string' ||
            (Object.hasOwn(data, 'id') && data.id !== firstNew.id) ||
            (Object.hasOwn(data, 'type') && data.type !== 'user')
        ) {
            return abstain('first new V2 user row is malformed or oversized');
        }
        if (
            typeof boundary.time_created !== 'number' ||
            !Number.isSafeInteger(boundary.time_created) ||
            boundary.time_created < anchor.timeCreated
        ) {
            return abstain('first new V2 user does not follow the stored V1 cursor in time');
        }
        return {
            status: 'ready',
            startCursor: `v2:${predecessor.seq}|${predecessor.id}`,
            boundarySeq: firstNew.seq,
            boundaryId: firstNew.id,
        };
    }

    // V2 projects whole messages with inline content. A durable idle marker
    // closes the turn; a partial live assistant row is never captured.
    // Closed turns are yielded only after the page statement is finished. An
    // active iterate() pins this connection's WAL read snapshot, so a consumer
    // awaiting between yields would otherwise re-validate its source against
    // stale rows. The buffer is bounded by the same row and byte budgets as
    // the read. Turns closed before a failing row are still delivered first.
    *parseSessionTurnsV2(
        db: Database.Database,
        session: OpencodeV2Session,
        sinceCursor?: string,
        progress?: OpencodeV2ParseProgress,
        omittedPrefix = false,
    ): IterableIterator<ParsedTurn> {
        const ready: ParsedTurn[] = [];
        let tailCursor: string | undefined;
        try {
            tailCursor = this.readV2Page(db, session, sinceCursor, progress, omittedPrefix, ready);
        } catch (error) {
            yield* ready;
            throw error;
        }
        if (tailCursor !== undefined) {
            yield* this.parseSessionTurnsV2(db, session, tailCursor, progress, true);
            return;
        }
        yield* ready;
    }

    // Returns the cursor to resume from when the oldest rows must be omitted.
    private readV2Page(
        db: Database.Database,
        session: OpencodeV2Session,
        sinceCursor: string | undefined,
        progress: OpencodeV2ParseProgress | undefined,
        omittedPrefix: boolean,
        ready: ParsedTurn[],
    ): string | undefined {
        const prior = sinceCursor === undefined ? undefined : v2CursorParts(sinceCursor);
        if (prior !== undefined) {
            const current = db
                .prepare('SELECT id FROM session_message WHERE session_id = ? AND seq = ?')
                .get(session.sessionId, prior.sequence) as { id: string } | undefined;
            if (current?.id !== prior.id) {
                throw new Error('OpenCode V2 cursor source changed');
            }
        }
        const resumeAfter = prior?.sequence ?? -1;
        const rowBytes = `COALESCE(length(CAST(id AS BLOB)), 0) + COALESCE(length(CAST(type AS BLOB)), 0)
            + COALESCE(length(CAST(data AS BLOB)), 0)`;
        const rows = db
            .prepare(`SELECT CASE WHEN ${rowBytes} <= ? THEN id END AS id,
            CASE WHEN ${rowBytes} <= ? THEN type END AS type, seq, time_created,
            CASE WHEN ${rowBytes} <= ? THEN data END AS data
            FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
            .iterate(
                MAX_TRANSCRIPT_RECORD_BYTES,
                MAX_TRANSCRIPT_RECORD_BYTES,
                MAX_TRANSCRIPT_RECORD_BYTES,
                session.sessionId,
                resumeAfter,
                CURRENT_CHAT_OPENCODE_MAX_SOURCE_ROWS + 1,
            ) as Iterable<V2MessageRow>;
        // Every exit from this loop, including a throw, finalizes the statement.
        let count = 0;
        let usedBytes = 0;
        let openTurn: OpenTurn | undefined;
        for (const row of rows) {
            if (++count > CURRENT_CHAT_OPENCODE_MAX_SOURCE_ROWS) {
                if (ready.length > 0) {
                    if (progress) {
                        progress.hasMore = true;
                        progress.pending = true;
                    }
                    return undefined;
                }
                if (omittedPrefix) {
                    throw new TranscriptReadBudgetError('OpenCode V2 tail exceeds row budget');
                }
                const boundary = db
                    .prepare(`SELECT seq, id FROM session_message WHERE session_id = ? AND seq > ?
                        ORDER BY seq DESC LIMIT 1 OFFSET ?`)
                    .get(session.sessionId, resumeAfter, CURRENT_CHAT_OPENCODE_MAX_SOURCE_ROWS) as
                    | { seq: unknown; id: unknown }
                    | undefined;
                if (
                    boundary === undefined ||
                    typeof boundary.seq !== 'number' ||
                    !Number.isSafeInteger(boundary.seq) ||
                    typeof boundary.id !== 'string' ||
                    !/^msg_[A-Za-z0-9_-]+$/.test(boundary.id)
                ) {
                    throw new TranscriptReadBudgetError('OpenCode V2 tail boundary is malformed');
                }
                this.warnUnknownLine(
                    `OpencodeAdapter: omitted oldest V2 rows before seq ${boundary.seq} in ${db.name} session ${session.sessionId}`,
                );
                if (progress) {
                    progress.omittedPrefix = true;
                }
                return `v2:${boundary.seq}|${boundary.id}`;
            }
            if (
                typeof row.id !== 'string' ||
                row.id.length === 0 ||
                typeof row.type !== 'string' ||
                row.type.length === 0 ||
                typeof row.data !== 'string' ||
                typeof row.seq !== 'number' ||
                !Number.isSafeInteger(row.seq) ||
                row.seq < 0 ||
                typeof row.time_created !== 'number' ||
                !Number.isSafeInteger(row.time_created)
            ) {
                this.warnUnknownLine(`OpencodeAdapter: malformed V2 message in ${db.name} session ${session.sessionId}`);
                throw new TranscriptReadBudgetError('OpenCode V2 message is malformed or oversized');
            }
            usedBytes += Buffer.byteLength(row.id) + Buffer.byteLength(row.type) + Buffer.byteLength(row.data);
            if (usedBytes > MAX_TRANSCRIPT_RECORD_BYTES) {
                if (ready.length > 0) {
                    if (progress) {
                        progress.hasMore = true;
                        progress.pending = true;
                    }
                    return undefined;
                }
                throw new TranscriptReadBudgetError('OpenCode V2 session exceeds byte budget');
            }
            const data = parseJsonRecord(row.data);
            // V2 projects id and type into columns; repeated JSON values must agree when present.
            if (!data || (Object.hasOwn(data, 'id') && data.id !== row.id) || (Object.hasOwn(data, 'type') && data.type !== row.type)) {
                this.warnUnknownLine(`OpencodeAdapter: malformed V2 message data in ${db.name} session ${session.sessionId}`);
                throw new TranscriptReadBudgetError('OpenCode V2 message data is malformed');
            }
            const timestamp = isoTimestamp(isRecord(data.time) ? data.time.created : undefined, row.time_created);
            if (omittedPrefix && row.type !== 'idle') {
                if (
                    (row.type === 'user' && typeof data.text !== 'string') ||
                    (row.type === 'assistant' && !Array.isArray(data.content)) ||
                    (row.type !== 'user' && row.type !== 'assistant' && !V2_NON_TURN_TYPES.has(row.type))
                ) {
                    throw new TranscriptReadBudgetError('OpenCode V2 omitted-prefix row is malformed');
                }
                continue;
            }
            if (row.type === 'user') {
                if (typeof data.text !== 'string') {
                    this.warnUnknownLine(`OpencodeAdapter: malformed V2 user message in ${db.name} session ${session.sessionId}`);
                    throw new TranscriptReadBudgetError('OpenCode V2 user message is malformed');
                }
                openTurn ??= {
                    turnIndex: row.seq,
                    startedAt: timestamp,
                    endedAt: timestamp,
                    userMessageParts: [],
                    assistantTextParts: [],
                    toolCalls: [],
                    hasExternalContent: false,
                    lastMessage: { id: row.id, timeCreated: row.time_created },
                    v2ReportState: createTurnBuilderState(),
                };
                openTurn.userMessageParts.push(data.text);
            } else if (row.type === 'assistant') {
                if (!Array.isArray(data.content)) {
                    this.warnUnknownLine(`OpencodeAdapter: malformed V2 assistant message in ${db.name} session ${session.sessionId}`);
                    throw new TranscriptReadBudgetError('OpenCode V2 assistant message is malformed');
                }
                if (openTurn !== undefined) {
                    for (const part of data.content) {
                        if (!isRecord(part)) {
                            this.warnUnknownLine(
                                `OpencodeAdapter: malformed V2 assistant content in ${db.name} session ${session.sessionId}`,
                            );
                            throw new TranscriptReadBudgetError('OpenCode V2 assistant content is malformed');
                        }
                        if (part.type === 'text' && typeof part.text === 'string') {
                            openTurn.assistantTextParts.push(part.text);
                        } else if (part.type === 'reasoning' && typeof part.text === 'string') {
                        } else if (part.type === 'tool' && typeof part.name === 'string') {
                            if (part.name === `${OPENCODE_ELEPHA_MCP_PREFIX}${TASK_STATE_REPORT_TOOL}`) {
                                openTurn.v2ReportState ??= createTurnBuilderState();
                                const state = openTurn.v2ReportState;
                                const toolState = isRecord(part.state) ? part.state : undefined;
                                observeTaskStateReportCall(state, 'opencode-v2', part.id, toolState?.input);
                                if (toolState?.status === 'completed') {
                                    consumeTaskStateReportResult(state, 'opencode-v2', part.id, toolState.content, false);
                                } else if (toolState?.status === 'error') {
                                    consumeTaskStateReportResult(state, 'opencode-v2', part.id, toolState.content, true);
                                }
                                continue;
                            }
                            if (part.name.startsWith(OPENCODE_ELEPHA_MCP_PREFIX)) {
                                openTurn.v2OtherElephaMcp = true;
                                continue;
                            }
                            const input = toolInput(part);
                            openTurn.toolCalls.push({
                                name: part.name,
                                filePaths: toolFilePaths(input, session.directory),
                                text: toolInputText(input),
                            });
                            if (EXTERNAL_FETCH_TOOLS.has(part.name.toLowerCase())) {
                                openTurn.hasExternalContent = true;
                            }
                        } else {
                            this.warnUnknownLine(
                                `OpencodeAdapter: unrecognized V2 assistant content ${safeDiscriminator(part.type)} in ${db.name} session ${session.sessionId}`,
                            );
                            throw new TranscriptReadBudgetError('OpenCode V2 assistant content is unrecognized');
                        }
                    }
                } else {
                    this.warnUnknownLine(`OpencodeAdapter: orphan V2 assistant ignored in ${db.name} session ${session.sessionId}`);
                }
            } else if (row.type === 'idle') {
                if (openTurn !== undefined && hasContent(openTurn)) {
                    openTurn.turnIndex = row.seq;
                    openTurn.endedAt = timestamp;
                    openTurn.lastMessage = { id: row.id, timeCreated: row.time_created };
                    const turn = parsedTurn(db.name, session, openTurn);
                    turn.cursor = `v2:${row.seq}|${row.id}`;
                    ready.push(this.withV2Report(turn, openTurn, session));
                } else if (omittedPrefix && progress) {
                    progress.skippedClosedCursor = `v2:${row.seq}|${row.id}`;
                }
                omittedPrefix = false;
                openTurn = undefined;
            } else if (!V2_NON_TURN_TYPES.has(row.type)) {
                this.warnUnknownLine(
                    `OpencodeAdapter: unrecognized V2 message type ${safeDiscriminator(row.type)} in ${db.name} session ${session.sessionId}`,
                );
                throw new TranscriptReadBudgetError('OpenCode V2 message type is unrecognized');
            }
            if (openTurn !== undefined) {
                openTurn.endedAt = timestamp;
                openTurn.lastMessage = { id: row.id, timeCreated: row.time_created };
            }
        }
        if (progress) {
            progress.pending =
                openTurn !== undefined || omittedPrefix || (progress.skippedClosedCursor !== undefined && ready.length === 0);
        }
        return undefined;
    }

    v2TailRevision(db: Database.Database, sessionId: string): { seq: number; updated: number } | undefined {
        const row = db
            .prepare('SELECT seq, time_updated FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 1')
            .get(sessionId) as { seq: unknown; time_updated: unknown } | undefined;
        if (row === undefined) {
            return undefined;
        }
        if (
            typeof row.seq !== 'number' ||
            !Number.isSafeInteger(row.seq) ||
            typeof row.time_updated !== 'number' ||
            !Number.isSafeInteger(row.time_updated)
        ) {
            throw new TranscriptReadBudgetError('OpenCode V2 latest message is malformed');
        }
        return { seq: row.seq, updated: row.time_updated };
    }

    boundedSessionById(db: Database.Database, sessionId: string, maxMetadataBytes: number): OpenedSessionRow | undefined {
        const metadataBytes = ['directory', 'title', 'version', 'parent_id']
            .map((field) => `COALESCE(length(CAST(${field} AS BLOB)), 0)`)
            .join(' + ');
        const row = db
            .prepare(`SELECT id, CASE WHEN typeof(time_updated) = 'integer' THEN time_updated END AS time_updated,
            CASE WHEN (${metadataBytes}) <= ? THEN directory END AS directory,
            CASE WHEN (${metadataBytes}) <= ? THEN title END AS title,
            CASE WHEN (${metadataBytes}) <= ? THEN version END AS version,
            CASE WHEN (${metadataBytes}) <= ? THEN parent_id END AS parent_id
            FROM session WHERE id = ?`)
            .get(maxMetadataBytes, maxMetadataBytes, maxMetadataBytes, maxMetadataBytes, sessionId) as SessionRow | undefined;
        if (row === undefined) {
            return undefined;
        }
        if (typeof row.directory !== 'string') {
            throw new TranscriptReadBudgetError('OpenCode session metadata exceeds read budget');
        }
        if (typeof row.id !== 'string' || typeof row.time_updated !== 'number' || !Number.isSafeInteger(row.time_updated)) {
            return undefined;
        }
        return {
            sessionId: row.id,
            directory: row.directory,
            title: typeof row.title === 'string' ? row.title : undefined,
            version: typeof row.version === 'string' ? row.version : undefined,
            parentId: typeof row.parent_id === 'string' && row.parent_id.length > 0 ? row.parent_id : undefined,
            timeUpdated: row.time_updated,
        };
    }

    *parseSessionTurnsBounded(
        db: Database.Database,
        session: OpenedSessionRow,
        maxBytes: number,
        maxRows: number,
        coverage: { omittedBefore: number },
        signal?: AbortSignal,
    ): IterableIterator<ParsedTurn> {
        let remainingBytes = maxBytes;
        const messageByteSql = `COALESCE(length(CAST(id AS BLOB)), 0)
            + COALESCE(length(CAST(time_created AS BLOB)), 0)
            + COALESCE(length(CAST(data AS BLOB)), 0)`;
        const newestMessages = db
            .prepare(`SELECT CASE WHEN ${messageByteSql} <= ? THEN id END AS id, time_created,
                CASE WHEN ${messageByteSql} <= ? THEN data END AS data
                FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?`)
            .all(maxBytes, maxBytes, session.sessionId, Math.min(maxRows, CURRENT_CHAT_OPENCODE_MAX_MESSAGE_ROWS) + 1) as MessageRow[];
        const selectedNewest: MessageRow[] = [];
        for (const row of newestMessages) {
            if (signal?.aborted) {
                throw new Error('OpenCode source read deadline');
            }
            if (typeof row.id !== 'string' || typeof row.data !== 'string') {
                if (selectedNewest.length === 0) {
                    throw new TranscriptReadBudgetError('OpenCode newest message exceeds read budget');
                }
                break;
            }
            const bytes = Buffer.byteLength(row.id) + Buffer.byteLength(String(row.time_created)) + Buffer.byteLength(row.data);
            if (selectedNewest.length >= Math.min(maxRows, CURRENT_CHAT_OPENCODE_MAX_MESSAGE_ROWS) || bytes > remainingBytes) {
                break;
            }
            remainingBytes -= bytes;
            selectedNewest.push(row);
        }
        // The source suffix must start at a user boundary; an assistant-only
        // prefix would be a fabricated partial turn.
        let messageRows = selectedNewest.reverse();
        const firstUser = messageRows.findIndex((row) => parseJsonRecord(row.data)?.role === 'user');
        if (firstUser < 0) {
            throw new TranscriptReadBudgetError('OpenCode source suffix has no complete turn');
        }
        messageRows = messageRows.slice(firstUser);
        const allIds = messageRows.map((row) => row.id as string);
        const placeholders = allIds.map(() => '?').join(',');
        const partTotals = db
            .prepare(`SELECT message_id, COUNT(*) AS rows,
                SUM(COALESCE(length(CAST(message_id AS BLOB)), 0) + COALESCE(length(CAST(data AS BLOB)), 0)) AS bytes
                FROM part WHERE session_id = ? AND message_id IN (${placeholders}) GROUP BY message_id`)
            .all(session.sessionId, ...allIds) as Array<{ message_id: string; rows: number; bytes: number }>;
        const totals = new Map(partTotals.map((row) => [row.message_id, row]));
        let retainedRows = 0;
        let retainedBytes = 0;
        let retainedPartBytes = 0;
        let retainedFrom = messageRows.length;
        for (let index = messageRows.length - 1; index >= 0; index--) {
            const row = messageRows[index];
            const total = totals.get(row.id as string);
            const rowBytes =
                Buffer.byteLength(row.id as string) + Buffer.byteLength(String(row.time_created)) + Buffer.byteLength(row.data as string);
            if (retainedRows + 1 + (total?.rows ?? 0) > maxRows || retainedBytes + rowBytes + (total?.bytes ?? 0) > maxBytes) {
                break;
            }
            retainedRows += 1 + (total?.rows ?? 0);
            retainedBytes += rowBytes + (total?.bytes ?? 0);
            retainedPartBytes += total?.bytes ?? 0;
            retainedFrom = index;
        }
        messageRows = messageRows.slice(retainedFrom);
        const completeFrom = messageRows.findIndex((row) => parseJsonRecord(row.data)?.role === 'user');
        if (completeFrom < 0) {
            throw new TranscriptReadBudgetError('OpenCode newest turn exceeds read budget');
        }
        messageRows = messageRows.slice(completeFrom);
        const first = messageRows[0];
        if (typeof first?.id !== 'string' || typeof first.time_created !== 'number') {
            throw new TranscriptReadBudgetError('OpenCode source suffix has no complete turn');
        }
        const olderSql = `SELECT CASE WHEN ${messageByteSql} <= ? THEN id END AS id, time_created,
            CASE WHEN ${messageByteSql} <= ? THEN data END AS data
            FROM message WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))
            ORDER BY time_created DESC, id DESC LIMIT ?`;
        let olderRows = 0;
        for (const row of db
            .prepare(olderSql)
            .iterate(
                maxBytes,
                maxBytes,
                session.sessionId,
                first.time_created,
                first.time_created,
                first.id,
                CURRENT_CHAT_OPENCODE_MAX_INDEX_ROWS + 1,
            ) as Iterable<MessageRow>) {
            if (signal?.aborted) {
                throw new Error('OpenCode source read deadline');
            }
            olderRows++;
            if (olderRows > CURRENT_CHAT_OPENCODE_MAX_INDEX_ROWS || typeof row.id !== 'string' || typeof row.data !== 'string') {
                throw new TranscriptReadBudgetError('OpenCode turn index exceeds read budget');
            }
            remainingBytes -= Buffer.byteLength(row.id) + Buffer.byteLength(String(row.time_created)) + Buffer.byteLength(row.data);
            if (remainingBytes < 0) {
                throw new TranscriptReadBudgetError('OpenCode turn index exceeds read budget');
            }
            if (parseJsonRecord(row.data)?.role === 'user') {
                coverage.omittedBefore++;
            }
        }
        if (retainedPartBytes > remainingBytes) {
            throw new TranscriptReadBudgetError('OpenCode source parts exceed read budget');
        }
        const ids = messageRows.map((row) => row.id as string);
        const partPlaceholders = ids.map(() => '?').join(',');
        const partByteSql = `COALESCE(length(CAST(message_id AS BLOB)), 0) + COALESCE(length(CAST(data AS BLOB)), 0)`;
        const partRows = db
            .prepare(`SELECT CASE WHEN ${partByteSql} <= ? THEN message_id END AS message_id,
                CASE WHEN ${partByteSql} <= ? THEN data END AS data
                FROM part WHERE session_id = ? AND message_id IN (${partPlaceholders}) ORDER BY time_created ASC, id ASC`)
            .all(maxBytes, maxBytes, session.sessionId, ...ids) as PartRow[];
        if (partRows.some((row) => typeof row.message_id !== 'string' || typeof row.data !== 'string')) {
            throw new TranscriptReadBudgetError('OpenCode source part exceeds read budget');
        }
        yield* this.parseLoadedRows(db.name, session, messageRows, partRows, undefined, {
            closeTrailingOnIdle: true,
            initialTurnIndex: coverage.omittedBefore,
        });
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

        yield* this.parseLoadedRows(db.name, session, messageRows, partRows, resumeAfter, options);
    }

    private *parseLoadedRows(
        dbPath: string,
        session: OpenedSessionRow,
        messageRows: MessageRow[],
        partRows: PartRow[],
        resumeAfter?: { timeCreated: number; id: string },
        options?: Pick<ParseTurnsOptions, 'closeTrailingOnIdle'> & { initialTurnIndex?: number },
    ): IterableIterator<ParsedTurn> {
        const partsByMessage = new Map<string, OpenCodePart[]>();
        for (const row of partRows) {
            if (typeof row.message_id !== 'string') {
                this.warnUnknownLine('OpencodeAdapter: discarded part with malformed message_id');
                continue;
            }
            const data = parseJsonRecord(row.data);
            if (!data) {
                this.warnUnknownLine(`OpencodeAdapter: discarded malformed part data in ${dbPath}`);
                continue;
            }
            const type = data.type;
            if (type !== 'text' && type !== 'reasoning' && type !== 'step-start' && type !== 'step-finish' && type !== 'tool') {
                this.warnUnknownLine(`OpencodeAdapter: unrecognized part.data.type "${safeDiscriminator(type)}" in ${dbPath}`);
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
                this.warnUnknownLine(`OpencodeAdapter: discarded malformed message data in ${dbPath}`);
                continue;
            }
            if (data.role !== 'user' && data.role !== 'assistant') {
                this.warnUnknownLine(`OpencodeAdapter: unrecognized message.data.role "${safeDiscriminator(data.role)}" in ${dbPath}`);
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

        let turnIndex =
            options?.initialTurnIndex ??
            (resumeAfter ? messages.filter((message) => message.role === 'user' && isAtOrBeforeCursor(message, resumeAfter)).length : 0);
        let openTurn: OpenTurn | undefined;
        for (const message of messages) {
            if (resumeAfter && isAtOrBeforeCursor(message, resumeAfter)) {
                continue;
            }

            if (message.role === 'user') {
                if (openTurn) {
                    if (hasContent(openTurn)) {
                        yield this.withSentinelDrop(parsedTurn(dbPath, session, openTurn));
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
                        this.warnUnknownLine(`OpencodeAdapter: discarded malformed text part in ${dbPath}`);
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
                    this.warnUnknownLine(`OpencodeAdapter: malformed tool name "${safeDiscriminator(part.data.tool)}" in ${dbPath}`);
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
            yield this.withSentinelDrop(parsedTurn(dbPath, session, openTurn));
        }
    }

    classifySession(session: OpenedSessionRow): SessionClassification {
        return session.parentId ? { kind: 'subagent', parentNativeId: session.parentId } : { kind: 'primary' };
    }
}
