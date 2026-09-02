import type { Database, Statement } from 'better-sqlite3';
import { TRAILING_FILES_CAP } from '../config/constants.js';
import { dedupePaths } from '../config/paths.js';
import { gitRevListCountHead } from '../security/subprocess-allowlist.js';
import type { ParsedTurn, SessionRowKind, SessionRowSurface, ToolName } from '../types/index.js';
import type { ProjectRow } from './project-store.js';
import { titleForTurn } from './session-title.js';

export interface SessionRow {
    id: number;
    tool: ToolName;
    native_id: string;
    segment_index: number;
    project_id: number;
    source_path: string;
    cursor: string | null;
    started_at: string;
    last_ingested_at: string;
    surface: SessionRowSurface | null;
    git_branch: string | null;
    kind: SessionRowKind | null;
    last_turn_at: string | null;
    trailing_branch: string | null;
    trailing_files: string[];
    rendered_chars: number | null;
    rendered_turns: number | null;
    title: string | null;
    custom_title: string | null;
    first_prompt_search: string | null;
    git_commit_count: number | null;
}

export type SessionMetadata = {
    surface?: SessionRowSurface | null;
    gitBranch?: string | null;
    kind?: SessionRowKind | null;
    customTitle?: string;
};

// `trailing_files` is stored as JSON text in SQLite but exposed as
// `string[]` on SessionRow, like the other hydrated JSON columns. Every
// SessionRow read must route through this function.
export function hydrateSessionRow(raw: Record<string, unknown>): SessionRow {
    return {
        ...raw,
        trailing_files: typeof raw.trailing_files === 'string' ? JSON.parse(raw.trailing_files) : [],
    } as SessionRow;
}

// Boundary evaluation needs recent overlap evidence, not full file history.

export class SessionStore {
    private readonly stmts: {
        findSession: Statement;
        findSessionSegment: Statement;
        insertSession: Statement;
        updateSessionCursor: Statement;
        listSessionsWithMemoriesSince: Statement;
    };

    constructor(
        private readonly db: Database,
        private readonly getProjectById: (id: number) => ProjectRow | undefined,
        private readonly resolveGitCommitCount: (projectPath: string) => number | null = gitRevListCountHead,
    ) {
        this.stmts = {
            findSession: db.prepare('SELECT * FROM sessions WHERE tool = ? AND native_id = ? ORDER BY segment_index DESC LIMIT 1'),
            findSessionSegment: db.prepare('SELECT * FROM sessions WHERE tool = ? AND native_id = ? AND segment_index = ?'),
            insertSession: db.prepare(
                `INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, cursor, started_at, last_ingested_at, surface, git_branch, kind, last_turn_at, trailing_branch, trailing_files, title, custom_title, git_commit_count)
         VALUES (@tool, @native_id, @segment_index, @project_id, @source_path, NULL, @now, @now, @surface, @git_branch, @kind, NULL, NULL, '[]', NULL, @custom_title, @git_commit_count)`,
            ),
            updateSessionCursor: db.prepare('UPDATE sessions SET cursor = ?, last_ingested_at = ? WHERE id = ?'),
            listSessionsWithMemoriesSince: db.prepare(
                `SELECT DISTINCT s.* FROM sessions s
         JOIN memories m ON m.session_id = s.id
         WHERE m.turn_started_at >= ?`,
            ),
        };
    }

    upsertSession(
        tool: ToolName,
        nativeId: string,
        projectId: number,
        sourcePath: string,
        meta?: SessionMetadata,
        gitCommitCount?: number | null,
    ): SessionRow {
        const existing = this.stmts.findSession.get(tool, nativeId) as Record<string, unknown> | undefined;
        if (existing) {
            if (meta?.customTitle !== undefined) {
                this.updateCustomTitle(tool, nativeId, meta.customTitle);
                return { ...hydrateSessionRow(existing), custom_title: meta.customTitle };
            }
            return hydrateSessionRow(existing);
        }
        const now = new Date().toISOString();
        const project = this.getProjectById(projectId);
        const info = this.stmts.insertSession.run({
            tool,
            native_id: nativeId,
            project_id: projectId,
            source_path: sourcePath,
            segment_index: 0,
            now,
            surface: meta?.surface ?? null,
            git_branch: meta?.gitBranch ?? null,
            kind: meta?.kind ?? null,
            custom_title: meta?.customTitle ?? null,
            git_commit_count:
                gitCommitCount !== undefined
                    ? gitCommitCount
                    : project === undefined
                      ? null
                      : this.resolveGitCommitCount(project.git_root ?? project.path),
        });
        return hydrateSessionRow(
            this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>,
        );
    }

    findSession(tool: ToolName, nativeId: string): SessionRow | undefined {
        const row = this.stmts.findSession.get(tool, nativeId) as Record<string, unknown> | undefined;
        return row ? hydrateSessionRow(row) : undefined;
    }

    // User-set custom titles remain native-transcript metadata; list_sessions uses the per-segment title field.
    updateCustomTitle(tool: ToolName, nativeId: string, customTitle: string): void {
        this.db.prepare('UPDATE sessions SET custom_title = ? WHERE tool = ? AND native_id = ?').run(customTitle, tool, nativeId);
    }

    // Opens the segment immediately after `previous`. Its trailing window and
    // cursor start empty by construction; recordTurn() fills them only after
    // the resuming turn has actually been stored. The exact-index lookup makes
    // this safe if an already-decided cut is retried after a partial failure.
    startNextSegment(
        previous: SessionRow,
        projectId: number,
        sourcePath: string,
        meta?: SessionMetadata,
        gitCommitCount?: number | null,
    ): SessionRow {
        const segmentIndex = previous.segment_index + 1;
        const existing = this.stmts.findSessionSegment.get(previous.tool, previous.native_id, segmentIndex) as
            | Record<string, unknown>
            | undefined;
        if (existing) {
            return hydrateSessionRow(existing);
        }

        const now = new Date().toISOString();
        const project = this.getProjectById(projectId);
        const info = this.stmts.insertSession.run({
            tool: previous.tool,
            native_id: previous.native_id,
            segment_index: segmentIndex,
            project_id: projectId,
            source_path: sourcePath,
            now,
            surface: meta?.surface ?? null,
            git_branch: meta?.gitBranch ?? null,
            kind: meta?.kind ?? null,
            custom_title: meta?.customTitle ?? previous.custom_title,
            git_commit_count:
                gitCommitCount !== undefined
                    ? gitCommitCount
                    : project === undefined
                      ? null
                      : this.resolveGitCommitCount(project.git_root ?? project.path),
        });
        return hydrateSessionRow(
            this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>,
        );
    }

    gitCommitCount(projectPath: string): number | null {
        return this.resolveGitCommitCount(projectPath);
    }

    // Sessions whose rollup is missing or was written by an older
    // `rollup_version` - the `elepha rollup --rebuild` target set.
    //
    // Distinct from listOpenSessions() on purpose: that one deliberately skips
    // `final` rollups, which is right for the idle-close sweep and wrong for a
    // version bump. A rebuild that silently cannot reach finalized rollups
    // would rebuild the 14 rollups nobody cared about and leave the 62 that
    // matter untouched, while reporting success.
    listSessionsForRollupRebuild(currentVersion: number): SessionRow[] {
        return this.db
            .prepare(
                `SELECT s.* FROM sessions s
         LEFT JOIN session_rollups r ON r.session_id = s.id
         WHERE r.session_id IS NULL OR r.rollup_version <> ?
         ORDER BY s.id`,
            )
            .all(currentVersion)
            .map((row) => hydrateSessionRow(row as Record<string, unknown>));
    }

    // Sessions with no rollup yet, or whose rollup is still 'live' - the idle-close sweep candidates.
    listOpenSessions(): SessionRow[] {
        return this.db
            .prepare(
                `SELECT s.* FROM sessions s
         LEFT JOIN session_rollups r ON r.session_id = s.id
         WHERE r.session_id IS NULL OR r.rollup_state = 'live'`,
            )
            .all()
            .map((row) => hydrateSessionRow(row as Record<string, unknown>));
    }

    getSessionCursor(tool: ToolName, nativeId: string): string | undefined {
        const row = this.stmts.findSession.get(tool, nativeId) as Record<string, unknown> | undefined;
        return row ? (hydrateSessionRow(row).cursor ?? undefined) : undefined;
    }

    // Advances an already-known session after a deliberately dropped turn.
    advanceSessionCursor(sessionDbId: number, cursor: string): void {
        this.advanceSessionCursorAt(sessionDbId, cursor, new Date().toISOString());
    }

    advanceSessionCursorAt(sessionDbId: number, cursor: string, now: string): void {
        this.stmts.updateSessionCursor.run(cursor, now, sessionDbId);
    }

    // Quote-back runs before project/session persistence, so it can only advance an existing session.
    advanceExistingSessionCursor(tool: ToolName, nativeId: string, cursor: string): boolean {
        const session = this.findSession(tool, nativeId);
        if (!session) {
            return false;
        }
        this.advanceSessionCursor(session.id, cursor);
        return true;
    }

    // Writes a sanitized title in the same transaction as the turn that establishes it.
    updateSessionTitle(sessionDbId: number, turn: Pick<ParsedTurn, 'aiTitle' | 'userMessage'>): void {
        const row = this.db.prepare('SELECT title, segment_index FROM sessions WHERE id = ?').get(sessionDbId) as
            | { title: string | null; segment_index: number }
            | undefined;
        if (!row) {
            return;
        }
        const title = titleForTurn(row.title, turn, row.segment_index === 0);
        if (title !== row.title) {
            this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionDbId);
        }
    }

    // Denormalized "recent state" on the session row, refreshed on every
    // turn close: this exists
    // so boundary evaluation is one row read per closed turn, not a query
    // into turn history on a 200-turn rollout. trailing_branch is the raw
    // per-turn value (drifts freely, unlike sessions.git_branch which is the
    // creation-time anchor); trailing_files is capped, most-recent-first,
    // case-insensitively deduped the same way memories.files_touched already is.
    // last_turn_at is the prior-close timestamp used for the next gap test;
    // unlike last_ingested_at it is transcript time, not daemon wall time.
    updateTrailingState(sessionDbId: number, turn: ParsedTurn): void {
        const current = this.db.prepare('SELECT trailing_branch, trailing_files FROM sessions WHERE id = ?').get(sessionDbId) as
            | { trailing_branch: string | null; trailing_files: string }
            | undefined;
        if (!current) {
            return;
        }
        const newBranch = turn.gitBranch ?? current.trailing_branch;
        const existingFiles = JSON.parse(current.trailing_files) as string[];
        const turnFiles = turn.toolCalls.flatMap((c) => c.filePaths);
        const merged = dedupePaths([...turnFiles, ...existingFiles]).slice(0, TRAILING_FILES_CAP);
        this.db
            .prepare('UPDATE sessions SET last_turn_at = ?, trailing_branch = ?, trailing_files = ? WHERE id = ?')
            .run(turn.endedAt, newBranch, JSON.stringify(merged), sessionDbId);
    }

    // Reingest targets have at least one memory row in [sinceIso, now) and carry
    // the source path and tool needed to walk the transcript again.
    listSessionsWithMemoriesSince(sinceIso: string): SessionRow[] {
        return this.stmts.listSessionsWithMemoriesSince.all(sinceIso).map((row) => hydrateSessionRow(row as Record<string, unknown>));
    }
}
