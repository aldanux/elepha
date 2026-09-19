// Canonical hydrated read model for served sessions. SQL storage details stay
// here so serving consumers share one shape instead of re-declaring row types.

import type Database from 'better-sqlite3-multiple-ciphers';
import { DURABLE_CAPTURE_FILTER_VERSION, SESSION_CAPSULE_METADATA_MAX_BYTES, SESSION_ELIGIBILITY_BATCH_SIZE } from '../config/constants.js';
import { type SessionRowSurface, SUPPORTED_TOOLS, type ToolName } from '../types/index.js';

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
    rollup_instructions: string | null;
    rollup_pending_items?: string | null;
    rollup_files_touched?: string | null;
    rollup_state: string | null;
    turn_count: number;
    has_files_touched: number;
    has_external_content: number;
    // Separate from canonical turn/rollup fields. Present only after the
    // failed-EOF grace has elapsed and the unchanged candidate was staged.
    open_turn_staged_at?: string | null;
    open_turn_failed_at?: string | null;
    open_turn_receipt_coverage?: 'complete' | 'incomplete' | null;
}

export interface ProjectSessionAggregate {
    project_id: number;
    tool: ToolName;
    surface: SessionRowSurface | null;
    last_ingested_at: string;
    work_episodes: number;
}

const CAPSULE_TEXT_FIELDS = {
    native_id: 's.native_id',
    tool: 's.tool',
    title: 's.title',
    project_name: 'p.display_name',
    project_key: "COALESCE(NULLIF(p.git_remote, ''), NULLIF(p.git_root_commit, ''), NULLIF(p.git_root, ''), p.path)",
    started_at: 's.started_at',
    last_activity: 'COALESCE(s.last_turn_at, s.last_ingested_at, s.started_at)',
    surface: 's.surface',
    git_branch: 's.git_branch',
    first_prompt_search: 's.first_prompt_search',
    trailing_files: 's.trailing_files',
    summary: 'r.summary',
    decisions: 'r.decisions',
    pending_items: 'r.pending_items',
    rollup_state: 'r.rollup_state',
    computed_at: 'r.computed_at',
    summarizer_status: 'r.summarizer_status',
    durable_state: 'd.state',
    open_turn_staged_at: 'ot.staged_at',
    open_turn_failed_at: 'ot.failed_at',
    open_turn_receipt_coverage: 'ot.receipt_coverage',
} as const;

export type SessionCapsuleMetadata = Record<keyof typeof CAPSULE_TEXT_FIELDS, string | null> & {
    id: number;
    project_id: number;
    segment_index: number;
    metadata_bytes: number;
    turn_count: number;
    watermark: number | null;
    newer_turn_count: number;
    durable_filter_version: number | null;
    durable_uncovered: number;
};

// This projection deliberately never selects transcript paths, durable bodies or
// standing instructions. Guard the sum of every variable field in SQL before
// handing strings to JavaScript; a per-column bound multiplies with field count.
const CAPSULE_TEXT_BYTES = Object.values(CAPSULE_TEXT_FIELDS)
    .map((expression) => `COALESCE(length(CAST(${expression} AS BLOB)), 0)`)
    .join(' + ');
const CAPSULE_BOUNDED_FIELDS = Object.entries(CAPSULE_TEXT_FIELDS)
    .map(
        ([name, expression]) =>
            `CASE WHEN (${CAPSULE_TEXT_BYTES}) <= ${SESSION_CAPSULE_METADATA_MAX_BYTES} THEN ${expression} END AS ${name}`,
    )
    .join(', ');

export function readSessionCapsuleByNaturalKey(
    db: Database.Database,
    key: { tool: ToolName; nativeId: string; segmentIndex: number },
): SessionCapsuleMetadata | undefined {
    return db
        .prepare(`SELECT s.id, s.project_id, s.segment_index,
        (${CAPSULE_TEXT_BYTES}) AS metadata_bytes, ${CAPSULE_BOUNDED_FIELDS},
        (SELECT COUNT(*) FROM memories m WHERE m.session_id = s.id) AS turn_count,
        r.rolled_up_through_turn_index AS watermark,
        (SELECT COUNT(*) FROM memories m WHERE m.session_id = s.id
            AND m.turn_index > r.rolled_up_through_turn_index) AS newer_turn_count,
        d.filter_version AS durable_filter_version,
        EXISTS (SELECT 1 FROM memories m LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
            WHERE m.session_id = s.id AND (ft.memory_id IS NULL OR ft.filter_version <> ?)) AS durable_uncovered
        FROM sessions s JOIN projects p ON p.id = s.project_id
        LEFT JOIN session_rollups r ON r.session_id = s.id
        LEFT JOIN durable_capture_status d ON d.session_id = s.id
        LEFT JOIN open_turns ot ON ot.session_id = s.id AND ot.staged_at IS NOT NULL AND ot.validated_epoch = ot.validation_epoch
        WHERE s.tool = ? AND s.native_id = ? AND s.segment_index = ?
        AND ${SERVED_SESSION_KIND_ELIGIBILITY}
        AND NOT EXISTS (SELECT 1 FROM purged_transcripts t WHERE t.tool = s.tool AND t.native_id = s.native_id)
        AND NOT EXISTS (SELECT 1 FROM incognito_transcripts t WHERE t.tool = s.tool AND t.native_id = s.native_id)`)
        .get(DURABLE_CAPTURE_FILTER_VERSION, key.tool, key.nativeId, key.segmentIndex) as SessionCapsuleMetadata | undefined;
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

// Canonical read-time substantive predicate. A rollup with decisions,
// instructions, or files is substantive; otherwise stored capture is substantive from two
// turns onward or when a turn touched files.
export function isSubstantive(
    session: Pick<
        ServedSession,
        'rollup_state' | 'rollup_decisions' | 'rollup_instructions' | 'turn_count' | 'has_files_touched' | 'open_turn_staged_at'
    >,
): boolean {
    if (session.open_turn_staged_at != null) {
        return true;
    }
    if (session.rollup_state !== null) {
        return (
            (jsonArrayLength(session.rollup_decisions) ?? 0) > 0 ||
            (jsonArrayLength(session.rollup_instructions) ?? 0) > 0 ||
            session.has_files_touched === 1
        );
    }
    return session.turn_count >= 2 || session.has_files_touched === 1;
}

// One SELECT shared by every served-session reader: a narrow lookup that
// diverged from the project query would silently split the canonical shape.
const SERVED_SESSION_SELECT = `SELECT s.*, r.title AS rollup_title, r.summary AS rollup_summary, r.decisions AS rollup_decisions, r.instructions AS rollup_instructions,
        r.pending_items AS rollup_pending_items, r.files_touched AS rollup_files_touched, r.rollup_state,
        ot.staged_at AS open_turn_staged_at, ot.failed_at AS open_turn_failed_at,
        ot.receipt_coverage AS open_turn_receipt_coverage,
        COUNT(m.id) AS turn_count, MAX(CASE WHEN m.files_touched <> '[]' THEN 1 ELSE 0 END) AS has_files_touched,
        MAX(CASE WHEN m.has_external_content = 1 THEN 1 ELSE 0 END) AS has_external_content
 FROM sessions s LEFT JOIN session_rollups r ON r.session_id = s.id LEFT JOIN memories m ON m.session_id = s.id
 LEFT JOIN open_turns ot ON ot.session_id = s.id AND ot.staged_at IS NOT NULL AND ot.validated_epoch = ot.validation_epoch`;

const SUPPORTED_TOOL_PLACEHOLDERS = SUPPORTED_TOOLS.map(() => '?').join(',');

// Historical guardian rows may retain memories and vectors after their kind
// is corrected. Exclude them at use time without erasing stored data.
export const SERVED_SESSION_KIND_ELIGIBILITY = "s.kind IS NOT 'adjudicator'";

// Background derivations also recheck stale work items after awaited reads.
export function isSessionKindEligible(db: Database.Database, sessionId: number): boolean {
    return db.prepare(`SELECT 1 FROM sessions s WHERE s.id = ? AND ${SERVED_SESSION_KIND_ELIGIBILITY}`).get(sessionId) !== undefined;
}

// The single project-session query used by serving readers, newest activity first.
export function readProjectSessions(db: Database.Database, projectIds: readonly number[]): ServedSession[] {
    const placeholders = projectIds.map(() => '?').join(',');
    const rows = db
        .prepare(
            `${SERVED_SESSION_SELECT}
             WHERE s.project_id IN (${placeholders}) AND s.tool IN (${SUPPORTED_TOOL_PLACEHOLDERS})
             AND ${SERVED_SESSION_KIND_ELIGIBILITY} GROUP BY s.id
             ORDER BY COALESCE(s.last_turn_at, s.last_ingested_at, s.started_at) DESC, s.id DESC`,
        )
        .all(...projectIds, ...SUPPORTED_TOOLS) as RawServedSession[];
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
                 WHERE s.project_id IN (${placeholders}) AND s.tool IN (${SUPPORTED_TOOL_PLACEHOLDERS})
                 AND ${SERVED_SESSION_KIND_ELIGIBILITY}
             )
             SELECT project_id, tool, surface, MAX(last_ingested_at) AS last_ingested_at,
                    COUNT(*) AS work_episodes,
                    MAX(CASE WHEN activity_rank = 1 THEN activity END) AS newest_activity,
                    MAX(CASE WHEN activity_rank = 1 THEN id END) AS newest_id
             FROM ranked
             GROUP BY project_id, tool, surface
             ORDER BY newest_activity DESC, newest_id DESC`,
        )
        .all(...projectIds, ...SUPPORTED_TOOLS) as Array<ProjectSessionAggregate & { newest_activity: string; newest_id: number }>;
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
    const row = db
        .prepare(`${SERVED_SESSION_SELECT} WHERE s.id = ? AND s.tool IN (${SUPPORTED_TOOL_PLACEHOLDERS})
            AND ${SERVED_SESSION_KIND_ELIGIBILITY} GROUP BY s.id`)
        .get(id, ...SUPPORTED_TOOLS) as RawServedSession | undefined;
    return row === undefined ? undefined : hydrateServedSession(db, row);
}

// Manual embedding jobs page identities, then hydrate only a currently
// authorized session. No transcript or filtered-turn body is selected.
export function readEmbeddingSessionIds(db: Database.Database, before: number, limit: number): number[] {
    return (db.prepare('SELECT id FROM sessions WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit) as Array<{ id: number }>).map(
        (row) => row.id,
    );
}

const EMBEDDING_SESSION_ELIGIBILITY = `s.tool IN (${SUPPORTED_TOOL_PLACEHOLDERS})
          AND ${SERVED_SESSION_KIND_ELIGIBILITY}
          AND s.project_id IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (SELECT 1 FROM purged_transcripts p WHERE p.tool = s.tool AND p.native_id = s.native_id)
          AND NOT EXISTS (SELECT 1 FROM incognito_transcripts i WHERE i.tool = s.tool AND i.native_id = s.native_id)`;

export function readEmbeddingSession(db: Database.Database, id: number, projectIds: readonly number[]): ServedSession | undefined {
    const row = db
        .prepare(`${SERVED_SESSION_SELECT} WHERE s.id = ? AND ${EMBEDDING_SESSION_ELIGIBILITY} GROUP BY s.id`)
        .get(id, ...SUPPORTED_TOOLS, JSON.stringify(projectIds)) as RawServedSession | undefined;
    return row === undefined ? undefined : hydrateServedSession(db, row);
}

// Revalidate omitted identities without loading rollups or aggregating memories.
// Both readers share the eligibility predicate; projects are authorized by the caller.
export function readEligibleEmbeddingSessionIds(
    db: Database.Database,
    sessionIds: readonly number[],
    projectIds: readonly number[],
): number[] {
    if (sessionIds.length === 0 || projectIds.length === 0) {
        return [];
    }
    const projects = JSON.stringify(projectIds);
    const eligible: number[] = [];
    for (let offset = 0; offset < sessionIds.length; offset += SESSION_ELIGIBILITY_BATCH_SIZE) {
        const batch = sessionIds.slice(offset, offset + SESSION_ELIGIBILITY_BATCH_SIZE);
        const rows = db
            .prepare(`SELECT s.id FROM sessions s
                WHERE s.id IN (${batch.map(() => '?').join(',')}) AND ${EMBEDDING_SESSION_ELIGIBILITY}`)
            .all(...batch, ...SUPPORTED_TOOLS, projects) as Array<{ id: number }>;
        eligible.push(...rows.map((row) => row.id));
    }
    return eligible;
}

// Indexed lookup on sessions.UNIQUE(tool, native_id, segment_index), for
// callers that need exactly one session. Consent-independent by design; the
// caller owns any consent gate.
export function readSessionByNaturalKey(
    db: Database.Database,
    key: { tool: ToolName; nativeId: string; segmentIndex: number },
): ServedSession | undefined {
    const row = db
        .prepare(
            `${SERVED_SESSION_SELECT} WHERE s.tool = ? AND s.native_id = ? AND s.segment_index = ? AND s.tool IN (${SUPPORTED_TOOL_PLACEHOLDERS})
            AND ${SERVED_SESSION_KIND_ELIGIBILITY} GROUP BY s.id`,
        )
        .get(key.tool, key.nativeId, key.segmentIndex, ...SUPPORTED_TOOLS) as RawServedSession | undefined;
    return row === undefined ? undefined : hydrateServedSession(db, row);
}
