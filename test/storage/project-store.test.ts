import type { Database } from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';

const projectPath = '/Users/test/scaffolded-project';
const gitRemote = 'git@example.test:team/scaffolded-project.git';
const gitRootCommit = '1111111111111111111111111111111111111111';
const summary = { decisions: [], pending_items: [], status: 'not_configured' as const };

function storeWithGitRoot(db: Database, gitRoot: string): MemoryStore {
    return new MemoryStore(db, {
        resolveGitRoot: () => gitRoot,
        resolveGitRemote: () => gitRemote,
        resolveGitRootCommit: () => gitRootCommit,
    });
}

function turn(): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'session-after-git-init',
        sourcePath: '/tmp/session-after-git-init.jsonl',
        projectPath,
        turnIndex: 0,
        startedAt: '2026-08-28T00:00:00.000Z',
        endedAt: '2026-08-28T00:00:01.000Z',
        userMessage: 'capture after git init',
        assistantText: 'captured',
        toolCalls: [],
        cursor: '100|1',
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

describe('ProjectStore git identity adoption', () => {
    it.each(['ingested', 'dropped'] as const)('never invokes git resolution while the %s write transaction is open', (turnKind) => {
        const db = openDb(':memory:');
        const assertOutsideWriteTransaction = () => {
            if (db.inTransaction) {
                throw new Error('git resolution ran inside the write transaction');
            }
        };
        const guardedStore = new MemoryStore(db, {
            resolveGitRoot: () => {
                assertOutsideWriteTransaction();
                return projectPath;
            },
            resolveGitRemote: () => {
                assertOutsideWriteTransaction();
                return gitRemote;
            },
            resolveGitRootCommit: () => {
                assertOutsideWriteTransaction();
                return gitRootCommit;
            },
            resolveGitCommitCount: () => {
                assertOutsideWriteTransaction();
                return 47;
            },
        });
        guardedStore.consent.grant(projectPath);

        expect(() => {
            if (turnKind === 'ingested') {
                guardedStore.recordIngestedTurn(turn(), {}, false, summary);
            } else {
                guardedStore.recordDroppedTurn(turn(), {});
            }
        }).not.toThrow();
    });

    it('performs zero git probes for a subsequent turn in an already-known project and session', () => {
        const db = openDb(':memory:');
        const resolveGitRoot = vi.fn(() => projectPath);
        const resolveGitRemote = vi.fn(() => gitRemote);
        const resolveGitRootCommit = vi.fn(() => gitRootCommit);
        const resolveGitCommitCount = vi.fn(() => 47);
        const knownStore = new MemoryStore(db, {
            resolveGitRoot,
            resolveGitRemote,
            resolveGitRootCommit,
            resolveGitCommitCount,
        });
        knownStore.consent.grant(projectPath);
        knownStore.recordIngestedTurn(turn(), {}, false, summary);
        resolveGitRoot.mockClear();
        resolveGitRemote.mockClear();
        resolveGitRootCommit.mockClear();
        resolveGitCommitCount.mockClear();

        const inserted = knownStore.recordIngestedTurn({ ...turn(), turnIndex: 1, cursor: '200|2' }, {}, false, summary);

        expect(inserted).toEqual(expect.objectContaining({ inserted: true }));
        expect(resolveGitRoot).not.toHaveBeenCalled();
        expect(resolveGitRemote).not.toHaveBeenCalled();
        expect(resolveGitRootCommit).not.toHaveBeenCalled();
        expect(resolveGitCommitCount).not.toHaveBeenCalled();
    });

    it('resolves a new project once and reuses its identity for the session commit baseline', () => {
        const db = openDb(':memory:');
        const checkoutPath = '/repo/packages/app';
        const repositoryRoot = '/repo';
        const resolveGitRoot = vi.fn(() => repositoryRoot);
        const resolveGitRemote = vi.fn(() => gitRemote);
        const resolveGitRootCommit = vi.fn(() => gitRootCommit);
        const resolveGitCommitCount = vi.fn(() => 47);
        const newProjectStore = new MemoryStore(db, {
            resolveGitRoot,
            resolveGitRemote,
            resolveGitRootCommit,
            resolveGitCommitCount,
        });
        newProjectStore.consent.grant(checkoutPath);

        const result = newProjectStore.recordIngestedTurn({ ...turn(), projectPath: checkoutPath }, {}, false, summary);

        expect(resolveGitRoot).toHaveBeenCalledTimes(1);
        expect(resolveGitRoot).toHaveBeenCalledWith(checkoutPath);
        expect(resolveGitRemote).toHaveBeenCalledTimes(1);
        expect(resolveGitRemote).toHaveBeenCalledWith(repositoryRoot);
        expect(resolveGitRootCommit).toHaveBeenCalledTimes(1);
        expect(resolveGitRootCommit).toHaveBeenCalledWith(repositoryRoot);
        expect(resolveGitCommitCount).toHaveBeenCalledTimes(1);
        expect(resolveGitCommitCount).toHaveBeenCalledWith(repositoryRoot);
        expect(result?.project).toEqual(
            expect.objectContaining({
                path: repositoryRoot,
                git_root: repositoryRoot,
                git_remote: gitRemote,
                git_root_commit: gitRootCommit,
            }),
        );
        expect(result?.session.git_commit_count).toBe(47);
    });

    it('adopts git identity onto an existing rootless row at the same path without throwing or adding a row', () => {
        const db = openDb(':memory:');
        const rootlessStore = new MemoryStore(db, { resolveGitRoot: () => null });
        const rootless = rootlessStore.upsertProject(projectPath);
        db.prepare('UPDATE projects SET display_name = ? WHERE id = ?').run('kept-display-name', rootless.id);

        const adopted = storeWithGitRoot(db, projectPath).upsertProject(projectPath);

        expect(adopted).toEqual(
            expect.objectContaining({
                id: rootless.id,
                path: projectPath,
                display_name: 'kept-display-name',
                git_root: projectPath,
                git_remote: gitRemote,
                git_root_commit: gitRootCommit,
            }),
        );
        expect(db.prepare('SELECT COUNT(*) AS count FROM projects WHERE path = ?').get(projectPath)).toEqual({ count: 1 });
    });

    it('completes ingestion and advances the cursor for a previously stuck rootless row', () => {
        const db = openDb(':memory:');
        new MemoryStore(db, { resolveGitRoot: () => null }).upsertProject(projectPath);
        const recoveredStore = storeWithGitRoot(db, projectPath);
        recoveredStore.consent.grant(projectPath);

        const result = recoveredStore.recordIngestedTurn(turn(), {}, false, { decisions: [], pending_items: [], status: 'not_configured' });

        expect(result).toEqual(expect.objectContaining({ inserted: true }));
        expect(recoveredStore.getSessionCursor('codex', 'session-after-git-init')).toBe('100|1');
        expect(db.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
    });

    it('is idempotent after adoption and refreshes last_seen_at without changing identity', () => {
        const db = openDb(':memory:');
        const rootless = new MemoryStore(db, { resolveGitRoot: () => null }).upsertProject(projectPath);
        const gitStore = storeWithGitRoot(db, projectPath);
        const adopted = gitStore.upsertProject(projectPath);
        db.prepare('UPDATE projects SET last_seen_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', adopted.id);

        const repeated = gitStore.upsertProject(projectPath);

        expect(repeated).toEqual(
            expect.objectContaining({
                id: rootless.id,
                path: projectPath,
                git_root: projectPath,
                git_remote: gitRemote,
                git_root_commit: gitRootCommit,
            }),
        );
        expect(repeated.last_seen_at).not.toBe('2020-01-01T00:00:00.000Z');
        expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 1 });
    });

    it('keeps a rootless cwd row separate when git resolves to a parent directory', () => {
        const db = openDb(':memory:');
        const childPath = '/repo/packages/app';
        const rootless = new MemoryStore(db, { resolveGitRoot: () => null }).upsertProject(childPath);

        const parent = storeWithGitRoot(db, '/repo').upsertProject(childPath);

        expect(parent.id).not.toBe(rootless.id);
        expect(parent).toEqual(expect.objectContaining({ path: '/repo', git_root: '/repo' }));
        expect(db.prepare('SELECT path, git_root FROM projects ORDER BY path').all()).toEqual([
            { path: '/repo', git_root: '/repo' },
            { path: childPath, git_root: null },
        ]);
    });
});
