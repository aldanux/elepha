import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { openDb } from '../../src/storage/db.js';

const { backupDatabaseAndReport, daemonHealth, defaultDbPath, serviceBackend } = vi.hoisted(() => ({
    backupDatabaseAndReport: vi.fn(),
    daemonHealth: vi.fn(),
    defaultDbPath: vi.fn(),
    serviceBackend: vi.fn(),
}));

vi.mock('../../src/install/health-checks.js', () => ({ daemonHealth }));
vi.mock('../../src/install/service-backend.js', () => ({ serviceBackend }));
vi.mock('../../src/storage/backup.js', () => ({ backupDatabaseAndReport }));
vi.mock('../../src/storage/db.js', () => ({ defaultDbPath }));

import { runDestructiveOp } from '../../src/cli/destructive-op.js';

describe('runDestructiveOp daemon liveness gate', () => {
    let error: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        process.exitCode = undefined;
    });

    afterEach(() => {
        error.mockRestore();
    });

    it('returns true for a dry run without inspecting or pausing capture', async () => {
        const apply = vi.fn();

        await expect(
            runDestructiveOp({
                applyRequested: false,
                db: { pragma: vi.fn() } as unknown as ReturnType<typeof openDb>,
                plan: () => ({ rows: 1 }),
                describe: vi.fn(),
                isEmpty: () => false,
                messages: { dryRun: 'dry run' },
                apply,
                verify: vi.fn(),
            }),
        ).resolves.toBe(true);

        expect(daemonHealth).not.toHaveBeenCalled();
        expect(serviceBackend).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
    });

    it('returns false after confirmation when a healthy daemon has no managed service to pause', async () => {
        daemonHealth.mockReturnValue({ state: 'RUNNING (pid 42, heartbeat 1s ago)', healthy: true });
        serviceBackend.mockReturnValue({ isInstalled: () => false });
        const confirm = vi.fn(async () => true);
        const apply = vi.fn();
        const verify = vi.fn();

        await expect(
            runDestructiveOp({
                applyRequested: true,
                db: { pragma: vi.fn() } as unknown as ReturnType<typeof openDb>,
                operationLabel: 'purge',
                plan: () => ({ rows: 1 }),
                describe: vi.fn(),
                isEmpty: () => false,
                confirm,
                messages: { dryRun: 'dry run' },
                apply,
                verify,
            }),
        ).resolves.toBe(false);

        expect(confirm).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledWith('Refusing purge: a running daemon could not be paused automatically. Stop it and retry.');
        expect(process.exitCode).toBe(1);
        expect(backupDatabaseAndReport).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
    });
});
