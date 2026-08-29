import type { Command } from 'commander';
import { runDoctor } from '../../install/doctor.js';
import { ConsentStore } from '../../storage/consent-store.js';
import { openDb } from '../../storage/db.js';

export function registerDoctor(program: Command): void {
    program
        .command('doctor')
        .description('Diagnose capture recovery prerequisites and restart only a down or stuck daemon')
        .action(() => {
            let approvedRoots = 0;
            let databaseError: unknown;
            try {
                approvedRoots = new ConsentStore(openDb()).countApproved();
            } catch (error) {
                databaseError = error;
            }
            const result = runDoctor({
                approvedRoots,
                inspectDatabase: databaseError
                    ? () => {
                          throw databaseError;
                      }
                    : undefined,
            });
            for (const line of result.lines) {
                console.log(line);
            }
            process.exitCode = result.exitCode;
        });
}
