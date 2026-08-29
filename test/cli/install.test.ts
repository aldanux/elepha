import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    installElepha: vi.fn(),
    openDb: vi.fn(() => ({})),
    printInstallation: vi.fn(),
    spinner: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({ spinner: mocks.spinner }));
vi.mock('../../src/install/installer.js', () => ({ installElepha: mocks.installElepha }));
vi.mock('../../src/storage/consent-store.js', () => ({
    ConsentStore: class {
        //noinspection JSUnusedGlobalSymbols
        countApproved(): number {
            return 2;
        }
    },
}));
vi.mock('../../src/storage/db.js', () => ({ openDb: mocks.openDb }));
vi.mock('../../src/cli/shared.js', () => ({ printInstallation: mocks.printInstallation }));

const { createInstallProgressReporter, registerInstall } = await import('../../src/cli/commands/install.js');

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
    it('renders one TTY spinner per phase and prints the installation summary last', async () => {
        setTty(true);
        const events: string[] = [];
        mocks.spinner.mockImplementation(() => ({
            start: (message: string) => events.push(`start:${message}`),
            stop: (message: string) => events.push(`stop:${message}`),
            error: (message: string) => events.push(`error:${message}`),
        }));
        mocks.installElepha.mockImplementation((_paths, runtime) => {
            runtime.onPhase('Preparing hooks & MCP', 'start');
            runtime.onPhase('Preparing hooks & MCP', 'done');
            runtime.onPhase('Registering integrations', 'start');
            runtime.onPhase('Registering integrations', 'done');
            runtime.onPhase('Starting the capture daemon', 'start');
            runtime.onPhase('Starting the capture daemon', 'done');
            return installationResult();
        });
        mocks.printInstallation.mockImplementation(() => events.push('summary'));

        await installProgram().parseAsync(['node', 'elepha', 'install']);

        expect(mocks.spinner).toHaveBeenCalledTimes(3);
        expect(events).toEqual([
            'start:Preparing hooks & MCP…',
            'stop:Preparing hooks & MCP ✔',
            'start:Registering integrations…',
            'stop:Registering integrations ✔',
            'start:Starting the capture daemon…',
            'stop:Starting the capture daemon ✔',
            'summary',
        ]);
    });

    it('passes no reporter and emits no spinner controls when stdout is not a TTY', async () => {
        setTty(false);
        mocks.installElepha.mockReturnValue(installationResult());

        await installProgram().parseAsync(['node', 'elepha', 'install']);

        expect(mocks.installElepha).toHaveBeenCalledWith(undefined, { approvedRoots: 2 });
        expect(mocks.spinner).not.toHaveBeenCalled();
        expect(mocks.printInstallation).toHaveBeenCalledOnce();
    });

    it('resolves an active spinner in a failure state', () => {
        setTty(true);
        const spinner = { start: vi.fn(), stop: vi.fn(), error: vi.fn() };
        mocks.spinner.mockReturnValue(spinner);
        const reporter = createInstallProgressReporter();

        reporter?.('Starting the capture daemon', 'start');
        reporter?.('Starting the capture daemon', 'fail');

        expect(spinner.start).toHaveBeenCalledWith('Starting the capture daemon…');
        expect(spinner.error).toHaveBeenCalledWith('Starting the capture daemon ✖');
        expect(spinner.stop).not.toHaveBeenCalled();
    });
});
