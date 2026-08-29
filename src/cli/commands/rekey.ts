import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { gitRevParseShowToplevel } from '../../security/subprocess-allowlist.js';
import { backupDatabaseAndReport } from '../../storage/backup.js';
import { defaultDbPath, openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { refuseIfDaemonRunning } from '../shared.js';

export function registerRekey(program: Command): void {
    program
        .command('rekey-projects', { hidden: true })
        .description('Consolidate project rows by stable repository identity. Dry-run by default.')
        .option('--apply', 'actually perform the merge (default is a dry run that only prints the mapping)')
        .action((opts: { apply: boolean }) => {
            const dbPath = defaultDbPath();
            const store = new MemoryStore(openDb());
            const resolveGitRoot = (p: string): string | null => {
                if (!p || !existsSync(p)) {
                    return null;
                }
                return gitRevParseShowToplevel(p);
            };

            const before = store.listProjects().length;
            let plans = store.planRekeyProjectsByIdentity(resolveGitRoot);

            if (plans.length === 0) {
                console.log('No project rows need consolidating.');
                return;
            }

            if (opts.apply) {
                if (refuseIfDaemonRunning('rekey-projects --apply')) {
                    return;
                }
                // Re-keying deletes only now-redundant project rows, but it still
                // moves foreign keys and must leave a full recoverable snapshot.
                if (existsSync(dbPath)) {
                    backupDatabaseAndReport(store.database, dbPath, reportBackupWithoutLeadingNewline);
                }
                plans = store.rekeyProjectsByIdentity(resolveGitRoot);
            }

            console.log(opts.apply ? '=== PROJECT RE-KEY APPLIED ===\n' : '=== PROJECT RE-KEY DRY RUN (nothing written) ===\n');
            for (const plan of plans) {
                console.log(`git_root: ${plan.gitRoot ?? '(unresolved)'}`);
                console.log(`  canonical -> [${plan.canonical.id}] ${plan.gitRoot ?? plan.canonical.path}`);
                for (const m of plan.merged) {
                    console.log(`     merged  <- [${m.id}] ${m.path}`);
                }
                console.log('');
            }
            const mergedCount = plans.reduce((sum, p) => sum + p.merged.length, 0);
            const verb = opts.apply ? 'merged' : 'would merge';
            console.log(`${plans.length} group(s), ${verb} ${mergedCount} row(s): ${before} -> ${before - mergedCount} project rows`);
            if (!opts.apply) {
                console.log('\nRe-run with --apply to perform the merge.');
            }
        });
}

function reportBackupWithoutLeadingNewline(message: string): void {
    console.log(message.startsWith('\n') ? message.slice(1) : message);
}
