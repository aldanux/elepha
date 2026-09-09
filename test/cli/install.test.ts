import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    installElepha: vi.fn(),
    uninstallElepha: vi.fn(),
    countApproved: vi.fn(() => 2),
    db: { open: false, close: vi.fn() },
    migrateDatabase: vi.fn(async () => undefined),
    openDb: vi.fn(),
    printInstallation: vi.fn(),
    service: {
        status: vi.fn(() => ({ loaded: false, disabled: false, unknown: false })),
        stop: vi.fn(),
        enable: vi.fn(),
        start: vi.fn(),
        waitForHealthy: vi.fn(() => true),
    },
}));

vi.mock('../../src/install/installer.js', () => ({ installElepha: mocks.installElepha, uninstallElepha: mocks.uninstallElepha }));
vi.mock('../../src/install/service-backend.js', () => ({ serviceBackend: () => mocks.service }));
vi.mock('../../src/storage/consent-store.js', () => ({
    ConsentStore: class {
        //noinspection JSUnusedGlobalSymbols
        countApproved(): number {
            return mocks.countApproved();
        }
    },
}));
vi.mock('../../src/install/database-migration.js', () => ({ migrateDatabaseForInstall: mocks.migrateDatabase }));
vi.mock('../../src/storage/db.js', () => ({ defaultDbPath: () => '/state/elepha.db', openDb: mocks.openDb }));
vi.mock('../../src/cli/shared.js', () => ({ printInstallation: mocks.printInstallation }));

const { registerInstall } = await import('../../src/cli/commands/install.js');
const { registerUninstall } = await import('../../src/cli/commands/uninstall.js');

const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setTty(value: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });
}

function installProgram(): Command {
    const program = new Command();
    program.command('hook');
    registerInstall(program);
    registerUninstall(program);
    return program;
}

function installationResult() {
    return {
        bin: '/opt/npm/bin/elepha',
        changed: true,
        status: {
            claudeHook: 'active',
            claudeUserPromptSubmitHook: 'active',
            claudeMcp: 'registered',
            codexHook: 'active',
            codexUserPromptSubmitHook: 'active',
            codexMcp: 'registered',
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.open = false;
    mocks.openDb.mockImplementation(async () => {
        mocks.db.open = true;
        return mocks.db;
    });
    mocks.db.close.mockImplementation(() => {
        mocks.db.open = false;
    });
    process.exitCode = undefined;
});

afterEach(() => {
    process.exitCode = undefined;
    if (stdoutTty) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
    } else {
        Reflect.deleteProperty(process.stdout, 'isTTY');
    }
});

describe('elepha install progress', () => {
    it('passes no reporter and emits no loader controls when stdout is not a TTY', async () => {
        setTty(false);
        mocks.installElepha.mockReturnValue(installationResult());

        await installProgram().parseAsync(['node', 'elepha', 'install']);

        expect(mocks.service.stop).toHaveBeenCalledOnce();
        expect(mocks.migrateDatabase).toHaveBeenCalledWith('/state/elepha.db');
        expect(mocks.installElepha).toHaveBeenCalledWith(undefined, { approvedRoots: 2, service: mocks.service });
        expect(mocks.service.stop.mock.invocationCallOrder[0]).toBeLessThan(mocks.migrateDatabase.mock.invocationCallOrder[0]);
        expect(mocks.migrateDatabase.mock.invocationCallOrder[0]).toBeLessThan(mocks.openDb.mock.invocationCallOrder[0]);
        expect(mocks.printInstallation).toHaveBeenCalledOnce();
    });
});

describe('installation database lifetime', () => {
    it.each(['install', 'uninstall'])('closes the consent reader before %s changes the service', async (command) => {
        const operation = command === 'install' ? mocks.installElepha : mocks.uninstallElepha;
        operation.mockImplementationOnce(() => {
            expect(mocks.db.open).toBe(false);
            return installationResult();
        });

        await installProgram().parseAsync(['node', 'elepha', command]);

        expect(operation).toHaveBeenCalledOnce();
        expect(mocks.db.close).toHaveBeenCalledOnce();
        expect(mocks.db.open).toBe(false);
        expect(process.exitCode).toBeUndefined();
    });

    it('closes the consent reader before restoring the service after a failed read', async () => {
        mocks.service.status.mockReturnValueOnce({ loaded: true, disabled: false, unknown: false });
        mocks.countApproved.mockImplementationOnce(() => {
            throw new Error('consent read failed');
        });
        mocks.service.start.mockImplementationOnce(() => {
            expect(mocks.db.open).toBe(false);
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await installProgram().parseAsync(['node', 'elepha', 'install']);

            expect(mocks.db.close).toHaveBeenCalledOnce();
            expect(mocks.db.open).toBe(false);
            expect(mocks.installElepha).not.toHaveBeenCalled();
            expect(mocks.service.start).toHaveBeenCalledOnce();
            expect(process.exitCode).toBe(1);
            expect(error).toHaveBeenCalledWith('consent read failed');
        } finally {
            error.mockRestore();
        }
    });
});
