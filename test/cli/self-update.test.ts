import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    selfUpdate: vi.fn(),
    countApproved: vi.fn(() => 1),
    openDb: vi.fn(async () => ({})),
    spinner: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({ spinner: mocks.spinner }));
vi.mock('../../src/install/self-update.js', () => ({ selfUpdate: mocks.selfUpdate }));
vi.mock('../../src/storage/consent-store.js', () => ({
    ConsentStore: class {
        //noinspection JSUnusedGlobalSymbols
        countApproved(): number {
            return mocks.countApproved();
        }
    },
}));
vi.mock('../../src/storage/db.js', () => ({ openDb: mocks.openDb }));

const { formatSelfUpdateCurrentMessage, formatSelfUpdateUpdatedMessage, registerSelfUpdate } = await import(
    '../../src/cli/commands/self-update.js'
);
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setTty(value: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });
}

async function runSelfUpdate(): Promise<{ stdout: string[]; stderr: string[] }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message) => stdout.push(String(message)));
    vi.spyOn(console, 'error').mockImplementation((message) => stderr.push(String(message)));
    const program = new Command();
    registerSelfUpdate(program);
    await program.parseAsync(['node', 'elepha', 'self-update']);
    return { stdout, stderr };
}

describe('elepha self-update', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.exitCode = undefined;
        mocks.countApproved.mockReturnValue(1);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        process.exitCode = undefined;
        if (stdoutTty) {
            Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
        } else {
            Reflect.deleteProperty(process.stdout, 'isTTY');
        }
    });

    it('says the install is already on the latest version when nothing changed', async () => {
        mocks.selfUpdate.mockReturnValue({ status: 'current', version: '1.2.3' });

        const { stdout, stderr } = await runSelfUpdate();

        expect(stdout).toEqual([formatSelfUpdateCurrentMessage('1.2.3')]);
        expect(stderr).toEqual([]);
        expect(mocks.openDb).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
    });

    it('keeps the arrow form for a real version change', async () => {
        mocks.selfUpdate.mockReturnValue({ status: 'updated', previousVersion: '1.2.3', version: '1.2.4' });

        const { stdout, stderr } = await runSelfUpdate();

        expect(stdout).toEqual([formatSelfUpdateUpdatedMessage('1.2.3', '1.2.4')]);
        expect(stderr).toEqual([]);
        expect(mocks.selfUpdate).toHaveBeenCalledWith({ readApprovedRoots: expect.any(Function) });
        expect(process.exitCode).toBeUndefined();
    });

    it('shows progress while a TTY update is pending and prints the installed version after it completes', async () => {
        setTty(true);
        const spinner = { start: vi.fn(), stop: vi.fn(), error: vi.fn() };
        mocks.spinner.mockReturnValue(spinner);
        let finish: ((result: { status: 'updated'; previousVersion: string; version: string }) => void) | undefined;
        mocks.selfUpdate.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );

        const running = runSelfUpdate();
        await vi.waitFor(() => expect(spinner.start).toHaveBeenCalledWith('Updating elepha…'));
        expect(spinner.stop).not.toHaveBeenCalled();

        finish?.({ status: 'updated', previousVersion: '0.3.2', version: '0.4.1' });
        const { stdout, stderr } = await running;

        expect(spinner.stop).toHaveBeenCalledWith('Update complete ✔');
        expect(spinner.error).not.toHaveBeenCalled();
        expect(stdout).toEqual(['elepha updated: 0.3.2 → 0.4.1']);
        expect(stderr).toEqual([]);
    });
});
