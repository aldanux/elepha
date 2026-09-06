import * as clack from '@clack/prompts';
import type { Command } from 'commander';
import { type InstallPhaseReporter, installElepha } from '../../install/installer.js';
import { type ServiceBackend, serviceBackend } from '../../install/service-backend.js';
import { ConsentStore } from '../../storage/consent-store.js';
import { migratePrimaryDatabaseToEncrypted } from '../../storage/database-migration.js';
import { defaultDbPath, openDb } from '../../storage/db.js';
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

async function runInstall(): Promise<void> {
    let service: ServiceBackend | undefined;
    let priorService: ReturnType<ServiceBackend['status']> | undefined;
    try {
        service = serviceBackend();
        priorService = service.status();
        service.stop();
        await migratePrimaryDatabaseToEncrypted(defaultDbPath());
        const onPhase = createInstallProgressReporter();
        const runtime = {
            approvedRoots: new ConsentStore(await openDb()).countApproved(),
            service,
            ...(onPhase ? { onPhase } : {}),
        };
        printInstallation(installElepha(undefined, runtime), 'install');
    } catch (error) {
        if (service !== undefined && priorService !== undefined) {
            try {
                restoreService(service, priorService);
            } catch (restoreError) {
                console.error(`Install failed and the prior capture service could not be restored: ${errorMessage(restoreError)}`);
            }
        }
        console.error(errorMessage(error));
        process.exitCode = 1;
    }
}

function restoreService(service: ServiceBackend, prior: ReturnType<ServiceBackend['status']>): void {
    service.stop();
    if (prior.disabled || prior.unknown) {
        service.disable();
        return;
    }
    service.enable();
    if (prior.loaded) {
        service.start();
        if (!service.waitForHealthy()) {
            throw service.healthFailure();
        }
    }
}
