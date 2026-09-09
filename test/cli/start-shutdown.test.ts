import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    close: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    approved: true,
}));

vi.mock('../../src/storage/db.js', () => ({
    defaultDbPath: () => '/state/elepha.db',
    openDb: async () => ({ close: mocks.close }),
}));
vi.mock('../../src/storage/memory-store.js', () => ({
    MemoryStore: class {
        consent = { list: () => (mocks.approved ? [{}] : []) };
    },
}));
vi.mock('../../src/storage/rollup-store.js', () => ({ RollupStore: class {} }));
vi.mock('../../src/summarizer/provider-config.js', () => ({ createConfiguredSynthesisProviders: () => undefined }));
vi.mock('../../src/daemon/index.js', () => ({
    IngestionDaemon: class {
        start = mocks.start;
        stop = mocks.stop;
    },
}));

const { registerStart } = await import('../../src/cli/commands/start.js');
const handlers = new Map<string | symbol, (...args: unknown[]) => void>();

beforeEach(() => {
    vi.clearAllMocks();
    mocks.approved = true;
    handlers.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
        handlers.set(event, listener);
        return process;
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

async function start(): Promise<void> {
    const program = new Command();
    registerStart(program, { migrateDatabase: async () => undefined });
    await program.parseAsync(['node', 'elepha', 'start']);
}

describe('daemon database shutdown', () => {
    it.each(['SIGTERM', 'SIGINT'])('drains capture and closes its database before exiting on %s', async (signal) => {
        let drain: () => void = () => {};
        const drained = new Promise<void>((resolve) => {
            drain = resolve;
        });
        mocks.stop.mockReturnValueOnce(drained);
        let exited: (code: number | string | null | undefined) => void = () => {};
        const exitCode = new Promise<number | string | null | undefined>((resolve) => {
            exited = resolve;
        });
        const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
            exited(code);
            return undefined as never;
        });

        await start();
        expect(mocks.start).toHaveBeenCalledOnce();
        expect(handlers.has(signal)).toBe(true);
        handlers.get(signal)?.();

        expect(mocks.stop).toHaveBeenCalledOnce();
        expect(mocks.close).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
        drain();
        expect(await exitCode).toBe(0);
        expect(mocks.close).toHaveBeenCalledOnce();
        expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    });

    it('closes the database when there are no approved roots', async () => {
        mocks.approved = false;

        await start();

        expect(mocks.close).toHaveBeenCalledOnce();
        expect(mocks.start).not.toHaveBeenCalled();
        expect(handlers.size).toBe(0);
    });
});
