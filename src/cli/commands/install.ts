import * as clack from '@clack/prompts';
import type { Command } from 'commander';
import { type InstallPhaseReporter, installElepha } from '../../install/installer.js';
import { ConsentStore } from '../../storage/consent-store.js';
import { openDb } from '../../storage/db.js';
import { errorMessage } from '../../util/error.js';
import { printInstallation } from '../shared.js';

export function createInstallProgressReporter(): InstallPhaseReporter | undefined {
    if (!process.stdout.isTTY) {
        return undefined;
    }

    let active: ReturnType<typeof clack.spinner> | undefined;
    return (phase, event) => {
        if (event === 'start') {
            active = clack.spinner({ output: process.stdout });
            active.start(`${phase}…`);
            return;
        }
        if (event === 'done') {
            active?.stop(`${phase} ✔`);
        } else {
            active?.error(`${phase} ✖`);
        }
        active = undefined;
    };
}

export function registerInstall(program: Command): void {
    const hook = program.commands.find((command) => command.name() === 'hook');
    if (!hook) {
        throw new Error('Install hooks require the hidden hook command to be registered first.');
    }

    program.command('install').description('Register elepha globally with supported AI coding tools').action(runInstall);
    hook.command('install').action(runInstall);
}

function runInstall(): void {
    try {
        const onPhase = createInstallProgressReporter();
        const runtime = {
            approvedRoots: new ConsentStore(openDb()).countApproved(),
            ...(onPhase ? { onPhase } : {}),
        };
        printInstallation(installElepha(undefined, runtime), 'install');
    } catch (error) {
        console.error(errorMessage(error));
        process.exitCode = 1;
    }
}
