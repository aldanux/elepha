import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeForCompare } from '../../src/config/paths.js';
import { lexicalRecall, tokenizeRecallQuery } from '../../src/serving/lexical-recall.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { ConsentStore } from '../../src/storage/consent-store.js';
import { openDb } from '../../src/storage/db.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

type Db = ReturnType<typeof openDb>;

describe('ProjectResolver', () => {
    let db: Db;
    let root: string;
    let roots: Map<string, string | null>;

    beforeEach(() => {
        db = openDb(':memory:');
        root = withGrantableTestDir('elepha-project-resolver-');
        roots = new Map();
    });

    function addProject(
        projectPath: string,
        options: {
            displayName?: string;
            gitRoot?: string | null;
            remote?: string | null;
            rootCommit?: string | null;
            createDirectory?: boolean;
        } = {},
    ): number {
        if (options.createDirectory !== false) {
            mkdirSync(projectPath, { recursive: true });
        }
        const row = db
            .prepare(
                `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                 VALUES (?, ?, ?, ?, ?, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
            )
            .run(
                projectPath,
                options.displayName ?? path.basename(projectPath),
                options.gitRoot ?? null,
                options.remote ?? null,
                options.rootCommit ?? null,
            );
        const id = Number(row.lastInsertRowid);
        db.prepare(
            `INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at, title, first_prompt_search)
             VALUES ('claude-code', ?, ?, ?, '2026-08-16T00:00:00.000Z', '2026-08-16T01:00:00.000Z', ?, 'stored identity needle')`,
        ).run(`session-${id}`, id, path.join(projectPath, 'session.jsonl'), `Stored session ${id}`);
        return id;
    }

    function markRoot(projectPath: string, gitRoot: string | null): void {
        roots.set(normalizeForCompare(projectPath), gitRoot);
    }

    function resolver(): ProjectResolver {
        return new ProjectResolver(db, { resolveGitRoot: (projectPath) => roots.get(normalizeForCompare(projectPath)) ?? null });
    }

    it('collapses nine rootless elepha-ext rows by their stored ancestor path and preserves every original path', () => {
        const ext = path.join(root, 'elepha-ext');
        const paths = [
            ext,
            path.join(ext, 'extension'),
            path.join(ext, 'extension/src'),
            path.join(ext, 'extension/src/popup'),
            path.join(ext, 'extension/src/popup/i18n'),
            path.join(ext, 'extension/src/popup/i18n/en'),
            path.join(ext, 'extension/src/popup/composables'),
            path.join(ext, 'extension/src/popup/pages/data/_c'),
            path.join(ext, 'extension/dist'),
        ];
        paths.forEach((projectPath) => {
            addProject(projectPath);
        });

        const set = resolver().resolve(ext);
        expect(set).toEqual(expect.objectContaining({ project: expect.anything() }));
        const project = (set as { project: { paths: string[]; projectIds: number[] } }).project;
        expect(project.paths).toHaveLength(9);
        expect(new Set(project.paths)).toEqual(new Set(paths));
        expect(project.projectIds).toHaveLength(9);
    });

    it('prefix-groups missing paths without probing them for a git root', () => {
        const ext = path.join(root, 'missing-elepha-ext');
        const paths = [ext, path.join(ext, 'extension'), path.join(ext, 'extension/src'), path.join(ext, 'extension/src/popup')];
        const gitRootCalls: string[] = [];
        paths.forEach((projectPath, index) => {
            // `root` exists, but this child is deliberately never created.
            // A true existsSync branch would call the injected resolver and
            // split the rows by these deliberately different fake roots.
            expect(existsSync(projectPath)).toBe(false);
            addProject(projectPath, { createDirectory: false });
            markRoot(projectPath, path.join(root, `unexpected-git-root-${index}`));
        });

        const result = new ProjectResolver(db, {
            resolveGitRoot: (projectPath) => {
                gitRootCalls.push(projectPath);
                return roots.get(normalizeForCompare(projectPath)) ?? null;
            },
        }).resolve(ext);

        expect(gitRootCalls).toEqual([]);
        expect(result).toEqual(expect.objectContaining({ project: expect.objectContaining({ paths }) }));
    });

    it('never prefix-groups a row with a resolvable git root, and never puts different roots in one set', () => {
        const repoA = path.join(root, 'repo-a');
        const repoAChild = path.join(repoA, 'packages/app');
        const repoB = path.join(root, 'repo-b');
        const rootless = path.join(root, 'repo-a-archive');
        [repoA, repoAChild, repoB, rootless].forEach((projectPath) => {
            addProject(projectPath);
        });
        markRoot(repoA, repoA);
        markRoot(repoAChild, repoA);
        markRoot(repoB, repoB);
        const consent = new ConsentStore(db);
        consent.grant(root);

        const sets = resolver().list(consent);
        expect(sets).toHaveLength(3);
        expect(sets.find((set) => set.gitRoot === repoA)?.paths).toEqual([repoA, repoAChild]);
        for (const set of sets) {
            const memberRoots = set.paths
                .map((projectPath) => roots.get(normalizeForCompare(projectPath)) ?? null)
                .filter((gitRoot): gitRoot is string => gitRoot !== null);
            expect(new Set(memberRoots.map(normalizeForCompare)).size).toBeLessThanOrEqual(1);
        }
    });

    it('groups renamed rows by their captured remote despite different live git roots', () => {
        const oldPath = path.join(root, 'old-checkout');
        const newPath = path.join(root, 'new-checkout');
        const remote = 'git@example.test:grouped/rename.git';
        addProject(oldPath, { remote });
        addProject(newPath, { remote });
        markRoot(oldPath, path.join(root, 'old-root'));
        markRoot(newPath, path.join(root, 'new-root'));

        const sets = resolver().list();
        expect(sets).toHaveLength(1);
        expect(sets[0]).toEqual(expect.objectContaining({ key: remote }));
        expect(new Set(sets[0]?.paths)).toEqual(new Set([oldPath, newPath]));
    });

    it('groups no-remote rows by their captured root commit', () => {
        const oldPath = path.join(root, 'old-checkout');
        const newPath = path.join(root, 'new-checkout');
        const rootCommit = '1111111111111111111111111111111111111111';
        addProject(oldPath, { rootCommit });
        addProject(newPath, { rootCommit });
        markRoot(oldPath, path.join(root, 'old-root'));
        markRoot(newPath, path.join(root, 'new-root'));

        const sets = resolver().list();
        expect(sets).toHaveLength(1);
        expect(sets[0]).toEqual(expect.objectContaining({ key: rootCommit, gitRemote: null }));
        expect(new Set(sets[0]?.paths)).toEqual(new Set([oldPath, newPath]));
    });

    it('enumerates consented stored identities without resolving Git and serves the same sessions', async () => {
        const remoteRoot = path.join(root, 'remote-root');
        const remoteOld = path.join(root, 'remote-old');
        const rootCommitRoot = path.join(root, 'root-commit-root');
        const rootCommitOld = path.join(root, 'root-commit-old');
        const remote = 'git@example.test:grouped/stored.git';
        const rootCommit = '2222222222222222222222222222222222222222';
        addProject(remoteRoot, { gitRoot: remoteRoot, remote });
        addProject(remoteOld, { gitRoot: remoteOld, remote });
        addProject(rootCommitRoot, { gitRoot: rootCommitRoot, rootCommit });
        addProject(rootCommitOld, { gitRoot: rootCommitOld, rootCommit });
        markRoot(remoteRoot, remoteRoot);
        markRoot(remoteOld, remoteOld);
        markRoot(rootCommitRoot, rootCommitRoot);
        markRoot(rootCommitOld, rootCommitOld);
        const consent = new ConsentStore(db);
        consent.grant(remoteRoot);
        consent.grant(rootCommitRoot);

        const live = resolver().listConsented(consent);
        const resolveGitRoot = vi.fn(() => {
            throw new Error('stored enumeration must not resolve Git');
        });
        const stored = new ProjectResolver(db, { resolveGitRoot }).listConsentedStored(consent);

        expect(resolveGitRoot).not.toHaveBeenCalled();
        expect(stored).toEqual(live);
        const reader = new SessionReader(db);
        expect(reader.recentConsentedSessions(stored).map((session) => session.id)).toEqual(
            reader.recentConsentedSessions(live).map((session) => session.id),
        );
        const query = tokenizeRecallQuery('stored identity needle');
        expect(query).toBeDefined();
        if (!query) return;
        const storedRecall = await lexicalRecall(reader, stored, query, 'global', undefined, undefined, 'strict');
        const liveRecall = await lexicalRecall(reader, live, query, 'global', undefined, undefined, 'strict');
        expect(storedRecall.sessionIds).toEqual(liveRecall.sessionIds);
    });

    it('uses stored identity when consent is unknown and resolves Git only for consented paths', () => {
        const approvedRoot = path.join(root, 'approved');
        const approvedProject = path.join(approvedRoot, 'project');
        const unconsentedProject = path.join(root, 'unconsented');
        addProject(approvedProject, { gitRoot: path.join(root, 'stale-approved-root') });
        addProject(unconsentedProject, { gitRoot: path.join(root, 'stale-unconsented-root') });
        markRoot(approvedProject, approvedRoot);
        markRoot(unconsentedProject, unconsentedProject);
        const consent = new ConsentStore(db);
        consent.grant(approvedRoot);
        const resolveGitRoot = vi.fn((projectPath: string) => roots.get(normalizeForCompare(projectPath)) ?? null);

        const unknownConsent = new ProjectResolver(db, { resolveGitRoot }).list();
        expect(resolveGitRoot).not.toHaveBeenCalled();
        expect(unknownConsent).toHaveLength(2);

        const consented = new ProjectResolver(db, { resolveGitRoot }).listConsented(consent);
        expect(resolveGitRoot).toHaveBeenCalledTimes(1);
        expect(resolveGitRoot).toHaveBeenCalledWith(approvedProject);
        expect(resolveGitRoot).not.toHaveBeenCalledWith(unconsentedProject);
        expect(consented).toEqual([
            expect.objectContaining({
                gitRoot: approvedRoot,
                paths: [approvedProject],
            }),
        ]);
    });

    it('keeps rows with different captured remotes separate even when their live root matches', () => {
        const firstPath = path.join(root, 'first-checkout');
        const secondPath = path.join(root, 'second-checkout');
        addProject(firstPath, { remote: 'git@example.test:grouped/first.git' });
        addProject(secondPath, { remote: 'git@example.test:grouped/second.git' });
        markRoot(firstPath, root);
        markRoot(secondPath, root);

        expect(resolver().list()).toHaveLength(2);
    });

    it('keeps a moved set consented for an approved path unless any member path is denied', () => {
        const oldPath = path.join(root, 'old-checkout');
        const newPath = path.join(root, 'new-checkout');
        const remote = 'git@example.test:grouped/consent.git';
        addProject(oldPath, { remote });
        addProject(newPath, { remote });
        markRoot(oldPath, path.join(root, 'old-root'));
        markRoot(newPath, path.join(root, 'new-root'));
        const consent = new ConsentStore(db);
        consent.grant(oldPath);

        const approved = resolver().resolveConsented(remote, consent);
        expect(approved).toEqual(expect.objectContaining({ project: expect.anything() }));
        expect(new Set((approved as { project: { paths: string[] } }).project.paths)).toEqual(new Set([oldPath, newPath]));

        consent.revoke(newPath);
        expect(resolver().resolveConsented(remote, consent)).toEqual({ project: null });
    });

    it('checks consent before probing an existing query path for its Git root', () => {
        const approvedRoot = path.join(root, 'approved');
        const approvedProject = path.join(approvedRoot, 'project');
        const unapprovedProject = path.join(root, 'unapproved');
        addProject(approvedProject, { displayName: 'Stored Identity' });
        mkdirSync(unapprovedProject);
        markRoot(approvedProject, approvedProject);
        const resolveGitRoot = vi.fn((projectPath: string) => roots.get(normalizeForCompare(projectPath)) ?? null);
        const guardedResolver = new ProjectResolver(db, { resolveGitRoot });
        const consent = new ConsentStore(db);
        consent.grant(approvedRoot);

        expect(guardedResolver.resolveConsented(unapprovedProject, consent)).toEqual({ project: null });
        expect(resolveGitRoot).not.toHaveBeenCalledWith(unapprovedProject);

        expect(guardedResolver.resolveConsented(approvedProject, consent)).toEqual(
            expect.objectContaining({ project: expect.objectContaining({ paths: [approvedProject] }) }),
        );
        expect(resolveGitRoot).toHaveBeenCalledWith(approvedProject);

        resolveGitRoot.mockClear();
        expect(guardedResolver.resolveConsented('Stored Identity', consent)).toEqual(
            expect.objectContaining({ project: expect.objectContaining({ paths: [approvedProject] }) }),
        );
        expect(resolveGitRoot).not.toHaveBeenCalledWith('Stored Identity');
    });

    it('matches a member path using host case semantics while preserving the stored path casing in the set', () => {
        const projectPath = path.join(root, 'MixedCaseProject');
        addProject(projectPath);

        const result = resolver().resolve(projectPath.toUpperCase());
        if (process.platform === 'darwin' || process.platform === 'win32') {
            expect(result).toEqual(expect.objectContaining({ project: expect.objectContaining({ paths: [projectPath] }) }));
        } else {
            expect(result).toEqual({ project: null });
        }
    });

    it('resolves a live checkout from its exact path or git root without probing every stored project', () => {
        const checkout = path.join(root, 'restored-checkout');
        const packagePath = path.join(checkout, 'packages', 'app');
        addProject(checkout);
        addProject(packagePath);
        db.prepare('UPDATE projects SET git_root = ? WHERE path = ?').run(path.join(root, 'stale-capture-root'), checkout);
        markRoot(checkout, checkout);
        markRoot(packagePath, checkout);

        for (let index = 0; index < 200; index += 1) {
            const unrelated = path.join(root, `unrelated-${index}`);
            addProject(unrelated);
            markRoot(unrelated, unrelated);
        }

        const gitRootCalls: string[] = [];
        const boundedResolver = new ProjectResolver(db, {
            resolveGitRoot: (projectPath) => {
                gitRootCalls.push(projectPath);
                return roots.get(normalizeForCompare(projectPath)) ?? null;
            },
        });

        const exact = boundedResolver.resolve(packagePath);
        expect(exact).toEqual(
            expect.objectContaining({
                project: expect.objectContaining({ gitRoot: checkout, paths: [checkout, packagePath] }),
            }),
        );
        expect(gitRootCalls).toHaveLength(2);

        gitRootCalls.length = 0;
        const byGitRoot = boundedResolver.resolve(checkout);
        expect(byGitRoot).toEqual(exact);
        expect(gitRootCalls).toHaveLength(2);
    });

    it('resolve() groups a row stored under a symlinked path with its physical checkout exactly as list() does', () => {
        const checkout = path.join(root, 'physical-checkout');
        const link = path.join(root, 'linked-checkout');
        addProject(checkout);
        symlinkSync(checkout, link);
        addProject(link);
        // `git rev-parse --show-toplevel` through the symlink returns the physical toplevel.
        markRoot(checkout, checkout);
        markRoot(link, checkout);
        const consent = new ConsentStore(db);
        consent.grant(root);

        const listed = resolver().list(consent);
        expect(listed).toHaveLength(1);
        expect(new Set(listed[0]?.paths)).toEqual(new Set([checkout, link]));

        expect(resolver().resolve(checkout)).toEqual({ project: listed[0] });
        expect(resolver().resolve(link)).toEqual({ project: listed[0] });
    });

    it('memoizes consented full enumeration for one resolver instance', () => {
        const projectA = path.join(root, 'project-a');
        const projectB = path.join(root, 'project-b');
        addProject(projectA);
        addProject(projectB);
        markRoot(projectA, projectA);
        markRoot(projectB, projectB);
        const consent = new ConsentStore(db);
        consent.grant(root);
        const gitRootCalls: string[] = [];
        const cachedResolver = new ProjectResolver(db, {
            resolveGitRoot: (projectPath) => {
                gitRootCalls.push(projectPath);
                return roots.get(normalizeForCompare(projectPath)) ?? null;
            },
        });

        expect(cachedResolver.list(consent)).toHaveLength(2);
        expect(cachedResolver.list(consent)).toHaveLength(2);
        expect(gitRootCalls).toEqual([projectA, projectB]);
    });

    const ambiguousCases: Array<{
        name: string;
        query: string;
        rows: Array<{ path: string; displayName: string; remote?: string }>;
    }> = [
        {
            name: 'case-insensitive display-name equality',
            query: 'shared name',
            rows: [
                { path: 'display-a', displayName: 'Shared Name' },
                { path: 'display-b', displayName: 'shared name' },
            ],
        },
        {
            name: 'path substring',
            query: 'client',
            rows: [
                { path: 'client-alpha', displayName: 'Alpha' },
                { path: 'client-beta', displayName: 'Beta' },
            ],
        },
        {
            name: 'display-name substring',
            query: 'research',
            rows: [
                { path: 'notes-a', displayName: 'Research Notes' },
                { path: 'notes-b', displayName: 'Research Tasks' },
            ],
        },
    ];

    it.each(ambiguousCases)('returns candidates instead of choosing on ambiguous $name', ({ query, rows }) => {
        rows.forEach((row) => {
            addProject(path.join(root, row.path), { displayName: row.displayName, remote: row.remote });
        });

        const result = resolver().resolve(query);
        expect(result).toEqual(
            expect.objectContaining({
                ambiguous: true,
                candidates: expect.arrayContaining(rows.map((row) => expect.objectContaining({ name: row.displayName, sessions: 1 }))),
            }),
        );
        expect((result as { candidates: unknown[] }).candidates).toHaveLength(2);
    });
});
