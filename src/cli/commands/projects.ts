import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { isWithin, samePath } from '../../config/paths.js';
import { discoverFolderRepos } from '../../discovery/session-projects.js';
import { openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { ProjectResolver } from '../../storage/project-resolver.js';
import { isLiveProjectPath, isTempProjectPath } from '../project-path.js';
import { withCliReadGeneration } from '../read-gate.js';

export function registerProjects(program: Command): void {
    program
        .command('projects')
        .description('List captured and approved projects')
        .option('--all', 'include missing and temporary project paths')
        .action(async (opts: { all?: boolean }) => {
            const db = await openDb();
            await withCliReadGeneration(db, async (output) => {
                const store = new MemoryStore(db);
                const scanRoots = store.consent.list('approved').map((root) => root.path);
                const discovered = await discoverFolderRepos(scanRoots, []);
                const approvedRoots = store.consent.list('approved');
                const approvedDiscovered = discovered
                    .filter((project) => store.consent.consentState(project.root) === 'approved')
                    .sort((a, b) => a.root.localeCompare(b.root));
                const sessionCounts = store.sessionCountsByProject();
                const projects = new ProjectResolver(store.database).list();
                const countSessions = (projectIds: readonly number[]): number =>
                    projectIds.reduce((total, projectId) => total + (sessionCounts.get(projectId) ?? 0), 0);
                for (const set of projects) {
                    const canonical =
                        (set.gitRoot && existsSync(set.gitRoot) ? set.gitRoot : undefined) ??
                        set.paths.find(isLiveProjectPath) ??
                        set.gitRoot ??
                        set.paths[0];
                    if (!canonical || (!opts.all && !isLiveProjectPath(canonical))) {
                        continue;
                    }
                    const marker = opts.all
                        ? isTempProjectPath(canonical)
                            ? '  (temp)'
                            : !existsSync(canonical)
                              ? '  (missing)'
                              : ''
                        : '';
                    const sessions = countSessions(set.projectIds);
                    const countLabel =
                        sessions === 0 && store.consent.isConsented(canonical)
                            ? 'no sessions yet'
                            : `${sessions} ${sessions === 1 ? 'session' : 'sessions'}`;
                    output.log(`${canonical}${marker} (${countLabel})`);
                }
                for (const project of approvedDiscovered) {
                    const represented = projects.some((set) =>
                        [set.gitRoot, ...set.paths].some((projectPath) => projectPath && samePath(projectPath, project.root)),
                    );
                    if (represented || (!opts.all && !isLiveProjectPath(project.root))) {
                        continue;
                    }
                    const marker = opts.all
                        ? isTempProjectPath(project.root)
                            ? '  (temp)'
                            : !existsSync(project.root)
                              ? '  (missing)'
                              : ''
                        : '';
                    output.log(`${project.root}${marker} (no sessions yet)`);
                }
                for (const root of approvedRoots) {
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
                    const discoveredWithin = approvedDiscovered.some((project) => isWithin(root.path, project.root));
                    if (represented || capturedSessions > 0 || discoveredWithin || (!opts.all && !isLiveProjectPath(root.path))) {
                        continue;
                    }
                    const marker = opts.all
                        ? isTempProjectPath(root.path)
                            ? '  (temp)'
                            : !existsSync(root.path)
                              ? '  (missing)'
                              : ''
                        : '';
                    output.log(`${root.path}${marker} (no sessions yet)`);
                }
            });
        });
}
