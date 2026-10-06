import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPurgeOperation } from '../../src/cli/commands/purge.js';
import { runRestoreOperation } from '../../src/cli/commands/restore.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import * as backups from '../../src/storage/backup.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { DurableCaptureStore } from '../../src/storage/durable-capture-store.js';
import { measureLiveMemoryBytes, readLiveMemoryUsage } from '../../src/storage/live-memory-usage.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { classifyOrphanUnits, observeOrphanPath } from '../../src/storage/orphan-classification.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';
import { expectLiveMemoryCurrent } from '../helpers/live-memory.js';

vi.mock('../../src/cli/shared.js', async (original) => ({
    ...(await original<typeof import('../../src/cli/shared.js')>()),
    withCapturePaused: async (_label: string, operation: () => Promise<void>) => {
        await operation();
        return true;
    },
}));
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function fixture(tool: 'codex' | 'claude-code' = 'codex') {
    const f = createTestDb('orphan-classification-');
    vi.stubEnv('ELEPHA_DB_PATH', f.dbPath);
    vi.stubEnv('ELEPHA_HOME', path.join(f.directory, 'home'));
    const project = seedProject(f, { path: path.join(f.directory, 'deleted') });
    const session = seedSession(f, { project, tool, nativeId: 'orphan-unit' });
    const memory = seedMemory(f, { project, session, durableCapture: true, userMessage: 'orphansearchneedle' });
    return { ...f, project, session, memory };
}

function addRule(f: ReturnType<typeof fixture>, projectId: number, text: string): void {
    f.db
        .prepare('INSERT INTO standing_rules(ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)')
        .run(`rule-${projectId}`, projectId, text, new Date().toISOString());
}

describe('bounded native-session orphan classification and safe purge', () => {
    it('removes empty unrecoverable bookkeeping without deleting the current owner or its rules', () => {
        const f = createTestDb('orphan-empty-');
        const project = seedProject(f);
        mkdirSync(project.path);
        const session = seedSession(f, { project });
        const memory = seedMemory(f, { project, session, userMessage: '', assistantText: '', durableCapture: true });
        seedRollup(f, { project, session });
        const old = seedProject(f, { path: path.join(f.directory, 'old-folder') });
        f.db.prepare('UPDATE projects SET git_root = ? WHERE id = ?').run(project.path, old.id);
        const relocatedEmpty = seedSession(f, { project: old, nativeId: 'empty-relocated' });
        new DurableCaptureStore(f.db).setStatus(session.id, 'parse_error', '2026-10-01');
        f.db
            .prepare('INSERT INTO standing_rules(ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)')
            .run('keep-policy', project.id, 'useful owner policy', '2026-10-01');
        f.db
            .prepare('INSERT INTO standing_rules(ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)')
            .run('keep-relocated-policy', old.id, 'useful relocated policy', '2026-10-01');
        const plan = f.store.planPurge({ orphan: true });
        expect(plan.sessions.map((row) => row.id)).toEqual([session.id, relocatedEmpty.id]);
        expect(plan.standingRules).toEqual([]);
        f.store.applyPurgePlan(plan);
        expect(f.store.getProjectById(project.id)).toBeDefined();
        expect(f.store.standingRules.list([project.id])).toHaveLength(1);
        expect(f.store.standingRules.list([old.id])).toHaveLength(1);
        expect(f.store.getProjectById(old.id)).toBeDefined();
        expect(f.store.findSession('codex', relocatedEmpty.native_id)).toBeUndefined();
        expect(f.store.listMemoriesForSession(session.id)).toEqual([]);
        expect(f.db.prepare('SELECT 1 FROM filtered_turns WHERE memory_id = ?').get(memory.id)).toBeUndefined();
        expect(f.db.prepare('SELECT 1 FROM session_rollups WHERE session_id = ?').get(session.id)).toBeUndefined();
        expect(f.store.isTranscriptCaptureBlocked('codex', session.native_id)).toBe(true);
        expect(f.store.planPurge({ orphan: true }).sessions).toEqual([]);
        expectLiveMemoryCurrent(f.db);
    });

    it('protects stale retained text, summaries and uncertain stored fields despite missing sources and indexes', () => {
        const f = createTestDb('orphan-protected-');
        const project = seedProject(f);
        mkdirSync(project.path);
        const retained = seedSession(f, { project, nativeId: 'retained' });
        const memory = seedMemory(f, { project, session: retained, durableCapture: true });
        // Remove the prompt index so retained conversation is the only protection.
        f.db.prepare('UPDATE sessions SET first_prompt_search = NULL WHERE id = ?').run(retained.id);
        f.db.prepare('UPDATE filtered_turns SET filter_version = 0 WHERE memory_id = ?').run(memory.id);
        f.db.prepare('DELETE FROM turn_search_index WHERE memory_id = ?').run(memory.id);
        new DurableCaptureStore(f.db).setStatus(retained.id, 'parse_error', '2026-10-01');
        const summarized = seedSession(f, { project, nativeId: 'summarized' });
        seedRollup(f, { project, session: summarized });
        f.db.prepare('UPDATE session_rollups SET summary = ? WHERE session_id = ?').run('useful retained summary', summarized.id);
        const decision = seedSession(f, { project, nativeId: 'useful-decision' });
        seedMemory(f, {
            project,
            session: decision,
            userMessage: '',
            assistantText: '',
            decisions: [{ what: 'preserve this decision', why: null }],
        });
        const uncertain = seedSession(f, { project, nativeId: 'uncertain-summary' });
        const malformed = seedMemory(f, { project, session: uncertain, userMessage: '', assistantText: '' });
        f.db.prepare('UPDATE memories SET decisions = ? WHERE id = ?').run('unrecognized retained decision', malformed.id);
        expect(f.store.planPurge({ orphan: true }).sessions).toEqual([]);
        expect(f.store.listMemoriesForSession(retained.id)).toHaveLength(1);
        expect(f.store.isTranscriptPurged('codex', retained.native_id)).toBe(false);
    });

    it('preserves empty chats on uncertain source inspection and aborts when a selected source returns', () => {
        const f = createTestDb('orphan-source-');
        const project = seedProject(f);
        mkdirSync(project.path);
        const session = seedSession(f, { project });
        expect(
            classifyOrphanUnits(f.store, {
                observeSource: () => ({ state: 'unresolved', reason: 'EACCES' }),
            }).candidates,
        ).toEqual([]);
        expect(classifyOrphanUnits(f.store, { maxProbes: 1 }).candidates).toEqual([]);
        const plan = f.store.planPurge({ orphan: true });
        expect(plan.sessions.map((row) => row.id)).toEqual([session.id]);
        writeFileSync(session.source_path, 'returned provider history');
        expect(() => f.store.applyPurgePlan(plan)).toThrow(/changed|aborted/);
        expect(f.store.findSession('codex', session.native_id)).toBeDefined();
        expect(f.store.isTranscriptPurged('codex', session.native_id)).toBe(false);
        expect(readFileSync(session.source_path, 'utf8')).toBe('returned provider history');
    });

    it('preserves empty mixed-project chats and useful siblings in full', () => {
        const f = createTestDb('orphan-empty-siblings-');
        const project = seedProject(f);
        mkdirSync(project.path);
        const mixed = seedSession(f, { project, nativeId: 'mixed-empty' });
        const missing = seedProject(f, { path: path.join(f.directory, 'gone') });
        const useful = seedSession(f, { project, nativeId: 'useful-sibling' });
        for (const [session, owner] of [
            [mixed, missing],
            [useful, project],
        ] as const) {
            f.db
                .prepare(`INSERT INTO sessions(tool, native_id, project_id, source_path, started_at, last_ingested_at, segment_index)
                VALUES ('codex', ?, ?, ?, ?, ?, 1)`)
                .run(session.native_id, owner.id, session.source_path, session.started_at, session.last_ingested_at);
        }
        seedMemory(f, { project, session: useful, durableCapture: true });
        expect(f.store.planPurge({ orphan: true }).sessions).toEqual([]);
        expect(f.db.prepare('SELECT id FROM sessions').all()).toHaveLength(4);
        expect(f.store.isTranscriptPurged('codex', mixed.native_id)).toBe(false);
        expect(f.store.isTranscriptPurged('codex', useful.native_id)).toBe(false);
    });

    it('keeps selected deletion authority across unrelated project activity and incidental owner touches', () => {
        const f = fixture();
        const otherProject = seedProject(f, { path: path.join(f.directory, 'other') });
        mkdirSync(otherProject.path);
        const other = seedSession(f, { project: otherProject, nativeId: 'unrelated' });
        seedMemory(f, { project: otherProject, session: other, durableCapture: true });
        const empty = seedSession(f, { project: otherProject, nativeId: 'empty-current-chat' });
        const plan = f.store.planPurge({ orphan: true });
        expect(plan.sessions.map((row) => row.id)).toEqual([f.session.id, empty.id]);
        f.db.prepare('UPDATE projects SET last_seen_at = ? WHERE id IN (?, ?)').run('2026-10-06', f.project.id, otherProject.id);
        seedMemory(f, { project: otherProject, session: other, turnIndex: 1, durableCapture: true });
        const newProject = seedProject(f, { path: path.join(f.directory, 'new-unrelated') });
        mkdirSync(newProject.path);
        f.store.consent.grant(newProject.path);
        f.store.applyPurgePlan(plan);
        expect(f.store.findSession('codex', f.session.native_id)).toBeUndefined();
        expect(f.store.findSession('codex', empty.native_id)).toBeUndefined();
        expect(f.store.listMemoriesForSession(other.id)).toHaveLength(2);
        expect(f.store.getProjectById(newProject.id)).toBeDefined();
        expect(f.store.planPurge({ orphan: true }).sessions).toEqual([]);
        expectLiveMemoryCurrent(f.db);
    });

    it.each(['codex', 'claude-code'] as const)(
        '%s preserves retained memory under valid current ownership despite missing provider source and audit gaps',
        (tool) => {
            const f = fixture(tool);
            mkdirSync(f.project.path);
            f.store.consent.grant(f.project.path);
            const recall = new SessionReader(f.db).storedContentRecallFor([{ id: f.session.id }], ['orphansearchneedle'], 10, () => true);
            expect(recall.matches.size).toBe(1);
            f.store.consent.revoke(f.project.path);
            const report = classifyOrphanUnits(f.store).report;
            expect(report.totals.associated).toBe(1);
            expect(f.store.planPurge({ orphan: true }).sessions).toEqual([]);
            expect(f.store.listMemoriesForSession(f.session.id)).toHaveLength(1);
            expect(f.store.isTranscriptPurged(tool, f.session.native_id)).toBe(false);
        },
    );

    it.each(['codex', 'claude-code'] as const)('%s requires complete absence and preserves incomplete discovery', (tool) => {
        const f = fixture(tool);
        expect(classifyOrphanUnits(f.store).report.totals.candidate).toBe(1);
        expect(classifyOrphanUnits(f.store, { maxProjects: 0 }).report).toMatchObject({
            incomplete: true,
            totals: { candidate: 0, unresolved: 1 },
        });
        expect(classifyOrphanUnits(f.store, { maxProbes: 0 }).report.totals.unresolved).toBe(1);
        expect(classifyOrphanUnits(f.store, { observe: () => ({ state: 'unresolved', reason: 'EACCES' }) }).report.totals.unresolved).toBe(
            1,
        );
        expect(f.store.listMemoriesForSession(f.session.id)).toHaveLength(1);
    });

    it('deletes a missing checkout while preserving an existing checkout with identical repository metadata', () => {
        const f = fixture();
        const directory = path.join(f.directory, 'moved');
        mkdirSync(directory);
        const moved = seedProject(f, { path: directory });
        f.db
            .prepare('UPDATE projects SET git_root = path, git_remote = ?, git_root_commit = ?, display_name = ? WHERE id IN (?, ?)')
            .run('shared-remote', 'shared-commit', 'shared-name', f.project.id, moved.id);
        const live = seedSession(f, { project: moved, nativeId: 'live-checkout', sourcePath: path.join(f.directory, 'live.jsonl') });
        seedMemory(f, { project: moved, session: live, durableCapture: true });
        writeFileSync(f.session.source_path, 'orphan provider history');
        writeFileSync(live.source_path, 'live provider history');
        const plan = f.store.planPurge({ orphan: true });
        expect(plan.sessions.map((session) => session.id)).toEqual([f.session.id]);
        f.store.applyPurgePlan(plan);
        expect(f.store.getProjectById(f.project.id)).toBeUndefined();
        expect(f.store.listMemoriesForSession(live.id)).toHaveLength(1);
        expect(f.store.isTranscriptPurged('codex', f.session.native_id)).toBe(true);
        expect(f.store.isTranscriptPurged('codex', live.native_id)).toBe(false);
        expect(readFileSync(f.session.source_path, 'utf8')).toBe('orphan provider history');
        expect(readFileSync(live.source_path, 'utf8')).toBe('live provider history');
        expect(f.store.planPurge({ orphan: true }).sessions).toEqual([]);
    });

    it('treats dangling links and non-directory parents as unresolved, while missing nested directories have an accessible ancestor', () => {
        const f = fixture();
        const dangling = path.join(f.directory, 'dangling');
        symlinkSync(path.join(f.directory, 'absent'), dangling);
        expect(observeOrphanPath(dangling).state).toBe('unresolved');
        const file = path.join(f.directory, 'file');
        writeFileSync(file, 'data');
        expect(observeOrphanPath(path.join(file, 'child')).state).toBe('unresolved');
        expect(observeOrphanPath(path.join(f.directory, 'absent', 'nested')).state).toBe('missing');
    });

    it.each(['directory', 'error', 'relocation'] as const)(
        'preserves all siblings and never tombstones a mixed native unit (%s)',
        (protection) => {
            const f = fixture();
            const siblingProject = seedProject(f, { path: path.join(f.directory, 'sibling') });
            f.db
                .prepare(`INSERT INTO sessions(tool, native_id, project_id, source_path, started_at, last_ingested_at, segment_index)
            VALUES ('codex', ?, ?, ?, ?, ?, 1)`)
                .run(f.session.native_id, siblingProject.id, f.session.source_path, f.session.started_at, f.session.last_ingested_at);
            if (protection === 'directory') mkdirSync(siblingProject.path);
            if (protection === 'error') writeFileSync(siblingProject.path, 'not an inspectable project directory');
            if (protection === 'relocation') {
                const moved = path.join(f.directory, 'moved-sibling');
                mkdirSync(moved);
                f.db.prepare('UPDATE projects SET git_root = ? WHERE id = ?').run(moved, siblingProject.id);
            }
            //noinspection JSUnusedGlobalSymbols
            const options =
                protection === 'error'
                    ? {
                          observe: (p: string) =>
                              p === siblingProject.path ? { state: 'unresolved' as const, reason: 'EACCES' } : observeOrphanPath(p),
                      }
                    : {};
            expect(classifyOrphanUnits(f.store, options).report.totals.mixed).toBe(1);
            const plan = f.store.planPurge({ orphan: true });
            expect(plan.sessions).toEqual([]);
            f.store.applyPurgePlan(plan);
            expect(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 });
            expect(f.store.listMemoriesForSession(f.session.id)).toHaveLength(1);
            expect(f.store.isTranscriptPurged('codex', f.session.native_id)).toBe(false);
        },
    );

    it.each(['directory', 'parent replacement', 'ownership', 'sibling', 'content', 'rules', 'preview'] as const)(
        'invalidates a frozen plan when %s changes',
        (change) => {
            const f = fixture();
            const plan = f.store.planPurge({ orphan: true });
            if (change === 'directory') mkdirSync(f.project.path);
            if (change === 'parent replacement') {
                // A replaced path component must not silently inherit the old absence proof.
                const parent = path.join(f.directory, 'new-parent');
                mkdirSync(parent);
                f.db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(path.join(parent, 'deleted'), f.project.id);
            }
            if (change === 'ownership') {
                const p = seedProject(f, { path: path.join(f.directory, 'new-owner') });
                f.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(p.id, f.session.id);
            }

            if (change === 'sibling')
                f.db
                    .prepare(
                        `INSERT INTO sessions(tool, native_id, project_id, source_path, started_at, last_ingested_at, segment_index) VALUES ('codex', ?, ?, ?, ?, ?, 1)`,
                    )
                    .run(f.session.native_id, f.project.id, f.session.source_path, f.session.started_at, f.session.last_ingested_at);
            if (change === 'content') f.db.prepare('UPDATE memories SET summarizer_status = ? WHERE id = ?').run('pending', f.memory.id);
            if (change === 'rules') addRule(f, f.project.id, 'new owner rule');
            if (change === 'preview') plan.sessions = [];
            expect(() => f.store.applyPurgePlan(plan)).toThrow();
            expect(f.store.listMemoriesForSession(f.session.id)).toHaveLength(1);
            expect(f.store.isTranscriptPurged('codex', f.session.native_id)).toBe(false);
        },
    );

    it('preview and cancellation do not change persisted state or create backups', async () => {
        const f = fixture();
        f.db.pragma('wal_checkpoint(TRUNCATE)');
        const before = readFileSync(f.dbPath);
        const plan = f.store.planPurge({ orphan: true });
        vi.spyOn(console, 'log').mockImplementation(() => {});
        expect(await runPurgeOperation(f.store, plan.scope, { applyRequested: true, plan, confirm: async () => false })).toBe(false);
        expect(readFileSync(f.dbPath)).toEqual(before);
        expect(backups.listManagedBackups(f.dbPath)).toEqual([]);
    });

    it.each(['backup', 'transaction'] as const)('preserves memory and tombstones on %s failure', async (failure) => {
        const f = fixture();
        const plan = f.store.planPurge({ orphan: true });
        vi.spyOn(console, 'log').mockImplementation(() => {});
        if (failure === 'backup')
            vi.spyOn(backups, 'backupDatabaseAndReport').mockImplementation(() => {
                throw new Error('backup failure');
            });
        else
            f.db.exec(
                "CREATE TRIGGER reject_orphan_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'transaction failure'); END",
            );
        await expect(runPurgeOperation(f.store, plan.scope, { applyRequested: true, plan, confirm: async () => true })).rejects.toThrow(
            `${failure} failure`,
        );
        expect(f.store.listMemoriesForSession(f.session.id)).toHaveLength(1);
        expect(f.store.isTranscriptPurged('codex', f.session.native_id)).toBe(false);
        expect(readLiveMemoryUsage(f.db)).toBe(measureLiveMemoryBytes(f.db));
        expectLiveMemoryCurrent(f.db);
    });

    it.each(['codex', 'claude-code'] as const)(
        '%s removes only confirmed owned state, retains unrelated rules, balances accounting and blocks reingestion',
        async (tool) => {
            const f = fixture(tool);
            const otherProject = seedProject(f, { path: path.join(f.directory, 'other') });
            mkdirSync(otherProject.path);
            const other = seedSession(f, { project: otherProject, tool, nativeId: 'kept-unit' });
            seedMemory(f, { project: otherProject, session: other });
            addRule(f, f.project.id, 'deleted owner rule');
            addRule(f, otherProject.id, 'retained owner rule');
            f.db.prepare('UPDATE source_generations SET generation = 1 WHERE tool = ? AND native_id = ?').run(tool, f.session.native_id);
            const plan = f.store.planPurge({ orphan: true });
            expect(plan.sessions.map((s) => s.id)).toEqual([f.session.id]);
            vi.spyOn(console, 'log').mockImplementation(() => {});
            expect(await runPurgeOperation(f.store, plan.scope, { applyRequested: true, plan, confirm: async () => true })).toBe(true);
            expect(f.store.getProjectById(f.project.id)).toBeUndefined();
            expect(f.store.listMemoriesForSession(other.id)).toHaveLength(1);
            expect(f.store.standingRules.list([otherProject.id])).toHaveLength(1);
            expect(f.store.isTranscriptCaptureBlocked(tool, f.session.native_id)).toBe(true);
            expect(
                f.db.prepare('SELECT * FROM source_generations WHERE tool = ? AND native_id = ?').all(tool, f.session.native_id),
            ).toEqual([]);
            expect(f.db.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'orphansearchneedle'").all()).toEqual(
                [],
            );
            expect(f.db.prepare('SELECT * FROM turn_search_index WHERE memory_id = ?').all(f.memory.id)).toEqual([]);
            expect(readLiveMemoryUsage(f.db)).toBe(measureLiveMemoryBytes(f.db));
            expectLiveMemoryCurrent(f.db);
            expect(f.store.planPurge({ orphan: true }).sessions).toEqual([]);
            expect(backups.listManagedBackups(f.dbPath)).toHaveLength(1);
        },
    );

    it('classifies stored hosts without bypassing conflicting native source protections', () => {
        const f = fixture();
        const unsupported = seedSession(f, { project: f.project, tool: 'opencode', nativeId: 'unsupported-orphan' });
        f.db
            .prepare(
                `INSERT INTO sessions(tool, native_id, project_id, source_path, started_at, last_ingested_at, segment_index) VALUES ('codex', ?, ?, 'different-source', ?, ?, 1)`,
            )
            .run(f.session.native_id, f.project.id, f.session.started_at, f.session.last_ingested_at);
        expect(classifyOrphanUnits(f.store).report.totals.unresolved).toBe(1);
        const plan = f.store.planPurge({ orphan: true });
        expect(plan.sessions.map((session) => session.id)).toEqual([unsupported.id]);
        f.store.applyPurgePlan(plan);
        expect(f.store.isTranscriptPurged('opencode', unsupported.native_id)).toBe(true);
        expect(f.store.isTranscriptPurged('codex', f.session.native_id)).toBe(false);
        expect(f.store.listMemoriesForSession(f.session.id)).toHaveLength(1);
        expect(f.store.planPurge({ orphan: true }).sessions).toEqual([]);
    });

    it('purges the exact legacy identity while protecting valid owners, uncertain inspection and chat-rule ownership', () => {
        const f = fixture();
        const legacyPath = path.join(f.directory, 'legacy.db');
        const prior = new Database(legacyPath);
        try {
            for (const table of ['projects', 'sessions', 'session_rules']) {
                const { sql } = f.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
                    sql: string;
                };
                // A real prior database admits its former provider; production migration
                // retains that exact stored identifier alongside today's supported tools.
                prior.exec(sql.replace(/CHECK \(tool IN \([^)]*\)\)/, "CHECK (tool IN ('deepseek'))"));
            }
            prior
                .prepare(`INSERT INTO projects(id, path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                VALUES (@id, @path, @display_name, @git_root, @git_remote, @git_root_commit, @first_seen_at, @last_seen_at)`)
                .run(f.project);
            prior
                .prepare(`INSERT INTO sessions(tool, native_id, project_id, source_path, started_at, last_ingested_at)
                VALUES ('deepseek', ?, ?, ?, ?, ?)`)
                .run(f.session.native_id, f.project.id, f.session.source_path, f.session.started_at, f.session.last_ingested_at);
        } finally {
            prior.close();
        }
        const db = openUnmanagedDb(legacyPath);
        try {
            const store = new MemoryStore(db, { resolveGitRoot: () => null });
            const legacy = db.prepare("SELECT id FROM sessions WHERE tool = 'deepseek'").get() as { id: number };
            const memory = db
                .prepare(`INSERT INTO memories(project_id, session_id, turn_index, tool, turn_started_at,
                decisions, files_touched, pending_items, created_at) VALUES (?, ?, 0, 'deepseek', ?, '[]', '[]', '[]', ?) RETURNING id`)
                .get(f.project.id, legacy.id, f.session.started_at, f.session.started_at) as { id: number };
            db.prepare(`INSERT INTO filtered_turns(memory_id, included, user_prompt, assistant_response, filter_version, captured_at)
                VALUES (?, 1, 'legacysearchneedle', 'retained legacy response', 1, ?)`).run(memory.id, f.session.started_at);
            const livePath = path.join(f.directory, 'live-checkout');
            mkdirSync(livePath);
            const current = store.upsertProject(livePath);
            const currentSession = seedSession({ ...f, db, store }, { project: current, nativeId: f.session.native_id });
            seedMemory({ ...f, db, store }, { project: current, session: currentSession, durableCapture: true });
            db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(f.directory, f.project.id);
            expect(store.planPurge({ orphan: true }).sessions).toEqual([]);
            db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(f.project.path, f.project.id);
            expect(
                classifyOrphanUnits(store, {
                    observe: (p) => (p === f.project.path ? { state: 'unresolved', reason: 'EACCES' } : observeOrphanPath(p)),
                }).candidates,
            ).toEqual([]);
            db.prepare(`INSERT INTO session_rules(ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
                VALUES ('legacy-rule', 'deepseek', ?, ?, ?, 'protected legacy rule', ?)`).run(
                f.session.native_id,
                current.path,
                current.id,
                f.session.started_at,
            );
            expect(store.planPurge({ orphan: true }).sessions).toEqual([]);
            db.prepare("UPDATE session_rules SET checkout_anchor = ?, owner_project_id = ? WHERE ulid = 'legacy-rule'").run(
                f.project.path,
                f.project.id,
            );
            const plan = store.planPurge({ orphan: true });
            expect(plan.sessions.map((session) => [session.tool, session.nativeId])).toEqual([['deepseek', f.session.native_id]]);
            expect(plan.sessionRules.map((rule) => rule.ulid)).toEqual(['legacy-rule']);
            store.applyPurgePlan(plan);
            expect(store.isTranscriptPurged('deepseek', f.session.native_id)).toBe(true);
            expect(store.isTranscriptPurged('codex', f.session.native_id)).toBe(false);
            expect(store.listMemoriesForSession(currentSession.id)).toHaveLength(1);
            expect(db.prepare('SELECT 1 FROM filtered_turns WHERE memory_id = ?').get(memory.id)).toBeUndefined();
            expect(db.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'legacysearchneedle'").all()).toEqual(
                [],
            );
            expect(db.prepare("SELECT 1 FROM session_rules WHERE ulid = 'legacy-rule'").get()).toBeUndefined();
            const repeated = store.planPurge({ orphan: true });
            expect(repeated.sessions).toEqual([]);
            expect(store.applyPurgePlan(repeated).sessions).toEqual([]);
            expectLiveMemoryCurrent(db);
        } finally {
            db.close();
        }
    });

    it('totals remain complete when oldest detailed diagnostics are dropped at their byte budget', () => {
        const f = fixture();
        for (let i = 0; i < 70; i++) seedSession(f, { project: f.project, nativeId: `diagnostic-${i}-${'x'.repeat(2000)}` });
        let observed = 0;
        const report = classifyOrphanUnits(f.store, {
            onClassified: () => {
                observed++;
            },
        }).report;
        expect(report.totals.candidate).toBe(71);
        expect(report.omittedDetails).toBeGreaterThan(0);
        expect(report.details.length + report.omittedDetails).toBe(71);
        expect(report.details.some((d) => d.nativeId === f.session.native_id)).toBe(false);
        expect(observed).toBe(report.totals.candidate);
    });

    it('deletes every confirmed missing project sibling together and excludes all siblings if a time filter would split the unit', () => {
        const f = fixture();
        const siblingProject = seedProject(f, { path: path.join(f.directory, 'missing-sibling') });
        f.db
            .prepare(
                `INSERT INTO sessions(tool, native_id, project_id, source_path, started_at, last_ingested_at, segment_index) VALUES ('codex', ?, ?, ?, ?, '2000-01-01', 1)`,
            )
            .run(f.session.native_id, siblingProject.id, f.session.source_path, f.session.started_at);
        expect(f.store.planPurge({ orphan: true, newerThan: '2020-01-01' }).sessions).toEqual([]);
        const plan = f.store.planPurge({ orphan: true });
        expect(plan.sessions).toHaveLength(2);
        f.store.applyPurgePlan(plan);
        expect(f.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
        expect(f.store.listMemoriesForSession(f.session.id)).toEqual([]);
        expect(f.store.isTranscriptPurged('codex', f.session.native_id)).toBe(true);
        const repeated = f.store.planPurge({ orphan: true });
        expect(repeated.sessions).toEqual([]);
        expect(f.store.applyPurgePlan(repeated).sessions).toEqual([]);
        expect(f.store.isTranscriptPurged('codex', f.session.native_id)).toBe(true);
        expectLiveMemoryCurrent(f.db);
    });

    it.each(['codex', 'claude-code'] as const)(
        '%s tombstones from orphan cleanup survive restore of a pre-deletion snapshot',
        async (tool) => {
            const f = fixture(tool);
            const beforeDeletion = backups.writeBackup(f.db, f.dbPath);
            f.store.applyPurgePlan(f.store.planPurge({ orphan: true }));
            f.close();
            await runRestoreOperation(beforeDeletion, { dbPath: f.dbPath, daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }) });
            const restored = openUnmanagedDb(f.dbPath);
            try {
                // Restore retains metadata under its existing contract, while the
                // carried native tombstone excludes every serving surface.
                expect(
                    new SessionReader(restored).capsuleByNaturalKey({ tool, nativeId: f.session.native_id, segmentIndex: 0 }),
                ).toBeUndefined();
                expect(
                    new SessionReader(restored).storedContentRecallFor([{ id: f.session.id }], ['orphansearchneedle'], 10, () => true)
                        .matches.size,
                ).toBe(0);
                expect(
                    restored.prepare('SELECT 1 FROM purged_transcripts WHERE tool = ? AND native_id = ?').get(tool, f.session.native_id),
                ).toBeDefined();
                expect(
                    restored.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'orphansearchneedle'").all(),
                ).toEqual([]);
                expectLiveMemoryCurrent(restored);
            } finally {
                restored.close();
            }
        },
    );

    it('preserves a missing native unit with retained chat rules owned by a valid current checkout', () => {
        const f = fixture();
        const siblingProject = seedProject(f, { path: path.join(f.directory, 'missing-sibling') });
        f.db
            .prepare(`INSERT INTO sessions(tool, native_id, project_id, source_path, started_at, last_ingested_at, segment_index)
            VALUES ('codex', ?, ?, ?, ?, ?, 1)`)
            .run(f.session.native_id, siblingProject.id, f.session.source_path, f.session.started_at, f.session.last_ingested_at);
        const currentPath = path.join(f.directory, 'rule-owner');
        mkdirSync(currentPath);
        const current = seedProject(f, { path: currentPath });
        f.db
            .prepare(
                'INSERT INTO session_rules(ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
                'protected-chat-rule',
                'codex',
                f.session.native_id,
                currentPath,
                current.id,
                'keep current association',
                new Date().toISOString(),
            );
        expect(classifyOrphanUnits(f.store).report.totals.mixed).toBe(1);
        expect(f.store.planPurge({ orphan: true }).sessions).toEqual([]);
        expect(f.db.prepare('SELECT id FROM sessions WHERE native_id = ?').all(f.session.native_id)).toHaveLength(2);
        expect(f.store.listMemoriesForSession(f.session.id)).toHaveLength(1);
    });
});
