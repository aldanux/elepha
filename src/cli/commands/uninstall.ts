import type { Command } from 'commander';
import { uninstallElepha } from '../../install/installer.js';
import { ConsentStore } from '../../storage/consent-store.js';
import { openDb } from '../../storage/db.js';
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
        printInstallation(uninstallElepha(undefined, { approvedRoots: new ConsentStore(openDb()).countApproved() }), 'uninstall');
    } catch (error) {
        console.error(errorMessage(error));
        process.exitCode = 1;
    }
}
