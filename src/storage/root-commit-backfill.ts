import type { Database } from 'better-sqlite3';

export interface RootCommitBackfillChange {
    projectId: number;
    path: string;
    gitRootCommit: string;
}

export interface RootCommitBackfillPlan {
    changes: RootCommitBackfillChange[];
    projectsScanned: number;
    projectsUnresolvable: number;
    projectsSkippedConcurrent: number;
}

interface ProjectSeed {
    id: number;
    path: string;
    git_root: string | null;
}

export type ResolveGitRoot = (projectPath: string) => string | null;
export type ResolveGitRootCommit = (gitRoot: string) => string | null;

export function planRootCommitBackfill(
    db: Database,
    resolveGitRoot: ResolveGitRoot,
    resolveGitRootCommit: ResolveGitRootCommit,
): RootCommitBackfillPlan {
    const projects = db.prepare('SELECT id, path, git_root FROM projects WHERE git_root_commit IS NULL ORDER BY id').all() as ProjectSeed[];
    const changes: RootCommitBackfillChange[] = [];
    let projectsUnresolvable = 0;

    for (const project of projects) {
        const gitRoot = project.git_root || resolveGitRoot(project.path);
        const gitRootCommit = gitRoot ? resolveGitRootCommit(gitRoot) : null;
        if (gitRootCommit === null) {
            projectsUnresolvable++;
            continue;
        }
        changes.push({ projectId: project.id, path: project.path, gitRootCommit });
    }

    return { changes, projectsScanned: projects.length, projectsUnresolvable, projectsSkippedConcurrent: 0 };
}

// Fills only project rows that still need the identity captured by the fresh plan.
export function applyRootCommitBackfill(
    db: Database,
    resolveGitRoot: ResolveGitRoot,
    resolveGitRootCommit: ResolveGitRootCommit,
): RootCommitBackfillPlan {
    const plan = planRootCommitBackfill(db, resolveGitRoot, resolveGitRootCommit);
    const apply = db.transaction((changes: RootCommitBackfillChange[]) => {
        let projectsSkippedConcurrent = 0;
        const update = db.prepare('UPDATE projects SET git_root_commit = ? WHERE id = ? AND git_root_commit IS NULL');
        for (const change of changes) {
            if (update.run(change.gitRootCommit, change.projectId).changes === 0) {
                projectsSkippedConcurrent++;
            }
        }
        return projectsSkippedConcurrent;
    });

    return { ...plan, projectsSkippedConcurrent: apply(plan.changes) };
}
