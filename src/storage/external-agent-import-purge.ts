// Purges Codex rollouts created by OpenAI's "Import from another agent".
// Identification is structural and source-backed: every stored Codex
// source_path is re-read through CodexAdapter.classifySession(), which checks
// event_msg.payload.turn_id for the external-import-turn- prefix.

import type Database from 'better-sqlite3';
import type { CodexAdapter } from '../adapters/codex.js';
import { isReadableProviderSource } from '../config/paths.js';
import { errorMessage } from '../util/error.js';

export interface ExternalImportPurgeSession {
    id: number;
    nativeId: string;
    segmentIndex: number;
    projectId: number;
    projectPath: string;
    sourcePath: string;
    memoryRows: number;
}

export interface ExternalImportPurgeIssue {
    sourcePath: string;
    reason: string;
}

export interface ExternalImportPurgeProject {
    id: number;
    path: string;
}

export interface StoreCounts {
    projects: number;
    sessions: number;
    memories: number;
    rollups: number;
}

export interface ExternalImportPurgePlan {
    sourcePathsScanned: number;
    importedSourcePaths: string[];
    sessions: ExternalImportPurgeSession[];
    memoryRowsAffected: number;
    rollupsAffected: number;
    emptiedProjects: ExternalImportPurgeProject[];
    issues: ExternalImportPurgeIssue[];
    before: StoreCounts;
    resulting: StoreCounts;
}

export interface ExternalImportPurgeVerification {
    ok: boolean;
    errors: string[];
    counts: StoreCounts;
}

interface StoredSession {
    id: number;
    native_id: string;
    segment_index: number;
    project_id: number;
    project_path: string;
    source_path: string;
}

function count(db: Database.Database, table: 'projects' | 'sessions' | 'memories' | 'session_rollups'): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function storeCounts(db: Database.Database): StoreCounts {
    return {
        projects: count(db, 'projects'),
        sessions: count(db, 'sessions'),
        memories: count(db, 'memories'),
        rollups: count(db, 'session_rollups'),
    };
}

function placeholders(values: readonly unknown[]): string {
    return values.map(() => '?').join(',');
}

function affectedRollupCount(db: Database.Database, sessionIds: number[]): number {
    if (sessionIds.length === 0) {
        return 0;
    }
    const marks = placeholders(sessionIds);
    return (
        db
            .prepare(`SELECT COUNT(*) AS count FROM session_rollups WHERE session_id IN (${marks}) OR parent_session_id IN (${marks})`)
            .get(...sessionIds, ...sessionIds) as { count: number }
    ).count;
}

function emptiedProjects(db: Database.Database, sessionIds: number[], projectIds: number[]): ExternalImportPurgeProject[] {
    if (sessionIds.length === 0 || projectIds.length === 0) {
        return [];
    }
    const sessionMarks = placeholders(sessionIds);
    const projectMarks = placeholders(projectIds);
    return db
        .prepare(
            `SELECT p.id, p.path
                 FROM projects p
                 WHERE p.id IN (${projectMarks})
                   AND NOT EXISTS (
                       SELECT 1 FROM sessions s
                       WHERE s.project_id = p.id AND s.id NOT IN (${sessionMarks})
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM memories m
                       WHERE m.project_id = p.id AND m.session_id NOT IN (${sessionMarks})
                   )
                 ORDER BY p.id`,
        )
        .all(...projectIds, ...sessionIds, ...sessionIds) as ExternalImportPurgeProject[];
}

// Read-only preview. Every currently referenced Codex transcript is re-read from disk.
export async function planExternalAgentImportPurge(
    db: Database.Database,
    adapter: Pick<CodexAdapter, 'classifySession'>,
): Promise<ExternalImportPurgePlan> {
    const sourcePaths = (
        db.prepare("SELECT DISTINCT source_path FROM sessions WHERE tool = 'codex' ORDER BY source_path").all() as Array<{
            source_path: string;
        }>
    ).map((row) => row.source_path);
    const importedSourcePaths: string[] = [];
    const issues: ExternalImportPurgeIssue[] = [];

    for (const sourcePath of sourcePaths) {
        if (!isReadableProviderSource('codex', sourcePath)) {
            issues.push({ sourcePath, reason: 'source transcript is missing' });
            continue;
        }
        try {
            const classification = await adapter.classifySession(sourcePath);
            if (classification.exclusion === 'external-agent-import') {
                importedSourcePaths.push(sourcePath);
            }
        } catch (error) {
            issues.push({ sourcePath, reason: errorMessage(error) });
        }
    }

    const rows =
        importedSourcePaths.length === 0
            ? []
            : (db
                  .prepare(
                      `SELECT s.id, s.native_id, s.segment_index, s.project_id, p.path AS project_path, s.source_path
                       FROM sessions s
                       JOIN projects p ON p.id = s.project_id
                       WHERE s.tool = 'codex' AND s.source_path IN (${placeholders(importedSourcePaths)})
                       ORDER BY s.id`,
                  )
                  .all(...importedSourcePaths) as StoredSession[]);
    const countMemories = db.prepare('SELECT COUNT(*) AS count FROM memories WHERE session_id = ?');
    const sessions = rows.map((row) => ({
        id: row.id,
        nativeId: row.native_id,
        segmentIndex: row.segment_index,
        projectId: row.project_id,
        projectPath: row.project_path,
        sourcePath: row.source_path,
        memoryRows: (countMemories.get(row.id) as { count: number }).count,
    }));
    const sessionIds = sessions.map((session) => session.id);
    const projectIds = [...new Set(sessions.map((session) => session.projectId))];
    const memoryRowsAffected = sessions.reduce((sum, session) => sum + session.memoryRows, 0);
    const rollupsAffected = affectedRollupCount(db, sessionIds);
    const emptiedProjectsAfterPurge = emptiedProjects(db, sessionIds, projectIds);
    const before = storeCounts(db);

    return {
        sourcePathsScanned: sourcePaths.length,
        importedSourcePaths,
        sessions,
        memoryRowsAffected,
        rollupsAffected,
        emptiedProjects: emptiedProjectsAfterPurge,
        issues,
        before,
        resulting: {
            projects: before.projects - emptiedProjectsAfterPurge.length,
            sessions: before.sessions - sessions.length,
            memories: before.memories - memoryRowsAffected,
            rollups: before.rollups - rollupsAffected,
        },
    };
}

function assertPlanStillMatches(db: Database.Database, plan: ExternalImportPurgePlan): void {
    const sessionIds = plan.sessions.map((session) => session.id);
    const currentSessionIds =
        plan.importedSourcePaths.length === 0
            ? []
            : (
                  db
                      .prepare(
                          `SELECT id FROM sessions
                           WHERE tool = 'codex' AND source_path IN (${placeholders(plan.importedSourcePaths)})
                           ORDER BY id`,
                      )
                      .all(...plan.importedSourcePaths) as Array<{ id: number }>
              ).map((row) => row.id);
    if (currentSessionIds.join(',') !== sessionIds.join(',')) {
        throw new Error('session rows changed after preview');
    }
    const memoryRows =
        sessionIds.length === 0
            ? 0
            : (
                  db
                      .prepare(`SELECT COUNT(*) AS count FROM memories WHERE session_id IN (${placeholders(sessionIds)})`)
                      .get(...sessionIds) as { count: number }
              ).count;
    if (memoryRows !== plan.memoryRowsAffected) {
        throw new Error('memory rows changed after preview');
    }
    if (affectedRollupCount(db, sessionIds) !== plan.rollupsAffected) {
        throw new Error('rollups changed after preview');
    }
}

// Applies exactly the previewed row ids in one transaction.
export function applyExternalAgentImportPurge(db: Database.Database, plan: ExternalImportPurgePlan): void {
    if (plan.issues.length > 0) {
        throw new Error(`cannot apply with ${plan.issues.length} unreadable or missing source transcript(s)`);
    }
    const sessionIds = plan.sessions.map((session) => session.id);
    if (sessionIds.length === 0) {
        return;
    }
    const marks = placeholders(sessionIds);
    const apply = db.transaction(() => {
        assertPlanStillMatches(db, plan);
        db.prepare(`DELETE FROM session_rollups WHERE session_id IN (${marks}) OR parent_session_id IN (${marks})`).run(
            ...sessionIds,
            ...sessionIds,
        );
        db.prepare(`DELETE FROM memories WHERE session_id IN (${marks})`).run(...sessionIds);
        db.prepare(`DELETE FROM sessions WHERE id IN (${marks})`).run(...sessionIds);
        if (plan.emptiedProjects.length > 0) {
            const projectIds = plan.emptiedProjects.map((project) => project.id);
            db.prepare(`DELETE FROM projects WHERE id IN (${placeholders(projectIds)})`).run(...projectIds);
        }
    });
    apply();
    db.pragma('wal_checkpoint(TRUNCATE)');
}

// Re-reads remaining Codex source paths and validates counts plus foreign keys.
export async function verifyExternalAgentImportPurge(
    db: Database.Database,
    adapter: Pick<CodexAdapter, 'classifySession'>,
    plan: ExternalImportPurgePlan,
): Promise<ExternalImportPurgeVerification> {
    const errors: string[] = [];
    const counts = storeCounts(db);
    for (const key of ['projects', 'sessions', 'memories', 'rollups'] as const) {
        if (counts[key] !== plan.resulting[key]) {
            errors.push(`${key} count is ${counts[key]}, expected ${plan.resulting[key]}`);
        }
    }
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
        errors.push(`foreign_key_check returned ${violations.length} violation(s)`);
    }
    const remaining = await planExternalAgentImportPurge(db, adapter);
    if (remaining.sessions.length > 0) {
        errors.push(`${remaining.sessions.length} session row(s) still reference external-agent import turns`);
    }
    if (remaining.issues.length > 0) {
        errors.push(`${remaining.issues.length} remaining Codex source transcript(s) could not be verified`);
    }
    return { ok: errors.length === 0, errors, counts };
}
