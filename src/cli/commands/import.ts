import path from 'node:path';
import Database from 'better-sqlite3';
import type { Command } from 'commander';
import { canonicalizeExisting, isWithinProviderStore, normalizeForCompare } from '../../config/paths.js';
import { readSessionMetadata } from '../../discovery/session-projects.js';
import { daemonHealth as currentDaemonHealth, type DaemonHealth } from '../../install/health-checks.js';
import { stripShellSyntax } from '../../security/sanitize.js';
import { writeBackup } from '../../storage/backup.js';
import { validateCandidateSemantics } from '../../storage/candidate-validator.js';
import { defaultDbPath } from '../../storage/db.js';
import { firstPromptSearch } from '../../storage/first-prompt-search.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { ProjectResolver } from '../../storage/project-resolver.js';
import type { ProjectRow } from '../../storage/project-store.js';
import {
    sanitizeRollupDecisionsField,
    sanitizeRollupDisplayField,
    sanitizeRollupPendingItemsField,
} from '../../storage/sanitize-backfill.js';
import { hydrateTurnDecisions, sanitizeTurnDecision } from '../../storage/turn-store.js';
import type { ToolName } from '../../types/index.js';
import { errorMessage } from '../../util/error.js';
import { runImportWizard } from '../import-wizard.js';
import { confirmYesNo } from '../shared.js';

export const IMPORTED_TABLES = ['projects', 'sessions', 'memories', 'session_rollups'] as const;

type ImportedTable = (typeof IMPORTED_TABLES)[number];
type SqlValue = string | number | bigint | Buffer | null;
type SqlRow = Record<string, SqlValue>;

interface ImportCommandOptions {
    overwrite: boolean;
    skipConfirmation: boolean;
}

interface ImportSessionRow extends SqlRow {
    id: number;
    tool: ToolName;
    native_id: string;
    segment_index: number;
    project_id: number;
    source_path: SqlValue;
}

interface ImportMemoryRow extends SqlRow {
    id: number;
    project_id: number;
    session_id: number;
}

interface ImportRollupRow extends SqlRow {
    session_id: number;
    project_id: number;
    parent_session_id: number | null;
}

type SessionDisposition = 'new' | 'existing' | 'purged' | 'incognito' | 'unconsented' | 'outside_store';

interface ProjectTarget {
    backupProjectIds: number[];
    representative: ProjectRow;
    existingLocalId?: number;
}

interface SessionPlan {
    row: ImportSessionRow;
    disposition: SessionDisposition;
    localSessionId?: number;
    canonicalCwd?: string;
}

export interface ImportPlan {
    projects: ProjectTarget[];
    sessions: SessionPlan[];
    counts: {
        new: number;
        existing: number;
        purged: number;
        incognito: number;
        unconsented: number;
        outsideStore: number;
    };
}

export interface ImportRuntime {
    dbPath?: string;
    daemonHealth?: () => DaemonHealth;
    writeBackup?: (db: Database.Database, dbPath: string) => string;
    confirm?: (plan: ImportPlan) => Promise<boolean>;
    /** Test seam for proving that any failure after writes begin rolls the transaction back. */
    beforeVerify?: (db: Database.Database) => void;
}

export interface ImportResult {
    cancelled: boolean;
    snapshotPath?: string;
    added: number;
    overwritten: number;
    skipped: number;
}

class ImportApplyError extends Error {
    constructor(
        readonly snapshotPath: string,
        cause: unknown,
    ) {
        super(`Import failed after saving the pre-import snapshot to ${snapshotPath}: ${errorMessage(cause)}`);
    }
}

const REQUIRED_COLUMNS: Record<ImportedTable, readonly string[]> = {
    projects: ['id', 'path', 'display_name', 'git_root', 'git_remote', 'git_root_commit', 'first_seen_at', 'last_seen_at'],
    sessions: [
        'id',
        'tool',
        'native_id',
        'segment_index',
        'project_id',
        'source_path',
        'cursor',
        'started_at',
        'last_ingested_at',
        'surface',
        'git_branch',
        'kind',
        'last_turn_at',
        'trailing_branch',
        'trailing_files',
        'rendered_chars',
        'rendered_turns',
        'title',
        'custom_title',
        'git_commit_count',
    ],
    memories: [
        'id',
        'project_id',
        'session_id',
        'turn_index',
        'tool',
        'turn_started_at',
        'decisions',
        'files_touched',
        'pending_items',
        'superseded_at',
        'created_at',
        'summarizer_status',
        'reingested_at',
        'has_external_content',
    ],
    session_rollups: [
        'session_id',
        'project_id',
        'tool',
        'title',
        'summary',
        'decisions',
        'pending_items',
        'files_touched',
        'turn_count',
        'started_at',
        'ended_at',
        'kind',
        'parent_session_id',
        'summarizer_status',
        'rollup_state',
        'rolled_up_through_turn_index',
        'computed_at',
        'rollup_version',
    ],
};

const SESSION_WRITE_COLUMNS = [...REQUIRED_COLUMNS.sessions.filter((column) => column !== 'id'), 'first_prompt_search'];
const MEMORY_WRITE_COLUMNS = REQUIRED_COLUMNS.memories.filter((column) => column !== 'id');
const ROLLUP_WRITE_COLUMNS = REQUIRED_COLUMNS.session_rollups;

function tableNames(db: Database.Database): Set<string> {
    return new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
}

function tableColumns(db: Database.Database, table: ImportedTable): Set<string> {
    return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name));
}

function validateCandidate(db: Database.Database): void {
    const tables = tableNames(db);
    const missingTables = IMPORTED_TABLES.filter((table) => !tables.has(table));
    if (missingTables.length > 0) {
        throw new Error(`Backup is incomplete (missing required table(s): ${missingTables.join(', ')}).`);
    }

    for (const table of IMPORTED_TABLES) {
        const columns = tableColumns(db, table);
        const missingColumns = REQUIRED_COLUMNS[table].filter((column) => !columns.has(column));
        if (missingColumns.length > 0) {
            throw new Error(`Backup is incompatible (${table} is missing required column(s): ${missingColumns.join(', ')}).`);
        }
    }

    const semanticViolations = validateCandidateSemantics(db, ['sessions', 'memories', 'session_rollups']);
    if (semanticViolations.length > 0) {
        throw new Error(`Backup is semantically invalid: ${semanticViolations.join('; ')}`);
    }

    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error(`Backup failed integrity_check: ${integrity.map((row) => row.integrity_check).join('; ')}`);
    }
    const foreignKeys = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeys.length > 0) {
        throw new Error(`Backup failed foreign_key_check with ${foreignKeys.length} violation(s).`);
    }
}

function openCandidate(candidatePath: string): Database.Database {
    let candidate: Database.Database | undefined;
    try {
        candidate = new Database(candidatePath, { readonly: true, fileMustExist: true });
        candidate.pragma('query_only = ON');
        candidate.exec('BEGIN');
        validateCandidate(candidate);
        return candidate;
    } catch (error) {
        candidate?.close();
        if (error instanceof Error && (error.message.startsWith('Backup is ') || error.message.startsWith('Backup failed '))) {
            throw error;
        }
        throw new Error(`Not a valid SQLite backup at ${candidatePath}: ${errorMessage(error)}`);
    }
}

function identityCandidates(project: ProjectRow): Array<{ key: string; rank: number }> {
    const candidates: Array<{ key: string; rank: number }> = [];
    if (project.git_remote) {
        candidates.push({ key: `remote:${project.git_remote}`, rank: 0 });
    }
    if (project.git_root_commit) {
        candidates.push({ key: `commit:${project.git_root_commit}`, rank: 1 });
    }
    if (project.git_root) {
        candidates.push({ key: `path:${normalizeForCompare(project.git_root)}`, rank: 2 });
    }
    candidates.push({ key: `path:${normalizeForCompare(project.path)}`, rank: 3 });
    return candidates.filter((candidate, index) => candidates.findIndex((other) => other.key === candidate.key) === index);
}

function identityKeys(project: ProjectRow): string[] {
    return identityCandidates(project).map((candidate) => candidate.key);
}

function isImportSourceWithinProviderStore(tool: ToolName, sourcePath: SqlValue): boolean {
    if (typeof sourcePath !== 'string') {
        return false;
    }
    return isWithinProviderStore(tool, sourcePath);
}

function groupBackupProjects(projects: ProjectRow[]): ProjectRow[][] {
    const parent = new Map(projects.map((project) => [project.id, project.id]));
    const ownerByIdentity = new Map<string, number>();
    const find = (id: number): number => {
        const owner = parent.get(id);
        if (owner === undefined || owner === id) {
            return id;
        }
        const root = find(owner);
        parent.set(id, root);
        return root;
    };
    const union = (left: number, right: number): void => {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) {
            parent.set(rightRoot, leftRoot);
        }
    };

    for (const project of projects) {
        for (const key of identityKeys(project)) {
            const owner = ownerByIdentity.get(key);
            if (owner === undefined) {
                ownerByIdentity.set(key, project.id);
            } else {
                union(project.id, owner);
            }
        }
    }

    const groups = new Map<number, ProjectRow[]>();
    for (const project of projects) {
        const root = find(project.id);
        const group = groups.get(root);
        if (group) {
            group.push(project);
        } else {
            groups.set(root, [project]);
        }
    }
    return [...groups.values()];
}

function canonicalLocalIds(db: Database.Database): Map<number, number> {
    // Imported paths are untrusted database content, so Git resolution is disabled:
    // identity comes only from stored fields and no backup-derived path can reach a subprocess.
    const sets = new ProjectResolver(db, { resolveGitRoot: () => null }).list();
    const canonicalById = new Map<number, number>();
    for (const set of sets) {
        const canonical = set.projectIds[0];
        if (canonical === undefined) {
            continue;
        }
        for (const projectId of set.projectIds) {
            canonicalById.set(projectId, canonical);
        }
    }
    return canonicalById;
}

function planProjects(active: Database.Database, candidate: Database.Database): ProjectTarget[] {
    const localProjects = active.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[];
    const backupProjects = candidate.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[];
    const canonicalById = canonicalLocalIds(active);
    const localByIdentity = new Map<string, number>();
    for (const project of localProjects) {
        const canonical = canonicalById.get(project.id) ?? project.id;
        for (const key of identityKeys(project)) {
            if (!localByIdentity.has(key)) {
                localByIdentity.set(key, canonical);
            }
        }
    }

    return groupBackupProjects(backupProjects).map((group) => {
        const existingLocalId = group
            .flatMap(identityCandidates)
            .sort((a, b) => a.rank - b.rank)
            .map((candidate) => localByIdentity.get(candidate.key))
            .find((localId) => localId !== undefined);
        const representative = [...group].sort(
            (a, b) =>
                Number(Boolean(b.git_remote)) - Number(Boolean(a.git_remote)) ||
                Number(Boolean(b.git_root_commit)) - Number(Boolean(a.git_root_commit)) ||
                Number(Boolean(b.git_root)) - Number(Boolean(a.git_root)) ||
                a.id - b.id,
        )[0];
        if (!representative) {
            throw new Error('Backup project group is empty.');
        }
        return {
            backupProjectIds: group.map((project) => project.id),
            representative,
            ...(existingLocalId === undefined ? {} : { existingLocalId }),
        };
    });
}

async function buildPlan(active: Database.Database, candidate: Database.Database): Promise<ImportPlan> {
    const projects = planProjects(active, candidate);
    const activeStore = new MemoryStore(active);
    const existing = active.prepare('SELECT id FROM sessions WHERE tool = ? AND native_id = ? AND segment_index = ?');
    const purged = active.prepare('SELECT 1 FROM purged_transcripts WHERE tool = ? AND native_id = ?');
    const sessions: SessionPlan[] = [];
    for (const row of candidate.prepare('SELECT * FROM sessions ORDER BY id').all() as ImportSessionRow[]) {
        if (!isImportSourceWithinProviderStore(row.tool, row.source_path)) {
            sessions.push({ row, disposition: 'outside_store' });
            continue;
        }
        if (purged.get(row.tool, row.native_id)) {
            sessions.push({ row, disposition: 'purged' });
            continue;
        }
        if (activeStore.isTranscriptIncognito(row.tool, row.native_id)) {
            sessions.push({ row, disposition: 'incognito' });
            continue;
        }
        const sourcePath = typeof row.source_path === 'string' ? row.source_path : undefined;
        const metadata = sourcePath === undefined ? undefined : await readSessionMetadata(sourcePath).catch(() => undefined);
        const canonicalCwd = metadata === undefined ? undefined : canonicalizeExisting(metadata.cwd);
        if (canonicalCwd === undefined || activeStore.consent.consentState(canonicalCwd) !== 'approved') {
            sessions.push({ row, disposition: 'unconsented' });
            continue;
        }
        const local = existing.get(row.tool, row.native_id, row.segment_index) as { id: number } | undefined;
        sessions.push(
            local ? { row, disposition: 'existing', localSessionId: local.id, canonicalCwd } : { row, disposition: 'new', canonicalCwd },
        );
    }
    return {
        projects,
        sessions,
        counts: {
            new: sessions.filter((session) => session.disposition === 'new').length,
            existing: sessions.filter((session) => session.disposition === 'existing').length,
            purged: sessions.filter((session) => session.disposition === 'purged').length,
            incognito: sessions.filter((session) => session.disposition === 'incognito').length,
            unconsented: sessions.filter((session) => session.disposition === 'unconsented').length,
            outsideStore: sessions.filter((session) => session.disposition === 'outside_store').length,
        },
    };
}

async function readPlan(dbPath: string, candidate: Database.Database): Promise<ImportPlan> {
    const active = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        active.pragma('query_only = ON');
        return await buildPlan(active, candidate);
    } finally {
        active.close();
    }
}

function printPreview(candidatePath: string, overwrite: boolean, plan: ImportPlan): void {
    console.log(`Import preview: ${candidatePath}`);
    if (overwrite) {
        console.log(
            `${plan.counts.new} new, ${plan.counts.existing} overwritten, ${plan.counts.purged} skipped (purged), ${plan.counts.incognito} skipped (incognito), ${plan.counts.unconsented} skipped (unconsented)`,
        );
    } else {
        console.log(
            `${plan.counts.new} new, ${plan.counts.existing} skipped (already present), ${plan.counts.purged} skipped (purged), ${plan.counts.incognito} skipped (incognito), ${plan.counts.unconsented} skipped (unconsented)`,
        );
    }
    if (plan.counts.outsideStore > 0) {
        console.error(`${plan.counts.outsideStore} skipped (transcript outside provider store)`);
    }
}

function insertRow(
    db: Database.Database,
    table: 'sessions' | 'memories' | 'session_rollups',
    columns: readonly string[],
    row: SqlRow,
    overrides: Record<string, SqlValue>,
): number {
    const values = columns.map((column) => (Object.hasOwn(overrides, column) ? overrides[column] : row[column]));
    const result = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
    return Number(result.lastInsertRowid);
}

function sanitizedImportedTitle(value: SqlValue): SqlValue {
    return typeof value === 'string' ? stripShellSyntax(value) : value;
}

function sanitizedImportedFirstPromptSearch(value: SqlValue): SqlValue {
    return typeof value === 'string' ? firstPromptSearch(value) : null;
}

function sanitizedImportedDecisions(value: SqlValue): SqlValue {
    return typeof value === 'string' ? JSON.stringify(hydrateTurnDecisions(value).map(sanitizeTurnDecision)) : value;
}

function sanitizedImportedPendingItems(value: SqlValue): SqlValue {
    if (typeof value !== 'string') {
        return value;
    }
    try {
        const parsed: unknown = JSON.parse(value);
        return JSON.stringify(
            Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').map(stripShellSyntax) : [],
        );
    } catch {
        return '[]';
    }
}

function sanitizedImportedRollupText(value: SqlValue): SqlValue {
    return typeof value === 'string' ? sanitizeRollupDisplayField(value) : value;
}

function sanitizedImportedRollupDecisions(value: SqlValue): SqlValue {
    return typeof value === 'string' ? sanitizeRollupDecisionsField(value) : value;
}

function sanitizedImportedRollupPendingItems(value: SqlValue): SqlValue {
    return typeof value === 'string' ? sanitizeRollupPendingItemsField(value) : value;
}

function updateSession(db: Database.Database, row: ImportSessionRow, localSessionId: number, projectId: number): void {
    const values = SESSION_WRITE_COLUMNS.map((column) => {
        if (column === 'project_id') {
            return projectId;
        }
        if (column === 'first_prompt_search') {
            return sanitizedImportedFirstPromptSearch(row[column]);
        }
        return column === 'title' || column === 'custom_title' ? sanitizedImportedTitle(row[column]) : row[column];
    });
    db.prepare(`UPDATE sessions SET ${SESSION_WRITE_COLUMNS.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`).run(
        ...values,
        localSessionId,
    );
}

function applyProjects(db: Database.Database, plan: ImportPlan, overwrite: boolean): Map<number, number> {
    const sessionStore = new MemoryStore(db);
    const localByCanonicalCwd = new Map<string, number>();
    const sessionProjectIds = new Map<number, number>();
    for (const session of plan.sessions) {
        if (session.disposition !== 'new' && !(overwrite && session.disposition === 'existing')) {
            continue;
        }
        const canonicalCwd = session.canonicalCwd;
        if (canonicalCwd === undefined) {
            throw new Error(`Importable backup session ${session.row.id} has no canonical cwd.`);
        }
        const projectId = localByCanonicalCwd.get(canonicalCwd) ?? sessionStore.upsertProject(canonicalCwd).id;
        localByCanonicalCwd.set(canonicalCwd, projectId);
        sessionProjectIds.set(session.row.id, projectId);
    }
    return sessionProjectIds;
}

function requiredMapping(map: Map<number, number>, backupId: number, label: string): number {
    const localId = map.get(backupId);
    if (localId === undefined) {
        throw new Error(`Backup ${label} ${backupId} has no local identity mapping.`);
    }
    return localId;
}

function assertPlanStillAuthorized(db: Database.Database, plan: ImportPlan): void {
    const activeStore = new MemoryStore(db);
    const purged = db.prepare('SELECT 1 FROM purged_transcripts WHERE tool = ? AND native_id = ?');
    const changed: string[] = [];

    for (const session of plan.sessions) {
        if (session.disposition !== 'new' && session.disposition !== 'existing') {
            continue;
        }

        const reasons: string[] = [];
        if (session.canonicalCwd === undefined) {
            reasons.push('canonical cwd missing');
        } else {
            const consent = activeStore.consent.consentState(session.canonicalCwd);
            if (consent !== 'approved') {
                reasons.push(`consent ${consent}`);
            }
        }
        if (purged.get(session.row.tool, session.row.native_id)) {
            reasons.push('purged');
        }
        if (activeStore.isTranscriptIncognito(session.row.tool, session.row.native_id)) {
            reasons.push('incognito');
        }
        if (reasons.length > 0) {
            changed.push(`${session.row.tool}:${session.row.native_id}#${session.row.segment_index} (${reasons.join(', ')})`);
        }
    }

    if (changed.length > 0) {
        throw new Error(
            `Import authorization changed after the preview for: ${changed.join('; ')}. Nothing was imported. Re-run elepha import for a fresh preview.`,
        );
    }
}

function applyMerge(db: Database.Database, candidate: Database.Database, plan: ImportPlan, overwrite: boolean): void {
    const sessionProjectIds = applyProjects(db, plan, overwrite);
    const sessionIds = new Map<number, number>();
    const importedSessionIds = new Set<number>();

    for (const session of plan.sessions) {
        if (
            session.disposition === 'purged' ||
            session.disposition === 'incognito' ||
            session.disposition === 'unconsented' ||
            session.disposition === 'outside_store'
        ) {
            continue;
        }
        if (session.disposition === 'existing') {
            const localSessionId = session.localSessionId;
            if (localSessionId === undefined) {
                throw new Error(`Existing backup session ${session.row.id} has no local mapping.`);
            }
            sessionIds.set(session.row.id, localSessionId);
            if (!overwrite) {
                continue;
            }
            const projectId = requiredMapping(sessionProjectIds, session.row.id, 'session project');
            db.prepare('DELETE FROM memories WHERE session_id = ?').run(localSessionId);
            db.prepare('DELETE FROM session_rollups WHERE session_id = ?').run(localSessionId);
            updateSession(db, session.row, localSessionId, projectId);
            importedSessionIds.add(session.row.id);
            continue;
        }

        const projectId = requiredMapping(sessionProjectIds, session.row.id, 'session project');
        const localSessionId = insertRow(db, 'sessions', SESSION_WRITE_COLUMNS, session.row, {
            project_id: projectId,
            title: sanitizedImportedTitle(session.row.title),
            custom_title: sanitizedImportedTitle(session.row.custom_title),
            first_prompt_search: sanitizedImportedFirstPromptSearch(session.row.first_prompt_search),
        });
        sessionIds.set(session.row.id, localSessionId);
        importedSessionIds.add(session.row.id);
    }

    const memories = candidate.prepare('SELECT * FROM memories WHERE session_id = ? ORDER BY id');
    const rollup = candidate.prepare('SELECT * FROM session_rollups WHERE session_id = ?');
    for (const backupSessionId of importedSessionIds) {
        const localSessionId = requiredMapping(sessionIds, backupSessionId, 'session');
        const projectId = requiredMapping(sessionProjectIds, backupSessionId, 'session project');
        for (const memory of memories.iterate(backupSessionId) as IterableIterator<ImportMemoryRow>) {
            insertRow(db, 'memories', MEMORY_WRITE_COLUMNS, memory, {
                project_id: projectId,
                session_id: localSessionId,
                decisions: sanitizedImportedDecisions(memory.decisions),
                pending_items: sanitizedImportedPendingItems(memory.pending_items),
            });
        }
        const backupRollup = rollup.get(backupSessionId) as ImportRollupRow | undefined;
        if (backupRollup) {
            // A vetoed parent has no local mapping by design. Detaching the child
            // preserves its portable rollup without resurrecting the tombstoned session.
            const parentSessionId =
                backupRollup.parent_session_id === null ? null : (sessionIds.get(backupRollup.parent_session_id) ?? null);
            insertRow(db, 'session_rollups', ROLLUP_WRITE_COLUMNS, backupRollup, {
                project_id: projectId,
                session_id: localSessionId,
                parent_session_id: parentSessionId,
                title: sanitizedImportedRollupText(backupRollup.title),
                summary: sanitizedImportedRollupText(backupRollup.summary),
                decisions: sanitizedImportedRollupDecisions(backupRollup.decisions),
                pending_items: sanitizedImportedRollupPendingItems(backupRollup.pending_items),
            });
        }
    }
}

function applyImport(
    dbPath: string,
    candidate: Database.Database,
    plan: ImportPlan,
    overwrite: boolean,
    snapshotWriter: (db: Database.Database, dbPath: string) => string,
    beforeVerify?: (db: Database.Database) => void,
): string {
    const active = new Database(dbPath, { fileMustExist: true });
    let snapshotPath: string | undefined;
    try {
        active.pragma('journal_mode = WAL');
        active.pragma('foreign_keys = ON');
        active.pragma('wal_checkpoint(TRUNCATE)');
        snapshotPath = snapshotWriter(active, dbPath);
        const merge = active.transaction(() => {
            assertPlanStillAuthorized(active, plan);
            applyMerge(active, candidate, plan, overwrite);
            beforeVerify?.(active);
            const foreignKeys = active.pragma('foreign_key_check') as unknown[];
            if (foreignKeys.length > 0) {
                throw new Error(`foreign_key_check found ${foreignKeys.length} violation(s)`);
            }
        });
        merge.immediate();
        return snapshotPath;
    } catch (error) {
        if (snapshotPath !== undefined) {
            throw new ImportApplyError(snapshotPath, error);
        }
        throw error;
    } finally {
        active.close();
    }
}

/** A multi-table identity-remapped merge needs one transaction spanning project resolution, FK remapping, and verification, so it cannot use the generic destructive-operation runner. */
export async function runImportOperation(candidatePath: string, overwrite: boolean, runtime: ImportRuntime = {}): Promise<ImportResult> {
    const dbPath = runtime.dbPath ?? defaultDbPath();
    const candidate = openCandidate(candidatePath);
    try {
        const health = (runtime.daemonHealth ?? currentDaemonHealth)();
        if (health.healthy) {
            throw new Error(`Refusing import while the daemon is running (${health.state}). Run elepha pause first.`);
        }
        if (health.state.startsWith('STUCK')) {
            console.error(`Daemon appears stuck (${health.state}); proceeding — it is not writing.`);
        }

        const plan = await readPlan(dbPath, candidate);
        printPreview(candidatePath, overwrite, plan);
        if (runtime.confirm && !(await runtime.confirm(plan))) {
            return {
                cancelled: true,
                added: 0,
                overwritten: 0,
                skipped:
                    plan.counts.existing + plan.counts.purged + plan.counts.incognito + plan.counts.unconsented + plan.counts.outsideStore,
            };
        }

        const snapshotPath = applyImport(dbPath, candidate, plan, overwrite, runtime.writeBackup ?? writeBackup, runtime.beforeVerify);
        const overwritten = overwrite ? plan.counts.existing : 0;
        const skipped =
            plan.counts.outsideStore +
            plan.counts.purged +
            plan.counts.incognito +
            plan.counts.unconsented +
            (overwrite ? 0 : plan.counts.existing);
        console.log(
            `Imported: ${plan.counts.new} added, ${overwritten} overwritten, ${skipped} skipped. ${plan.counts.unconsented} skipped (unconsented). Snapshot: ${snapshotPath}`,
        );
        return { cancelled: false, snapshotPath, added: plan.counts.new, overwritten, skipped };
    } finally {
        candidate.close();
    }
}

async function confirmImport(overwrite: boolean): Promise<boolean> {
    const prompt = overwrite
        ? 'Import this backup and overwrite matching sessions? A snapshot is saved first. [y/N] '
        : 'Import only new sessions from this backup? A snapshot is saved first. [y/N] ';
    return confirmYesNo(prompt);
}

export function reportImportError(error: unknown): void {
    console.error(errorMessage(error));
    process.exitCode = 1;
}

export function registerImport(program: Command): void {
    program
        .command('import [file]')
        .description('Merge an elepha backup into the local database')
        .option('--overwrite', "overwrite matching sessions with the backup's version")
        .option('--skip-confirmation', 'import without an interactive confirmation')
        .action(async (file: string | undefined, opts: ImportCommandOptions) => {
            const importBackup = (candidate: string, overwrite: boolean, confirm?: () => Promise<boolean>) =>
                runImportOperation(candidate, overwrite, {
                    dbPath: defaultDbPath(),
                    ...(confirm === undefined ? {} : { confirm }),
                });
            if (file === undefined) {
                if (!process.stdin.isTTY) {
                    console.error('Specify a backup file when not running interactively.');
                    process.exitCode = 1;
                    return;
                }
                try {
                    process.exitCode = await runImportWizard({
                        skipConfirmation: opts.skipConfirmation,
                        importBackup,
                    });
                } catch (error) {
                    reportImportError(error);
                }
                return;
            }

            const confirm = opts.skipConfirmation
                ? undefined
                : process.stdin.isTTY
                  ? () => confirmImport(opts.overwrite)
                  : async () => {
                        throw new Error('Refusing to import without a TTY confirmation. Re-run interactively or use --skip-confirmation.');
                    };
            try {
                const result = await importBackup(path.resolve(file), opts.overwrite, confirm);
                if (result.cancelled) {
                    console.log('Cancelled — no changes were made.');
                }
            } catch (error) {
                reportImportError(error);
            }
        });
}
