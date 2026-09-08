import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceBackend } from '../../src/install/service-backend.js';
import type { openUnmanagedDb } from '../../src/storage/db.js';

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

function fakeService(calls: string[]): ServiceBackend {
    let loaded = true;
    let disabled = false;
    return {
        launcherPath: '',
        manifestPath: '',
        transactionPath: '',
        artifactPaths: [],
        hasArtifacts: () => true,
        isInstalled: () => true,
        installationMatches: () => true,
        install: () => {},
        uninstall: () => {},
        start: () => {
            calls.push('start');
            loaded = true;
        },
        stop: () => {
            calls.push('stop');
            loaded = false;
        },
        restart: () => {},
        status: () => ({ loaded, disabled, unknown: false }),
        healthy: () => true,
        waitForHealthy: () => true,
        healthFailure: () => new Error('unhealthy'),
        enable: () => {
            calls.push('enable');
            disabled = false;
        },
        disable: () => {
            calls.push('disable');
            disabled = true;
        },
    };
}

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
                db: { pragma: vi.fn() } as unknown as ReturnType<typeof openUnmanagedDb>,
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
                db: { pragma: vi.fn() } as unknown as ReturnType<typeof openUnmanagedDb>,
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

    it('closes the operation database before resuming capture', async () => {
        const calls: string[] = [];
        serviceBackend.mockReturnValue(fakeService(calls));
        defaultDbPath.mockReturnValue('test/fixtures/missing-elepha.db');
        daemonHealth
            .mockReturnValueOnce({
                state: 'RUNNING (pid 42, heartbeat 1s ago)',
                healthy: true,
                heartbeat: { pid: 42, startedAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:01.000Z' },
            })
            .mockReturnValueOnce({
                state: 'NOT RUNNING (pid 42 from last heartbeat is gone - crashed?)',
                healthy: false,
                heartbeat: { pid: 42, startedAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:01.000Z' },
            })
            .mockReturnValueOnce({
                state: 'NOT RUNNING (pid 42 from last heartbeat is gone - crashed?)',
                healthy: false,
                heartbeat: { pid: 42, startedAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:01.000Z' },
            })
            .mockReturnValueOnce({
                state: 'RUNNING (pid 43, heartbeat 0s ago)',
                healthy: true,
                heartbeat: { pid: 43, startedAt: '2026-08-28T00:01:00.000Z', updatedAt: '2026-08-28T00:01:00.000Z' },
            });
        const close = vi.fn(() => {
            calls.push('close');
        });
        const db = { close } as unknown as ReturnType<typeof openUnmanagedDb>;

        await expect(
            runDestructiveOp({
                applyRequested: true,
                db,
                plan: () => ({ rows: 1 }),
                describe: vi.fn(),
                isEmpty: () => false,
                messages: { dryRun: 'dry run' },
                apply: () => {
                    calls.push('apply');
                },
                verify: () => {
                    calls.push('verify');
                },
            }),
        ).resolves.toBe(true);

        expect(close).toHaveBeenCalledOnce();
        expect(calls).toEqual(['stop', 'disable', 'apply', 'verify', 'close', 'enable', 'start']);
    });
});
