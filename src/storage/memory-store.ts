// Read/write facade for summarized memory records.
// Data concerns live in dedicated stores; this class preserves the existing API.

import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { canonicalizeExisting, isWithin, normalizeForCompare, samePath } from '../config/paths.js';
import type { ParsedTurn, SessionRowKind, SessionRowSurface, SummarizationOutput, ToolName } from '../types/index.js';
import { ConsentStore } from './consent-store.js';
import { type InjectionRow, InjectionStore, type RecordInjectionInput } from './injection-store.js';
import { type ProjectRow, ProjectStore, type ResolvedProjectIdentity } from './project-store.js';
import { hydrateSessionRow, type SessionRow, SessionStore } from './session-store.js';
import { ShownSessionListStore } from './shown-session-list-store.js';
import { minMedianMax, type ProjectCount, type Stats, type StatusCount, type ToolCount, type ToolZeroPaths } from './stats.js';
import { type MemoryRow, TurnStore } from './turn-store.js';

export type { InjectionRow, RecordInjectionInput } from './injection-store.js';
export type { ProjectRow } from './project-store.js';
export type { SessionRow } from './session-store.js';
export type { MemoryRow } from './turn-store.js';
export { hydrateTurnDecisions } from './turn-store.js';

/** One group of project rows consolidated onto a single canonical row. Returned for reporting - a migration that can't show its work isn't reviewable. */
export interface ProjectMergePlan {
    canonical: ProjectRow;
    gitRoot: string | null;
    merged: ProjectRow[];
}

export interface MemoryStoreOptions {
    /** Test seam; production resolves through the Rule 2 subprocess allowlist. */
    resolveGitRoot?: (projectPath: string) => string | null;
    /** Test seam paired with resolveGitRoot so git-backed project creation stays deterministic. */
    resolveGitRemote?: (gitRoot: string) => string | null;
    /** Test seam paired with resolveGitRoot so git-backed project creation stays deterministic. */
    resolveGitRootCommit?: (gitRoot: string) => string | null;
    /** Test seam for the session/segment baseline captured from the same resolved project identity. */
    resolveGitCommitCount?: (projectPath: string) => number | null;
}

/** What to purge: at most one project scope, optionally narrowed by time. */
export interface PurgeScope {
    /** Purge every session belonging to project rows matching this path or display name (see findProjectsForPurge). */
    projectPath?: string;
    /** Purge every session belonging to these already-resolved project rows. */
    projectIds?: number[];
    /** Purge every project row at or below one approved consent root. */
    projectRoot?: string;
    /** Purge sessions with last_ingested_at >= this ISO timestamp. */
    newerThan?: string;
    /** Purge sessions with last_ingested_at <= this ISO timestamp. */
    olderThan?: string;
    /** Purge everything: every session, every project row. */
    all?: boolean;
}

export interface PurgeSessionPreview {
    id: number;
    nativeId: string;
    title: string | null;
    projectId: number;
    projectPath: string;
    tool: ToolName;
    startedAt: string;
    lastIngestedAt: string;
    turnCount: number;
}

/** Preview of a purge before it runs: the actual session list, not just a count, because aggregates hide misclassification. */
export interface PurgePlan {
    scope: PurgeScope;
    sessions: PurgeSessionPreview[];
    /** Project rows that will have zero sessions left and are therefore removed too. */
    emptiedProjects: ProjectRow[];
}

export class MemoryStore {
    private readonly db: Database;
    readonly consent: ConsentStore;
    private readonly projects: ProjectStore;
    private readonly sessions: SessionStore;
    private readonly turns: TurnStore;
    private readonly injections: InjectionStore;
    readonly shownSessionLists: ShownSessionListStore;

    constructor(db: Database, options: MemoryStoreOptions = {}) {
        this.db = db;
        this.consent = new ConsentStore(db);
        this.projects = new ProjectStore(db, options);
        this.sessions = new SessionStore(db, (id) => this.projects.getProjectById(id), options.resolveGitCommitCount);
        this.turns = new TurnStore(db, this.sessions);
        this.injections = new InjectionStore(db);
        this.shownSessionLists = new ShownSessionListStore(db);
    }

    get database(): Database {
        return this.db;
    }

    recordInjection(input: RecordInjectionInput): boolean {
        return this.injections.recordInjection(input);
    }

    injectionsForSession(tool: ToolName, nativeSessionId: string, atOrBefore: string): InjectionRow[] {
        return this.injections.injectionsForSession(tool, nativeSessionId, atOrBefore);
    }

    hasMemoryForNativeTurn(tool: ToolName, nativeId: string, turnIndex: number): boolean {
        return this.turns.hasMemoryForNativeTurn(tool, nativeId, turnIndex);
    }

    upsertProject(projectPath: string): ProjectRow {
        return this.projects.upsertProject(projectPath);
    }

    getProjectById(id: number): ProjectRow | undefined {
        return this.projects.getProjectById(id);
    }

    findProject(query: string): ProjectRow | undefined {
        return this.projects.findProject(query);
    }

    listProjects(): ProjectRow[] {
        return this.projects.listProjects();
    }

    sessionCountsByProject(): Map<number, number> {
        const rows = this.db.prepare('SELECT project_id, COUNT(*) AS c FROM sessions GROUP BY project_id').all() as Array<{
            project_id: number;
            c: number;
        }>;
        return new Map(rows.map((row) => [row.project_id, row.c]));
    }

    upsertSession(
        tool: ToolName,
        nativeId: string,
        projectId: number,
        sourcePath: string,
        meta?: { surface?: SessionRowSurface | null; gitBranch?: string | null; kind?: SessionRowKind | null; customTitle?: string },
    ): SessionRow {
        return this.sessions.upsertSession(tool, nativeId, projectId, sourcePath, meta);
    }

    findSession(tool: ToolName, nativeId: string): SessionRow | undefined {
        return this.sessions.findSession(tool, nativeId);
    }

    /** A purge freezes the whole native transcript, across all its segments. */
    isTranscriptPurged(tool: ToolName, nativeId: string): boolean {
        return this.db.prepare('SELECT 1 FROM purged_transcripts WHERE tool = ? AND native_id = ?').get(tool, nativeId) !== undefined;
    }

    /** Records only the stable provider/session identity, never transcript content. */
    recordIncognitoTranscript(tool: ToolName, nativeId: string): void {
        this.db
            .prepare('INSERT OR IGNORE INTO incognito_transcripts (tool, native_id, tombstoned_at) VALUES (?, ?, ?)')
            .run(tool, nativeId, new Date().toISOString());
    }

    isTranscriptIncognito(tool: ToolName, nativeId: string): boolean {
        return this.db.prepare('SELECT 1 FROM incognito_transcripts WHERE tool = ? AND native_id = ?').get(tool, nativeId) !== undefined;
    }

    startNextSegment(
        previous: SessionRow,
        projectId: number,
        sourcePath: string,
        meta?: { surface?: SessionRowSurface | null; gitBranch?: string | null; kind?: SessionRowKind | null; customTitle?: string },
    ): SessionRow {
        return this.sessions.startNextSegment(previous, projectId, sourcePath, meta);
    }

    listSessionsForRollupRebuild(currentVersion: number): SessionRow[] {
        return this.sessions.listSessionsForRollupRebuild(currentVersion);
    }

    listOpenSessions(): SessionRow[] {
        return this.sessions.listOpenSessions();
    }

    getSessionCursor(tool: ToolName, nativeId: string): string | undefined {
        return this.sessions.getSessionCursor(tool, nativeId);
    }

    advanceExistingSessionCursor(tool: ToolName, nativeId: string, cursor: string): boolean {
        return this.sessions.advanceExistingSessionCursor(tool, nativeId, cursor);
    }

    getLastIngestedAt(): string | undefined {
        return this.turns.getLastIngestedAt();
    }

    recordTurn(turn: ParsedTurn, sessionDbId: number, projectId: number, summary: SummarizationOutput): boolean {
        return this.turns.recordTurn(turn, sessionDbId, projectId, summary);
    }

    /**
     * Creates the project/session and records one live turn as one SQLite
     * transaction. Write blockers and native-turn dedupe are authoritative
     * here: an earlier scan check may avoid work, but it cannot make a
     * persistence decision across concurrent writers.
     */
    recordIngestedTurn(
        turn: ParsedTurn,
        meta: { surface?: SessionRowSurface | null; gitBranch?: string | null; kind?: SessionRowKind | null; customTitle?: string },
        startNextSegment: boolean,
        summary: SummarizationOutput,
    ): { project: ProjectRow; session: SessionRow; inserted: boolean } | undefined {
        const resolved = this.resolveTurnGitValues(turn, startNextSegment);
        const write = this.db.transaction(() => {
            if (this.recordIncognitoIfWriteBlocked(turn)) {
                return undefined;
            }
            if (this.turns.hasMemoryForNativeTurn(turn.tool, turn.sessionId, turn.turnIndex)) {
                return undefined;
            }
            const project = this.projects.upsertProject(turn.projectPath, resolved.projectIdentity);
            let session = this.sessions.upsertSession(
                turn.tool,
                turn.sessionId,
                project.id,
                turn.sourcePath,
                meta,
                resolved.gitCommitCount,
            );
            if (startNextSegment) {
                session = this.sessions.startNextSegment(session, project.id, turn.sourcePath, meta, resolved.gitCommitCount);
            }
            return { project, session, inserted: this.turns.recordTurnInTransaction(turn, session.id, project.id, summary) };
        });
        return write();
    }

    recordDroppedTurn(
        turn: ParsedTurn,
        meta: { surface?: SessionRowSurface | null; gitBranch?: string | null; kind?: SessionRowKind | null; customTitle?: string },
    ): boolean {
        const resolved = this.resolveTurnGitValues(turn, false);
        const write = this.db.transaction(() => {
            if (this.recordIncognitoIfWriteBlocked(turn)) {
                return false;
            }
            const project = this.projects.upsertProject(turn.projectPath, resolved.projectIdentity);
            const session = this.sessions.upsertSession(
                turn.tool,
                turn.sessionId,
                project.id,
                turn.sourcePath,
                meta,
                resolved.gitCommitCount,
            );
            this.sessions.updateSessionTitle(session.id, turn);
            this.sessions.advanceSessionCursor(session.id, turn.cursor);
            return true;
        });
        return write();
    }

    private resolveTurnGitValues(
        turn: ParsedTurn,
        startNextSegment: boolean,
    ): { projectIdentity: ResolvedProjectIdentity; gitCommitCount: number | null } {
        const projectIdentity = this.projects.resolveProjectIdentity(turn.projectPath);
        const existingSession = this.sessions.findSession(turn.tool, turn.sessionId);
        const needsGitCommitCount = existingSession === undefined || startNextSegment;
        return {
            projectIdentity,
            gitCommitCount: needsGitCommitCount
                ? this.sessions.gitCommitCount(projectIdentity.gitRoot ?? turn.projectPath)
                : existingSession.git_commit_count,
        };
    }

    /** The final consent and tombstone decision must share the transaction that would mutate capture rows. */
    private recordIncognitoIfWriteBlocked(turn: ParsedTurn): boolean {
        const consentState = this.consent.consentState(turn.projectPath);
        const mustRecordIncognito =
            consentState === 'denied' ||
            this.isTranscriptPurged(turn.tool, turn.sessionId) ||
            this.isTranscriptIncognito(turn.tool, turn.sessionId);
        if (mustRecordIncognito) {
            this.recordIncognitoTranscript(turn.tool, turn.sessionId);
        }
        return consentState !== 'approved' || mustRecordIncognito;
    }

    reingestTurn(turn: ParsedTurn, sessionDbId: number, projectId: number, summary: SummarizationOutput): void {
        this.turns.reingestTurn(turn, sessionDbId, projectId, summary);
    }

    listSessionsWithMemoriesSince(sinceIso: string): SessionRow[] {
        return this.sessions.listSessionsWithMemoriesSince(sinceIso);
    }

    /**
     * Consolidates project rows that identify the same repository even when a
     * checkout was renamed or moved. A stored remote is the durable identity,
     * followed by the root commit; a live git root is the fallback for legacy
     * rows without either value.
     *
     * When a group has a live checkout, its canonical row is chosen from those
     * live members, preferring the repository root and then the shallowest
     * path. Without a live checkout, the shallowest row survives but keeps its
     * existing path and git root rather than being rewritten to stale data.
     */
    planRekeyProjectsByIdentity(resolveGitRoot: (path: string) => string | null): ProjectMergePlan[] {
        const groups = new Map<string, Array<{ project: ProjectRow; gitRoot: string | null }>>();
        for (const project of this.listProjects()) {
            const gitRoot = project.path ? resolveGitRoot(project.path) : null;
            const identity = project.git_remote || project.git_root_commit || gitRoot;
            if (!identity) {
                continue;
            }
            const key = gitRoot === identity ? normalizeForCompare(identity) : identity;
            const members = groups.get(key);
            if (members) {
                members.push({ project, gitRoot });
            } else {
                groups.set(key, [{ project, gitRoot }]);
            }
        }

        const plans: ProjectMergePlan[] = [];
        for (const members of groups.values()) {
            const liveMembers = members.filter((member) => member.gitRoot !== null);
            const candidates = liveMembers.length > 0 ? liveMembers : members;
            const canonicalMember =
                candidates.find((member) => member.gitRoot !== null && samePath(member.project.path, member.gitRoot)) ??
                candidates.reduce((shallowest, member) =>
                    member.project.path.split('/').length < shallowest.project.path.split('/').length ? member : shallowest,
                );
            const gitRoot = canonicalMember.gitRoot;
            const requiresCanonicalization =
                gitRoot !== null &&
                (!samePath(canonicalMember.project.path, gitRoot) || canonicalMember.project.display_name !== path.basename(gitRoot));
            if (members.length < 2 && !requiresCanonicalization) {
                continue;
            }
            plans.push({
                canonical: canonicalMember.project,
                gitRoot,
                merged: members.map((member) => member.project).filter((member) => member.id !== canonicalMember.project.id),
            });
        }
        return plans;
    }

    /** Applies planRekeyProjectsByIdentity's plan in a single transaction. Returns the plan that was applied, for reporting. */
    rekeyProjectsByIdentity(resolveGitRoot: (path: string) => string | null): ProjectMergePlan[] {
        const plans = this.planRekeyProjectsByIdentity(resolveGitRoot);
        const apply = this.db.transaction(() => {
            for (const plan of plans) {
                for (const victim of plan.merged) {
                    this.db.prepare('UPDATE memories SET project_id = ? WHERE project_id = ?').run(plan.canonical.id, victim.id);
                    this.db.prepare('UPDATE sessions SET project_id = ? WHERE project_id = ?').run(plan.canonical.id, victim.id);
                    this.db.prepare('UPDATE session_rollups SET project_id = ? WHERE project_id = ?').run(plan.canonical.id, victim.id);
                    this.db.prepare('DELETE FROM projects WHERE id = ?').run(victim.id);
                }
                if (plan.gitRoot !== null) {
                    this.db
                        .prepare('UPDATE projects SET path = ?, display_name = ?, git_root = ? WHERE id = ?')
                        .run(plan.gitRoot, path.basename(plan.gitRoot), plan.gitRoot, plan.canonical.id);
                }
            }
        });
        apply();
        return plans;
    }

    /**
     * Project rows matching a purge query: exact path match if one exists,
     * otherwise every row whose path or display_name contains the query.
     * Unlike findProject() (single best guess, for UX lookups), this returns
     * every match because one project can be fragmented across multiple rows,
     * and a purge that only
     * hit the first match would silently leave the rest behind.
     */
    findProjectsForPurge(query: string): ProjectRow[] {
        if (query.trim().length === 0) {
            return [];
        }
        const rows = this.listProjects();
        const exact = rows.filter((r) => r.path === query);
        if (exact.length > 0) {
            return exact;
        }
        return rows.filter((r) => r.path.includes(query) || r.display_name?.includes(query));
    }

    /**
     * Computes what a purge would delete, without deleting anything. The
     * actual session list, not just a count: aggregates hide misclassification.
     */
    planPurge(scope: PurgeScope): PurgePlan {
        let sessionRows: SessionRow[];
        if (scope.projectRoot !== undefined) {
            const root = canonicalizeExisting(scope.projectRoot);
            const projectIds = this.listProjects()
                .filter((p) => isWithin(root, canonicalizeExisting(p.path)))
                .map((p) => p.id);
            sessionRows = this.sessionsForProjectIds(projectIds);
        } else if (scope.projectPath !== undefined) {
            const projectIds = this.findProjectsForPurge(scope.projectPath).map((p) => p.id);
            sessionRows = this.sessionsForProjectIds(projectIds);
        } else if (scope.projectIds !== undefined) {
            sessionRows = this.sessionsForProjectIds(scope.projectIds);
        } else if (scope.all || scope.newerThan !== undefined || scope.olderThan !== undefined) {
            sessionRows = this.db
                .prepare('SELECT * FROM sessions')
                .all()
                .map((row) => hydrateSessionRow(row as Record<string, unknown>));
        } else {
            sessionRows = [];
        }
        const newerThan = scope.newerThan;
        if (newerThan !== undefined) {
            sessionRows = sessionRows.filter((session) => session.last_ingested_at >= newerThan);
        }
        const olderThan = scope.olderThan;
        if (olderThan !== undefined) {
            sessionRows = sessionRows.filter((session) => session.last_ingested_at <= olderThan);
        }
        const projectById = new Map(this.listProjects().map((p) => [p.id, p]));
        const countTurns = this.db.prepare('SELECT COUNT(*) as c FROM memories WHERE session_id = ?');
        const sessions: PurgeSessionPreview[] = sessionRows.map((s) => ({
            id: s.id,
            nativeId: s.native_id,
            title: s.title,
            projectId: s.project_id,
            projectPath: projectById.get(s.project_id)?.path ?? '(unknown project)',
            tool: s.tool,
            startedAt: s.started_at,
            lastIngestedAt: s.last_ingested_at,
            turnCount: (countTurns.get(s.id) as { c: number }).c,
        }));
        // A project is "emptied" if every one of its sessions is in this
        // purge - compare against its true total, not just what we selected.
        const purgedByProject = new Map<number, number>();
        for (const s of sessions) {
            purgedByProject.set(s.projectId, (purgedByProject.get(s.projectId) ?? 0) + 1);
        }
        const totalSessionsByProject = this.db.prepare('SELECT COUNT(*) as c FROM sessions WHERE project_id = ?');
        const emptiedProjects: ProjectRow[] = [];
        for (const [projectId, purgedCount] of purgedByProject) {
            const total = (totalSessionsByProject.get(projectId) as { c: number }).c;
            if (purgedCount === total) {
                const project = projectById.get(projectId);
                if (project) {
                    emptiedProjects.push(project);
                }
            }
        }
        return { scope, sessions, emptiedProjects };
    }

    /** Applies exactly the still-present sessions in a previewed purge plan, in one transaction. */
    applyPurgePlan(plan: PurgePlan, purgedAt = new Date().toISOString()): PurgePlan {
        const sessionIdentity = this.db.prepare('SELECT tool, native_id FROM sessions WHERE id = ?');
        const tombstone = this.db.prepare('INSERT OR IGNORE INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)');
        const deleteRollup = this.db.prepare('DELETE FROM session_rollups WHERE session_id = ?');
        const deleteMemories = this.db.prepare('DELETE FROM memories WHERE session_id = ?');
        const deleteSession = this.db.prepare('DELETE FROM sessions WHERE id = ?');
        const countProjectSessions = this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?');
        const deleteProject = this.db.prepare('DELETE FROM projects WHERE id = ?');
        const appliedSessions: PurgeSessionPreview[] = [];
        const emptiedProjects: ProjectRow[] = [];
        const apply = this.db.transaction(() => {
            for (const s of plan.sessions) {
                const identity = sessionIdentity.get(s.id) as { tool: ToolName; native_id: string } | undefined;
                if (!identity) {
                    continue;
                }
                if (identity.tool !== s.tool || identity.native_id !== s.nativeId) {
                    throw new Error(`Purge plan session id ${s.id} no longer matches the previewed session.`);
                }
                tombstone.run(identity.tool, identity.native_id, purgedAt);
                deleteRollup.run(s.id);
                deleteMemories.run(s.id);
                deleteSession.run(s.id);
                appliedSessions.push(s);
            }
            for (const p of plan.emptiedProjects) {
                const remaining = countProjectSessions.get(p.id) as { count: number };
                if (remaining.count === 0 && deleteProject.run(p.id).changes > 0) {
                    emptiedProjects.push(p);
                }
            }
        });
        apply();
        // "Revocation = deletion" isn't true of the file on disk until the
        // WAL is reclaimed too - a deleted row's page can sit in
        // elepha.db-wal, readable to anything with filesystem access, until a
        // checkpoint overwrites it. TRUNCATE both checkpoints and shrinks the
        // file back to zero, rather than leaving a large reusable-but-still-
        // populated WAL behind.
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        return { ...plan, sessions: appliedSessions, emptiedProjects };
    }

    /** Plans and applies a scope immediately. Existing callers retain the same behavior and signature. */
    purge(scope: PurgeScope, purgedAt = new Date().toISOString()): PurgePlan {
        return this.applyPurgePlan(this.planPurge(scope), purgedAt);
    }

    listMemoriesForSession(sessionId: number): MemoryRow[] {
        return this.turns.listMemoriesForSession(sessionId);
    }

    listRecentMemories(projectId: number, limit = 20): MemoryRow[] {
        return this.turns.listRecentMemories(projectId, limit);
    }

    /** Dogfooding instrumentation - see ./stats.ts. Not part of the served-memory surface. */
    getStats(sinceIso: string): Stats {
        const byTool = this.db
            .prepare(`SELECT tool, COUNT(DISTINCT session_id) as sessions, COUNT(*) as turns
         FROM memories WHERE turn_started_at >= ? GROUP BY tool`)
            .all(sinceIso) as ToolCount[];
        const perSessionCounts = (
            this.db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE turn_started_at >= ? GROUP BY session_id`).all(sinceIso) as Array<{
                cnt: number;
            }>
        ).map((r) => r.cnt);
        const perSessionPending = (
            this.db
                .prepare(`SELECT SUM(json_array_length(pending_items)) as cnt FROM memories WHERE turn_started_at >= ? GROUP BY session_id`)
                .all(sinceIso) as Array<{ cnt: number }>
        ).map((r) => r.cnt);
        const byProject = this.db
            .prepare(
                `SELECT m.project_id as project_id, COALESCE(p.display_name, p.path) as project,
                COUNT(*) as memories, SUM(json_array_length(m.pending_items)) as open_pending_items
         FROM memories m JOIN projects p ON p.id = m.project_id
         WHERE m.turn_started_at >= ?
         GROUP BY m.project_id
         ORDER BY memories DESC`,
            )
            .all(sinceIso) as ProjectCount[];
        const noise = this.db
            .prepare(
                `SELECT
           SUM(CASE WHEN decisions = '[]' AND pending_items = '[]' THEN 1 ELSE 0 END) as count,
           COUNT(*) as total
         FROM memories WHERE turn_started_at >= ?`,
            )
            .get(sinceIso) as { count: number; total: number };
        const filesTouchedZero = this.db
            .prepare(
                `SELECT tool,
           SUM(CASE WHEN files_touched = '[]' THEN 1 ELSE 0 END) as zero_paths,
           COUNT(*) as total
         FROM memories WHERE turn_started_at >= ? GROUP BY tool`,
            )
            .all(sinceIso) as ToolZeroPaths[];
        const byStatus = this.db
            .prepare(`SELECT summarizer_status, COUNT(*) as count FROM memories WHERE turn_started_at >= ? GROUP BY summarizer_status`)
            .all(sinceIso) as StatusCount[];
        return {
            since: sinceIso,
            totalMemories: noise.total,
            byTool,
            memoriesPerSession: minMedianMax(perSessionCounts),
            pendingItemsPerSession: minMedianMax(perSessionPending),
            byProject,
            noise,
            byStatus,
            filesTouchedZero,
        };
    }

    private sessionsForProjectIds(projectIds: number[]): SessionRow[] {
        return projectIds.length === 0
            ? []
            : this.db
                  .prepare(`SELECT * FROM sessions WHERE project_id IN (${projectIds.map(() => '?').join(',')})`)
                  .all(...projectIds)
                  .map((row) => hydrateSessionRow(row as Record<string, unknown>));
    }
}
