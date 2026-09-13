import type { Command } from 'commander';
import { uninstallElepha } from '../../install/installer.js';
import { errorMessage } from '../../util/error.js';
import { printInstallation } from '../shared.js';

export function registerUninstall(program: Command): void {
    const hook = program.commands.find((command) => command.name() === 'hook');
    if (!hook) {
        throw new Error('Uninstall hooks require the hidden hook command to be registered first.');
    }

    program.command('uninstall').description('Remove only elepha global registrations').action(runUninstall);
    hook.command('uninstall').action(runUninstall);
}

function runUninstall(): void {
    try {
        // Teardown never starts capture and must work even when the database cannot open.
        const result = uninstallElepha(undefined, { approvedRoots: 0 });
        printInstallation(result, 'uninstall');
        for (const warning of result.warnings) {
            console.warn(warning);
        }
        for (const failure of result.failures) {
            console.error(failure);
        }
        if (result.failures.length > 0) {
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(errorMessage(error));
        process.exitCode = 1;
    }
}
