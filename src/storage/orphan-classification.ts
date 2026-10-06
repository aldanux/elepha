import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import {
    ORPHAN_DETAILS_MAX_BYTES,
    ORPHAN_DISCOVERY_MAX_PROJECTS,
    ORPHAN_FILESYSTEM_MAX_PROBES,
    ORPHAN_FINGERPRINT_MAX_BYTES,
    ORPHAN_FINGERPRINT_MAX_ROWS,
    ORPHAN_INSPECTION_MAX_MS,
    ORPHAN_MAX_SEGMENTS,
    ORPHAN_NATIVE_RULE_MAX_ROWS,
    ORPHAN_PATH_MAX_COMPONENTS,
    ORPHAN_PLAN_MAX_BYTES,
    ORPHAN_PLAN_MAX_MEMORIES,
    ORPHAN_PLAN_MAX_SEGMENT_ROWS,
    ORPHAN_PROJECT_PAGE_SIZE,
} from '../config/orphan-cleanup.js';
import type { ToolName } from '../types/index.js';

import { measureLiveMemoryBytes, readLiveMemoryUsage } from './live-memory-usage.js';
import type { MemoryStore, ProjectRow, PurgePlan, PurgeScope } from './memory-store.js';

import { nativeSessionUnits, storedNativeSegments } from './session-read-model.js';

export interface NativeSessionIdentity {
    tool: ToolName;
    nativeId: string;
}
export type OrphanOutcome = 'associated' | 'relocated' | 'candidate' | 'unresolved' | 'mixed';
export interface OrphanDiagnostic extends NativeSessionIdentity {
    outcome: OrphanOutcome;
    reasons: string[];
    inspectionReason?: string;

    ownership: Array<{ segmentId: number; segmentIndex: number; projectId: number; projectPath: string | null }>;
}
export interface OrphanClassification {
    totals: Record<OrphanOutcome, number>;
    details: OrphanDiagnostic[];
    omittedDetails: number;
    incomplete: boolean;
}
export interface OrphanEvidence {
    identities: NativeSessionIdentity[];
    filesystem: string;
    database: string;
    preview: string;
    classification: OrphanClassification;
}
export type PathObservation =
    | { state: 'directory'; physical: string; dev: number; ino: number }
    | { state: 'missing'; ancestor: string; physical: string; dev: number; ino: number; missing: string }
    | { state: 'unresolved'; reason: string };

function filesystemInspectionFailure(error: unknown): PathObservation {
    return { state: 'unresolved', reason: `filesystem inspection failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}` };
}

// ENOENT is evidence only after walking accessible directory ancestors. A dangling
// link, file in the path, denied traversal or a changing identity stays unresolved.
export function observeOrphanPath(projectPath: string): PathObservation {
    if (!path.isAbsolute(projectPath)) {
        return { state: 'unresolved', reason: 'non-absolute project path' };
    }
    if (projectPath.split(path.sep).includes('..')) {
        return { state: 'unresolved', reason: 'noncanonical recorded path; lexical/physical identity is ambiguous' };
    }
    const absolute = path.resolve(projectPath);
    const components = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
    if (components.length > ORPHAN_PATH_MAX_COMPONENTS) {
        return { state: 'unresolved', reason: 'ancestor inspection budget exhausted' };
    }
    let current = path.parse(absolute).root;
    try {
        for (const component of components) {
            const parent = current;
            const before = statSync(parent);
            accessSync(parent, constants.R_OK | constants.X_OK);
            current = path.join(parent, component);
            try {
                lstatSync(current);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    return filesystemInspectionFailure(error);
                }
                const physical = realpathSync(parent);
                const after = statSync(parent);
                if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
                    return { state: 'unresolved', reason: 'ancestor identity changed' };
                }
                return { state: 'missing', ancestor: parent, physical, dev: after.dev, ino: after.ino, missing: current };
            }
            const stat = statSync(current);
            if (!stat.isDirectory()) {
                return { state: 'unresolved', reason: 'non-directory path component' };
            }
            accessSync(current, constants.R_OK | constants.X_OK);
        }
        const physical = realpathSync(absolute);
        const before = statSync(physical);
        const after = statSync(absolute);
        if (before.dev !== after.dev || before.ino !== after.ino) {
            return { state: 'unresolved', reason: 'path identity changed' };
        }
        return { state: 'directory', physical, dev: after.dev, ino: after.ino };
    } catch (error) {
        return filesystemInspectionFailure(error);
    }
}

export interface OrphanClassifierOptions {
    identities?: NativeSessionIdentity[];

    // Observe every scoped outcome before bounded display details are evicted.

    // Filesystem boundary and smaller budgets for deterministic failure regressions.
    observe?: (projectPath: string) => PathObservation;
    maxProbes?: number;
    maxProjects?: number;
}

function recordedProjects(db: Database, limit: number): { projects: ProjectRow[]; complete: boolean } {
    const projects: ProjectRow[] = [];
    let after = 0;
    let bytes = 0;
    while (true) {
        const page = db
            .prepare('SELECT * FROM projects WHERE id > ? ORDER BY id LIMIT ?')
            .all(after, ORPHAN_PROJECT_PAGE_SIZE) as ProjectRow[];
        for (const row of page) {
            bytes += Buffer.byteLength(JSON.stringify(row));
            if (projects.length >= limit || bytes > ORPHAN_PLAN_MAX_BYTES) {
                return { projects, complete: false };
            }
            projects.push(row);
            after = row.id;
        }
        if (page.length < ORPHAN_PROJECT_PAGE_SIZE) {
            return { projects, complete: true };
        }
    }
}

function possibleMove(a: ProjectRow, b: ProjectRow): boolean {
    return (
        a.id !== b.id &&
        Boolean(
            (a.git_remote && a.git_remote === b.git_remote) ||
                (a.git_root_commit && a.git_root_commit === b.git_root_commit) ||
                (a.git_root && a.git_root === b.git_root) ||
                (a.display_name && a.display_name === b.display_name),
        )
    );
}

// An identity match only protects memory and reports a possible relocation. It never
// grants an association, consent, or permission to run Git under a recorded cwd.
export function classifyOrphanUnits(
    store: MemoryStore,
    options: OrphanClassifierOptions = {},
): {
    report: OrphanClassification;
    candidates: NativeSessionIdentity[];
    observations: Map<string, PathObservation>;
} {
    const db = store.database;

    const discovery = recordedProjects(db, options.maxProjects ?? ORPHAN_DISCOVERY_MAX_PROJECTS);
    const projects = new Map(discovery.projects.map((p) => [p.id, p]));
    const observations = new Map<string, PathObservation>();
    const started = Date.now();
    let probes = 0;
    const observe = (p: string): PathObservation => {
        const cached = observations.get(p);
        if (cached) {
            return cached;
        }
        const value: PathObservation =
            probes++ >= (options.maxProbes ?? ORPHAN_FILESYSTEM_MAX_PROBES) || Date.now() - started > ORPHAN_INSPECTION_MAX_MS
                ? { state: 'unresolved', reason: 'filesystem discovery budget exhausted' }
                : (options.observe ?? observeOrphanPath)(p);
        observations.set(p, value);
        return value;
    };
    const report: OrphanClassification = {
        totals: { associated: 0, relocated: 0, candidate: 0, unresolved: 0, mixed: 0 },
        details: [],
        omittedDetails: 0,
        incomplete: !discovery.complete,
    };
    const candidates: NativeSessionIdentity[] = [];
    let candidateBytes = 0;
    let detailBytes = 0;
    for (const identity of options.identities ?? nativeSessionUnits(db)) {
        const segments = storedNativeSegments(db, identity, ORPHAN_MAX_SEGMENTS + 1);
        const reasons: string[] = [];

        const outcomes: OrphanOutcome[] = [];
        const inspectOwner = (projectId: number, label: string): void => {
            const project = projects.get(projectId);
            if (!project) {
                outcomes.push('unresolved');
                reasons.push(`${label}: project discovery incomplete or ownership conflict`);
                return;
            }
            const observation = observe(project.path);
            if (observation.state === 'directory') {
                outcomes.push('associated');
                reasons.push(`${label}: current project ${project.path}`);
                return;
            }

            if (observation.state === 'unresolved' || !discovery.complete) {
                outcomes.push('unresolved');
                reasons.push(`${label}: ${observation.state === 'unresolved' ? observation.reason : 'project discovery budget exhausted'}`);
                return;
            }
            if (project.git_root && project.git_root !== project.path) {
                const root = observe(project.git_root);
                if (root.state !== 'missing') {
                    outcomes.push(root.state === 'directory' ? 'relocated' : 'unresolved');
                    reasons.push(`${label}: recorded root ${project.git_root}; inspection needed`);
                    return;
                }
            }

            const matches = discovery.projects.filter((p) => possibleMove(project, p));
            const possible = matches.filter((p) => observe(p.path).state !== 'missing');
            if (possible.length > 0) {
                const ambiguous = possible.length > 1 || possible.some((p) => observe(p.path).state === 'unresolved');
                outcomes.push(ambiguous ? 'unresolved' : 'relocated');
                reasons.push(
                    `${label}: ${ambiguous ? 'ambiguous/unresolved relocation' : 'possible relocation'}: ${possible.map((p) => p.path).join(', ')}`,
                );
            } else {
                outcomes.push('candidate');
                reasons.push(`${label}: absent ${project.path}; complete recorded-project check`);
            }
        };
        if (identity.tool !== 'claude-code' && identity.tool !== 'codex') {
            outcomes.push('unresolved');
            reasons.push('unsupported host; preserved');
        } else if (segments.length === 0 || segments.length > ORPHAN_MAX_SEGMENTS) {
            outcomes.push('unresolved');
            reasons.push('missing membership or sibling inspection budget exhausted');
        } else if (new Set(segments.map((s) => s.source_path)).size !== 1) {
            outcomes.push('unresolved');
            reasons.push('conflicting source identities across native siblings');
        } else {
            for (const segment of segments) {
                inspectOwner(segment.project_id, `segment ${segment.id}`);
            }
        }
        if (identity.tool === 'codex' || identity.tool === 'claude-code') {
            const rules = db
                .prepare(
                    'SELECT owner_project_id, checkout_anchor FROM session_rules WHERE tool = ? AND native_session_id = ? ORDER BY id LIMIT ?',
                )
                .all(identity.tool, identity.nativeId, ORPHAN_NATIVE_RULE_MAX_ROWS + 1) as Array<{
                owner_project_id: number;
                checkout_anchor: string;
            }>;
            if (rules.length > ORPHAN_NATIVE_RULE_MAX_ROWS) {
                outcomes.push('unresolved');
                reasons.push('native rule association inspection budget exhausted');
            } else {
                for (const rule of rules) {
                    const owner = projects.get(rule.owner_project_id);
                    if (!owner) {
                        outcomes.push('unresolved');
                        reasons.push('native rule ownership unavailable');
                        continue;
                    }
                    inspectOwner(rule.owner_project_id, `native rule owner ${rule.owner_project_id}`);
                    const ownership = observe(owner.path);
                    const anchor = observe(rule.checkout_anchor);
                    if (anchor.state === 'missing' && rule.checkout_anchor !== owner.path) {
                        const anchorOwner = discovery.projects.find((p) => p.path === rule.checkout_anchor);
                        if (anchorOwner) {
                            inspectOwner(anchorOwner.id, 'native rule checkout owner');
                        }
                    }
                    if (ownership.state === 'directory' || anchor.state === 'directory') {
                        outcomes.push('relocated');
                        reasons.push(`native chat rules retain a current checkout association: ${owner.path}, ${rule.checkout_anchor}`);
                    } else if (ownership.state === 'unresolved' || anchor.state === 'unresolved') {
                        outcomes.push('unresolved');
                        reasons.push('native rule checkout association could not be inspected');
                    }
                }
            }
        }
        let outcome: OrphanOutcome = outcomes.includes('unresolved')
            ? 'unresolved'
            : outcomes.includes('relocated')
              ? 'relocated'
              : outcomes.includes('associated')
                ? 'associated'
                : 'candidate';
        if (outcomes.includes('candidate') && outcome !== 'candidate') {
            outcome = 'mixed';
            reasons.push('entire native unit preserved; segment cleanup requires segment-scoped no-resurrection support');
        }

        report.incomplete ||= outcome === 'unresolved' || outcomes.includes('unresolved');
        report.totals[outcome]++;
        if (outcome === 'candidate') {
            candidateBytes += Buffer.byteLength(JSON.stringify(identity));
            if (candidateBytes > ORPHAN_PLAN_MAX_BYTES) {
                throw new Error('Orphan deletion identity plan exceeds its budget; narrow the scope');
            }
            candidates.push(identity);
        }
        const diagnostic = {
            ...identity,
            outcome,
            reasons,

            ownership: segments.slice(0, ORPHAN_MAX_SEGMENTS).map((segment) => ({
                segmentId: segment.id,
                segmentIndex: segment.segment_index,
                projectId: segment.project_id,
                projectPath: projects.get(segment.project_id)?.path ?? null,
            })),
        };

        const bytes = Buffer.byteLength(JSON.stringify(diagnostic));
        if (bytes <= ORPHAN_DETAILS_MAX_BYTES) {
            while (detailBytes + bytes > ORPHAN_DETAILS_MAX_BYTES && report.details.length > 0) {
                detailBytes -= Buffer.byteLength(JSON.stringify(report.details.shift()));
                report.omittedDetails++;
            }
            report.details.push(diagnostic);
            detailBytes += bytes;
        } else {
            report.omittedDetails++;
        }
    }
    return { report, candidates, observations };
}

// This freezes complete owned rows and control state, including the sibling set,
// without retaining conversation text in the authorization plan.
export function orphanDatabaseFingerprint(db: Database, identities: NativeSessionIdentity[], projectIds: number[]): string {
    const hash = createHash('sha256');
    let bytes = 0;
    let rows = 0;
    const feed = (query: string, args: unknown[] = []) => {
        hash.update(query);
        for (const row of db.prepare(query).iterate(...args)) {
            const serialized = JSON.stringify(row);
            bytes += Buffer.byteLength(serialized);
            if (++rows > ORPHAN_FINGERPRINT_MAX_ROWS || bytes > ORPHAN_FINGERPRINT_MAX_BYTES) {
                throw new Error('Orphan owned-state inspection budget exhausted; deletion refused');
            }
            hash.update(serialized);
        }
    };
    for (const table of ['projects', 'consent_roots', 'paranoid_authority']) {
        if (db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)) {
            feed(`SELECT * FROM ${table} ORDER BY rowid`);
        }
    }
    const sessionScope = 'SELECT id FROM sessions WHERE tool = ? AND native_id = ?';
    const memoryScope = `SELECT id FROM memories WHERE session_id IN (${sessionScope})`;
    const sessionTables = [
        'memories',
        'session_rollups',
        'session_embeddings',
        'durable_capture_status',
        'open_turns',
        'first_prompt_search_backfill_skips',
        'task_state_requests',
    ];
    const memoryTables = ['filtered_turns', 'task_state_manifests', 'turn_search_index', 'turn_embeddings'];
    const nativeTables = [
        'source_generations',
        'purged_transcripts',
        'incognito_transcripts',
        'live_memory_retention_removals',
        'live_memory_capture_deferrals',
        'segment_corrections',
    ];
    for (const identity of identities) {
        const args = [identity.tool, identity.nativeId];
        feed('SELECT * FROM sessions WHERE tool = ? AND native_id = ? ORDER BY id', args);
        for (const table of sessionTables) {
            feed(`SELECT * FROM ${table} WHERE session_id IN (${sessionScope}) ORDER BY rowid`, args);
        }
        for (const table of memoryTables) {
            feed(`SELECT * FROM ${table} WHERE memory_id IN (${memoryScope}) ORDER BY rowid`, args);
        }
        for (const table of nativeTables) {
            if (db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)) {
                feed(`SELECT * FROM ${table} WHERE tool = ? AND native_id = ? ORDER BY rowid`, args);
            }
        }
        for (const table of ['injections', 'mcp_receipts', 'shown_session_lists', 'session_rules']) {
            feed(`SELECT * FROM ${table} WHERE tool = ? AND native_session_id = ? ORDER BY rowid`, args);
        }
    }
    const ids = JSON.stringify(projectIds);

    for (const [table, column] of [
        ['sessions', 'project_id'],
        ['memories', 'project_id'],
        ['standing_rules', 'project_id'],
        ['session_rules', 'owner_project_id'],
    ]) {
        feed(`SELECT * FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?)) ORDER BY rowid`, [ids]);
    }
    return hash.digest('hex');
}

function filesystemFingerprint(observations: Map<string, PathObservation>): string {
    return createHash('sha256')
        .update(JSON.stringify([...observations].sort(([a], [b]) => a.localeCompare(b))))
        .digest('hex');
}

function orphanAssociationOwnerIds(db: Database, identities: NativeSessionIdentity[], sessionOwnerIds: number[]): number[] {
    const ruleOwners = db
        .prepare(`SELECT DISTINCT owner_project_id FROM session_rules
            WHERE EXISTS (SELECT 1 FROM json_each(?) AS unit
                WHERE json_extract(unit.value, '$.tool') = tool
                  AND json_extract(unit.value, '$.nativeId') = native_session_id)`)
        .all(JSON.stringify(identities)) as Array<{ owner_project_id: number }>;
    return [...new Set([...sessionOwnerIds, ...ruleOwners.map((r) => r.owner_project_id)])];
}

export function planOrphanPurge(store: MemoryStore, scope: PurgeScope): PurgePlan {
    const classified = classifyOrphanUnits(store, { identities: scope.nativeUnits });
    const candidates = classified.candidates.filter((identity) => {
        if (scope.newerThan === undefined && scope.olderThan === undefined) {
            return true;
        }
        return (
            store.database
                .prepare(`SELECT 1 FROM sessions WHERE tool = ? AND native_id = ?
            AND ((? IS NOT NULL AND last_ingested_at < ?) OR (? IS NOT NULL AND last_ingested_at > ?)) LIMIT 1`)
                .get(
                    identity.tool,
                    identity.nativeId,
                    scope.newerThan ?? null,
                    scope.newerThan ?? null,
                    scope.olderThan ?? null,
                    scope.olderThan ?? null,
                ) === undefined
        );
    });
    const ids: number[] = [];
    for (const identity of candidates) {
        for (const segment of storedNativeSegments(store.database, identity, ORPHAN_MAX_SEGMENTS)) {
            if (ids.length >= ORPHAN_PLAN_MAX_SEGMENT_ROWS) {
                throw new Error('Orphan segment-row plan exceeds its budget; narrow the scope');
            }
            ids.push(segment.id);
        }
    }
    const ownerIds = [
        ...new Set(
            ids
                .map(
                    (id) =>
                        (
                            store.database.prepare('SELECT project_id FROM sessions WHERE id = ?').get(id) as
                                | { project_id: number }
                                | undefined
                        )?.project_id,
                )
                .filter((id): id is number => id !== undefined),
        ),
    ];
    const nativeRuleScope = JSON.stringify(candidates);
    const associationOwnerIds = orphanAssociationOwnerIds(store.database, candidates, ownerIds);
    // A rule-only chat still needs its owner and project policy. Preserve every
    // unconfirmed chat association, regardless of whether it has captured rows.
    const ruleProjects = associationOwnerIds.filter(
        (id) =>
            store.database
                .prepare('SELECT 1 FROM sessions WHERE project_id = ? AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 1')
                .get(id, JSON.stringify(ids)) === undefined &&
            store.database
                .prepare(`SELECT 1 FROM session_rules WHERE owner_project_id = ?
                    AND NOT EXISTS (SELECT 1 FROM json_each(?) AS unit
                        WHERE json_extract(unit.value, '$.tool') = tool
                          AND json_extract(unit.value, '$.nativeId') = native_session_id) LIMIT 1`)
                .get(id, nativeRuleScope) === undefined,
    );
    const count = store.database
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE session_id IN (SELECT value FROM json_each(?))')
        .get(JSON.stringify(ids)) as { n: number };
    if (count.n > ORPHAN_PLAN_MAX_MEMORIES) {
        throw new Error('Orphan retained-row plan exceeds its budget; narrow the scope');
    }
    const plan = store.planPurge({
        sessionIds: ids,
        projectIds: ruleProjects,
        sessionRuleNativeUnits: candidates,
        deleteStandingRules: scope.newerThan === undefined && scope.olderThan === undefined,
    });
    const selectedIds = JSON.stringify(ids);
    plan.emptiedProjects = plan.emptiedProjects.filter((project) =>
        ['memories', 'session_rollups', 'session_embeddings', 'open_turns'].every(
            (table) =>
                store.database
                    .prepare(`SELECT 1 FROM ${table} WHERE project_id = ? AND session_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`)
                    .get(project.id, selectedIds) === undefined,
        ),
    );
    plan.scope = scope;
    if (Buffer.byteLength(JSON.stringify(plan)) > ORPHAN_PLAN_MAX_BYTES) {
        throw new Error('Orphan deletion preview exceeds its budget; narrow the scope');
    }
    // Freeze only candidate probes. Other classified units cannot enter apply.
    const selected = classifyOrphanUnits(store, { identities: candidates });
    if (selected.candidates.length !== candidates.length) {
        throw new Error('Orphan classification changed during planning');
    }
    plan.orphanEvidence = {
        identities: candidates,

        preview: orphanPreviewFingerprint(plan),
        filesystem: filesystemFingerprint(selected.observations),
        database: candidates.length === 0 ? '' : orphanDatabaseFingerprint(store.database, candidates, associationOwnerIds),
        classification: classified.report,
    };
    return plan;
}

export function assertOrphanPlanFilesystem(store: MemoryStore, plan: PurgePlan): void {
    const evidence = plan.orphanEvidence;
    if (!evidence) {
        return;
    }
    const fresh = classifyOrphanUnits(store, { identities: evidence.identities });
    if (
        JSON.stringify(fresh.candidates) !== JSON.stringify(evidence.identities) ||
        filesystemFingerprint(fresh.observations) !== evidence.filesystem
    ) {
        throw new Error('Orphan filesystem/association facts changed after preview; deletion aborted');
    }
}
function orphanPreviewFingerprint(plan: PurgePlan): string {
    const { orphanEvidence: _evidence, ...preview } = plan;
    return createHash('sha256').update(JSON.stringify(preview)).digest('hex');
}

export function assertOrphanPlanDatabase(store: MemoryStore, plan: PurgePlan): void {
    const evidence = plan.orphanEvidence;
    if (!evidence) {
        return;
    }
    const ownerIds = orphanAssociationOwnerIds(
        store.database,
        evidence.identities,
        plan.sessions.map((s) => s.projectId),
    );
    if (
        orphanPreviewFingerprint(plan) !== evidence.preview ||
        (evidence.identities.length > 0 && orphanDatabaseFingerprint(store.database, evidence.identities, ownerIds) !== evidence.database)
    ) {
        throw new Error('Orphan ownership, sibling membership or control state changed after preview; deletion aborted');
    }
}

// Run inside the purge transaction too: a failed postcondition rolls back all
// content, tombstones and accounting instead of reporting a partial deletion.
export function verifyOrphanPurge(store: MemoryStore, plan: PurgePlan): void {
    const db = store.database;
    for (const identity of plan.orphanEvidence?.identities ?? []) {
        const args = [identity.tool, identity.nativeId];
        if (
            db.prepare('SELECT 1 FROM sessions WHERE tool = ? AND native_id = ?').get(...args) ||
            !store.isTranscriptPurged(identity.tool, identity.nativeId)
        ) {
            throw new Error('Orphan purge postcondition failed: native membership or tombstone');
        }
        for (const table of ['source_generations', 'live_memory_capture_deferrals', 'segment_corrections']) {
            if (
                db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) &&
                db.prepare(`SELECT 1 FROM ${table} WHERE tool = ? AND native_id = ?`).get(...args)
            ) {
                throw new Error(`Orphan purge postcondition failed: ${table}`);
            }
        }
        for (const table of ['injections', 'mcp_receipts', 'shown_session_lists']) {
            if (db.prepare(`SELECT 1 FROM ${table} WHERE tool = ? AND native_session_id = ?`).get(...args)) {
                throw new Error(`Orphan purge postcondition failed: ${table}`);
            }
        }
    }
    for (const [table, rules] of [
        ['session_rules', plan.sessionRules],
        ['standing_rules', plan.standingRules],
    ] as const) {
        if (
            db
                .prepare(`SELECT 1 FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) LIMIT 1`)
                .get(JSON.stringify(rules.map((r) => r.id)))
        ) {
            throw new Error(`Orphan purge postcondition failed: ${table}`);
        }
    }
    const ids = JSON.stringify(plan.sessions.map((s) => s.id));
    for (const table of [
        'memories',
        'session_rollups',
        'session_embeddings',
        'open_turns',
        'durable_capture_status',
        'task_state_requests',
    ]) {
        if (db.prepare(`SELECT 1 FROM ${table} WHERE session_id IN (SELECT value FROM json_each(?)) LIMIT 1`).get(ids)) {
            throw new Error(`Orphan purge postcondition failed: ${table}`);
        }
    }
    const memoryIds = JSON.stringify(plan.sessions.flatMap((s) => s.filteredMemoryIds));
    for (const table of ['filtered_turns', 'turn_search_index', 'turn_embeddings', 'task_state_manifests']) {
        if (db.prepare(`SELECT 1 FROM ${table} WHERE memory_id IN (SELECT value FROM json_each(?)) LIMIT 1`).get(memoryIds)) {
            throw new Error(`Orphan purge postcondition failed: ${table}`);
        }
    }
    if (plan.sessions.some((s) => s.filteredMemoryIds.length > 0)) {
        db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.orphan_filtered_turn_terms USING fts5vocab(main, filtered_turns_fts, instance)');
        if (
            db.prepare('SELECT 1 FROM temp.orphan_filtered_turn_terms WHERE doc IN (SELECT value FROM json_each(?)) LIMIT 1').get(memoryIds)
        ) {
            throw new Error('Orphan purge postcondition failed: retained FTS postings');
        }
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0 || measureLiveMemoryBytes(db) !== readLiveMemoryUsage(db)) {
        throw new Error('Orphan purge postcondition failed: foreign keys or retained-memory accounting');
    }
}
