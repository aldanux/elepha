import { beforeEach, describe, expect, it } from 'vitest';
import { FIRST_PROMPT_SEARCH_CAP } from '../../src/config/constants.js';
import { renderRawTurns } from '../../src/rendering/raw-turn-renderer.js';
import { stripShellSyntax } from '../../src/security/sanitize.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
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
        store = new MemoryStore(openUnmanagedDb(':memory:'));
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
        const gitStore = new MemoryStore(openUnmanagedDb(':memory:'), {
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
        const gitStore = new MemoryStore(openUnmanagedDb(':memory:'), { resolveGitRoot: () => null });

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

        it('preserves every rule identity and creation order when merging project owners', () => {
            const root = store.upsertProject('/rules-repo');
            const child = store.upsertProject('/rules-repo/child');
            const insert = store.database.prepare('INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)');
            insert.run('first-rule', child.id, 'First rule', '2026-09-20T01:00:00.000Z');
            insert.run('second-rule', root.id, 'Second rule', '2026-09-20T00:00:00.000Z');
            const before = store.standingRules.list([root.id, child.id]);
            store.rekeyProjectsByIdentity(fakeResolver({ '/rules-repo': '/rules-repo', '/rules-repo/child': '/rules-repo' }));
            expect(store.standingRules.list([root.id])).toEqual(before.map((rule) => ({ ...rule, project_id: root.id })));
            expect(store.getProjectById(child.id)).toBeUndefined();
            expect(store.database.pragma('foreign_key_check')).toEqual([]);
        });

        it('moves durable chat-rule owners before deleting a merged project row', () => {
            const root = store.upsertProject('/chat-rules-repo');
            const child = store.upsertProject('/chat-rules-repo/child');
            const insert = store.database.prepare(
                `INSERT INTO session_rules (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
                 VALUES (?, 'codex', 'same-chat', '/chat-rules-repo', ?, ?, '2026-09-20')`,
            );
            insert.run('first-chat-rule', child.id, 'First chat rule');
            insert.run('second-chat-rule', root.id, 'Second chat rule');
            const before = store.database.prepare('SELECT * FROM session_rules ORDER BY id').all() as Array<Record<string, unknown>>;
            store.rekeyProjectsByIdentity(
                fakeResolver({ '/chat-rules-repo': '/chat-rules-repo', '/chat-rules-repo/child': '/chat-rules-repo' }),
            );
            expect(store.database.prepare('SELECT * FROM session_rules ORDER BY id').all()).toEqual(
                before.map((rule) => ({ ...rule, owner_project_id: root.id })),
            );
            expect(store.getProjectById(child.id)).toBeUndefined();
            expect(store.database.pragma('foreign_key_check')).toEqual([]);
        });

        it('keeps different physical checkout anchors as independent chat-rule budgets during rekey', () => {
            const root = store.upsertProject('/independent-checkouts');
            const child = store.upsertProject('/independent-checkouts/child');
            store.database
                .prepare(
                    `INSERT INTO session_rules (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
                     VALUES (?, 'codex', 'same-chat', ?, ?, 'Same text', '2026-09-20')`,
                )
                .run('checkout-one-rule', '/checkout-one', root.id);
            store.database
                .prepare(
                    `INSERT INTO session_rules (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
                     VALUES (?, 'codex', 'same-chat', ?, ?, 'Same text', '2026-09-20')`,
                )
                .run('checkout-two-rule', '/checkout-two', child.id);
            expect(() =>
                store.rekeyProjectsByIdentity(
                    fakeResolver({
                        '/independent-checkouts': '/independent-checkouts',
                        '/independent-checkouts/child': '/independent-checkouts',
                    }),
                ),
            ).not.toThrow();
            expect(store.database.prepare('SELECT checkout_anchor, owner_project_id FROM session_rules ORDER BY id').all()).toEqual([
                { checkout_anchor: '/checkout-one', owner_project_id: root.id },
                { checkout_anchor: '/checkout-two', owner_project_id: root.id },
            ]);
        });

        it.each(['duplicate', 'count', 'characters'] as const)(
            'rejects a %s chat-rule scope merge before mutating any project',
            (conflict) => {
                const earlier = store.upsertProject('/chat-earlier');
                const earlierChild = store.upsertProject('/chat-earlier/child');
                const root = store.upsertProject('/chat-conflict');
                const child = store.upsertProject('/chat-conflict/child');
                const insert = store.database.prepare(
                    `INSERT INTO session_rules (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
                     VALUES (?, 'codex', 'same-chat', '/chat-conflict', ?, ?, '2026-09-20')`,
                );
                const texts =
                    conflict === 'duplicate'
                        ? ['same', 'same']
                        : conflict === 'count'
                          ? Array.from({ length: 9 }, (_, i) => `rule ${i}`)
                          : Array.from({ length: 5 }, (_, i) => `${i}${'x'.repeat(299)}`);
                texts.forEach((text, index) => {
                    insert.run(`chat-conflict-${index}`, index % 2 === 0 ? root.id : child.id, text);
                });
                const state = () => ({
                    projects: store.database.prepare('SELECT * FROM projects ORDER BY id').all(),
                    rules: store.database.prepare('SELECT * FROM session_rules ORDER BY id').all(),
                });
                const before = state();
                expect(() =>
                    store.rekeyProjectsByIdentity(
                        fakeResolver({
                            '/chat-earlier': '/chat-earlier',
                            '/chat-earlier/child': '/chat-earlier',
                            '/chat-conflict': '/chat-conflict',
                            '/chat-conflict/child': '/chat-conflict',
                        }),
                    ),
                ).toThrow(/Rekey refused:.*chat rule.*chat-conflict-0/);
                expect(state()).toEqual(before);
                expect(store.getProjectById(earlier.id)).toBeDefined();
                expect(store.getProjectById(earlierChild.id)).toBeDefined();
            },
        );

        it('rekeys an exactly full rule budget with escaped shell references byte-for-byte', () => {
            const root = store.upsertProject('/escaped-rules');
            const child = store.upsertProject('/escaped-rules/child');
            const texts = [
                'Never execute \\`commands\\` or $\\(commands).'.padEnd(300, 'x'),
                'Second rule.'.padEnd(300, 'y'),
                'Third rule.'.padEnd(300, 'z'),
                'Fourth rule.'.padEnd(300, 'w'),
            ];
            const insert = store.database.prepare('INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)');
            texts.forEach((text, index) => {
                insert.run(`escaped-${index}`, index % 2 === 0 ? child.id : root.id, text, '2026-09-20T00:00:00.000Z');
            });
            const before = store.standingRules.list([root.id, child.id]);
            expect(before.reduce((total, rule) => total + rule.text.length, 0)).toBe(1200);
            expect(() =>
                store.rekeyProjectsByIdentity(
                    fakeResolver({ '/escaped-rules': '/escaped-rules', '/escaped-rules/child': '/escaped-rules' }),
                ),
            ).not.toThrow();
            expect(store.standingRules.list([root.id])).toEqual(before.map((rule) => ({ ...rule, project_id: root.id })));
        });

        it.each(['duplicate', 'count', 'characters'] as const)(
            'rejects a %s rule conflict before mutating any planned project group',
            (conflict) => {
                const root = store.upsertProject('/earlier');
                const child = store.upsertProject('/earlier/child');
                const later = store.upsertProject('/later');
                const laterChild = store.upsertProject('/later/child');
                const now = '2026-09-20T00:00:00.000Z';
                const session = store.upsertSession('codex', 'rekey-owner', child.id, '/tmp/rekey-owner.jsonl');
                store.recordTurn(makeTurn({ tool: 'codex', sessionId: session.native_id, projectPath: child.path }), session.id, child.id, {
                    decisions: [{ what: 'preserve', why: null }],
                    pending_items: [],
                    status: 'ok',
                });
                store.database
                    .prepare(`INSERT INTO session_rollups
                (session_id, project_id, tool, title, summary, decisions, pending_items, files_touched, turn_count, started_at, ended_at, kind, parent_session_id, summarizer_status, rollup_state, rolled_up_through_turn_index, computed_at, rollup_version)
                VALUES (?, ?, 'codex', 'preserve', '', '[]', '[]', '[]', 0, ?, ?, 'primary', NULL, 'ok', 'final', -1, ?, 1)`)
                    .run(session.id, child.id, now, now, now);
                store.database
                    .prepare(`INSERT INTO open_turns
                (tool, native_session_id, session_id, project_id, source_generation, turn_index, candidate_cursor, source_path, source_dev, source_ino, source_size, source_mtime_ms, source_revision, source_digest, failed_at, observed_at, receipt_coverage)
                VALUES ('codex', 'rekey-owner', ?, ?, 0, 1, 'next', '/tmp/rekey-owner.jsonl', '1', '2', 1, 1, 'revision', 'digest', ?, ?, 'complete')`)
                    .run(session.id, child.id, now, now);
                const insert = store.database.prepare(
                    'INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)',
                );
                insert.run('earlier-rule', child.id, 'Preserve earlier rule', now);
                const texts =
                    conflict === 'duplicate'
                        ? ['same', 'same']
                        : conflict === 'count'
                          ? Array.from({ length: 9 }, (_, i) => `rule ${i}`)
                          : Array.from({ length: 5 }, (_, i) => `${i}${'😀'.repeat(125)}`);
                texts.forEach((text, index) => {
                    insert.run(`conflict-${index}`, index % 2 === 0 ? later.id : laterChild.id, text, now);
                });
                const state = () =>
                    Object.fromEntries(
                        ['projects', 'sessions', 'memories', 'session_rollups', 'open_turns', 'standing_rules'].map((table) => [
                            table,
                            store.database.prepare(`SELECT * FROM ${table}`).all(),
                        ]),
                    );
                const before = state();
                expect(() =>
                    store.rekeyProjectsByIdentity(
                        fakeResolver({
                            '/earlier': '/earlier',
                            '/earlier/child': '/earlier',
                            '/later': '/later',
                            '/later/child': '/later',
                        }),
                    ),
                ).toThrow(/Rekey refused:.*standing rule.*project ids.*conflict-0/);
                expect(state()).toEqual(before);
                expect(store.getProjectById(root.id)).toBeDefined();
                expect(store.database.pragma('foreign_key_check')).toEqual([]);
            },
        );

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

        it('merges a renamed checkout into the live row sharing its remote and moves every project foreign key', () => {
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

            const plans = store.rekeyProjectsByIdentity(
                fakeResolver({ '/work/old-name': '/work/current-name', '/work/current-name': '/work/current-name' }),
            );

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

        it('merges a transferred repository by live git root and moves every project foreign key', () => {
            const now = '2026-09-08T00:00:00.000Z';
            const insertProject = store.database.prepare(
                `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            );
            const canonical = Number(
                insertProject.run(
                    '/work/current-name',
                    'current-name',
                    '/work/current-name',
                    'git@example.test:new-owner/repo.git',
                    'root-commit',
                    now,
                    now,
                ).lastInsertRowid,
            );
            const transferred = Number(
                insertProject.run(
                    '/work/current-name/packages/app',
                    'app',
                    '/work/current-name',
                    'git@example.test:old-owner/repo.git',
                    'root-commit',
                    now,
                    now,
                ).lastInsertRowid,
            );
            const transferredSession = store.upsertSession('codex', 'transferred-session', transferred, '/tmp/transferred.jsonl');
            store.recordTurn(makeTurn({ tool: 'codex', sessionId: 'transferred-session' }), transferredSession.id, transferred, {
                decisions: [],
                pending_items: [],
                status: 'ok',
            });
            store.database
                .prepare(
                    `INSERT INTO session_rollups
                     (session_id, project_id, tool, title, summary, decisions, pending_items, files_touched, turn_count, started_at, ended_at, kind, parent_session_id, summarizer_status, rollup_state, rolled_up_through_turn_index, computed_at, rollup_version)
                     VALUES (?, ?, 'codex', 'transferred', '', '[]', '[]', '[]', 0, ?, ?, 'primary', NULL, 'ok', 'final', -1, ?, 1)`,
                )
                .run(transferredSession.id, transferred, now, now, now);
            const resolver = fakeResolver({
                '/work/current-name': '/work/current-name',
                '/work/current-name/packages/app': '/work/current-name',
            });

            expect(store.planRekeyProjectsByIdentity(resolver)).toEqual([
                expect.objectContaining({
                    canonical: expect.objectContaining({ id: canonical }),
                    gitRoot: '/work/current-name',
                    merged: [expect.objectContaining({ id: transferred })],
                }),
            ]);

            const plans = store.rekeyProjectsByIdentity(resolver);

            expect(plans).toEqual([
                expect.objectContaining({
                    canonical: expect.objectContaining({ id: canonical }),
                    gitRoot: '/work/current-name',
                    merged: [expect.objectContaining({ id: transferred })],
                }),
            ]);
            expect(store.listProjects()).toEqual([expect.objectContaining({ id: canonical, path: '/work/current-name' })]);
            expect(store.database.prepare('SELECT project_id FROM memories').all()).toEqual([{ project_id: canonical }]);
            expect(store.database.prepare('SELECT project_id FROM sessions').all()).toEqual([{ project_id: canonical }]);
            expect(store.database.prepare('SELECT project_id FROM session_rollups').all()).toEqual([{ project_id: canonical }]);
        });

        it('does not merge forks that share a root commit but resolve to different git roots', () => {
            const now = '2026-09-08T00:00:00.000Z';
            const insertProject = store.database.prepare(
                `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                 VALUES (?, ?, ?, NULL, ?, ?, ?)`,
            );
            insertProject.run('/work/fork-one', 'fork-one', '/work/fork-one', 'shared-root-commit', now, now);
            insertProject.run('/work/fork-two', 'fork-two', '/work/fork-two', 'shared-root-commit', now, now);

            expect(
                store.planRekeyProjectsByIdentity(fakeResolver({ '/work/fork-one': '/work/fork-one', '/work/fork-two': '/work/fork-two' })),
            ).toEqual([]);
            expect(store.listProjects()).toHaveLength(2);
        });

        it('groups unresolvable rows by their stored identity', () => {
            const now = '2026-09-08T00:00:00.000Z';
            const insertProject = store.database.prepare(
                `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            );
            const canonical = Number(
                insertProject.run('/gone/repo', 'repo', '/stale/repo', 'git@example.test:team/repo.git', 'commit-one', now, now)
                    .lastInsertRowid,
            );
            const victim = Number(
                insertProject.run('/gone/repo/nested', 'nested', '/stale/repo', 'git@example.test:team/repo.git', 'commit-two', now, now)
                    .lastInsertRowid,
            );

            expect(store.planRekeyProjectsByIdentity(fakeResolver({}))).toEqual([
                expect.objectContaining({
                    canonical: expect.objectContaining({ id: canonical }),
                    gitRoot: null,
                    merged: [expect.objectContaining({ id: victim })],
                }),
            ]);
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

            store.consent.grant('/Users/test/demo-project');
            expect(
                store.reingestTurn(turn, session.id, project.id, {
                    decisions: [{ what: 'recovered', why: null }],
                    pending_items: [],
                    status: 'ok',
                }),
            ).toBe(true);

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
            store.consent.grant('/Users/test/demo-project');
            expect(
                store.reingestTurn(makeTurn({ cursor: '999|9' }), session.id, project.id, {
                    decisions: [{ what: 'x', why: null }],
                    pending_items: [],
                    status: 'ok',
                }),
            ).toBe(true);

            expect(store.getSessionCursor('claude-code', 'sess-1')).toBe(cursorAfterRecord);
        });
    });
});

describe('session metadata capture', () => {
    it('upsertSession writes surface/gitBranch/kind/customTitle on first creation, while only customTitle is refreshable', () => {
        const db = openUnmanagedDb(':memory:');
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

    it('sanitizes transcript-derived custom titles inside the session store', () => {
        const db = openUnmanagedDb(':memory:');
        const store = new MemoryStore(db);
        const project = store.upsertProject('/tmp/proj');
        const initialTitle = '`whoami` $(touch nope)';
        const updatedTitle = '$' + '{HOME}; still inert';

        const created = store.upsertSession('claude-code', 'native-title', project.id, '/tmp/title.jsonl', {
            customTitle: initialTitle,
        });
        expect(created.custom_title).toBe(stripShellSyntax(initialTitle));

        const updated = store.upsertSession('claude-code', 'native-title', project.id, '/tmp/title.jsonl', {
            customTitle: updatedTitle,
        });
        expect(updated.custom_title).toBe(stripShellSyntax(updatedTitle));
        db.close();
    });
});

describe('trailing state', () => {
    it('recordTurn updates trailing_branch and trailing_files, capped and deduped, on every turn close', () => {
        const db = openUnmanagedDb(':memory:');
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
        const db = openUnmanagedDb(':memory:');
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
        const db = openUnmanagedDb(':memory:');
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
