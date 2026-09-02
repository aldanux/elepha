// Canonical hydrated read model for served sessions. SQL storage details stay
// here so serving consumers share one shape instead of re-declaring row types.

import type Database from 'better-sqlite3';
import type { SessionRowSurface, ToolName } from '../types/index.js';

export interface ServedSession {
    id: number;
    tool: ToolName;
    native_id: string;
    segment_index: number;
    project_id: number;
    source_path: string;
    started_at: string;
    last_ingested_at: string;
    surface: SessionRowSurface | null;
    git_branch: string | null;
    last_turn_at: string | null;
    trailing_files?: string[];
    rendered_chars: number | null;
    rendered_turns: number | null;
    title: string | null;
    custom_title: string | null;
    first_prompt_search: string | null;
    git_commit_count: number | null;
    rollup_title: string | null;
    rollup_summary?: string | null;
    rollup_decisions: string | null;
    rollup_pending_items?: string | null;
    rollup_files_touched?: string | null;
    rollup_state: string | null;
    turn_count: number;
    has_files_touched: number;
    has_external_content: number;
}

export interface ProjectSessionAggregate {
    project_id: number;
    tool: ToolName;
    surface: SessionRowSurface | null;
    last_ingested_at: string;
    work_episodes: number;
}

type RawServedSession = Omit<ServedSession, 'trailing_files'> & { trailing_files: string };

const warnedDegradedFields = new WeakMap<Database.Database, Set<string>>();

export function safeStringArray(value: string, onDropped?: () => void): string[] {
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            onDropped?.();
            return [];
        }
        const strings = parsed.filter((item): item is string => typeof item === 'string');
        if (strings.length !== parsed.length) {
            onDropped?.();
        }
        return strings;
    } catch {
        onDropped?.();
        return [];
    }
}

function warnDegradedField(db: Database.Database, sessionId: number, column: string): void {
    let warned = warnedDegradedFields.get(db);
    if (warned === undefined) {
        warned = new Set<string>();
        warnedDegradedFields.set(db, warned);
    }
    const key = `${sessionId}:${column}`;
    if (warned.has(key)) {
        return;
    }
    warned.add(key);
    console.warn(`[elepha] degraded session read: session ${sessionId} ${column} contained invalid data; dropped invalid values`);
}

function hydrateServedSession(db: Database.Database, row: RawServedSession): ServedSession {
    return {
        ...row,
        trailing_files: safeStringArray(row.trailing_files, () => warnDegradedField(db, row.id, 'trailing_files')),
    };
}

export function jsonArrayLength(value: string | null): number | null {
    if (value === null) {
        return null;
    }
    try {
        const decoded: unknown = JSON.parse(value);
        return Array.isArray(decoded) ? decoded.length : 0;
    } catch {
        return null;
    }
}

// Canonical read-time substantive predicate. A rollup with decisions
// or files is substantive; otherwise stored capture is substantive from two
// turns onward or when a turn touched files.
export function isSubstantive(
    session: Pick<ServedSession, 'rollup_state' | 'rollup_decisions' | 'turn_count' | 'has_files_touched'>,
): boolean {
    if (session.rollup_state !== null) {
        return (jsonArrayLength(session.rollup_decisions) ?? 0) > 0 || session.has_files_touched === 1;
    }
    return session.turn_count >= 2 || session.has_files_touched === 1;
}

// One SELECT shared by every served-session reader: a narrow lookup that
// diverged from the project query would silently split the canonical shape.
const SERVED_SESSION_SELECT = `SELECT s.*, r.title AS rollup_title, r.summary AS rollup_summary, r.decisions AS rollup_decisions,
        r.pending_items AS rollup_pending_items, r.files_touched AS rollup_files_touched, r.rollup_state,
        COUNT(m.id) AS turn_count, MAX(CASE WHEN m.files_touched <> '[]' THEN 1 ELSE 0 END) AS has_files_touched,
        MAX(CASE WHEN m.has_external_content = 1 THEN 1 ELSE 0 END) AS has_external_content
 FROM sessions s LEFT JOIN session_rollups r ON r.session_id = s.id LEFT JOIN memories m ON m.session_id = s.id`;

// The single project-session query used by serving readers, newest activity first.
export function readProjectSessions(db: Database.Database, projectIds: readonly number[]): ServedSession[] {
    const placeholders = projectIds.map(() => '?').join(',');
    const rows = db
        .prepare(
            `${SERVED_SESSION_SELECT}
             WHERE s.project_id IN (${placeholders}) GROUP BY s.id
             ORDER BY COALESCE(s.last_turn_at, s.last_ingested_at, s.started_at) DESC, s.id DESC`,
        )
        .all(...projectIds) as RawServedSession[];
    return rows.map((row) => hydrateServedSession(db, row));
}

// One grouped read for list-project aggregate inputs, ordered like the canonical session list.
export function readProjectSessionAggregates(db: Database.Database, projectIds: readonly number[]): ProjectSessionAggregate[] {
    if (projectIds.length === 0) {
        return [];
    }
    const placeholders = projectIds.map(() => '?').join(',');
    const rows = db
        .prepare(
            `WITH ranked AS (
                 SELECT s.project_id, s.tool, s.surface, s.last_ingested_at,
                        COALESCE(s.last_turn_at, s.last_ingested_at, s.started_at) AS activity, s.id,
                        ROW_NUMBER() OVER (
                            PARTITION BY s.project_id, s.tool, s.surface
                            ORDER BY COALESCE(s.last_turn_at, s.last_ingested_at, s.started_at) DESC, s.id DESC
                        ) AS activity_rank
                 FROM sessions s
                 WHERE s.project_id IN (${placeholders})
             )
             SELECT project_id, tool, surface, MAX(last_ingested_at) AS last_ingested_at,
                    COUNT(*) AS work_episodes,
                    MAX(CASE WHEN activity_rank = 1 THEN activity END) AS newest_activity,
                    MAX(CASE WHEN activity_rank = 1 THEN id END) AS newest_id
             FROM ranked
             GROUP BY project_id, tool, surface
             ORDER BY newest_activity DESC, newest_id DESC`,
        )
        .all(...projectIds) as Array<ProjectSessionAggregate & { newest_activity: string; newest_id: number }>;
    return rows.map(({ project_id, tool, surface, last_ingested_at, work_episodes }) => ({
        project_id,
        tool,
        surface,
        last_ingested_at,
        work_episodes,
    }));
}

// Indexed session-id lookup sharing the exact hydrated shape used by project reads.
export function readSessionById(db: Database.Database, id: number): ServedSession | undefined {
    const row = db.prepare(`${SERVED_SESSION_SELECT} WHERE s.id = ? GROUP BY s.id`).get(id) as RawServedSession | undefined;
    return row === undefined ? undefined : hydrateServedSession(db, row);
}

// Indexed lookup on sessions.UNIQUE(tool, native_id, segment_index), for
// callers that need exactly one session. Consent-independent by design; the
// caller owns any consent gate.
export function readSessionByNaturalKey(
    db: Database.Database,
    key: { tool: ToolName; nativeId: string; segmentIndex: number },
): ServedSession | undefined {
    const row = db
        .prepare(`${SERVED_SESSION_SELECT} WHERE s.tool = ? AND s.native_id = ? AND s.segment_index = ? GROUP BY s.id`)
        .get(key.tool, key.nativeId, key.segmentIndex) as RawServedSession | undefined;
    return row === undefined ? undefined : hydrateServedSession(db, row);
}
