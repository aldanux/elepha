import type { Command } from 'commander';
import { migrateDatabaseForInstall } from '../../install/database-migration.js';
import { type InstallPhaseReporter, installElepha } from '../../install/installer.js';
import { type ServiceBackend, serviceBackend } from '../../install/service-backend.js';
import { ConsentStore } from '../../storage/consent-store.js';
import { defaultDbPath, openDb } from '../../storage/db.js';
import { errorMessage } from '../../util/error.js';
import { type CliProgress, startCliProgress } from '../progress.js';
import { printInstallation } from '../shared.js';

export function createInstallProgressReporter(): InstallPhaseReporter | undefined {
    if (!process.stdout.isTTY) {
        return undefined;
    }

    let active: CliProgress | undefined;
    return (phase, event) => {
        if (event === 'start') {
            active = startCliProgress(phase);
            return;
        }
        if (event === 'done') {
            active?.done(phase);
        } else {
            active?.fail(phase);
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
        await migrateDatabaseForInstall(defaultDbPath());
        const db = await openDb();
        let approvedRoots: number;
        try {
            approvedRoots = new ConsentStore(db).countApproved();
        } finally {
            db.close();
        }
        const onPhase = createInstallProgressReporter();
        const runtime = {
            approvedRoots,
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
