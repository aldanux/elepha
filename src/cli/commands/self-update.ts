import type { Command } from 'commander';
import { selfUpdate } from '../../install/self-update.js';
import { ConsentStore } from '../../storage/consent-store.js';
import { openDb } from '../../storage/db.js';
import { errorMessage } from '../../util/error.js';
import { startCliProgress } from '../progress.js';

export function formatSelfUpdateUpdatedMessage(previousVersion: string, version: string): string {
    return `elepha updated: ${previousVersion} → ${version}`;
}

export function formatSelfUpdateCurrentMessage(version: string): string {
    return `elepha is already on the latest version (${version})`;
}

export function registerSelfUpdate(program: Command): void {
    program
        .command('self-update')
        .description('Update the global build, restart capture, and verify the daemon is healthy')
        .action(async () => {
            const progress = startCliProgress('Updating elepha');
            try {
                const result = await selfUpdate({
                    readApprovedRoots: async () => new ConsentStore(await openDb()).countApproved(),
                });
                if (result.status === 'current') {
                    progress.done('Update check complete');
                    console.log(formatSelfUpdateCurrentMessage(result.version));
                    return;
                }
                if (result.status === 'updated') {
                    progress.done('Update complete');
                    console.log(formatSelfUpdateUpdatedMessage(result.previousVersion, result.version));
                    return;
                }
                progress.fail('Update failed');
                console.error(
                    `elepha update to ${result.attemptedVersion} failed; restored ${result.previousVersion} and verified capture is healthy: ${result.failure}`,
                );
                process.exitCode = 1;
            } catch (error) {
                progress.fail('Update failed');
                console.error(errorMessage(error));
                process.exitCode = 1;
            }
        });
}
