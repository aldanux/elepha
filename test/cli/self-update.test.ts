import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    selfUpdate: vi.fn(),
    countApproved: vi.fn(() => 1),
    openDb: vi.fn(() => ({})),
}));

vi.mock('../../src/install/self-update.js', () => ({ selfUpdate: mocks.selfUpdate }));
vi.mock('../../src/storage/consent-store.js', () => ({
    ConsentStore: class {
        countApproved(): number {
            return mocks.countApproved();
        }
    },
}));
vi.mock('../../src/storage/db.js', () => ({ openDb: mocks.openDb }));

const { formatSelfUpdateCurrentMessage, formatSelfUpdateUpdatedMessage, registerSelfUpdate } = await import(
    '../../src/cli/commands/self-update.js'
);

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
    });

    it('says the install is already on the latest version when nothing changed', async () => {
        mocks.selfUpdate.mockReturnValue({ status: 'current', version: '1.2.3' });

        const { stdout, stderr } = await runSelfUpdate();

        expect(stdout).toEqual([formatSelfUpdateCurrentMessage('1.2.3')]);
        expect(stderr).toEqual([]);
        expect(process.exitCode).toBeUndefined();
    });

    it('keeps the arrow form for a real version change', async () => {
        mocks.selfUpdate.mockReturnValue({ status: 'updated', previousVersion: '1.2.3', version: '1.2.4' });

        const { stdout, stderr } = await runSelfUpdate();

        expect(stdout).toEqual([formatSelfUpdateUpdatedMessage('1.2.3', '1.2.4')]);
        expect(stderr).toEqual([]);
        expect(process.exitCode).toBeUndefined();
    });
});
