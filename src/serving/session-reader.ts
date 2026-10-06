// Tool-neutral retained evidence reader with a newest-first serving budget.
// Only legacy OpenCode rendering may replay a source; callers own envelopes.

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import { TranscriptReadBudgetError } from '../adapters/base.js';
import { OpencodeAdapter, openOpencodeDbReadonly } from '../adapters/opencode.js';
import {
    CURRENT_CHAT_EVIDENCE_DEADLINE_MS,
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    CURRENT_CHAT_OPENCODE_MAX_SOURCE_ROWS,
    DURABLE_CAPTURE_FILTER_VERSION,
    MAX_GET_SESSION_LAST_N,
    RECENT_SESSION_WINDOW_MS,
    SESSION_CHAR_BUDGET,
    SESSION_EVIDENCE_SOURCE_MAX_BYTES,
} from '../config/constants.js';
import { canonicalizeExisting, samePath } from '../config/paths.js';
import { type AssistantStructure, decodeAssistantStructure } from '../rendering/assistant-structure.js';
import type { FilterableToolCall, FilteredTurnProjection } from '../rendering/filtered-turn.js';
import {
    omissionMarker,
    RAW_TURN_SEPARATOR,
    renderableFilteredTurns,
    renderableRawTurns,
    renderFilteredTurn,
    renderRawTurn,
} from '../rendering/raw-turn-renderer.js';
import { containsSentinel } from '../security/sentinel.js';
import { ConsentStore } from '../storage/consent-store.js';
import { NOT_CURRENT_COPY_SQL, SUPERSEDED_COPY_SQL } from '../storage/durable-capture-store.js';
import { matchesFirstPromptSearch } from '../storage/first-prompt-search.js';
import { InjectionStore } from '../storage/injection-store.js';
import { retentionRemovedSql } from '../storage/live-memory-retention-schema.js';
import {
    type AuthenticatedReadGeneration,
    isMemoryLocked,
    LOCKED_CONTENT_COVERAGE,
    type LockedContentCoverage,
    memoryServeState,
    withMemoryReadGeneration,
    withMemoryReadGenerationAsync,
} from '../storage/paranoid-gate.js';

import type { ProjectSet } from '../storage/project-resolver.js';
import {
    type ProjectSessionAggregate,
    readIndexedTurnLocator,
    readProjectSessionAggregates,
    readProjectSessions,
    readSessionById,
    readSessionCapsuleByNaturalKey,
    SERVED_SESSION_KIND_ELIGIBILITY,
    type ServedSession,
    safeStringArray,
} from '../storage/session-read-model.js';
import { UNTITLED_EPISODE } from '../storage/session-title.js';
import { hydrateTurnDecisions } from '../storage/turn-store.js';
import {
    type OpenedSessionRow,
    type ParsedTurn,
    SUPPORTED_TOOLS,
    TOOL_METADATA,
    type ToolName,
    type TurnDecision,
} from '../types/index.js';
import { dataBlockClose, dataBlockOpen } from './instructions.js';

export type { ServedSession } from '../storage/session-read-model.js';

export const STORED_EVIDENCE_REASONS = {
    missing: 'durable_capture_missing',
    incomplete: 'durable_capture_incomplete',
    evicted: 'durable_capture_evicted',
    filterVersionMismatch: 'durable_capture_filter_version_mismatch',
    stale: 'durable_turn_stale_after_reingest',
    unreadable: 'durable_turn_unreadable',
    selfInjected: 'durable_turn_self_injected',
} as const;

export interface BoundedEpisode {
    text: string;
    returned: number;
    omitted: number;
    total: number;
    renderedChars: number;
    nonce: string;
}

export interface FirstInteraction {
    projection?: FilteredTurnProjection;
    turnIndex?: number;
    source?: 'durable stored interaction';
    reason?: string;
}

export interface EvidenceWindow {
    projections?: FilteredTurnProjection[];
    returned: number;
    omitted: number;
    total: number;
    reason?: string;
}

export interface IndexedEvidenceWindow extends EvidenceWindow {
    turnIndexes?: number[];
}

export type IndexedTurnEvidence =
    | { state: 'available'; turnIndex: number; projection: FilteredTurnProjection; source: 'durable' | 'transcript' }
    | { state: 'unavailable'; reason: string };

export interface IncompleteLastObservedSnapshot {
    complete: false;
    turnIndex: number;
    failedAt: string;
    observedAt: string;
    stagedAt: string;
    decisions: TurnDecision[];
    pendingItems: string[];
    summarizerStatus: string;
    durableProjection?: FilteredTurnProjection;
}

export interface StoredTurnRecallFields {
    decisions: string[];
    filesTouched: string[];
    pendingItems: string[];
}

export type StoredSessionRecallFields = Map<number, StoredTurnRecallFields>;

export interface AvailableStoredContentCoverage {
    complete: number;
    completeTruncated: number;
    incomplete: number;
    evicted: number;
    neverCaptured: number;
    total: number;
}

export type StoredContentCoverage = AvailableStoredContentCoverage | LockedContentCoverage;

export interface StoredContentMatch {
    bm25: number;
    texts: string[];
}

export interface StoredContentRecall {
    coverage: StoredContentCoverage;
    matches: Map<number, StoredContentMatch>;
    rowCapReached: boolean;
    timeBudgetReached: boolean;
}

interface TurnCollectionBounds {
    lastN?: number;
    charBudget: number;
    nonce: string;
}

interface RetainedTurn {
    turn: ParsedTurn;
    renderedLength: number;
}

interface RetainedFilteredTurn {
    projection: FilteredTurnProjection;
    renderedLength: number;
}

interface StoredFilteredTurnRow {
    turn_index: number;
    included: number;
    user_prompt: string | null;
    assistant_response: string | null;
    assistant_structure: string | null;
    tool_calls: string | null;
    omitted_tool_call_count: number;
    filter_version: number;
}

interface DurableTurnCollection {
    complete: boolean;
    present: boolean;
    projections?: FilteredTurnProjection[];
    turnIndexes?: number[];
    omittedBefore?: number;
    reason?: string;
}

interface TurnCollection {
    turns?: ParsedTurn[];
    omittedBefore?: number;
    retentionHighWater?: { turns: number; renderedChars: number };
    reason?: string;
    state?: 'locked';
    content_coverage?: LockedContentCoverage;
}

interface SourceTurnCollection extends TurnCollection {
    sourceUnavailable?: boolean;
}

interface OpenedSourceTurns {
    turns: AsyncIterable<ParsedTurn> | Iterable<ParsedTurn>;
    close(): Promise<void> | void;
    coverage?: { omittedBefore: number };
}

type IndexedSourceSession = Pick<ServedSession, 'id' | 'tool' | 'native_id' | 'source_path' | 'source_format'> & {
    expectedProjectPath?: string;
};

function leafStrings(value: unknown): string[] {
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.flatMap(leafStrings);
    }
    if (value && typeof value === 'object') {
        return Object.values(value).flatMap(leafStrings);
    }
    return [];
}

function decodedStrings(value: string): string[] {
    try {
        return leafStrings(JSON.parse(value));
    } catch {
        return [];
    }
}

function decodedToolCalls(value: string): FilterableToolCall[] | undefined {
    try {
        const parsed: unknown = JSON.parse(value);
        if (
            !Array.isArray(parsed) ||
            parsed.some(
                (call) =>
                    !call ||
                    typeof call !== 'object' ||
                    typeof (call as { name?: unknown }).name !== 'string' ||
                    !Array.isArray((call as { filePaths?: unknown }).filePaths) ||
                    (call as { filePaths: unknown[] }).filePaths.some((filePath) => typeof filePath !== 'string'),
            )
        ) {
            return undefined;
        }
        return parsed as FilterableToolCall[];
    } catch {
        return undefined;
    }
}

export function surfaceLabel(tool: ToolName, surface: ServedSession['surface']): string {
    const displayName = TOOL_METADATA[tool].displayName;
    return surface === 'desktop' ? `${displayName} Desktop` : `${displayName} CLI`;
}

export function endedAt(session: Pick<ServedSession, 'last_turn_at' | 'last_ingested_at' | 'started_at'>): string {
    return session.last_turn_at ?? session.last_ingested_at ?? session.started_at;
}

export function titleOf(session: Pick<ServedSession, 'title'>): string {
    return session.title?.trim() || UNTITLED_EPISODE;
}

export function hasRealContent(session: Pick<ServedSession, 'title' | 'custom_title' | 'open_turn_staged_at'>): boolean {
    if (session.open_turn_staged_at != null) {
        return true;
    }
    if (session.custom_title?.trim()) {
        return true;
    }
    const title = session.title?.trim();
    return title !== undefined && title !== '' && title !== UNTITLED_EPISODE;
}

export function newestActivity(
    sessions: Iterable<ServedSession>,
    { excludeNativeId }: { excludeNativeId: string },
): ServedSession | undefined {
    let newest: ServedSession | undefined;
    let newestEndedAt = Number.NEGATIVE_INFINITY;
    for (const session of sessions) {
        if (session.native_id === excludeNativeId) {
            continue;
        }
        const sessionEndedAt = Date.parse(endedAt(session));
        if (sessionEndedAt > newestEndedAt) {
            newest = session;
            newestEndedAt = sessionEndedAt;
        }
    }
    return newest;
}

const SUPERSEDED_COPY = SUPERSEDED_COPY_SQL;

export class SessionReader {
    private readonly opencodeAdapter = new OpencodeAdapter();
    private readonly sessionsMemo = new Map<string, ServedSession[]>();
    private readonly consentedSessionsMemo = new Map<string, ServedSession[]>();

    constructor(private readonly db: Database.Database) {}

    serveState(): 'locked' | 'unlocked' {
        return memoryServeState(this.db);
    }

    withReadGeneration<T>(locked: () => T, read: (token: AuthenticatedReadGeneration) => T): T {
        return withMemoryReadGeneration(this.db, locked, read);
    }

    withReadGenerationAsync<T>(locked: () => T, read: (token: AuthenticatedReadGeneration) => Promise<T>): Promise<T> {
        return withMemoryReadGenerationAsync(this.db, locked, read);
    }

    // Memoized per reader instance, the same pattern as ProjectResolver.list:
    // one operation's repeated reads of a project share a single load. A
    // long-lived caller constructs a fresh reader per request so later
    // requests observe daemon writes.
    sessionsFor(project: ProjectSet): ServedSession[] {
        return this.withReadGeneration(
            () => [],
            () => {
                const key = project.projectIds.join(',');
                const cached = this.sessionsMemo.get(key);
                if (cached !== undefined) {
                    return cached;
                }
                const rows = readProjectSessions(this.db, project.projectIds);
                this.sessionsMemo.set(key, rows);
                return rows;
            },
        );
    }

    storedContentRecallFor(
        sessions: Iterable<Pick<ServedSession, 'id'>>,
        matchExpressions: readonly string[],
        perComponentRowCap: number,
        withinBudget: () => boolean,
    ): StoredContentRecall {
        const locked = (): StoredContentRecall => ({
            coverage: LOCKED_CONTENT_COVERAGE,
            matches: new Map(),
            rowCapReached: false,
            timeBudgetReached: false,
        });
        return this.withReadGeneration(locked, () => {
            const requestedIds = [...new Set([...sessions].map((session) => session.id))];
            const emptyCoverage: AvailableStoredContentCoverage = {
                complete: 0,
                completeTruncated: 0,
                incomplete: 0,
                evicted: 0,
                neverCaptured: 0,
                total: 0,
            };
            if (requestedIds.length === 0) {
                return { coverage: emptyCoverage, matches: new Map(), rowCapReached: false, timeBudgetReached: false };
            }

            const coverageRows = this.db
                .prepare(
                    `WITH requested(id) AS (
                     SELECT CAST(value AS INTEGER) FROM json_each(?)
                 )
                 SELECT s.id, dcs.state, dcs.filter_version,
                        EXISTS (
                            SELECT 1 FROM filtered_turns ft
                            JOIN memories m ON m.id = ft.memory_id
                            WHERE m.session_id = s.id
                        ) AS has_filtered,
                        EXISTS (
                            SELECT 1 FROM memories m
                            LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                            WHERE m.session_id = s.id
                              AND ${NOT_CURRENT_COPY_SQL}
                        ) AS has_uncovered
                 FROM requested
                 JOIN sessions s ON s.id = requested.id
                 LEFT JOIN durable_capture_status dcs ON dcs.session_id = s.id
                 WHERE ${SERVED_SESSION_KIND_ELIGIBILITY} AND NOT EXISTS (
                           SELECT 1 FROM purged_transcripts p
                           WHERE p.tool = s.tool AND p.native_id = s.native_id
                       )
                   AND NOT ${retentionRemovedSql('s.tool', 's.native_id')}
                   AND NOT EXISTS (
                           SELECT 1 FROM incognito_transcripts i
                           WHERE i.tool = s.tool AND i.native_id = s.native_id
                       )
                 ORDER BY s.id`,
                )
                .all(JSON.stringify(requestedIds)) as Array<{
                filter_version: number | null;
                has_filtered: number;
                has_uncovered: number;
                id: number;
                state: string | null;
            }>;
            const activeIds = coverageRows.map((row) => row.id);
            const coverage = { ...emptyCoverage, total: activeIds.length };
            for (const row of coverageRows) {
                const currentAndCovered = row.filter_version === DURABLE_CAPTURE_FILTER_VERSION && row.has_uncovered === 0;
                if (row.state === 'complete' && currentAndCovered) {
                    coverage.complete += 1;
                } else if (row.state === 'complete_truncated' && currentAndCovered) {
                    coverage.completeTruncated += 1;
                } else if (row.state === 'evicted') {
                    coverage.evicted += 1;
                } else if (row.state !== null || row.has_filtered === 1) {
                    coverage.incomplete += 1;
                } else {
                    coverage.neverCaptured += 1;
                }
            }
            if (activeIds.length === 0) {
                return { coverage, matches: new Map(), rowCapReached: false, timeBudgetReached: false };
            }

            // State is authoritative even if an interrupted external repair left
            // stale FTS rows behind; evicted sessions are pre-durable search input.
            const searchableIds = coverageRows.filter((row) => row.state !== 'evicted').map((row) => row.id);
            if (searchableIds.length === 0) {
                return { coverage, matches: new Map(), rowCapReached: false, timeBudgetReached: false };
            }
            const activeIdsJson = JSON.stringify(searchableIds);
            const ftsStatement = this.db.prepare(
                `WITH eligible(id) AS (
                 SELECT CAST(value AS INTEGER) FROM json_each(?)
             )
             SELECT m.session_id, filtered_turns_fts.rowid AS memory_id, bm25(filtered_turns_fts) AS score
             FROM eligible
             JOIN memories m ON m.session_id = eligible.id
             JOIN filtered_turns_fts ON filtered_turns_fts.rowid = m.id
             JOIN filtered_turns ft ON ft.memory_id = m.id
             WHERE filtered_turns_fts MATCH ? AND NOT ${SUPERSEDED_COPY}
             ORDER BY score, m.session_id, memory_id
             LIMIT ?`,
            );
            const bestScoreBySession = new Map<number, number>();
            const matchedSessionIds = new Set<number>();
            let rowCapReached = false;
            let timeBudgetReached = false;
            for (const expression of matchExpressions) {
                if (!withinBudget()) {
                    timeBudgetReached = true;
                    break;
                }
                const rows = ftsStatement.all(activeIdsJson, expression, perComponentRowCap) as Array<{
                    memory_id: number;
                    score: number;
                    session_id: number;
                }>;
                rowCapReached ||= rows.length === perComponentRowCap;
                for (const row of rows) {
                    matchedSessionIds.add(row.session_id);
                    const previous = bestScoreBySession.get(row.session_id);
                    if (previous === undefined || row.score < previous) {
                        bestScoreBySession.set(row.session_id, row.score);
                    }
                }
            }

            const textsBySession = new Map<number, string[]>();
            if (matchedSessionIds.size > 0 && withinBudget()) {
                const rows = this.db
                    .prepare(
                        `SELECT m.session_id, ft.user_prompt, ft.assistant_response, ft.tool_calls
                     FROM filtered_turns ft
                     JOIN memories m ON m.id = ft.memory_id
                     WHERE m.session_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
                       AND NOT ${SUPERSEDED_COPY}
                     ORDER BY m.session_id, m.turn_index`,
                    )
                    .iterate(JSON.stringify([...matchedSessionIds])) as Iterable<{
                    assistant_response: string;
                    session_id: number;
                    tool_calls: string;
                    user_prompt: string;
                }>;
                for (const row of rows) {
                    if (!withinBudget()) {
                        timeBudgetReached = true;
                        break;
                    }
                    const texts = textsBySession.get(row.session_id) ?? [];
                    texts.push(row.user_prompt, row.assistant_response, row.tool_calls);
                    textsBySession.set(row.session_id, texts);
                }
            } else if (matchedSessionIds.size > 0) {
                timeBudgetReached = true;
            }

            const matches = new Map<number, StoredContentMatch>();
            for (const [sessionId, texts] of textsBySession) {
                matches.set(sessionId, { bm25: bestScoreBySession.get(sessionId) ?? 0, texts });
            }
            return { coverage, matches, rowCapReached, timeBudgetReached };
        });
    }

    sessionAggregatesFor(projects: readonly ProjectSet[]): ProjectSessionAggregate[] {
        return this.withReadGeneration(
            () => [],
            () => {
                const projectIds = [...new Set(projects.flatMap((project) => project.projectIds))];
                return readProjectSessionAggregates(this.db, projectIds);
            },
        );
    }

    // Reads every session belonging to the already consent-filtered project
    // sets in one newest-first query. The caller owns the consent boundary;
    // this reader only combines its internal project ids.
    recentConsentedSessions(projects: readonly ProjectSet[]): ServedSession[] {
        return this.withReadGeneration(
            () => [],
            () => {
                const projectIds = [...new Set(projects.flatMap((project) => project.projectIds))].sort((a, b) => a - b);
                if (projectIds.length === 0) {
                    return [];
                }
                const key = projectIds.join(',');
                const cached = this.consentedSessionsMemo.get(key);
                if (cached !== undefined) {
                    return cached;
                }
                const rows = readProjectSessions(this.db, projectIds).filter(hasRealContent);
                this.consentedSessionsMemo.set(key, rows);
                return rows;
            },
        );
    }

    consentedTotal(projects: readonly ProjectSet[]): number {
        return this.withReadGeneration(
            () => 0,
            () => this.recentConsentedSessions(projects).length,
        );
    }

    sessionCountsByProject(): Map<number, number> {
        return this.withReadGeneration(
            () => new Map(),
            () => {
                const rows = this.db
                    .prepare(
                        `SELECT s.project_id, s.title, s.custom_title, ot.staged_at AS open_turn_staged_at FROM sessions s
                         LEFT JOIN open_turns ot ON ot.session_id = s.id AND ot.staged_at IS NOT NULL AND ot.validated_epoch = ot.validation_epoch
                         WHERE s.tool IN (${SUPPORTED_TOOLS.map(() => '?').join(',')}) AND ${SERVED_SESSION_KIND_ELIGIBILITY}`,
                    )
                    .all(...SUPPORTED_TOOLS) as Array<Pick<ServedSession, 'project_id' | 'title' | 'custom_title'>>;
                const counts = new Map<number, number>();
                for (const session of rows.filter(hasRealContent)) {
                    counts.set(session.project_id, (counts.get(session.project_id) ?? 0) + 1);
                }
                return counts;
            },
        );
    }

    sessionById(id: number): ServedSession | undefined {
        return this.withReadGeneration(
            () => undefined,
            () => readSessionById(this.db, id),
        );
    }

    capsuleByNaturalKey(key: Parameters<typeof readSessionCapsuleByNaturalKey>[1]) {
        return this.withReadGeneration(
            () => undefined,
            () => readSessionCapsuleByNaturalKey(this.db, key),
        );
    }

    incompleteLastObservedFor(session: Pick<ServedSession, 'id'>): IncompleteLastObservedSnapshot | undefined {
        return this.withReadGeneration(
            () => undefined,
            () => {
                const row = this.db
                    .prepare(
                        `SELECT turn_index, failed_at, observed_at, staged_at, decisions, pending_items, summarizer_status,
                                durable_included, durable_user_prompt, durable_assistant_response,
                                durable_assistant_structure, durable_tool_calls,
                                durable_omitted_tool_call_count, durable_filter_version
                         FROM open_turns
                         WHERE session_id = ? AND open_turns.staged_at IS NOT NULL AND open_turns.validated_epoch = open_turns.validation_epoch
                           AND receipt_coverage = 'complete'`,
                    )
                    .get(session.id) as
                    | {
                          turn_index: number;
                          failed_at: string;
                          observed_at: string;
                          staged_at: string;
                          decisions: string;
                          pending_items: string;
                          summarizer_status: string;
                          durable_included: number | null;
                          durable_user_prompt: string | null;
                          durable_assistant_response: string | null;
                          durable_assistant_structure: string | null;
                          durable_tool_calls: string | null;
                          durable_omitted_tool_call_count: number | null;
                          durable_filter_version: number | null;
                      }
                    | undefined;
                if (row === undefined) {
                    return undefined;
                }
                const toolCalls = row.durable_tool_calls === null ? undefined : decodedToolCalls(row.durable_tool_calls);
                const durableProjection =
                    row.durable_included !== 1 ||
                    row.durable_filter_version !== DURABLE_CAPTURE_FILTER_VERSION ||
                    toolCalls === undefined ||
                    containsSentinel(row.durable_user_prompt ?? '') ||
                    containsSentinel(row.durable_assistant_response ?? '')
                        ? undefined
                        : {
                              included: row.durable_included === 1,
                              userPrompt: row.durable_user_prompt ?? '',
                              assistantResponse: row.durable_assistant_response ?? '',
                              assistantStructure:
                                  row.durable_assistant_structure === null
                                      ? undefined
                                      : decodeAssistantStructure(
                                            row.durable_assistant_structure,
                                            (row.durable_assistant_response ?? '').length,
                                        ),
                              toolCalls,
                              omittedToolCallCount: row.durable_omitted_tool_call_count ?? 0,
                              filterVersion: row.durable_filter_version,
                          };
                return {
                    complete: false,
                    turnIndex: row.turn_index,
                    failedAt: row.failed_at,
                    observedAt: row.observed_at,
                    stagedAt: row.staged_at,
                    decisions: hydrateTurnDecisions(row.decisions),
                    pendingItems: safeStringArray(row.pending_items),
                    summarizerStatus: row.summarizer_status,
                    durableProjection,
                };
            },
        );
    }

    counts(project: ProjectSet, now: number = Date.now()): { recent: number; total: number } {
        return this.withReadGeneration(
            () => ({ recent: 0, total: 0 }),
            () => {
                const rows = this.sessionsFor(project);
                const sevenDaysAgo = now - RECENT_SESSION_WINDOW_MS;
                return { total: rows.length, recent: rows.filter((row) => Date.parse(endedAt(row)) >= sevenDaysAgo).length };
            },
        );
    }

    storedRecallFieldsFor(sessions: Iterable<Pick<ServedSession, 'id'>>): Map<number, StoredSessionRecallFields> {
        const ids = [...new Set([...sessions].map((session) => session.id))];
        const empty = () => new Map(ids.map((id) => [id, new Map<number, StoredTurnRecallFields>()]));
        return this.withReadGeneration(empty, () => {
            if (ids.length === 0) {
                return empty();
            }
            const bySession = empty();
            const rows = this.db
                .prepare(
                    `SELECT session_id, turn_index, decisions, files_touched, pending_items
                         FROM memories m JOIN sessions s ON s.id = m.session_id
                         WHERE session_id IN (${ids.map(() => '?').join(',')}) AND ${SERVED_SESSION_KIND_ELIGIBILITY}
                         ORDER BY session_id, turn_index`,
                )
                .all(...ids) as Array<{
                session_id: number;
                turn_index: number;
                decisions: string;
                files_touched: string;
                pending_items: string;
            }>;
            for (const row of rows) {
                bySession.get(row.session_id)?.set(row.turn_index, {
                    decisions: decodedStrings(row.decisions),
                    filesTouched: decodedStrings(row.files_touched),
                    pendingItems: decodedStrings(row.pending_items),
                });
            }
            return bySession;
        });
    }

    storedTurnRecallFields(session: Pick<ServedSession, 'id'>): StoredSessionRecallFields {
        return this.withReadGeneration(
            () => new Map(),
            () => this.storedRecallFieldsFor([session]).get(session.id) ?? new Map(),
        );
    }

    // The index belongs to this stored segment, not to a guessed transcript
    // position. Stop at that interaction; later repeated mentions cannot
    // displace the response paired with the indexed first prompt.
    async firstInteraction(session: ServedSession, signal?: AbortSignal): Promise<FirstInteraction> {
        return this.withReadGenerationAsync(
            () => ({ reason: 'locked' }),
            async () => {
                if (signal?.aborted) {
                    return { reason: 'deadline' };
                }
                const first = this.db
                    .prepare('SELECT MIN(turn_index) AS turn_index FROM memories WHERE session_id = ?')
                    .get(session.id) as { turn_index: number | null };
                if (first.turn_index === null) {
                    return { reason: 'no_stored_turn_indexes' };
                }
                const row = this.db
                    .prepare(`SELECT ft.included, ft.filter_version, ft.omitted_before_chars, d.state,
                CASE WHEN length(CAST(ft.user_prompt AS BLOB)) + length(CAST(ft.assistant_response AS BLOB)) + COALESCE(length(CAST(ft.assistant_structure AS BLOB)), 0) <= ?
                    THEN ft.user_prompt END AS user_prompt,
                CASE WHEN length(CAST(ft.user_prompt AS BLOB)) + length(CAST(ft.assistant_response AS BLOB)) + COALESCE(length(CAST(ft.assistant_structure AS BLOB)), 0) <= ?
                    THEN ft.assistant_response END AS assistant_response,
                CASE WHEN length(CAST(ft.user_prompt AS BLOB)) + length(CAST(ft.assistant_response AS BLOB)) + COALESCE(length(CAST(ft.assistant_structure AS BLOB)), 0) <= ?
                    THEN ft.assistant_structure END AS assistant_structure,
                ${NOT_CURRENT_COPY_SQL} AS not_current
                FROM memories m LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                LEFT JOIN durable_capture_status d ON d.session_id = m.session_id
                WHERE m.session_id = ? AND m.turn_index = ?`)
                    .get(
                        SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                        SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                        SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                        session.id,
                        first.turn_index,
                    ) as
                    | {
                          included: number | null;
                          filter_version: number | null;
                          omitted_before_chars: number | null;
                          state: string | null;
                          user_prompt: string | null;
                          assistant_response: string | null;
                          assistant_structure: string | null;
                          not_current: number;
                      }
                    | undefined;
                if (
                    session.tool === 'opencode' &&
                    (row?.state === 'evicted' ||
                        row?.filter_version !== DURABLE_CAPTURE_FILTER_VERSION ||
                        row.not_current !== 0 ||
                        row.omitted_before_chars !== 0 ||
                        row.user_prompt === null ||
                        row.assistant_response === null)
                ) {
                    return { reason: 'first_interaction_requires_durable_capture' };
                }
                if (row?.state === 'evicted') {
                    return { reason: STORED_EVIDENCE_REASONS.evicted };
                }
                if (row?.filter_version == null) {
                    return { reason: STORED_EVIDENCE_REASONS.missing };
                }
                if (row.filter_version !== DURABLE_CAPTURE_FILTER_VERSION) {
                    return { reason: STORED_EVIDENCE_REASONS.filterVersionMismatch };
                }
                // Individually current evidence does not certify whole-session
                // coverage. A superseded copy can never supply this interaction.
                if (row.not_current !== 0) {
                    return { reason: STORED_EVIDENCE_REASONS.stale };
                }
                if (row.omitted_before_chars !== 0) {
                    return { reason: 'first_interaction_requires_durable_capture' };
                }
                if (row.user_prompt === null || row.assistant_response === null) {
                    return { reason: 'evidence_source_byte_budget' };
                }
                if (row.included === 1 && (containsSentinel(row.user_prompt) || containsSentinel(row.assistant_response))) {
                    return { reason: STORED_EVIDENCE_REASONS.selfInjected };
                }
                const projection: FilteredTurnProjection = {
                    included: row.included === 1,
                    filterVersion: row.filter_version,
                    userPrompt: row.user_prompt,
                    assistantResponse: row.assistant_response,
                    assistantStructure: this.readAssistantStructure(session.id, row.assistant_structure, row.assistant_response.length),
                    toolCalls: [],
                    omittedToolCallCount: 0,
                };
                const source: FirstInteraction['source'] = 'durable stored interaction';
                if (signal?.aborted) {
                    return { reason: 'deadline' };
                }
                if (!projection.included || !projection.assistantResponse.trim()) {
                    return { reason: 'first_interaction_has_no_response' };
                }
                if (
                    session.first_prompt_search === null ||
                    !matchesFirstPromptSearch(projection.userPrompt, session.first_prompt_search, true)
                ) {
                    return { reason: 'first_prompt_source_changed' };
                }
                return { projection, turnIndex: first.turn_index, source };
            },
        );
    }

    // Preserve roles from the adapters/storage. Rendered Markdown is content,
    // so its headings can never establish a user/assistant boundary.
    async evidenceWindow(session: ServedSession, lastN?: number, signal?: AbortSignal): Promise<EvidenceWindow> {
        const { turnIndexes: _, ...window } = await this.indexedEvidenceWindow(session, lastN, signal);
        return window;
    }

    // Resolves one indexed interaction from the complete, current-version
    // filtered copy stored in elepha's database. The provider transcript is
    // never reopened here, so evidence survives the source being removed and
    // a missing copy stays an explicit unavailable state.
    async indexedTurnEvidence(
        session: IndexedSourceSession & { expectedProjectPath: string },
        turnIndex: number,
        signal?: AbortSignal,
    ): Promise<IndexedTurnEvidence> {
        const unavailable = (reason: string): IndexedTurnEvidence => ({ state: 'unavailable', reason });
        return this.withReadGenerationAsync(
            () => unavailable('locked'),
            async () => {
                if (!Number.isSafeInteger(turnIndex) || turnIndex < 0) {
                    return unavailable('invalid_turn_index');
                }
                const deadline = AbortSignal.timeout(CURRENT_CHAT_EVIDENCE_DEADLINE_MS);
                const readSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
                const consent = new ConsentStore(this.db);
                const authorizedCheckout = (): string | undefined => {
                    if (Buffer.byteLength(session.expectedProjectPath, 'utf8') > CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES) {
                        return undefined;
                    }
                    try {
                        if (!statSync(session.expectedProjectPath).isDirectory()) {
                            return undefined;
                        }
                    } catch {
                        return undefined;
                    }
                    if (
                        consent.consentState(session.expectedProjectPath) !== 'approved' ||
                        consent.isRefusedForCapture(session.expectedProjectPath)
                    ) {
                        return undefined;
                    }
                    return canonicalizeExisting(session.expectedProjectPath);
                };
                const physicalCheckout = authorizedCheckout();
                if (physicalCheckout === undefined) {
                    return unavailable('checkout_not_consented');
                }
                const checkoutAuthorizationFailure = (): string | undefined => {
                    const currentCheckout = authorizedCheckout();
                    if (currentCheckout === undefined) {
                        return 'checkout_not_consented';
                    }
                    return samePath(currentCheckout, physicalCheckout) ? undefined : 'checkout_identity_changed';
                };
                const locator = readIndexedTurnLocator(
                    this.db,
                    session,
                    session.expectedProjectPath,
                    turnIndex,
                    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
                    SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                );
                if (readSignal.aborted) {
                    return unavailable('deadline');
                }
                if (locator === undefined) {
                    return unavailable('indexed_turn_unavailable');
                }
                // A stored turn without a coverage row has no retained current
                // copy; the durable checks below name that gap.
                const indexed = locator.coverage !== null;
                if (indexed && locator.filterVersion !== DURABLE_CAPTURE_FILTER_VERSION) {
                    return unavailable('indexed_turn_filter_version_mismatch');
                }
                if (indexed && (!locator.sourceDigest || !/^[a-f0-9]{64}$/.test(locator.sourceDigest))) {
                    return unavailable('indexed_turn_digest_unavailable');
                }
                if (locator.coverage === 'excluded') {
                    return unavailable('indexed_turn_filtered');
                }
                // Only the filtered copy in elepha's own database is evidence here.
                // A missing or untrustworthy copy is a coverage gap, never a
                // reason to reopen the provider transcript.
                if (locator.durableState === null) {
                    return unavailable('indexed_turn_evidence_missing');
                }
                if (locator.durableState !== 'complete') {
                    return unavailable(`indexed_turn_evidence_${locator.durableState}`);
                }
                if (locator.durableFilterVersion === null) {
                    return unavailable('indexed_turn_evidence_missing');
                }
                if (
                    locator.durableVersion !== DURABLE_CAPTURE_FILTER_VERSION ||
                    locator.durableFilterVersion !== DURABLE_CAPTURE_FILTER_VERSION
                ) {
                    return unavailable('indexed_turn_evidence_filter_version_mismatch');
                }
                // A reingest that retains a replacement writes the copy and its
                // coverage row in one transaction, stamped with the reingest time.
                // A reingested turn whose copy is older, or has no coverage row,
                // still holds superseded text; the coverage test does not depend
                // on the two timestamps differing.
                if (
                    locator.memoryReingestedAt !== null &&
                    (!indexed || locator.durableCapturedAt === null || locator.durableCapturedAt < locator.memoryReingestedAt)
                ) {
                    return unavailable('indexed_turn_evidence_stale');
                }
                if (locator.durableIncluded !== 1) {
                    return unavailable('indexed_turn_filtered');
                }
                if (locator.durableOmittedBeforeChars !== 0) {
                    return unavailable('indexed_turn_evidence_truncated');
                }
                if (!indexed) {
                    return unavailable('indexed_turn_evidence_missing');
                }
                const inconsistent = this.db
                    .prepare(`SELECT 1 FROM memories m LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                              WHERE m.session_id = ? AND m.turn_index = ? AND ${NOT_CURRENT_COPY_SQL}`)
                    .get(session.id, turnIndex);
                if (inconsistent !== undefined) {
                    return unavailable('indexed_turn_evidence_stale');
                }
                const toolCalls = locator.durableToolCalls === null ? undefined : decodedToolCalls(locator.durableToolCalls);
                if (locator.durableUserPrompt === null || locator.durableAssistantResponse === null || toolCalls === undefined) {
                    return unavailable('indexed_turn_evidence_unreadable');
                }
                if (containsSentinel(locator.durableUserPrompt) || containsSentinel(locator.durableAssistantResponse)) {
                    return unavailable('indexed_turn_evidence_self_injected');
                }
                const projection: FilteredTurnProjection = {
                    included: true,
                    filterVersion: locator.durableFilterVersion,
                    userPrompt: locator.durableUserPrompt,
                    assistantResponse: locator.durableAssistantResponse,
                    assistantStructure: this.readAssistantStructure(
                        session.id,
                        locator.durableAssistantStructure,
                        locator.durableAssistantResponse.length,
                    ),
                    toolCalls,
                    omittedToolCallCount: locator.durableOmittedToolCallCount ?? 0,
                };
                const authorizationFailure = checkoutAuthorizationFailure();
                if (authorizationFailure !== undefined) {
                    return unavailable(authorizationFailure);
                }
                return { state: 'available', turnIndex, projection, source: 'durable' };
            },
        );
    }

    async indexedEvidenceWindow(session: IndexedSourceSession, lastN?: number, signal?: AbortSignal): Promise<IndexedEvidenceWindow> {
        const unavailable = (reason?: string): IndexedEvidenceWindow => ({ returned: 0, omitted: 0, total: 0, reason });
        return this.withReadGenerationAsync(
            () => unavailable('locked'),
            async () => {
                const boundedLastN = lastN === undefined ? undefined : Math.min(Math.max(1, Math.trunc(lastN)), MAX_GET_SESSION_LAST_N);
                const bounds = { lastN: boundedLastN, charBudget: SESSION_CHAR_BUDGET, nonce: randomUUID() };
                const durable = this.durableTurns(session, bounds, signal);
                if (!durable.complete || durable.projections === undefined) {
                    if (!durable.complete && session.tool === 'opencode') {
                        // Legacy SQLite cannot authenticate current-chat source
                        // evidence by opened-file identity.
                        return unavailable(
                            session.expectedProjectPath === undefined
                                ? 'evidence_source_requires_durable_capture'
                                : 'opencode_source_identity_unverified',
                        );
                    }
                    return unavailable(durable.reason);
                }
                const projections = durable.projections;
                const turnIndexes = durable.turnIndexes ?? [];
                const omitted = durable.omittedBefore ?? 0;
                return { projections, turnIndexes, returned: projections.length, omitted, total: projections.length + omitted };
            },
        );
    }

    private durableTurns(session: Pick<ServedSession, 'id'>, bounds: TurnCollectionBounds, signal?: AbortSignal): DurableTurnCollection {
        if (signal?.aborted) {
            return { complete: false, present: false, reason: 'deadline' };
        }
        const status = this.db
            .prepare(
                `SELECT state, filter_version
                 FROM durable_capture_status
                 WHERE session_id = ?`,
            )
            .get(session.id) as { state: string; filter_version: number } | undefined;
        if (status === undefined) {
            const capturedRow = this.db
                .prepare(
                    `SELECT 1
                     FROM filtered_turns ft
                     JOIN memories m ON m.id = ft.memory_id
                     WHERE m.session_id = ?
                     LIMIT 1`,
                )
                .get(session.id);
            return {
                complete: false,
                present: capturedRow !== undefined,
                reason: capturedRow === undefined ? STORED_EVIDENCE_REASONS.missing : STORED_EVIDENCE_REASONS.incomplete,
            };
        }
        if (status.state === 'evicted') {
            return { complete: false, present: false, reason: STORED_EVIDENCE_REASONS.evicted };
        }
        if (status.filter_version !== DURABLE_CAPTURE_FILTER_VERSION) {
            return { complete: false, present: true, reason: STORED_EVIDENCE_REASONS.filterVersionMismatch };
        }
        if (status.state !== 'complete' && status.state !== 'complete_truncated') {
            return { complete: false, present: true, reason: `durable_capture_${status.state}` };
        }
        const stale = this.db
            .prepare(
                `SELECT 1 FROM memories m JOIN filtered_turns ft ON ft.memory_id = m.id
                 WHERE m.session_id = ? AND ${SUPERSEDED_COPY}
                 LIMIT 1`,
            )
            .get(session.id);
        if (stale !== undefined) {
            // Reingest invalidated this copy; only retained current evidence
            // may supply the session, never the superseded text.
            return { complete: true, present: true, reason: STORED_EVIDENCE_REASONS.stale };
        }
        const uncovered = this.db
            .prepare(
                `SELECT ft.filter_version
                 FROM memories m
                 LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                 WHERE m.session_id = ?
                   AND ${NOT_CURRENT_COPY_SQL}
                 LIMIT 1`,
            )
            .get(session.id) as { filter_version: number | null } | undefined;
        if (uncovered !== undefined) {
            return {
                complete: false,
                present: true,
                reason:
                    uncovered.filter_version !== null && uncovered.filter_version !== DURABLE_CAPTURE_FILTER_VERSION
                        ? STORED_EVIDENCE_REASONS.filterVersionMismatch
                        : STORED_EVIDENCE_REASONS.incomplete,
            };
        }

        const rows = this.db
            .prepare(
                `SELECT m.turn_index, ft.included,
                        CASE WHEN length(CAST(ft.user_prompt AS BLOB)) + length(CAST(ft.assistant_response AS BLOB))
                            + length(CAST(ft.tool_calls AS BLOB)) <= ? THEN ft.user_prompt END AS user_prompt,
                        CASE WHEN length(CAST(ft.user_prompt AS BLOB)) + length(CAST(ft.assistant_response AS BLOB))
                            + length(CAST(ft.tool_calls AS BLOB)) <= ? THEN ft.assistant_response END AS assistant_response,
                        CASE WHEN length(CAST(ft.assistant_structure AS BLOB)) <= ? THEN ft.assistant_structure
                             WHEN ft.assistant_structure IS NOT NULL THEN '{}' END AS assistant_structure,
                        CASE WHEN length(CAST(ft.user_prompt AS BLOB)) + length(CAST(ft.assistant_response AS BLOB))
                            + length(CAST(ft.tool_calls AS BLOB)) <= ? THEN ft.tool_calls END AS tool_calls,
                        ft.omitted_tool_call_count, ft.filter_version
                 FROM memories m
                 JOIN filtered_turns ft ON ft.memory_id = m.id
                 WHERE m.session_id = ?
                 ORDER BY m.turn_index`,
            )
            .iterate(
                SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                session.id,
            ) as Iterable<StoredFilteredTurnRow>;
        const retained = new Map<number, RetainedFilteredTurn>();
        let renderedTurns = 0;
        let omittedBefore = 0;
        let retainedRenderedChars = 0;
        try {
            for (const row of rows) {
                if (signal?.aborted) {
                    return { complete: true, present: true, reason: 'deadline' };
                }
                if (row.user_prompt === null || row.assistant_response === null || row.tool_calls === null) {
                    return { complete: true, present: true, reason: 'evidence_source_byte_budget' };
                }
                const toolCalls = decodedToolCalls(row.tool_calls);
                if (toolCalls === undefined) {
                    return { complete: false, present: true, reason: STORED_EVIDENCE_REASONS.unreadable };
                }
                if (row.included === 1 && (containsSentinel(row.user_prompt) || containsSentinel(row.assistant_response))) {
                    return { complete: false, present: true, reason: STORED_EVIDENCE_REASONS.selfInjected };
                }
                const projection: FilteredTurnProjection = {
                    filterVersion: row.filter_version,
                    included: row.included === 1,
                    userPrompt: row.user_prompt,
                    assistantResponse: row.assistant_response,
                    assistantStructure: this.readAssistantStructure(session.id, row.assistant_structure, row.assistant_response.length),
                    toolCalls,
                    omittedToolCallCount: row.omitted_tool_call_count,
                };
                const rendered = renderFilteredTurn(projection, renderedTurns + 1);
                if (rendered === null) {
                    continue;
                }
                renderedTurns += 1;
                const framedLength = dataBlockOpen(bounds.nonce).length + 1 + rendered.length + 1 + dataBlockClose(bounds.nonce).length;
                retainedRenderedChars += framedLength + (retained.size === 0 ? 1 : RAW_TURN_SEPARATOR.length);
                retained.set(row.turn_index, { projection, renderedLength: framedLength });
                while ((bounds.lastN !== undefined && retained.size > bounds.lastN) || retainedRenderedChars > bounds.charBudget) {
                    const oldest = retained.entries().next().value;
                    if (oldest === undefined) {
                        break;
                    }
                    const [oldestIndex, oldestTurn] = oldest;
                    const oldestContribution = oldestTurn.renderedLength + (retained.size === 1 ? 1 : RAW_TURN_SEPARATOR.length);
                    retained.delete(oldestIndex);
                    retainedRenderedChars -= oldestContribution;
                    omittedBefore += 1;
                }
            }
        } catch {
            return { complete: false, present: true, reason: STORED_EVIDENCE_REASONS.unreadable };
        }
        return {
            complete: true,
            present: true,
            projections: [...retained.values()].map((entry) => entry.projection),
            turnIndexes: [...retained.keys()],
            omittedBefore,
        };
    }

    private readAssistantStructure(sessionId: number, value: string | null, textLength: number): AssistantStructure | undefined {
        try {
            return decodeAssistantStructure(value, textLength);
        } catch {
            console.warn(`[elepha] invalid assistant phase metadata in stored session ${sessionId}; treating response as unclassified`);
            return undefined;
        }
    }

    private async opencodeSourceTurns(
        session: IndexedSourceSession & { tool: 'opencode' },
        signal?: AbortSignal,
        storedIndexes?: ReadonlySet<number>,
        bounds?: TurnCollectionBounds,
        maxReadBytes?: number,
    ): Promise<SourceTurnCollection> {
        if (session.source_format === 'opencode-v2') {
            // V2 SQLite is not bound to the opened inode here; only the verified
            // filtered copy may serve this segment.
            return { reason: 'opencode_v2_requires_durable_capture', sourceUnavailable: true };
        }
        let opened: OpenedSourceTurns | undefined;
        try {
            const sourceDb = openOpencodeDbReadonly(session.source_path);
            const currentChatRead = session.expectedProjectPath !== undefined;
            const coverage = { omittedBefore: 0 };
            opened = {
                turns: [],
                close: () => {
                    sourceDb.close();
                },
            };
            if (currentChatRead) {
                sourceDb.exec('BEGIN');
            }
            const sourceSession: OpenedSessionRow | undefined = currentChatRead
                ? this.opencodeAdapter.boundedSessionById(sourceDb, session.native_id, CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES)
                : this.opencodeAdapter.dirtySessions(sourceDb).find((candidate) => candidate.sessionId === session.native_id);
            if (!sourceSession) {
                return { reason: 'transcript_unreadable', sourceUnavailable: true };
            }
            opened.turns = currentChatRead
                ? this.opencodeAdapter.parseSessionTurnsBounded(
                      sourceDb,
                      sourceSession,
                      maxReadBytes ?? SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                      CURRENT_CHAT_OPENCODE_MAX_SOURCE_ROWS,
                      coverage,
                      signal,
                  )
                : this.opencodeAdapter.parseSessionTurns(sourceDb, sourceSession, undefined, { closeTrailingOnIdle: true });
            opened.coverage = currentChatRead ? coverage : undefined;
            if (!opened) {
                return { reason: 'transcript_unreadable', sourceUnavailable: true };
            }

            const indexes = storedIndexes ?? new Set(this.storedTurnRecallFields(session).keys());
            if (indexes.size === 0) {
                return { reason: 'no_stored_turn_indexes' };
            }
            const turns: ParsedTurn[] = [];
            const retained = new Map<number, RetainedTurn>();
            let matchedTurns = 0;
            let renderedTurns = 0;
            let omittedBefore = 0;
            let retainedRenderedChars = 0;
            let highWaterTurns = 0;
            let highWaterRenderedChars = 0;
            const replayInjections = new InjectionStore(this.db, { includePersistedMcp: session.expectedProjectPath !== undefined });
            for await (const turn of opened.turns) {
                if (isMemoryLocked(this.db)) {
                    return { reason: 'locked' };
                }
                if (signal?.aborted) {
                    return { reason: 'deadline' };
                }
                if (turn.droppedReason !== undefined) {
                    if (turn.droppedReason === 'elepha-mcp' && !replayInjections.rememberElephaMcpReceipts(turn)) {
                        return { reason: 'self_ingestion_protection_incomplete' };
                    }
                    continue;
                }
                const quoteBackStatus = replayInjections.quoteBackStatus(turn);
                if (quoteBackStatus === 'incomplete') {
                    return { reason: 'self_ingestion_protection_incomplete' };
                }
                if (quoteBackStatus === 'match') {
                    continue;
                }
                if (indexes.has(turn.turnIndex)) {
                    if (
                        session.expectedProjectPath !== undefined &&
                        (turn.tool !== session.tool ||
                            turn.sessionId !== session.native_id ||
                            !samePath(canonicalizeExisting(turn.projectPath), canonicalizeExisting(session.expectedProjectPath)))
                    ) {
                        return { reason: 'transcript_identity_mismatch' };
                    }
                    matchedTurns += 1;
                    if (bounds === undefined) {
                        turns.push(turn);
                    } else {
                        const rendered = renderRawTurn(turn, renderedTurns + 1);
                        if (rendered !== null) {
                            renderedTurns += 1;
                            const framedLength =
                                dataBlockOpen(bounds.nonce).length + 1 + rendered.length + 1 + dataBlockClose(bounds.nonce).length;
                            retainedRenderedChars += framedLength + (retained.size === 0 ? 1 : RAW_TURN_SEPARATOR.length);
                            retained.set(turn.turnIndex, { turn, renderedLength: framedLength });
                            while (
                                (bounds.lastN !== undefined && retained.size > bounds.lastN) ||
                                retainedRenderedChars > bounds.charBudget
                            ) {
                                const oldest = retained.entries().next().value;
                                if (oldest === undefined) {
                                    break;
                                }
                                const [oldestIndex, oldestTurn] = oldest;
                                const oldestContribution =
                                    oldestTurn.renderedLength + (retained.size === 1 ? 1 : RAW_TURN_SEPARATOR.length);
                                retained.delete(oldestIndex);
                                retainedRenderedChars -= oldestContribution;
                                omittedBefore += 1;
                            }
                            highWaterTurns = Math.max(highWaterTurns, retained.size);
                            highWaterRenderedChars = Math.max(highWaterRenderedChars, retainedRenderedChars);
                        }
                    }
                    if (matchedTurns === indexes.size) {
                        break;
                    }
                }
            }
            if (signal?.aborted) {
                return { reason: 'deadline' };
            }
            if (matchedTurns === 0) {
                return { reason: 'transcript_reparse_empty' };
            }
            if (bounds === undefined) {
                return { turns };
            }
            return {
                turns: [...retained.values()].map((entry) => entry.turn),
                omittedBefore: omittedBefore + (opened.coverage?.omittedBefore ?? 0),
                retentionHighWater: { turns: highWaterTurns, renderedChars: highWaterRenderedChars },
            };
        } catch (error) {
            return {
                reason: signal?.aborted
                    ? 'deadline'
                    : error instanceof TranscriptReadBudgetError
                      ? 'evidence_source_byte_budget'
                      : 'transcript_unreadable',
            };
        } finally {
            await opened?.close();
        }
    }

    async render(
        session: ServedSession,
        lastN?: number,
        signal?: AbortSignal,
        charBudget: number = SESSION_CHAR_BUDGET,
    ): Promise<{
        episode?: BoundedEpisode;
        reason?: string;
        state?: 'locked';
        content_coverage?: LockedContentCoverage;
    }> {
        const locked = () => ({ state: 'locked' as const, reason: 'locked', content_coverage: LOCKED_CONTENT_COVERAGE });
        return this.withReadGenerationAsync(locked, async () => {
            const nonce = randomUUID();
            const boundedLastN = lastN === undefined ? undefined : Math.min(Math.max(1, Math.trunc(lastN)), MAX_GET_SESSION_LAST_N);
            const durable = this.durableTurns(session, { lastN: boundedLastN, charBudget, nonce }, signal);
            if (durable.complete) {
                if (durable.projections === undefined) {
                    return { reason: durable.reason };
                }
                return {
                    episode: boundedFilteredRender(durable.projections, boundedLastN, charBudget, nonce, durable.omittedBefore),
                };
            }
            if (session.tool !== 'opencode') {
                return { reason: durable.reason };
            }
            if (session.source_format === 'opencode-v2') {
                return { reason: 'opencode_v2_requires_durable_capture' };
            }
            const parsed = await this.opencodeSourceTurns({ ...session, tool: 'opencode' }, signal, undefined, {
                lastN: boundedLastN,
                charBudget,
                nonce,
            });
            return parsed.turns === undefined
                ? { reason: parsed.sourceUnavailable && durable.present ? 'durable_capture_incomplete' : parsed.reason }
                : { episode: boundedRender(parsed.turns, boundedLastN, charBudget, nonce, parsed.omittedBefore) };
        });
    }
}

export function boundedRender(
    turns: Iterable<ParsedTurn>,
    lastN?: number,
    charBudget: number = SESSION_CHAR_BUDGET,
    nonce: string = randomUUID(),
    omittedBefore: number = 0,
): BoundedEpisode {
    return boundedRenderedPieces(renderableRawTurns(turns, omittedBefore), lastN, charBudget, nonce, omittedBefore);
}

function boundedFilteredRender(
    projections: Iterable<FilteredTurnProjection>,
    lastN?: number,
    charBudget: number = SESSION_CHAR_BUDGET,
    nonce: string = randomUUID(),
    omittedBefore: number = 0,
): BoundedEpisode {
    return boundedRenderedPieces(renderableFilteredTurns(projections, omittedBefore), lastN, charBudget, nonce, omittedBefore);
}

function boundedRenderedPieces(
    renderedPieces: Iterable<string>,
    lastN: number | undefined,
    charBudget: number,
    nonce: string,
    omittedBefore: number,
): BoundedEpisode {
    const pieces = [...renderedPieces].map((piece) => `${dataBlockOpen(nonce)}\n${piece}\n${dataBlockClose(nonce)}`);
    const eligible = lastN === undefined ? pieces : pieces.slice(-lastN);
    const chosen: string[] = [];
    let renderedChars = 0;
    for (let index = eligible.length - 1; index >= 0; index--) {
        const piece = eligible[index];
        if (piece === undefined) {
            continue;
        }
        const addition = piece.length + (chosen.length === 0 ? 1 : RAW_TURN_SEPARATOR.length);
        if (renderedChars + addition > charBudget) {
            break;
        }
        chosen.unshift(piece);
        renderedChars += addition;
    }
    const total = omittedBefore + pieces.length;
    const omitted = total - chosen.length;
    const suffix = omitted === 0 ? '' : `\n${omissionMarker(omitted, chosen.length, total)}\n`;
    return {
        text: `${chosen.join(RAW_TURN_SEPARATOR)}${chosen.length > 0 ? '\n' : ''}${suffix}`,
        returned: chosen.length,
        omitted,
        total,
        renderedChars,
        nonce,
    };
}
