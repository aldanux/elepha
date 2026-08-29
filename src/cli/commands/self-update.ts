import type { Command } from 'commander';
import { selfUpdate } from '../../install/self-update.js';
import { ConsentStore } from '../../storage/consent-store.js';
import { openDb } from '../../storage/db.js';
import { errorMessage } from '../../util/error.js';

export function registerSelfUpdate(program: Command): void {
    program
        .command('self-update')
        .description('Update the global build, restart capture, and verify the daemon is healthy')
        .action(() => {
            try {
                const approvedRoots = new ConsentStore(openDb()).countApproved();
                const result = selfUpdate({ approvedRoots });
                if (result.status === 'updated') {
                    console.log(`elepha updated: ${result.previousVersion} → ${result.version}`);
                    return;
                }
                console.error(
                    `elepha update to ${result.attemptedVersion} failed; restored ${result.previousVersion} and verified capture is healthy: ${result.failure}`,
                );
                process.exitCode = 1;
            } catch (error) {
                console.error(errorMessage(error));
                process.exitCode = 1;
            }
        });
}
