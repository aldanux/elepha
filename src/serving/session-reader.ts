// Tool-neutral read path for historical episodes. It owns transcript reparse
// and the 20k newest-first budget; callers own their transport/envelopes.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { defaultAdapters } from '../adapters/index.js';
import {
    AUTO_BRIEF_AGGREGATE_FILE_LIMIT,
    AUTO_BRIEF_AGGREGATE_SESSION_LIMIT,
    MAX_GET_SESSION_LAST_N,
    RECENT_SESSION_WINDOW_MS,
    SESSION_CHAR_BUDGET,
} from '../config/constants.js';
import { omissionMarker, RAW_TURN_SEPARATOR, renderableRawTurns, renderRawTurn } from '../rendering/raw-turn-renderer.js';
import { openProviderTranscript, type ProviderTranscriptOpener } from '../security/provider-transcript.js';
import type { ProjectSet } from '../storage/project-resolver.js';
import {
    isSubstantive,
    type ProjectSessionAggregate,
    readProjectSessionAggregates,
    readProjectSessions,
    readSessionById,
    type ServedSession,
} from '../storage/session-read-model.js';
import { UNTITLED_EPISODE } from '../storage/session-title.js';
import { type ParsedTurn, type SessionAdapter, TOOL_METADATA, type ToolName } from '../types/index.js';
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

export interface StoredTurnRecallFields {
    decisions: string[];
    filesTouched: string[];
    pendingItems: string[];
}

export type StoredSessionRecallFields = Map<number, StoredTurnRecallFields>;

interface TurnCollectionBounds {
    lastN?: number;
    charBudget: number;
    nonce: string;
}

interface RetainedTurn {
    turn: ParsedTurn;
    renderedLength: number;
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

export function hasRealContent(session: Pick<ServedSession, 'title' | 'custom_title'>): boolean {
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
    private readonly adapters: Record<ToolName, SessionAdapter>;
    private readonly sessionsMemo = new Map<string, ServedSession[]>();
    private readonly consentedSessionsMemo = new Map<string, ServedSession[]>();

    constructor(
        private readonly db: Database.Database,
        adapters: Record<ToolName, SessionAdapter> = defaultAdapters(),
        private readonly openTranscript: ProviderTranscriptOpener = openProviderTranscript,
    ) {
        this.adapters = adapters;
    }

    /**
     * Memoized per reader instance, the same pattern as ProjectResolver.list:
     * one operation's repeated reads of a project share a single load. A
     * long-lived caller constructs a fresh reader per request so later
     * requests observe daemon writes.
     */
    sessionsFor(project: ProjectSet): ServedSession[] {
        const key = project.projectIds.join(',');
        const cached = this.sessionsMemo.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const rows = readProjectSessions(this.db, project.projectIds);
        this.sessionsMemo.set(key, rows);
        return rows;
    }

    sessionAggregatesFor(projects: readonly ProjectSet[]): ProjectSessionAggregate[] {
        const projectIds = [...new Set(projects.flatMap((project) => project.projectIds))];
        return readProjectSessionAggregates(this.db, projectIds);
    }

    /**
     * Reads every session belonging to the already consent-filtered project
     * sets in one newest-first query. The caller owns the consent boundary;
     * this reader only combines its internal project ids.
     */
    recentConsentedSessions(projects: readonly ProjectSet[]): ServedSession[] {
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
    }

    consentedTotal(projects: readonly ProjectSet[]): number {
        return this.recentConsentedSessions(projects).length;
    }

    sessionById(id: number): ServedSession | undefined {
        return readSessionById(this.db, id);
    }

    newestSubstantive(project: ProjectSet): ServedSession | undefined {
        return this.sessionsFor(project).find(isSubstantive);
    }

    counts(project: ProjectSet, now: number = Date.now()): { recent: number; total: number } {
        const rows = this.sessionsFor(project);
        const sevenDaysAgo = now - RECENT_SESSION_WINDOW_MS;
        return { total: rows.length, recent: rows.filter((row) => Date.parse(endedAt(row)) >= sevenDaysAgo).length };
    }

    storedRecallFieldsFor(sessions: Iterable<Pick<ServedSession, 'id'>>): Map<number, StoredSessionRecallFields> {
        const ids = [...new Set([...sessions].map((session) => session.id))];
        const bySession = new Map(ids.map((id) => [id, new Map<number, StoredTurnRecallFields>()]));
        if (ids.length === 0) {
            return bySession;
        }
        const rows = this.db
            .prepare(
                `SELECT session_id, turn_index, decisions, files_touched, pending_items
                 FROM memories WHERE session_id IN (${ids.map(() => '?').join(',')})
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
    }

    storedTurnRecallFields(session: Pick<ServedSession, 'id'>): StoredSessionRecallFields {
        return this.storedRecallFieldsFor([session]).get(session.id) ?? new Map();
    }

    async turns(
        session: ServedSession,
        signal?: AbortSignal,
        storedIndexes?: ReadonlySet<number>,
        bounds?: TurnCollectionBounds,
    ): Promise<{
        turns?: ParsedTurn[];
        omittedBefore?: number;
        retentionHighWater?: { turns: number; renderedChars: number };
        reason?: string;
    }> {
        const opened = await this.openTranscript(session.tool, session.source_path);
        if ('reason' in opened) {
            return { reason: opened.reason };
        }
        const { handle } = opened;
        try {
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
            for await (const turn of this.adapters[session.tool].parseTurns(session.source_path, undefined, {
                closeTrailingOnIdle: true,
                handle,
                signal,
            })) {
                if (signal?.aborted) {
                    return { reason: 'deadline' };
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
        } catch {
            return { reason: 'transcript_unreadable' };
        } finally {
            await handle.close();
        }
    }

    async render(
        session: ServedSession,
        lastN?: number,
        signal?: AbortSignal,
        charBudget: number = SESSION_CHAR_BUDGET,
    ): Promise<{ episode?: BoundedEpisode; reason?: string }> {
        const nonce = randomUUID();
        const boundedLastN = lastN === undefined ? undefined : Math.min(Math.max(1, Math.trunc(lastN)), MAX_GET_SESSION_LAST_N);
        const parsed = await this.turns(session, signal, undefined, { lastN: boundedLastN, charBudget, nonce });
        return parsed.turns === undefined
            ? { reason: parsed.reason }
            : { episode: boundedRender(parsed.turns, boundedLastN, charBudget, nonce, parsed.omittedBefore) };
    }

    aggregate(project: ProjectSet): { files: string[]; surfaces: string[]; lastActivity: string | null } {
        const rows = this.sessionsFor(project).filter(isSubstantive).slice(0, AUTO_BRIEF_AGGREGATE_SESSION_LIMIT);
        const ids = rows.map((row) => row.id);
        if (ids.length === 0) {
            return { files: [], surfaces: [], lastActivity: null };
        }
        const memories = this.db
            .prepare(`SELECT files_touched FROM memories WHERE session_id IN (${ids.map(() => '?').join(',')})`)
            .all(...ids) as Array<{ files_touched: string }>;
        const count = new Map<string, number>();
        for (const memory of memories) {
            try {
                const files: unknown = JSON.parse(memory.files_touched);
                if (Array.isArray(files)) {
                    for (const file of files) {
                        if (typeof file === 'string') {
                            count.set(file, (count.get(file) ?? 0) + 1);
                        }
                    }
                }
            } catch {
                // Stored malformed JSON is not a valid zero; omit it from an aggregate only.
            }
        }
        const files = [...count.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, AUTO_BRIEF_AGGREGATE_FILE_LIMIT)
            .map(([file]) => file.split('/').filter(Boolean).at(-1) ?? file);
        return { files, surfaces: [...new Set(rows.map((row) => surfaceLabel(row.tool, row.surface)))], lastActivity: endedAt(rows[0]) };
    }
}

export function boundedRender(
    turns: Iterable<ParsedTurn>,
    lastN?: number,
    charBudget: number = SESSION_CHAR_BUDGET,
    nonce: string = randomUUID(),
    omittedBefore: number = 0,
): BoundedEpisode {
    const pieces = renderableRawTurns(turns, omittedBefore).map((piece) => `${dataBlockOpen(nonce)}\n${piece}\n${dataBlockClose(nonce)}`);
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
