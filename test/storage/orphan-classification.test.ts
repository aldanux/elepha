import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPurgeOperation } from '../../src/cli/commands/purge.js';
import { runRestoreOperation } from '../../src/cli/commands/restore.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import * as backups from '../../src/storage/backup.js';
import { openUnmanagedDb } from '../../src/storage/db.js';

import { measureLiveMemoryBytes, readLiveMemoryUsage } from '../../src/storage/live-memory-usage.js';
import { classifyOrphanUnits, observeOrphanPath } from '../../src/storage/orphan-classification.js';
import { createTestDb, seedMemory, seedProject, seedSession } from '../helpers/db.js';
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

    it.each(['codex', 'claude-code'] as const)(
        '%s requires complete absence and preserves ambiguous moves and incomplete discovery',
        (tool) => {
            const f = fixture(tool);
            expect(classifyOrphanUnits(f.store).report.totals.candidate).toBe(1);
            expect(classifyOrphanUnits(f.store, { maxProjects: 0 }).report).toMatchObject({
                incomplete: true,
                totals: { candidate: 0, unresolved: 1 },
            });
            expect(classifyOrphanUnits(f.store, { maxProbes: 0 }).report.totals.unresolved).toBe(1);
            expect(
                classifyOrphanUnits(f.store, { observe: () => ({ state: 'unresolved', reason: 'EACCES' }) }).report.totals.unresolved,
            ).toBe(1);
            f.db.prepare('UPDATE projects SET git_remote = ? WHERE id = ?').run('recorded-remote', f.project.id);
            for (const name of ['move-a', 'move-b']) {
                const directory = path.join(f.directory, name);
                mkdirSync(directory);
                const p = seedProject(f, { path: directory });
                f.db.prepare('UPDATE projects SET git_remote = ? WHERE id = ?').run('recorded-remote', p.id);
            }
            expect(classifyOrphanUnits(f.store).report.totals.unresolved).toBe(1);
            expect(f.store.planPurge({ orphan: true }).sessions).toEqual([]);
            expect(f.store.listMemoriesForSession(f.session.id)).toHaveLength(1);
        },
    );

    it('reports a possible move without modifying ownership and preserves stale binding evidence', () => {
        const f = fixture();
        const directory = path.join(f.directory, 'moved');
        mkdirSync(directory);
        const moved = seedProject(f, { path: directory });
        f.db.prepare('UPDATE projects SET git_root_commit = ? WHERE id IN (?, ?)').run('recorded-commit', f.project.id, moved.id);
        expect(classifyOrphanUnits(f.store).report.totals.relocated).toBe(1);
        expect(f.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(f.session.id)).toEqual({ project_id: f.project.id });
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

    it.each(['directory', 'error'] as const)('preserves all siblings and never tombstones a mixed native unit (%s)', (protection) => {
        const f = fixture();
        const siblingProject = seedProject(f, { path: path.join(f.directory, 'sibling') });
        f.db
            .prepare(`INSERT INTO sessions(tool, native_id, project_id, source_path, started_at, last_ingested_at, segment_index)
            VALUES ('codex', ?, ?, ?, ?, ?, 1)`)
            .run(f.session.native_id, siblingProject.id, f.session.source_path, f.session.started_at, f.session.last_ingested_at);
        if (protection === 'directory') mkdirSync(siblingProject.path);
        //noinspection JSUnusedGlobalSymbols
        const options =
            protection === 'error'
                ? {
                      observe: (p: string) =>
                          p === siblingProject.path ? { state: 'unresolved' as const, reason: 'EACCES' } : observeOrphanPath(p),
                  }
                : {};
        expect(classifyOrphanUnits(f.store, options).report.totals.mixed).toBe(1);
        if (protection !== 'error') {
            const plan = f.store.planPurge({ orphan: true });
            expect(plan.sessions).toEqual([]);
            f.store.applyPurgePlan(plan);
            expect(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 });
            expect(f.store.isTranscriptPurged('codex', f.session.native_id)).toBe(false);
        }
    });

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

    it('unsupported hosts and conflicting native source identities remain unresolved and cannot produce tombstones', () => {
        const f = fixture();
        seedSession(f, { project: f.project, tool: 'opencode', nativeId: 'unsupported-orphan' });
        f.db
            .prepare(
                `INSERT INTO sessions(tool, native_id, project_id, source_path, started_at, last_ingested_at, segment_index) VALUES ('codex', ?, ?, 'different-source', ?, ?, 1)`,
            )
            .run(f.session.native_id, f.project.id, f.session.started_at, f.session.last_ingested_at);
        expect(classifyOrphanUnits(f.store).report.totals.unresolved).toBe(2);
        expect(f.store.planPurge({ orphan: true }).sessions).toEqual([]);
        expect(f.store.isTranscriptPurged('codex', f.session.native_id)).toBe(false);
    });

    it('totals remain complete when oldest detailed diagnostics are dropped at their byte budget', () => {
        const f = fixture();
        for (let i = 0; i < 70; i++) seedSession(f, { project: f.project, nativeId: `diagnostic-${i}-${'x'.repeat(2000)}` });
        const report = classifyOrphanUnits(f.store).report;
        expect(report.totals.candidate).toBe(71);
        expect(report.omittedDetails).toBeGreaterThan(0);
        expect(report.details.length + report.omittedDetails).toBe(71);
        expect(report.details.some((d) => d.nativeId === f.session.native_id)).toBe(false);
    });

    it('deletes every confirmed missing sibling together and excludes all siblings if a time filter would split the unit', () => {
        const f = fixture();
        f.db
            .prepare(
                `INSERT INTO sessions(tool, native_id, project_id, source_path, started_at, last_ingested_at, segment_index) VALUES ('codex', ?, ?, ?, ?, '2000-01-01', 1)`,
            )
            .run(f.session.native_id, f.project.id, f.session.source_path, f.session.started_at);
        expect(f.store.planPurge({ orphan: true, newerThan: '2020-01-01' }).sessions).toEqual([]);
        const plan = f.store.planPurge({ orphan: true });
        expect(plan.sessions).toHaveLength(2);
        f.store.applyPurgePlan(plan);
        expect(f.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
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
        expect(f.store.listMemoriesForSession(f.session.id)).toHaveLength(1);
    });
});
