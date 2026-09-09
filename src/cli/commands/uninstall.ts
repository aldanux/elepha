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

async function runUninstall(): Promise<void> {
    try {
        const db = await openDb();
        let approvedRoots: number;
        try {
            approvedRoots = new ConsentStore(db).countApproved();
        } finally {
            db.close();
        }
        printInstallation(uninstallElepha(undefined, { approvedRoots }), 'uninstall');
    } catch (error) {
        console.error(errorMessage(error));
        process.exitCode = 1;
    }
}
