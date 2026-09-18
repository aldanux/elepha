// Tool-neutral read path for historical episodes. It owns transcript reparse
// and the 20k newest-first budget; callers own their transport/envelopes.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import { TranscriptReadBudgetError } from '../adapters/base.js';
import { defaultAdapters, sessionAdapterFor } from '../adapters/index.js';
import { OpencodeAdapter, openOpencodeDbReadonly } from '../adapters/opencode.js';
import {
    DURABLE_CAPTURE_FILTER_VERSION,
    MAX_GET_SESSION_LAST_N,
    RECENT_SESSION_WINDOW_MS,
    SESSION_CHAR_BUDGET,
    SESSION_EVIDENCE_SOURCE_MAX_BYTES,
} from '../config/constants.js';
import { type AssistantStructure, decodeAssistantStructure } from '../rendering/assistant-structure.js';
import { type FilterableToolCall, type FilteredTurnProjection, filterTurn } from '../rendering/filtered-turn.js';
import {
    omissionMarker,
    RAW_TURN_SEPARATOR,
    renderableFilteredTurns,
    renderableRawTurns,
    renderFilteredTurn,
    renderRawTurn,
} from '../rendering/raw-turn-renderer.js';
import { openProviderTranscript, type ProviderTranscriptOpener } from '../security/provider-transcript.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { matchesFirstPromptSearch } from '../storage/first-prompt-search.js';
import { InjectionStore } from '../storage/injection-store.js';
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
    readProjectSessionAggregates,
    readProjectSessions,
    readSessionById,
    SERVED_SESSION_KIND_ELIGIBILITY,
    type ServedSession,
    safeStringArray,
} from '../storage/session-read-model.js';
import { UNTITLED_EPISODE } from '../storage/session-title.js';
import { hydrateTurnDecisions } from '../storage/turn-store.js';
import {
    type ParsedTurn,
    type SessionAdapterMap,
    SUPPORTED_TOOLS,
    TOOL_METADATA,
    type ToolName,
    type TurnDecision,
} from '../types/index.js';
import { dataBlockClose, dataBlockOpen } from './instructions.js';

export type { ServedSession } from '../storage/session-read-model.js';

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
    source?: 'durable stored interaction' | 'provider transcript interaction';
    reason?: string;
}

export interface EvidenceWindow {
    projections?: FilteredTurnProjection[];
    returned: number;
    omitted: number;
    total: number;
    reason?: string;
}

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
    user_prompt: string;
    assistant_response: string;
    assistant_structure: string | null;
    tool_calls: string;
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
}

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

export class SessionReader {
    private readonly adapters: SessionAdapterMap;
    private readonly opencodeAdapter = new OpencodeAdapter();
    private readonly sessionsMemo = new Map<string, ServedSession[]>();
    private readonly consentedSessionsMemo = new Map<string, ServedSession[]>();

    constructor(
        private readonly db: Database.Database,
        adapters: SessionAdapterMap = defaultAdapters(),
        private readonly openTranscript: ProviderTranscriptOpener = openProviderTranscript,
    ) {
        this.adapters = adapters;
    }

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
                              AND (ft.memory_id IS NULL OR ft.filter_version <> ?)
                        ) AS has_uncovered
                 FROM requested
                 JOIN sessions s ON s.id = requested.id
                 LEFT JOIN durable_capture_status dcs ON dcs.session_id = s.id
                 WHERE ${SERVED_SESSION_KIND_ELIGIBILITY} AND NOT EXISTS (
                           SELECT 1 FROM purged_transcripts p
                           WHERE p.tool = s.tool AND p.native_id = s.native_id
                       )
                   AND NOT EXISTS (
                           SELECT 1 FROM incognito_transcripts i
                           WHERE i.tool = s.tool AND i.native_id = s.native_id
                       )
                 ORDER BY s.id`,
                )
                .all(JSON.stringify(requestedIds), DURABLE_CAPTURE_FILTER_VERSION) as Array<{
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
             WHERE filtered_turns_fts MATCH ?
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
                         WHERE session_id = ? AND staged_at IS NOT NULL AND validated_epoch = validation_epoch
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
                    row.durable_included === null || row.durable_filter_version === null || toolCalls === undefined
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
                const first = this.db
                    .prepare('SELECT MIN(turn_index) AS turn_index FROM memories WHERE session_id = ?')
                    .get(session.id) as { turn_index: number | null };
                if (first.turn_index === null) {
                    return { reason: 'no_stored_turn_indexes' };
                }
                const row = this.db
                    .prepare(`SELECT ft.included, ft.filter_version, ft.omitted_before_chars,
                CASE WHEN length(CAST(ft.user_prompt AS BLOB)) + length(CAST(ft.assistant_response AS BLOB)) + COALESCE(length(CAST(ft.assistant_structure AS BLOB)), 0) <= ?
                    THEN ft.user_prompt END AS user_prompt,
                CASE WHEN length(CAST(ft.user_prompt AS BLOB)) + length(CAST(ft.assistant_response AS BLOB)) + COALESCE(length(CAST(ft.assistant_structure AS BLOB)), 0) <= ?
                    THEN ft.assistant_response END AS assistant_response,
                CASE WHEN length(CAST(ft.user_prompt AS BLOB)) + length(CAST(ft.assistant_response AS BLOB)) + COALESCE(length(CAST(ft.assistant_structure AS BLOB)), 0) <= ?
                    THEN ft.assistant_structure END AS assistant_structure
                FROM memories m JOIN filtered_turns ft ON ft.memory_id = m.id
                LEFT JOIN durable_capture_status d ON d.session_id = m.session_id
                WHERE m.session_id = ? AND m.turn_index = ? AND COALESCE(d.state, '') <> 'evicted'`)
                    .get(
                        SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                        SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                        SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                        session.id,
                        first.turn_index,
                    ) as
                    | {
                          included: number;
                          filter_version: number;
                          omitted_before_chars: number;
                          user_prompt: string | null;
                          assistant_response: string | null;
                          assistant_structure: string | null;
                      }
                    | undefined;
                let projection: FilteredTurnProjection | undefined;
                let source: FirstInteraction['source'] = 'durable stored interaction';
                if (
                    row?.filter_version === DURABLE_CAPTURE_FILTER_VERSION &&
                    row.omitted_before_chars === 0 &&
                    row.user_prompt !== null &&
                    row.assistant_response !== null
                ) {
                    projection = {
                        included: row.included === 1,
                        filterVersion: row.filter_version,
                        userPrompt: row.user_prompt,
                        assistantResponse: row.assistant_response,
                        assistantStructure: this.readAssistantStructure(session.id, row.assistant_structure, row.assistant_response.length),
                        toolCalls: [],
                        omittedToolCallCount: 0,
                    };
                    if (session.tool === 'codex' && projection.assistantStructure === undefined) {
                        const parsed = await this.sourceTurns(
                            session,
                            signal,
                            new Set([first.turn_index]),
                            undefined,
                            SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                        );
                        projection = this.enrichAssistantStructure(projection, parsed.turns?.[0]);
                    }
                } else {
                    // OpenCode's DB adapter has no byte-bounded directed read yet.
                    // Do not silently replace an incomplete first interaction.
                    if (session.tool === 'opencode') {
                        return { reason: 'first_interaction_requires_durable_capture' };
                    }
                    const parsed = await this.sourceTurns(
                        session,
                        signal,
                        new Set([first.turn_index]),
                        undefined,
                        SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                    );
                    const turn = parsed.turns?.[0];
                    if (turn === undefined) {
                        return { reason: parsed.reason };
                    }
                    if (turn.droppedReason !== undefined) {
                        return { reason: 'first_interaction_filtered' };
                    }
                    projection = filterTurn(turn);
                    source = 'provider transcript interaction';
                }
                if (signal?.aborted) {
                    return { reason: 'deadline' };
                }
                if (!projection.included || !projection.assistantResponse.trim()) {
                    return { reason: 'first_interaction_has_no_response' };
                }
                if (
                    session.first_prompt_search === null ||
                    !matchesFirstPromptSearch(projection.userPrompt, session.first_prompt_search, source === 'durable stored interaction')
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
        const unavailable = (reason?: string): EvidenceWindow => ({ returned: 0, omitted: 0, total: 0, reason });
        return this.withReadGenerationAsync(
            () => unavailable('locked'),
            async () => {
                const boundedLastN = lastN === undefined ? undefined : Math.min(Math.max(1, Math.trunc(lastN)), MAX_GET_SESSION_LAST_N);
                const bounds = { lastN: boundedLastN, charBudget: SESSION_CHAR_BUDGET, nonce: randomUUID() };
                const durable = this.durableTurns(session, bounds, signal);
                let projections: FilteredTurnProjection[];
                let omitted: number;
                if (durable.complete) {
                    if (durable.projections === undefined) {
                        return unavailable(durable.reason);
                    }
                    projections = durable.projections;
                    omitted = durable.omittedBefore ?? 0;
                    if (session.tool === 'codex' && projections.some((projection) => projection.assistantStructure === undefined)) {
                        const parsed = await this.sourceTurns(
                            session,
                            signal,
                            new Set(durable.turnIndexes),
                            bounds,
                            SESSION_EVIDENCE_SOURCE_MAX_BYTES,
                        );
                        const sourceByIndex = new Map(parsed.turns?.map((turn) => [turn.turnIndex, turn]));
                        projections = projections.map((projection, index) =>
                            projection.assistantStructure === undefined
                                ? this.enrichAssistantStructure(projection, sourceByIndex.get(durable.turnIndexes?.[index] ?? -1))
                                : projection,
                        );
                    }
                } else {
                    if (session.tool === 'opencode') {
                        return unavailable('evidence_source_requires_durable_capture');
                    }
                    const parsed = await this.sourceTurns(session, signal, undefined, bounds, SESSION_EVIDENCE_SOURCE_MAX_BYTES);
                    if (parsed.turns === undefined) {
                        return unavailable(parsed.reason);
                    }
                    if (parsed.turns.some((turn) => turn.droppedReason !== undefined)) {
                        return unavailable('evidence_source_turn_filtered');
                    }
                    projections = parsed.turns.map(filterTurn).filter((projection) => projection.included);
                    omitted = parsed.omittedBefore ?? 0;
                }
                return { projections, returned: projections.length, omitted, total: projections.length + omitted };
            },
        );
    }

    private durableTurns(session: Pick<ServedSession, 'id'>, bounds: TurnCollectionBounds, signal?: AbortSignal): DurableTurnCollection {
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
            return { complete: false, present: capturedRow !== undefined };
        }
        if (status.state === 'evicted') {
            return { complete: false, present: false };
        }
        if (
            (status.state !== 'complete' && status.state !== 'complete_truncated') ||
            status.filter_version !== DURABLE_CAPTURE_FILTER_VERSION
        ) {
            return { complete: false, present: true };
        }
        const uncovered = this.db
            .prepare(
                `SELECT 1
                 FROM memories m
                 LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                 WHERE m.session_id = ?
                   AND (ft.memory_id IS NULL OR ft.filter_version <> ?)
                 LIMIT 1`,
            )
            .get(session.id, DURABLE_CAPTURE_FILTER_VERSION);
        if (uncovered !== undefined) {
            return { complete: false, present: true };
        }

        const rows = this.db
            .prepare(
                `SELECT m.turn_index, ft.included, ft.user_prompt, ft.assistant_response,
                        CASE WHEN length(CAST(ft.assistant_structure AS BLOB)) <= ? THEN ft.assistant_structure
                             WHEN ft.assistant_structure IS NOT NULL THEN '{}' END AS assistant_structure, ft.tool_calls,
                        ft.omitted_tool_call_count, ft.filter_version
                 FROM memories m
                 JOIN filtered_turns ft ON ft.memory_id = m.id
                 WHERE m.session_id = ?
                 ORDER BY m.turn_index`,
            )
            .iterate(SESSION_EVIDENCE_SOURCE_MAX_BYTES, session.id) as Iterable<StoredFilteredTurnRow>;
        const retained = new Map<number, RetainedFilteredTurn>();
        let renderedTurns = 0;
        let omittedBefore = 0;
        let retainedRenderedChars = 0;
        try {
            for (const row of rows) {
                if (signal?.aborted) {
                    return { complete: true, present: true, reason: 'deadline' };
                }
                const toolCalls = decodedToolCalls(row.tool_calls);
                if (toolCalls === undefined) {
                    return { complete: false, present: true };
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
            return { complete: false, present: true };
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

    // Historical rows remain untouched. Borrow phase only from a safely read
    // source whose complete filtered response still matches the stored value.
    private enrichAssistantStructure(stored: FilteredTurnProjection, turn: ParsedTurn | undefined): FilteredTurnProjection {
        if (turn === undefined || turn.droppedReason !== undefined) {
            return stored;
        }
        const current = filterTurn(turn);
        return current.included &&
            escapeShellSyntax(current.userPrompt) === stored.userPrompt &&
            escapeShellSyntax(current.assistantResponse) === stored.assistantResponse
            ? { ...current, toolCalls: stored.toolCalls, omittedToolCallCount: stored.omittedToolCallCount }
            : stored;
    }

    async turns(
        session: ServedSession,
        signal?: AbortSignal,
        storedIndexes?: ReadonlySet<number>,
        bounds?: TurnCollectionBounds,
    ): Promise<TurnCollection> {
        const locked = (): TurnCollection => ({ state: 'locked', reason: 'locked', content_coverage: LOCKED_CONTENT_COVERAGE });
        return this.withReadGenerationAsync(locked, async () => {
            const { sourceUnavailable: _, ...result } = await this.sourceTurns(session, signal, storedIndexes, bounds);
            return result;
        });
    }

    private async sourceTurns(
        session: ServedSession,
        signal?: AbortSignal,
        storedIndexes?: ReadonlySet<number>,
        bounds?: TurnCollectionBounds,
        maxReadBytes?: number,
    ): Promise<SourceTurnCollection> {
        let opened: OpenedSourceTurns | undefined;
        try {
            if (session.tool === 'opencode') {
                const sourceDb = openOpencodeDbReadonly(session.source_path);
                const sourceSession = this.opencodeAdapter
                    .dirtySessions(sourceDb)
                    .find((candidate) => candidate.sessionId === session.native_id);
                if (!sourceSession) {
                    sourceDb.close();
                    return { reason: 'transcript_unreadable', sourceUnavailable: true };
                }
                opened = {
                    turns: this.opencodeAdapter.parseSessionTurns(sourceDb, sourceSession, undefined, { closeTrailingOnIdle: true }),
                    close: () => {
                        sourceDb.close();
                    },
                };
            } else {
                const transcript = await this.openTranscript(session.tool, session.source_path);
                if ('reason' in transcript) {
                    return { reason: transcript.reason, sourceUnavailable: true };
                }
                const adapter = sessionAdapterFor(this.adapters, session.tool);
                if (!adapter) {
                    await transcript.handle.close();
                    return { reason: 'transcript_unreadable', sourceUnavailable: true };
                }
                opened = {
                    turns: adapter.parseTurns(session.source_path, undefined, {
                        closeTrailingOnIdle: true,
                        handle: transcript.handle,
                        signal,
                        maxReadBytes,
                    }),
                    close: () => transcript.handle.close(),
                };
            }
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
            const replayInjections = new InjectionStore(this.db, { includePersistedMcp: false });
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
                omittedBefore,
                retentionHighWater: { turns: highWaterTurns, renderedChars: highWaterRenderedChars },
            };
        } catch (error) {
            return { reason: error instanceof TranscriptReadBudgetError ? 'evidence_source_byte_budget' : 'transcript_unreadable' };
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
            const parsed = await this.sourceTurns(session, signal, undefined, { lastN: boundedLastN, charBudget, nonce });
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
