import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    installElepha: vi.fn(),
    migrateDatabase: vi.fn(async () => undefined),
    openDb: vi.fn(async () => ({})),
    printInstallation: vi.fn(),
    service: {
        status: vi.fn(() => ({ loaded: false, disabled: false, unknown: false })),
        stop: vi.fn(),
    },
}));

vi.mock('../../src/install/installer.js', () => ({ installElepha: mocks.installElepha }));
vi.mock('../../src/install/service-backend.js', () => ({ serviceBackend: () => mocks.service }));
vi.mock('../../src/storage/consent-store.js', () => ({
    ConsentStore: class {
        //noinspection JSUnusedGlobalSymbols
        countApproved(): number {
            return 2;
        }
    },
}));
vi.mock('../../src/install/database-migration.js', () => ({ migrateDatabaseForInstall: mocks.migrateDatabase }));
vi.mock('../../src/storage/db.js', () => ({ defaultDbPath: () => '/state/elepha.db', openDb: mocks.openDb }));
vi.mock('../../src/cli/shared.js', () => ({ printInstallation: mocks.printInstallation }));

const { registerInstall } = await import('../../src/cli/commands/install.js');

const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setTty(value: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });
}

function installProgram(): Command {
    const program = new Command();
    program.command('hook');
    registerInstall(program);
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
    process.exitCode = undefined;
});

afterEach(() => {
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
