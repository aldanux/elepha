import { beforeEach, describe, expect, it } from 'vitest';
import { FIRST_PROMPT_SEARCH_CAP } from '../../src/config/constants.js';
import { renderRawTurns } from '../../src/rendering/raw-turn-renderer.js';
import { stripShellSyntax } from '../../src/security/sanitize.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
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
        toolCalls: [{ name: 'Edit', filePaths: ['/Users/test/demo-project/a.ts'] }],
        cursor: '100|1',
        ...overrides,
        hasExternalContent: overrides.hasExternalContent ?? false,
        resumeMarkerBefore: overrides.resumeMarkerBefore ?? false,
    };
}

describe('MemoryStore', () => {
    let store: MemoryStore;

    beforeEach(() => {
        store = new MemoryStore(openDb(':memory:'));
    });

    it('re-ingesting the same turn is a no-op, not a duplicate row', () => {
        const project = store.upsertProject('/Users/test/demo-project');
        const session = store.upsertSession('claude-code', 'sess-1', project.id, '/tmp/sess-1.jsonl');
        const turn = makeTurn();

        const first = store.recordTurn(turn, session.id, project.id, {
            decisions: [{ what: 'picked X', why: null }],
            pending_items: [],
            status: 'ok',
        });
        const second = store.recordTurn(turn, session.id, project.id, {
            decisions: [{ what: 'picked X', why: null }],
            pending_items: [],
            status: 'ok',
        });

        expect(first).toBe(true);
        expect(second).toBe(false);

        const rows = store.listRecentMemories(project.id, 10);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.decisions).toEqual([{ what: 'picked X', why: null }]);
        expect(rows[0]!.files_touched).toEqual(['/Users/test/demo-project/a.ts']);
    });

    it('stores only the sanitized capped first user prompt and never replaces it with a later turn', () => {
        const project = store.upsertProject('/Users/test/demo-project');
        const session = store.upsertSession('claude-code', 'first-prompt-search', project.id, '/tmp/first-prompt-search.jsonl');
        const prompt = `ask $(whoami) \`danger\` ${'x'.repeat(FIRST_PROMPT_SEARCH_CAP + 100)}`;
        const summary = { decisions: [], pending_items: [], status: 'ok' as const };

        store.recordTurn(makeTurn({ sessionId: session.native_id, userMessage: prompt }), session.id, project.id, summary);

        expect(store.findSession('claude-code', session.native_id)?.first_prompt_search).toBe(
            stripShellSyntax(prompt).slice(0, FIRST_PROMPT_SEARCH_CAP),
        );
        expect(store.findSession('claude-code', session.native_id)?.first_prompt_search).toHaveLength(FIRST_PROMPT_SEARCH_CAP);

        store.recordTurn(
            makeTurn({ sessionId: session.native_id, turnIndex: 1, userMessage: 'later prompt must not replace the first' }),
            session.id,
            project.id,
            summary,
        );
        expect(store.findSession('claude-code', session.native_id)?.first_prompt_search).toBe(
            stripShellSyntax(prompt).slice(0, FIRST_PROMPT_SEARCH_CAP),
        );

        store.database.prepare('UPDATE sessions SET first_prompt_search = NULL WHERE id = ?').run(session.id);
        store.recordTurn(
            makeTurn({ sessionId: session.native_id, turnIndex: 2, userMessage: 'a migrated row appended later' }),
            session.id,
            project.id,
            summary,
        );
        expect(store.findSession('claude-code', session.native_id)?.first_prompt_search).toBeNull();
    });

    it('accumulates the exact bytes served by the raw-turn renderer, without counting a duplicate or pause turn', () => {
        const project = store.upsertProject('/Users/test/demo-project');
        const session = store.upsertSession('claude-code', 'rendered-chars', project.id, '/tmp/rendered.jsonl');
        const first = makeTurn({ sessionId: 'rendered-chars', turnIndex: 0 });
        const second = makeTurn({ sessionId: 'rendered-chars', turnIndex: 1, userMessage: 'next', assistantText: 'done `safely`' });
        const pause = makeTurn({
            sessionId: 'rendered-chars',
            turnIndex: 2,
            userMessage: 'no hagas nada de momento',
            assistantText: 'Entendido, no haré nada de momento.',
            toolCalls: [],
        });
        const summary = { decisions: [], pending_items: [], status: 'empty_turn' as const };

        expect(store.recordTurn(first, session.id, project.id, summary)).toBe(true);
        expect(store.recordTurn(second, session.id, project.id, summary)).toBe(true);
        expect(store.recordTurn(pause, session.id, project.id, summary)).toBe(true);
        expect(store.recordTurn(second, session.id, project.id, summary)).toBe(false);

        expect(store.findSession('claude-code', 'rendered-chars')?.rendered_chars).toBe(renderRawTurns([first, second, pause]).length);
        expect(store.findSession('claude-code', 'rendered-chars')?.rendered_turns).toBe(2);
    });

    it('keys sessions by (tool, native_id) so ids from different tools cannot collide', () => {
        const project = store.upsertProject('/Users/test/demo-project');
        const ccSession = store.upsertSession('claude-code', 'shared-id', project.id, '/tmp/a.jsonl');
        const codexSession = store.upsertSession('codex', 'shared-id', project.id, '/tmp/b.jsonl');
        expect(ccSession.id).not.toBe(codexSession.id);

        store.recordTurn(makeTurn({ tool: 'claude-code', turnIndex: 0 }), ccSession.id, project.id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });
        store.recordTurn(makeTurn({ tool: 'codex', turnIndex: 0 }), codexSession.id, project.id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });

        expect(store.listRecentMemories(project.id, 10)).toHaveLength(2);
    });

    it('upsertProject is idempotent by canonical path', () => {
        const a = store.upsertProject('/Users/test/demo-project');
        const b = store.upsertProject('/Users/test/demo-project');
        expect(a.id).toBe(b.id);
        expect(store.listProjects()).toHaveLength(1);
    });

    it('keys two git working directories by one repository root and caches root lookup per cwd', () => {
        const calls = new Map<string, number>();
        const gitStore = new MemoryStore(openDb(':memory:'), {
            resolveGitRoot: (cwd) => {
                calls.set(cwd, (calls.get(cwd) ?? 0) + 1);
                return cwd.startsWith('/repo/') ? '/repo' : null;
            },
            resolveGitRemote: (gitRoot) => (gitRoot === '/repo' ? 'git@example.test:team/repo.git' : null),
            resolveGitRootCommit: (gitRoot) => (gitRoot === '/repo' ? '1111111111111111111111111111111111111111' : null),
        });

        const app = gitStore.upsertProject('/repo/apps/web');
        const packageDir = gitStore.upsertProject('/repo/packages/core');
        const appAgain = gitStore.upsertProject('/repo/apps/web');

        expect(packageDir.id).toBe(app.id);
        expect(appAgain.id).toBe(app.id);
        expect(gitStore.listProjects()).toEqual([
            expect.objectContaining({
                path: '/repo',
                display_name: 'repo',
                git_root: '/repo',
                git_remote: 'git@example.test:team/repo.git',
                git_root_commit: '1111111111111111111111111111111111111111',
            }),
        ]);
        expect(calls).toEqual(
            new Map([
                ['/repo/apps/web', 1],
                ['/repo/packages/core', 1],
            ]),
        );
    });

    it('keeps non-git working directories keyed by their exact path', () => {
        const gitStore = new MemoryStore(openDb(':memory:'), { resolveGitRoot: () => null });

        const first = gitStore.upsertProject('/scratch/one');
        const second = gitStore.upsertProject('/scratch/two');
        const firstAgain = gitStore.upsertProject('/scratch/one');

        expect(firstAgain.id).toBe(first.id);
        expect(second.id).not.toBe(first.id);
        expect(gitStore.listProjects().map((project) => project.path)).toEqual(['/scratch/one', '/scratch/two']);
    });

    describe('rekeyProjectsByIdentity', () => {
        // Sessions are keyed by cwd, so one repo entered from a subdirectory
        // becomes several project rows and get_context for one silently misses
        // the others' history.
        const fakeResolver = (map: Record<string, string | null>) => (p: string) => map[p] ?? null;

        it('merges subdirectory rows onto the row whose path IS the git root', () => {
            const root = store.upsertProject('/repo');
            const sub = store.upsertProject('/repo/resources/js');
            const rootSession = store.upsertSession('claude-code', 's-root', root.id, '/tmp/a.jsonl');
            const subSession = store.upsertSession('codex', 's-sub', sub.id, '/tmp/b.jsonl');
            store.recordTurn(makeTurn({ turnIndex: 0 }), rootSession.id, root.id, {
                decisions: [{ what: 'a', why: null }],
                pending_items: [],
                status: 'ok',
            });
            store.recordTurn(makeTurn({ turnIndex: 0, tool: 'codex' }), subSession.id, sub.id, {
                decisions: [{ what: 'b', why: null }],
                pending_items: [],
                status: 'ok',
            });

            const plans = store.rekeyProjectsByIdentity(fakeResolver({ '/repo': '/repo', '/repo/resources/js': '/repo' }));

            expect(plans).toHaveLength(1);
            expect(plans[0]!.canonical.id).toBe(root.id);
            expect(plans[0]!.merged.map((m) => m.id)).toEqual([sub.id]);
            expect(store.listProjects()).toHaveLength(1);
            // Both sessions' history now reachable from the single project.
            expect(store.listRecentMemories(root.id, 10)).toHaveLength(2);
        });

        it('falls back to the shallowest path when no row matches the git root exactly', () => {
            const a = store.upsertProject('/repo/deep/nested/dir');
            const b = store.upsertProject('/repo/deep');
            const plans = store.rekeyProjectsByIdentity(fakeResolver({ '/repo/deep/nested/dir': '/repo', '/repo/deep': '/repo' }));
            expect(plans[0]!.canonical.id).toBe(b.id);
            expect(plans[0]!.merged.map((m) => m.id)).toEqual([a.id]);
            expect(store.getProjectById(b.id)).toEqual(expect.objectContaining({ path: '/repo', display_name: 'repo', git_root: '/repo' }));
        });

        it('canonicalizes a single surviving subdirectory row to its git root', () => {
            const sub = store.upsertProject('/repo/resources/js');

            const plans = store.rekeyProjectsByIdentity(fakeResolver({ '/repo/resources/js': '/repo' }));

            expect(plans).toHaveLength(1);
            expect(plans[0]).toEqual(
                expect.objectContaining({ canonical: expect.objectContaining({ id: sub.id }), gitRoot: '/repo', merged: [] }),
            );
            expect(store.listProjects()).toEqual([
                expect.objectContaining({ id: sub.id, path: '/repo', display_name: 'repo', git_root: '/repo' }),
            ]);
        });

        it('merges a dead checkout into the live row sharing its remote and moves every project foreign key', () => {
            const now = '2026-08-22T00:00:00.000Z';
            const insertProject = store.database.prepare(
                `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            );
            const dead = Number(
                insertProject.run('/work/old-name', 'old-name', '/work/old-name', 'git@example.test:team/repo.git', 'root-commit', now, now)
                    .lastInsertRowid,
            );
            const live = Number(
                insertProject.run(
                    '/work/current-name',
                    'current-name',
                    '/work/old-name',
                    'git@example.test:team/repo.git',
                    'root-commit',
                    now,
                    now,
                ).lastInsertRowid,
            );
            const deadSession = store.upsertSession('claude-code', 'dead-session', dead, '/tmp/dead.jsonl');
            store.recordTurn(makeTurn(), deadSession.id, dead, { decisions: [], pending_items: [], status: 'ok' });
            store.database
                .prepare(
                    `INSERT INTO session_rollups
                     (session_id, project_id, tool, title, summary, decisions, pending_items, files_touched, turn_count, started_at, ended_at, kind, parent_session_id, summarizer_status, rollup_state, rolled_up_through_turn_index, computed_at, rollup_version)
                     VALUES (?, ?, 'claude-code', 'dead', '', '[]', '[]', '[]', 0, ?, ?, 'primary', NULL, 'ok', 'final', -1, ?, 1)`,
                )
                .run(deadSession.id, dead, now, now, now);

            const plans = store.rekeyProjectsByIdentity(fakeResolver({ '/work/current-name': '/work/current-name' }));

            expect(plans).toEqual([
                expect.objectContaining({ canonical: expect.objectContaining({ id: live }), gitRoot: '/work/current-name' }),
            ]);
            expect(store.listProjects()).toEqual([
                expect.objectContaining({
                    id: live,
                    path: '/work/current-name',
                    git_root: '/work/current-name',
                    git_remote: 'git@example.test:team/repo.git',
                    git_root_commit: 'root-commit',
                }),
            ]);
            expect(store.database.prepare('SELECT project_id FROM memories').all()).toEqual([{ project_id: live }]);
            expect(store.database.prepare('SELECT project_id FROM sessions').all()).toEqual([{ project_id: live }]);
            expect(store.database.prepare('SELECT project_id FROM session_rollups').all()).toEqual([{ project_id: live }]);
        });

        it('merges matching root commits without a remote and keeps a no-longer-live canonical path unchanged', () => {
            const now = '2026-08-22T00:00:00.000Z';
            const insertProject = store.database.prepare(
                `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                 VALUES (?, ?, ?, NULL, ?, ?, ?)`,
            );
            const canonical = Number(
                insertProject.run('/gone/repo', 'original-name', '/stale/repo', 'root-commit', now, now).lastInsertRowid,
            );
            const victim = Number(insertProject.run('/gone/repo/nested', 'nested', '/stale/repo', 'root-commit', now, now).lastInsertRowid);
            const victimSession = store.upsertSession('codex', 'victim-session', victim, '/tmp/victim.jsonl');

            const plans = store.rekeyProjectsByIdentity(fakeResolver({}));

            expect(plans).toEqual([expect.objectContaining({ canonical: expect.objectContaining({ id: canonical }), gitRoot: null })]);
            expect(store.listProjects()).toEqual([
                expect.objectContaining({
                    id: canonical,
                    path: '/gone/repo',
                    display_name: 'original-name',
                    git_root: '/stale/repo',
                    git_root_commit: 'root-commit',
                }),
            ]);
            expect(store.database.prepare('SELECT project_id FROM sessions WHERE id = ?').get(victimSession.id)).toEqual({
                project_id: canonical,
            });
        });

        it('keeps rows with different remotes separate', () => {
            const now = '2026-08-22T00:00:00.000Z';
            const insertProject = store.database.prepare(
                `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                 VALUES (?, ?, ?, ?, NULL, ?, ?)`,
            );
            insertProject.run('/repo/one', 'one', '/repo/one', 'git@example.test:team/one.git', now, now);
            insertProject.run('/repo/two', 'two', '/repo/two', 'git@example.test:team/two.git', now, now);

            expect(store.rekeyProjectsByIdentity(fakeResolver({ '/repo/one': '/repo/one', '/repo/two': '/repo/two' }))).toEqual([]);
            expect(store.listProjects()).toHaveLength(2);
        });

        it('refreshes a stale git_root on the surviving canonical row', () => {
            const root = store.upsertProject('/repo');
            store.upsertProject('/repo/sub');
            expect(store.getProjectById(root.id)!.git_root).toBeNull();

            store.rekeyProjectsByIdentity(fakeResolver({ '/repo': '/repo', '/repo/sub': '/repo' }));
            expect(store.getProjectById(root.id)!.git_root).toBe('/repo');
        });

        it('planRekeyProjectsByIdentity reports the same plan without writing', () => {
            store.upsertProject('/repo');
            store.upsertProject('/repo/sub');
            const resolver = fakeResolver({ '/repo': '/repo', '/repo/sub': '/repo' });

            const planned = store.planRekeyProjectsByIdentity(resolver);
            expect(planned).toHaveLength(1);
            expect(store.listProjects()).toHaveLength(2); // untouched
        });
    });

    describe('reingestTurn', () => {
        it('overwrites an existing row instead of silently no-op-ing like recordTurn would', () => {
            const project = store.upsertProject('/Users/test/demo-project');
            const session = store.upsertSession('claude-code', 'sess-1', project.id, '/tmp/sess-1.jsonl');
            const turn = makeTurn();

            store.recordTurn(turn, session.id, project.id, { decisions: [], pending_items: [], status: 'parse_error' });
            // recordTurn (INSERT OR IGNORE) would silently drop this - proving
            // the bug reingest exists to fix.
            expect(
                store.recordTurn(turn, session.id, project.id, {
                    decisions: [{ what: 'recovered', why: null }],
                    pending_items: [],
                    status: 'ok',
                }),
            ).toBe(false);
            expect(store.listRecentMemories(project.id, 10)[0]!.decisions).toEqual([]);

            store.reingestTurn(turn, session.id, project.id, {
                decisions: [{ what: 'recovered', why: null }],
                pending_items: [],
                status: 'ok',
            });

            const rows = store.listRecentMemories(project.id, 10);
            expect(rows).toHaveLength(1);
            expect(rows[0]!.decisions).toEqual([{ what: 'recovered', why: null }]);
            expect(rows[0]!.summarizer_status).toBe('ok');
            expect(rows[0]!.reingested_at).not.toBeNull();
        });

        it('never touches sessions.cursor - reingest is orthogonal to the live daemon cursor', () => {
            const project = store.upsertProject('/Users/test/demo-project');
            const session = store.upsertSession('claude-code', 'sess-1', project.id, '/tmp/sess-1.jsonl');
            const turn = makeTurn({ cursor: '100|1' });

            store.recordTurn(turn, session.id, project.id, { decisions: [], pending_items: [], status: 'ok' });
            const cursorAfterRecord = store.getSessionCursor('claude-code', 'sess-1');
            expect(cursorAfterRecord).toBe('100|1');

            // Reingest a turn carrying a different (stale, re-derived) cursor value.
            store.reingestTurn(makeTurn({ cursor: '999|9' }), session.id, project.id, {
                decisions: [{ what: 'x', why: null }],
                pending_items: [],
                status: 'ok',
            });

            expect(store.getSessionCursor('claude-code', 'sess-1')).toBe(cursorAfterRecord);
        });
    });
});

describe('session metadata capture', () => {
    it('upsertSession writes surface/gitBranch/kind/customTitle on first creation, while only customTitle is refreshable', () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const project = store.upsertProject('/tmp/proj');

        const created = store.upsertSession('codex', 'native-1', project.id, '/tmp/x.jsonl', {
            surface: 'cli',
            gitBranch: 'main',
            kind: 'main',
            customTitle: 'Initial title',
        });
        expect(created.surface).toBe('cli');
        expect(created.git_branch).toBe('main');
        expect(created.kind).toBe('main');
        expect(created.custom_title).toBe('Initial title');
        expect(created.segment_index).toBe(0);
        expect(created.last_turn_at).toBeNull();
        expect(created.trailing_files).toEqual([]);

        // A second call for the same (tool, native_id) is the "already
        // exists" path - meta must be ignored, not overwrite the anchor
        // captured at creation, so the anchor does not drift on every scan.
        const again = store.upsertSession('codex', 'native-1', project.id, '/tmp/x.jsonl', {
            surface: 'desktop',
            gitBranch: 'other',
            kind: 'subagent',
            customTitle: 'Renamed title',
        });
        expect(again.surface).toBe('cli');
        expect(again.git_branch).toBe('main');
        expect(again.kind).toBe('main');
        expect(again.custom_title).toBe('Renamed title');

        const withoutMeta = store.upsertSession('claude-code', 'native-2', project.id, '/tmp/y.jsonl');
        expect(withoutMeta.surface).toBeNull();
        expect(withoutMeta.git_branch).toBeNull();
        expect(withoutMeta.kind).toBeNull();
        expect(withoutMeta.custom_title).toBeNull();
        db.close();
    });
});

describe('trailing state', () => {
    it('recordTurn updates trailing_branch and trailing_files, capped and deduped, on every turn close', () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const project = store.upsertProject('/tmp/proj3');
        const session = store.upsertSession('claude-code', 'native-3', project.id, '/tmp/z.jsonl', { kind: 'main' });

        const baseTurn = (idx: number, branch: string, files: string[]) => ({
            tool: 'claude-code' as const,
            sessionId: 'native-3',
            sourcePath: '/tmp/z.jsonl',
            projectPath: '/tmp/proj3',
            turnIndex: idx,
            startedAt: '2026-08-15T00:00:00.000Z',
            endedAt: '2026-08-15T00:00:01.000Z',
            userMessage: 'hi',
            assistantText: 'ok',
            toolCalls: files.map((f) => ({ name: 'Edit', filePaths: [f] })),
            cursor: `cursor-${idx}`,
            surface: 'cli',
            gitBranch: branch,
            hasExternalContent: false,
            resumeMarkerBefore: false,
        });

        store.recordTurn(baseTurn(0, 'main', ['/tmp/proj3/a.ts']), session.id, project.id, {
            decisions: [],
            pending_items: [],
            status: 'empty_turn',
        });
        let row = store.findSession('claude-code', 'native-3');
        expect(row?.trailing_branch).toBe('main');
        expect(row?.last_turn_at).toBe('2026-08-15T00:00:01.000Z');
        expect(row?.trailing_files).toEqual(['/tmp/proj3/a.ts']);

        store.recordTurn(baseTurn(1, 'feature/x', ['/tmp/proj3/b.ts']), session.id, project.id, {
            decisions: [],
            pending_items: [],
            status: 'empty_turn',
        });
        row = store.findSession('claude-code', 'native-3');
        expect(row?.trailing_branch).toBe('feature/x'); // drifted - this signals a boundary evaluation
        expect(row?.trailing_files).toEqual(['/tmp/proj3/b.ts', '/tmp/proj3/a.ts']); // most-recent-first

        // git_branch (the anchor, captured at creation) must NOT drift.
        expect(row?.git_branch).toBeNull(); // no meta was passed at creation in this test
        const listed = store.listSessionsForRollupRebuild(project.id).find((candidate) => candidate.id === session.id);
        expect(listed?.trailing_files).toEqual(['/tmp/proj3/b.ts', '/tmp/proj3/a.ts']);

        db.close();
    });

    it('updates last_turn_at even when branch and files are unavailable', () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const project = store.upsertProject('/tmp/proj-no-evidence');
        const session = store.upsertSession('codex', 'native-no-evidence', project.id, '/tmp/no-evidence.jsonl');

        store.recordTurn(
            makeTurn({
                tool: 'codex',
                sessionId: 'native-no-evidence',
                endedAt: '2026-08-15T03:04:05.000Z',
                toolCalls: [],
                gitBranch: undefined,
            }),
            session.id,
            project.id,
            { decisions: [], pending_items: [], status: 'empty_turn' },
        );

        expect(store.findSession('codex', 'native-no-evidence')?.last_turn_at).toBe('2026-08-15T03:04:05.000Z');
        db.close();
    });
});

describe('findSession ordering', () => {
    it('returns the row with the highest segment_index when more than one exists for (tool, native_id)', () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const project = store.upsertProject('/tmp/proj4');

        // segment_index 0, written the normal way.
        const first = store.upsertSession('codex', 'native-multi-segment', project.id, '/tmp/w.jsonl');
        expect(first.segment_index).toBe(0);

        // segment_index 1: nothing in this codebase writes a non-zero
        // segment_index yet (that's a future segmentation feature), so this
        // row is inserted directly via raw SQL to prove the READ path is
        // deterministic ahead of a writer existing.
        const now = new Date().toISOString();
        db.prepare(
            `INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run('codex', 'native-multi-segment', 1, project.id, '/tmp/w.jsonl', now, now);

        const found = store.findSession('codex', 'native-multi-segment');
        expect(found?.segment_index).toBe(1);

        db.close();
    });
});
