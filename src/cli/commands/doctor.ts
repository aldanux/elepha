import type { Command } from 'commander';
import { runDoctor } from '../../install/doctor.js';
import { serviceBackend } from '../../install/service-backend.js';
import { ConsentStore } from '../../storage/consent-store.js';
import { databaseMigrationIsActive, recoverPrimaryDatabaseMigration } from '../../storage/database-migration.js';
import { defaultDbPath, openDb } from '../../storage/db.js';
import { errorMessage } from '../../util/error.js';
import { startCliProgress } from '../progress.js';

export function registerDoctor(program: Command): void {
    program
        .command('doctor')
        .description('Diagnose capture recovery prerequisites and restart only a down or stuck daemon')
        .action(async () => {
            const progress = startCliProgress('Checking elepha');
            let approvedRoots = 0;
            let databaseError: unknown;
            try {
                try {
                    if (databaseMigrationIsActive()) {
                        serviceBackend().stop();
                        await recoverPrimaryDatabaseMigration(defaultDbPath());
                    }
                    approvedRoots = new ConsentStore(await openDb()).countApproved();
                } catch (error) {
                    databaseError = error;
                }
                const result = await runDoctor({
                    approvedRoots,
                    inspectDatabase: databaseError
                        ? () => {
                              throw databaseError;
                          }
                        : undefined,
                });
                progress.done('Checks complete');
                for (const line of result.lines) {
                    console.log(line);
                }
                process.exitCode = result.exitCode;
            } catch (error) {
                progress.fail('Checks failed');
                console.error(errorMessage(error));
                process.exitCode = 1;
            }
        });
}
