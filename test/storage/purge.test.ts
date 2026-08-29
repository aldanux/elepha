// elepha purge: the privacy instrument and mechanism behind
// "revocation = deletion". Covers the three scopes (project, date range,
// all), the emptied-project cleanup, and that a partial purge leaves a
// project row alone when it still has sessions outside the purged scope.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPurgeOperation } from '../../src/cli/commands/purge.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore, type PurgeScope } from '../../src/storage/memory-store.js';
import { RollupStore } from '../../src/storage/rollup-store.js';
import type { ParsedTurn } from '../../src/types/index.js';

function makeTurn(overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: 'sess-1',
        sourcePath: '/tmp/sess-1.jsonl',
        projectPath: '/Users/test/demo-project',
        turnIndex: 0,
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-01T00:00:01.000Z',
        userMessage: 'do a thing',
        assistantText: 'done',
        toolCalls: [],
        cursor: '100|1',
        ...overrides,
        hasExternalContent: overrides.hasExternalContent ?? false,
        resumeMarkerBefore: overrides.resumeMarkerBefore ?? false,
    };
}

function purgeState(store: MemoryStore): Record<string, unknown[]> {
    return {
        projects: store.database.prepare('SELECT * FROM projects ORDER BY id').all(),
        sessions: store.database.prepare('SELECT * FROM sessions ORDER BY id').all(),
        memories: store.database.prepare('SELECT * FROM memories ORDER BY id').all(),
        rollups: store.database.prepare('SELECT * FROM session_rollups ORDER BY session_id').all(),
        purgedTombstones: store.database.prepare('SELECT * FROM purged_transcripts ORDER BY tool, native_id').all(),
        incognitoTombstones: store.database.prepare('SELECT * FROM incognito_transcripts ORDER BY tool, native_id').all(),
    };
}

describe('purge', () => {
    let store: MemoryStore;
    let rollups: RollupStore;

    beforeEach(() => {
        const db = openDb(':memory:');
        store = new MemoryStore(db);
        rollups = new RollupStore(db);
    });

    it('purge by project deletes sessions, turns, and rollups, and removes the now-empty project row - other projects untouched', () => {
        const projectA = store.upsertProject('/Users/test/project-a');
        const sessionA = store.upsertSession('claude-code', 'sess-a', projectA.id, '/tmp/a.jsonl');
        store.recordTurn(makeTurn({ sessionId: 'sess-a', projectPath: '/Users/test/project-a' }), sessionA.id, projectA.id, {
            decisions: [{ what: 'a', why: null }],
            pending_items: [],
            status: 'ok',
        });
        rollups.write(
            {
                sessionId: sessionA.id,
                projectId: projectA.id,
                tool: 'claude-code',
                title: 't',
                summary: 's',
                decisions: [],
                pendingItems: [],
                filesTouched: [],
                turnCount: 1,
                startedAt: '2026-08-01T00:00:00.000Z',
                endedAt: '2026-08-01T00:00:01.000Z',
                kind: 'primary',
                parentSessionId: null,
                summarizerStatus: 'ok',
                state: 'final',
                throughTurnIndex: 0,
            },
            undefined,
        );

        const projectB = store.upsertProject('/Users/test/project-b');
        const sessionB = store.upsertSession('claude-code', 'sess-b', projectB.id, '/tmp/b.jsonl');
        store.recordTurn(makeTurn({ sessionId: 'sess-b', projectPath: '/Users/test/project-b' }), sessionB.id, projectB.id, {
            decisions: [{ what: 'b', why: null }],
            pending_items: [],
            status: 'ok',
        });

        const before = purgeState(store);
        const plan = store.planPurge({ projectPath: '/Users/test/project-a' });
        expect(plan.sessions.map((session) => session.id)).toEqual([sessionA.id]);
        expect(plan.sessions[0]!.turnCount).toBe(1);
        expect(plan.emptiedProjects.map((project) => project.id)).toEqual([projectA.id]);
        expect(purgeState(store)).toEqual(before);

        const applied = store.purge({ projectPath: '/Users/test/project-a' });

        expect(applied.sessions.map((s) => s.id)).toEqual([sessionA.id]);
        expect(store.getProjectById(projectA.id)).toBeUndefined();
        expect(store.listMemoriesForSession(sessionA.id)).toHaveLength(0);
        expect(rollups.get(sessionA.id)).toBeUndefined();

        // Project B is untouched.
        expect(store.getProjectById(projectB.id)).toBeDefined();
        expect(store.listMemoriesForSession(sessionB.id)).toHaveLength(1);

        // Re-running the same scope finds nothing left - the verification step the CLI performs.
        expect(store.planPurge({ projectPath: '/Users/test/project-a' }).sessions).toHaveLength(0);
    });

    it('purges only the explicitly resolved project ids', () => {
        const selected = store.upsertProject('/Users/test/selected');
        const selectedSession = store.upsertSession('claude-code', 'selected-session', selected.id, '/tmp/selected.jsonl');
        store.recordTurn(makeTurn({ sessionId: 'selected-session', projectPath: selected.path }), selectedSession.id, selected.id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });
        const retained = store.upsertProject('/Users/test/retained');
        const retainedSession = store.upsertSession('claude-code', 'retained-session', retained.id, '/tmp/retained.jsonl');

        const plan = store.planPurge({ projectIds: [selected.id] });
        expect(plan.sessions.map((session) => session.id)).toEqual([selectedSession.id]);
        expect(plan.emptiedProjects.map((project) => project.id)).toEqual([selected.id]);

        store.purge({ projectIds: [selected.id] });

        expect(store.getProjectById(selected.id)).toBeUndefined();
        expect(store.getProjectById(retained.id)).toBeDefined();
        expect(store.listMemoriesForSession(retainedSession.id)).toEqual([]);
    });

    it('applies project-scoped inclusive temporal purges in both directions and keeps partially purged projects', () => {
        const cutoff = '2026-08-15T00:00:00.000Z';
        const cases: Array<{
            name: string;
            timeScope: Pick<PurgeScope, 'newerThan' | 'olderThan'>;
            retainedTime: string;
        }> = [
            { name: 'newer-than', timeScope: { newerThan: cutoff }, retainedTime: '2026-08-01T00:00:00.000Z' },
            { name: 'older-than', timeScope: { olderThan: cutoff }, retainedTime: '2026-08-20T00:00:00.000Z' },
        ];

        for (const [index, scenario] of cases.entries()) {
            const caseStore = new MemoryStore(openDb(':memory:'));
            const selected = caseStore.upsertProject(`/Users/test/selected-window-${index}`);
            const outside = caseStore.upsertProject(`/Users/test/outside-window-${index}`);
            const matched = caseStore.upsertSession('codex', `matched-${index}`, selected.id, `/tmp/matched-${index}.jsonl`);
            const retained = caseStore.upsertSession('codex', `retained-${index}`, selected.id, `/tmp/retained-${index}.jsonl`);
            const outsideMatch = caseStore.upsertSession('codex', `outside-${index}`, outside.id, `/tmp/outside-${index}.jsonl`);
            caseStore.recordTurn(
                makeTurn({ tool: 'codex', sessionId: `matched-${index}`, projectPath: selected.path }),
                matched.id,
                selected.id,
                { decisions: [], pending_items: [], status: 'ok' },
            );
            caseStore.recordTurn(
                makeTurn({ tool: 'codex', sessionId: `retained-${index}`, projectPath: selected.path }),
                retained.id,
                selected.id,
                { decisions: [], pending_items: [], status: 'ok' },
            );
            const setLastIngestedAt = caseStore.database.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?');
            setLastIngestedAt.run(cutoff, matched.id);
            setLastIngestedAt.run(scenario.retainedTime, retained.id);
            setLastIngestedAt.run(cutoff, outsideMatch.id);
            const scope = { projectPath: selected.path, ...scenario.timeScope };

            const plan = caseStore.planPurge(scope);
            expect(
                plan.sessions.map((session) => session.id),
                scenario.name,
            ).toEqual([matched.id]);
            expect(plan.emptiedProjects, scenario.name).toEqual([]);

            const applied = caseStore.purge(scope);
            expect(
                applied.sessions.map((session) => session.id),
                scenario.name,
            ).toEqual([matched.id]);
            expect(applied.emptiedProjects).toEqual([]); // project still has the retained session
            expect(caseStore.getProjectById(selected.id)).toBeDefined();
            expect(caseStore.findSession('codex', `retained-${index}`)?.id).toBe(retained.id);
            expect(caseStore.findSession('codex', `outside-${index}`)?.id).toBe(outsideMatch.id);
            caseStore.database.close();
        }
    });

    it('selects no sessions for an empty scope with no time filter', () => {
        const project = store.upsertProject('/Users/test/empty-scope');
        store.upsertSession('codex', 'empty-scope-session', project.id, '/tmp/empty-scope.jsonl');

        expect(store.planPurge({}).sessions).toEqual([]);
    });

    it('applies empty resolved scopes as strict no-ops without backup or delete side effects', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-empty-purge-'));
        const dbPath = path.join(directory, 'elepha.db');
        const previousDbPath = process.env.ELEPHA_DB_PATH;
        process.env.ELEPHA_DB_PATH = dbPath;
        const db = openDb(dbPath);
        const fileStore = new MemoryStore(db);
        const fileRollups = new RollupStore(db);
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            for (const [index, projectPath] of ['/Users/test/empty-apply-a', '/Users/test/empty-apply-b'].entries()) {
                const project = fileStore.upsertProject(projectPath);
                const nativeId = `empty-apply-${index}`;
                const session = fileStore.upsertSession('codex', nativeId, project.id, `/tmp/${nativeId}.jsonl`);
                fileStore.recordTurn(
                    makeTurn({ tool: 'codex', sessionId: nativeId, sourcePath: `/tmp/${nativeId}.jsonl`, projectPath }),
                    session.id,
                    project.id,
                    { decisions: [{ what: `decision-${index}`, why: null }], pending_items: [`pending-${index}`], status: 'ok' },
                );
                fileRollups.write(
                    {
                        sessionId: session.id,
                        projectId: project.id,
                        tool: 'codex',
                        title: `title-${index}`,
                        summary: `summary-${index}`,
                        decisions: [],
                        pendingItems: [],
                        filesTouched: [],
                        turnCount: 1,
                        startedAt: '2026-08-01T00:00:00.000Z',
                        endedAt: '2026-08-01T00:00:01.000Z',
                        kind: 'primary',
                        parentSessionId: null,
                        summarizerStatus: 'ok',
                        state: 'final',
                        throughTurnIndex: 0,
                    },
                    undefined,
                );
            }
            db.prepare(
                "INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES ('claude-code', 'already-purged', '2026-08-20T00:00:00.000Z')",
            ).run();
            db.prepare(
                "INSERT INTO incognito_transcripts (tool, native_id, tombstoned_at) VALUES ('codex', 'already-incognito', '2026-08-21T00:00:00.000Z')",
            ).run();

            for (const scope of [{}, { projectIds: [] }] satisfies PurgeScope[]) {
                const before = purgeState(fileStore);
                const filesBefore = readdirSync(directory).sort();
                const purge = vi.spyOn(fileStore, 'purge');
                const applyPurgePlan = vi.spyOn(fileStore, 'applyPurgePlan');
                const planPurge = vi.spyOn(fileStore, 'planPurge');
                const confirm = vi.fn(async () => true);

                await expect(runPurgeOperation(fileStore, scope, { applyRequested: true, confirm })).resolves.toBe(true);

                expect(planPurge).toHaveReturnedWith({ scope, sessions: [], emptiedProjects: [] });
                expect(confirm).not.toHaveBeenCalled();
                expect(purge).not.toHaveBeenCalled();
                expect(applyPurgePlan).not.toHaveBeenCalled();
                expect(purgeState(fileStore)).toEqual(before);
                expect(readdirSync(directory).sort()).toEqual(filesBefore);

                planPurge.mockRestore();
                applyPurgePlan.mockRestore();
                purge.mockRestore();
            }
        } finally {
            log.mockRestore();
            db.close();
            if (previousDbPath === undefined) delete process.env.ELEPHA_DB_PATH;
            else process.env.ELEPHA_DB_PATH = previousDbPath;
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('plans a project-root purge through a symlink against the stored physical path', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-symlink-'));
        const physicalRoot = path.join(directory, 'repo');
        const aliasRoot = path.join(directory, 'link');
        const projectPath = path.join(physicalRoot, 'packages', 'app');
        mkdirSync(projectPath, { recursive: true });
        symlinkSync(physicalRoot, aliasRoot);

        try {
            const project = store.upsertProject(projectPath);
            const session = store.upsertSession('codex', 'symlink-session', project.id, '/tmp/symlink-session.jsonl');

            expect(store.planPurge({ projectRoot: aliasRoot }).sessions.map((candidate) => candidate.id)).toEqual([session.id]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('uses lexical project-root containment when paths do not exist', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-missing-'));
        const root = path.join(directory, 'missing-root');
        const child = store.upsertProject(path.join(root, 'packages', 'app'));
        const outside = store.upsertProject(path.join(directory, 'other'));
        const childSession = store.upsertSession('codex', 'missing-child', child.id, '/tmp/missing-child.jsonl');
        store.upsertSession('codex', 'missing-outside', outside.id, '/tmp/missing-outside.jsonl');

        try {
            expect(() => store.planPurge({ projectRoot: root })).not.toThrow();
            expect(store.planPurge({ projectRoot: root }).sessions.map((candidate) => candidate.id)).toEqual([childSession.id]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('purge --all wipes every project, session, and turn', () => {
        const projectA = store.upsertProject('/Users/test/project-a');
        const sessionA = store.upsertSession('claude-code', 'sess-a', projectA.id, '/tmp/a.jsonl');
        store.recordTurn(makeTurn({ sessionId: 'sess-a', projectPath: '/Users/test/project-a' }), sessionA.id, projectA.id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });
        const projectB = store.upsertProject('/Users/test/project-b');
        store.upsertSession('claude-code', 'sess-b', projectB.id, '/tmp/b.jsonl');

        store.purge({ all: true });

        expect(store.listProjects()).toHaveLength(0);
        expect(store.planPurge({ all: true }).sessions).toHaveLength(0);
    });

    it('aborts atomically when a planned id now belongs to a different session', () => {
        const project = store.upsertProject('/Users/test/reused-purge-id');
        const first = store.upsertSession('codex', 'first-planned', project.id, '/tmp/first-planned.jsonl');
        const replaced = store.upsertSession('codex', 'replaced-planned', project.id, '/tmp/replaced-planned.jsonl');
        const plan = store.planPurge({ all: true });
        expect(plan.sessions.map((session) => session.nativeId)).toEqual(['first-planned', 'replaced-planned']);

        store.database.prepare('DELETE FROM sessions WHERE id = ?').run(replaced.id);
        const replacement = store.upsertSession('claude-code', 'replacement-session', project.id, '/tmp/replacement.jsonl');
        expect(replacement.id).toBe(replaced.id);
        const beforeApply = purgeState(store);

        expect(() => store.applyPurgePlan(plan, '2026-08-22T00:00:00.000Z')).toThrow(`session id ${replaced.id}`);

        expect(purgeState(store)).toEqual(beforeApply);
        expect(store.findSession('codex', first.native_id)?.id).toBe(first.id);
        expect(store.findSession('claude-code', replacement.native_id)?.id).toBe(replacement.id);
    });

    it('keeps a previewed empty project when it gains a session before apply', () => {
        const project = store.upsertProject('/Users/test/reoccupied-project');
        const planned = store.upsertSession('codex', 'planned-session', project.id, '/tmp/planned.jsonl');
        const plan = store.planPurge({ projectIds: [project.id] });
        expect(plan.emptiedProjects.map((candidate) => candidate.id)).toEqual([project.id]);

        const late = store.upsertSession('codex', 'late-session', project.id, '/tmp/late.jsonl');
        const applied = store.applyPurgePlan(plan, '2026-08-22T00:00:00.000Z');

        expect(applied.sessions.map((session) => session.id)).toEqual([planned.id]);
        expect(applied.emptiedProjects).toEqual([]);
        expect(store.findSession('codex', planned.native_id)).toBeUndefined();
        expect(store.findSession('codex', late.native_id)?.id).toBe(late.id);
        expect(store.getProjectById(project.id)).toBeDefined();
    });

    it('records one immutable tombstone per (tool, native_id), including every purged segment', () => {
        const project = store.upsertProject('/Users/test/project-tombstones');
        const claude = store.upsertSession('claude-code', 'shared-native-id', project.id, '/tmp/claude.jsonl');
        store.startNextSegment(claude, project.id, '/tmp/claude.jsonl');
        store.upsertSession('codex', 'shared-native-id', project.id, '/tmp/codex.jsonl');

        const checkpoint = vi.spyOn(store.database, 'pragma');

        const applied = store.purge({ all: true }, '2026-08-21T00:00:00.000Z');

        expect(applied.sessions.map((session) => session.nativeId)).toEqual(['shared-native-id', 'shared-native-id', 'shared-native-id']);
        expect(store.database.prepare('SELECT tool, native_id, purged_at FROM purged_transcripts ORDER BY tool').all()).toEqual([
            { tool: 'claude-code', native_id: 'shared-native-id', purged_at: '2026-08-21T00:00:00.000Z' },
            { tool: 'codex', native_id: 'shared-native-id', purged_at: '2026-08-21T00:00:00.000Z' },
        ]);
        expect(store.isTranscriptPurged('claude-code', 'shared-native-id')).toBe(true);
        expect(store.isTranscriptPurged('codex', 'shared-native-id')).toBe(true);
        expect(checkpoint).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
    });

    it('findProjectsForPurge returns every fragmented row matching a query, not just the first', () => {
        store.upsertProject('/Users/test/demo-project');
        store.upsertProject('/Users/test/demo-project-moved');

        expect(store.findProjectsForPurge('')).toEqual([]);
        expect(store.findProjectsForPurge('   ')).toEqual([]);

        const matches = store.findProjectsForPurge('demo-project');
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });
});
