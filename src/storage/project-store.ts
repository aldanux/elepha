import path from 'node:path';
import type { Database, Statement } from 'better-sqlite3';
import { gitRemoteGetUrlOrigin, gitRevParseShowToplevel, gitRootCommit } from '../security/subprocess-allowlist.js';

export interface ProjectRow {
    id: number;
    path: string;
    display_name: string | null;
    git_root: string | null;
    git_remote: string | null;
    git_root_commit: string | null;
    first_seen_at: string;
    last_seen_at: string;
}

export interface ProjectStoreOptions {
    resolveGitRoot?: (projectPath: string) => string | null;
    resolveGitRemote?: (gitRoot: string) => string | null;
    resolveGitRootCommit?: (gitRoot: string) => string | null;
}

export interface ResolvedProjectIdentity {
    gitRoot: string | null;
    gitRemote: string | null;
    gitRootCommit: string | null;
}

export class ProjectStore {
    private readonly resolveGitRoot: (projectPath: string) => string | null;
    private readonly resolveGitRemote: (gitRoot: string) => string | null;
    private readonly resolveGitRootCommit: (gitRoot: string) => string | null;
    /** Git discovery is per-cwd input, so null results must be cached as well. */
    private readonly gitRootsByCwd = new Map<string, string | null>();
    private readonly stmts: {
        findProjectByPath: Statement;
        findProjectByGitRoot: Statement;
        insertProject: Statement;
        touchProject: Statement;
    };

    constructor(
        private readonly db: Database,
        options: ProjectStoreOptions = {},
    ) {
        this.resolveGitRoot = options.resolveGitRoot ?? gitRevParseShowToplevel;
        this.resolveGitRemote = options.resolveGitRemote ?? gitRemoteGetUrlOrigin;
        this.resolveGitRootCommit = options.resolveGitRootCommit ?? gitRootCommit;
        this.stmts = {
            findProjectByPath: db.prepare('SELECT * FROM projects WHERE path = ?'),
            findProjectByGitRoot: db.prepare('SELECT * FROM projects WHERE git_root = ? ORDER BY id LIMIT 1'),
            insertProject: db.prepare(
                `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
         VALUES (@path, @display_name, @git_root, @git_remote, @git_root_commit, @now, @now)
         ON CONFLICT(path) DO UPDATE SET
             git_root = excluded.git_root,
             git_remote = excluded.git_remote,
             git_root_commit = excluded.git_root_commit,
             last_seen_at = excluded.last_seen_at
         RETURNING id`,
            ),
            touchProject: db.prepare('UPDATE projects SET last_seen_at = ? WHERE id = ?'),
        };
    }

    /**
     * Finds or creates the project row for a captured cwd. Git-backed projects
     * are keyed by their repository root; rootless directories retain the
     * historical cwd key. Resolution is cached for this store lifetime so the
     * daemon does not execute git for every turn from the same cwd.
     */
    upsertProject(projectPath: string, identity = this.resolveProjectIdentity(projectPath)): ProjectRow {
        const existing = identity.gitRoot
            ? ((this.stmts.findProjectByGitRoot.get(identity.gitRoot) as ProjectRow | undefined) ?? undefined)
            : (this.stmts.findProjectByPath.get(projectPath) as ProjectRow | undefined);
        const now = new Date().toISOString();
        if (existing) {
            this.stmts.touchProject.run(now, existing.id);
            return { ...existing, last_seen_at: now };
        }
        const projectKey = identity.gitRoot ?? projectPath;
        const inserted = this.stmts.insertProject.get({
            path: projectKey,
            display_name: path.basename(projectKey),
            git_root: identity.gitRoot,
            git_remote: identity.gitRemote,
            git_root_commit: identity.gitRootCommit,
            now,
        }) as { id: number };
        // biome-ignore lint/style/noNonNullAssertion: row was just inserted or updated above, lookup by its returned id can't miss
        return this.getProjectById(inserted.id)!;
    }

    /**
     * Resolves the values needed by upsertProject before its caller opens a
     * write transaction. Stored identities and the per-cwd cache avoid git on
     * the common path; a stored rootless row is deliberately re-probed by a
     * new store so it can adopt a repository created since first capture.
     */
    resolveProjectIdentity(projectPath: string): ResolvedProjectIdentity {
        const byPath = this.stmts.findProjectByPath.get(projectPath) as ProjectRow | undefined;
        if (byPath?.git_root) {
            this.gitRootsByCwd.set(projectPath, byPath.git_root);
            return this.identityFromProject(byPath);
        }

        const gitRoot = this.gitRootFor(projectPath);
        const existing = gitRoot ? ((this.stmts.findProjectByGitRoot.get(gitRoot) as ProjectRow | undefined) ?? undefined) : byPath;
        if (existing) {
            return this.identityFromProject(existing);
        }
        return {
            gitRoot,
            gitRemote: gitRoot ? this.resolveGitRemote(gitRoot) : null,
            gitRootCommit: gitRoot ? this.resolveGitRootCommit(gitRoot) : null,
        };
    }

    getProjectById(id: number): ProjectRow | undefined {
        return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    }

    findProject(query: string): ProjectRow | undefined {
        const rows = this.listProjects();
        return rows.find((r) => r.path === query) ?? rows.find((r) => r.path.includes(query) || r.display_name?.includes(query));
    }

    listProjects(): ProjectRow[] {
        return this.db.prepare('SELECT * FROM projects ORDER BY last_seen_at DESC').all() as ProjectRow[];
    }

    private gitRootFor(projectPath: string): string | null {
        if (!this.gitRootsByCwd.has(projectPath)) {
            this.gitRootsByCwd.set(projectPath, this.resolveGitRoot(projectPath));
        }
        return this.gitRootsByCwd.get(projectPath) ?? null;
    }

    private identityFromProject(project: ProjectRow): ResolvedProjectIdentity {
        return {
            gitRoot: project.git_root,
            gitRemote: project.git_remote,
            gitRootCommit: project.git_root_commit,
        };
    }
}
