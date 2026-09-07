import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    countApproved: vi.fn(() => 2),
    databaseMigrationIsActive: vi.fn(() => false),
    openDb: vi.fn(async () => ({})),
    runDoctor: vi.fn(),
}));

vi.mock('../../src/install/doctor.js', () => ({ runDoctor: mocks.runDoctor }));
vi.mock('../../src/install/service-backend.js', () => ({ serviceBackend: vi.fn() }));
vi.mock('../../src/storage/consent-store.js', () => ({
    ConsentStore: class {
        countApproved(): number {
            return mocks.countApproved();
        }
    },
}));
vi.mock('../../src/storage/database-migration.js', () => ({
    databaseMigrationIsActive: mocks.databaseMigrationIsActive,
    recoverPrimaryDatabaseMigration: vi.fn(),
}));
vi.mock('../../src/storage/db.js', () => ({ defaultDbPath: () => '/state/elepha.db', openDb: mocks.openDb }));

const { registerDoctor } = await import('../../src/cli/commands/doctor.js');
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setTty(value: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });
}

beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
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

describe('elepha doctor progress', () => {
    it('shows a TTY loader until all checks finish, then prints the report', async () => {
        setTty(true);
        let finish: ((result: { lines: string[]; nextSteps: string[]; exitCode: 0 }) => void) | undefined;
        mocks.runDoctor.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const terminal = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const output: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line) => output.push(String(line)));
        const program = new Command();
        registerDoctor(program);

        const running = program.parseAsync(['node', 'elepha', 'doctor']);
        await vi.waitFor(() => expect(terminal).toHaveBeenCalled());
        const pending = terminal.mock.calls.map(([chunk]) => String(chunk)).join('');
        expect(pending).toContain('Checking elepha');
        expect(pending).not.toContain('…');
        expect(pending).not.toMatch(/Checking elepha\.{1,3}/);

        finish?.({ lines: ['✓ Daemon: RUNNING', 'Summary: all checks passed.'], nextSteps: [], exitCode: 0 });
        await running;

        expect(terminal.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('Checks complete ✔\n');
        expect(output).toEqual(['✓ Daemon: RUNNING', 'Summary: all checks passed.']);
        expect(process.exitCode).toBe(0);
    });
});
