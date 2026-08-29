import type { Command } from 'commander';
import { openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { errorMessage } from '../../util/error.js';
import { runInit } from '../init.js';

export function registerInit(program: Command): void {
    program
        .command('init')
        .description('Interactively choose which local projects elepha may remember')
        .action(async () => {
            try {
                process.exitCode = await runInit({ store: new MemoryStore(openDb()) });
            } catch (error) {
                console.error(errorMessage(error));
                process.exitCode = 1;
            }
        });
}
