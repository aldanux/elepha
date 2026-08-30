import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { isWithin, samePath } from '../../config/paths.js';
import { openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { ProjectResolver } from '../../storage/project-resolver.js';
import { isLiveProjectPath, isTempProjectPath } from '../project-path.js';

export function registerProjects(program: Command): void {
    program
        .command('projects')
        .description('List all projects with captured memory')
        .option('--all', 'include missing and temporary project paths')
        .action((opts: { all?: boolean }) => {
            const store = new MemoryStore(openDb());
            const sessionCounts = store.sessionCountsByProject();
            const projects = new ProjectResolver(store.database).list();
            const countSessions = (projectIds: readonly number[]): number =>
                projectIds.reduce((total, projectId) => total + (sessionCounts.get(projectId) ?? 0), 0);
            for (const set of projects) {
                const canonical = set.gitRoot ?? set.paths[0];
                if (!canonical || (!opts.all && !isLiveProjectPath(canonical))) {
                    continue;
                }
                const marker = opts.all ? (isTempProjectPath(canonical) ? '  (temp)' : !existsSync(canonical) ? '  (missing)' : '') : '';
                const sessions = countSessions(set.projectIds);
                const countLabel =
                    sessions === 0 && store.consent.isConsented(canonical)
                        ? 'no sessions yet'
                        : `${sessions} ${sessions === 1 ? 'session' : 'sessions'}`;
                console.log(`${canonical}${marker} (${countLabel})`);
            }
            for (const root of store.consent.list('approved')) {
                const represented = projects.some((set) =>
                    [set.gitRoot, ...set.paths].some((projectPath) => projectPath && samePath(projectPath, root.path)),
                );
                const capturedSessions = projects.reduce(
                    (total, set) =>
                        [set.gitRoot, ...set.paths].some((projectPath) => projectPath && isWithin(root.path, projectPath))
                            ? total + countSessions(set.projectIds)
                            : total,
                    0,
                );
                if (represented || capturedSessions > 0 || (!opts.all && !isLiveProjectPath(root.path))) {
                    continue;
                }
                const marker = opts.all ? (isTempProjectPath(root.path) ? '  (temp)' : !existsSync(root.path) ? '  (missing)' : '') : '';
                console.log(`${root.path}${marker} (no sessions yet)`);
            }
        });
}
