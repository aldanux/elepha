import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { applyRootCommitBackfill, planRootCommitBackfill } from '../../src/storage/root-commit-backfill.js';

describe('root-commit backfill', () => {
    it('fills resolvable NULL rows, preserves populated rows, reports unresolvable rows, and is idempotent', () => {
        const db = openDb(':memory:');
        const now = '2026-08-22T00:00:00.000Z';
        const insert = db.prepare(
            `INSERT INTO projects (path, display_name, git_root, git_root_commit, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const resolvable = Number(insert.run('/work/app', 'app', null, null, now, now).lastInsertRowid);
        const storedRoot = Number(insert.run('/work/library', 'library', '/repos/library', null, now, now).lastInsertRowid);
        const alreadyPopulated = Number(insert.run('/work/current', 'current', '/repos/current', 'already-set', now, now).lastInsertRowid);
        const unresolvable = Number(insert.run('/work/gone', 'gone', null, null, now, now).lastInsertRowid);
        const resolveGitRoot = (projectPath: string): string | null =>
            projectPath === '/work/app' ? '/repos/app' : projectPath === '/work/gone' ? null : '/unexpected';
        const resolveGitRootCommit = (gitRoot: string): string | null =>
            gitRoot === '/repos/app' ? 'app-root' : gitRoot === '/repos/library' ? 'library-root' : null;

        const preview = planRootCommitBackfill(db, resolveGitRoot, resolveGitRootCommit);

        expect(preview.changes).toEqual([
            { projectId: resolvable, path: '/work/app', gitRootCommit: 'app-root' },
            { projectId: storedRoot, path: '/work/library', gitRootCommit: 'library-root' },
        ]);
        expect(preview.projectsScanned).toBe(3);
        expect(preview.projectsUnresolvable).toBe(1);
        expect(db.prepare('SELECT git_root_commit FROM projects WHERE id = ?').get(resolvable)).toEqual({ git_root_commit: null });

        const applied = applyRootCommitBackfill(db, resolveGitRoot, resolveGitRootCommit);

        expect(applied.projectsSkippedConcurrent).toBe(0);
        expect(db.prepare('SELECT id, git_root_commit FROM projects ORDER BY id').all()).toEqual([
            { id: resolvable, git_root_commit: 'app-root' },
            { id: storedRoot, git_root_commit: 'library-root' },
            { id: alreadyPopulated, git_root_commit: 'already-set' },
            { id: unresolvable, git_root_commit: null },
        ]);

        const second = applyRootCommitBackfill(db, resolveGitRoot, resolveGitRootCommit);
        expect(second.changes).toHaveLength(0);
        expect(second.projectsUnresolvable).toBe(1);
        db.close();
    });
});
