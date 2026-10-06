import type Database from 'better-sqlite3-multiple-ciphers';
import type { Command } from 'commander';
import { openManagedDatabase } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { errorMessage } from '../../util/error.js';
import { runDestructiveOp } from '../destructive-op.js';

export function registerMoveProject(program: Command): void {
    program
        .command('move-project')
        .description('Move saved memory to an already authorized project folder without moving files')
        .requiredOption('--from <old-folder>', 'previous project folder')
        .requiredOption('--to <new-folder>', 'new project folder')
        .option('--apply', 'apply the folder mapping (default is a preview)')
        .action(async (opts: { from: string; to: string; apply?: boolean }) => {
            let db: Database.Database | undefined;
            try {
                // Preview must not initialize or migrate persisted state.
                db = await openManagedDatabase(undefined, { readonly: !opts.apply, fileMustExist: true });
                db.pragma('foreign_keys = ON');
                const store = new MemoryStore(db);
                const plan = store.planMoveProject(opts.from, opts.to);
                const completed = await runDestructiveOp({
                    db,
                    applyRequested: opts.apply === true,
                    operationLabel: 'move-project --apply',
                    captureProgress: false,
                    plan: () => plan,
                    describe: () => {
                        if (!opts.apply) {
                            console.log(`Move saved memory:\n  From: ${plan.from}\n  To:   ${plan.to}\n`);
                            console.log('Your chats and saved memory will be kept.');
                        }
                    },
                    isEmpty: () => opts.apply === true && (!plan.source || plan.source.id === plan.destination?.id),
                    onEmpty: () => store.applyProjectMove(plan),
                    apply: () => store.applyProjectMove(plan),
                    verify: () => store.verifyProjectMove(plan),
                    backupLog: () => undefined,
                    messages: { dryRun: 'Run with --apply to move them.' },
                });
                if (completed && opts.apply) {
                    console.log(`Saved memory moved to ${plan.to}.`);
                }
            } catch (error) {
                console.error(errorMessage(error));
                process.exitCode = 1;
            } finally {
                if (db?.open) {
                    db.close();
                }
            }
        });
}
