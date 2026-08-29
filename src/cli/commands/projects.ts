import { existsSync } from 'node:fs';
import type { Command } from 'commander';
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
            for (const set of projects) {
                const canonical = set.gitRoot ?? set.paths[0];
                if (!canonical || (!opts.all && !isLiveProjectPath(canonical))) {
                    continue;
                }
                const marker = opts.all ? (isTempProjectPath(canonical) ? '  (temp)' : !existsSync(canonical) ? '  (missing)' : '') : '';
                const sessions = set.projectIds.reduce((total, projectId) => total + (sessionCounts.get(projectId) ?? 0), 0);
                console.log(`${canonical}${marker} (${sessions} ${sessions === 1 ? 'session' : 'sessions'})`);
            }
        });
}
