import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_PAUSE_DEADLINE_MS } from '../../src/config/constants.js';
import type { ServiceBackend } from '../../src/install/service-backend.js';
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

import { prepareDestructiveApply, withCapturePaused } from '../../src/cli/shared.js';

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

describe('prepareDestructiveApply daemon liveness gate', () => {
    let root: string;
    let db: ReturnType<typeof openDb>;
    let error: ReturnType<typeof vi.spyOn>;
    let log: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), 'elepha-destructive-apply-'));
        const dbPath = path.join(root, 'elepha.db');
        defaultDbPath.mockReturnValue(dbPath);
        writeFileSync(dbPath, 'database');
        db = { pragma: vi.fn() } as unknown as ReturnType<typeof openDb>;
        error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.clearAllMocks();
        process.exitCode = undefined;
    });

    afterEach(() => {
        error.mockRestore();
        log.mockRestore();
        vi.useRealTimers();
        rmSync(root, { recursive: true, force: true });
    });

    it('refuses only a RUNNING daemon before checkpointing or backing up', () => {
        const state = 'RUNNING (pid 42, heartbeat 1s ago)';
        daemonHealth.mockReturnValue({ state, healthy: true });

        expect(prepareDestructiveApply(db, 'destructive segmentation')).toBe(false);

        expect(error).toHaveBeenCalledWith(
            'Refusing destructive segmentation while the daemon is running (RUNNING (pid 42, heartbeat 1s ago)). Stop it and retry.',
        );
        expect(process.exitCode).toBe(1);
        expect(db.pragma).not.toHaveBeenCalled();
        expect(backupDatabaseAndReport).not.toHaveBeenCalled();
    });

    it('proceeds past a STUCK daemon after reporting that it is not writing', () => {
        const state = 'STUCK (pid 42 alive, but heartbeat is 1m old - process may be hung)';
        daemonHealth.mockReturnValue({ state, healthy: false });

        expect(prepareDestructiveApply(db, 'destructive segmentation')).toBe(true);

        expect(error).toHaveBeenCalledWith(`Daemon appears stuck (${state}); proceeding — it is not writing.`);
        expect(db.pragma).not.toHaveBeenCalled();
        expect(backupDatabaseAndReport).toHaveBeenCalledWith(db, defaultDbPath());
    });

    it('proceeds when the daemon is NOT RUNNING', () => {
        daemonHealth.mockReturnValue({ state: 'NOT RUNNING (no heartbeat file)', healthy: false });

        expect(prepareDestructiveApply(db, 'destructive segmentation')).toBe(true);

        expect(error).not.toHaveBeenCalled();
        expect(db.pragma).not.toHaveBeenCalled();
        expect(backupDatabaseAndReport).toHaveBeenCalledWith(db, defaultDbPath());
    });
});

describe('withCapturePaused', () => {
    let error: ReturnType<typeof vi.spyOn>;
    let log: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        process.exitCode = undefined;
    });

    afterEach(() => {
        error.mockRestore();
        log.mockRestore();
        vi.useRealTimers();
    });

    it('pauses a healthy managed writer, runs the operation, and resumes it', async () => {
        const calls: string[] = [];
        serviceBackend.mockReturnValue(fakeService(calls));
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

        await expect(
            withCapturePaused('purge', async () => {
                calls.push('operation');
            }),
        ).resolves.toBe(true);

        expect(calls).toEqual(['stop', 'disable', 'operation', 'enable', 'start']);
        expect(log).toHaveBeenCalledWith('Paused capture…');
        expect(log).toHaveBeenCalledWith('Capture resumed.');
    });

    it('leaves capture paused when no healthy writer was running', async () => {
        const operation = vi.fn(async () => undefined);
        daemonHealth.mockReturnValue({ state: 'NOT RUNNING (no heartbeat file)', healthy: false });

        await expect(withCapturePaused('purge', operation)).resolves.toBe(true);

        expect(operation).toHaveBeenCalledOnce();
        expect(serviceBackend).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalledWith('Capture resumed.');
    });

    it('refuses without running or resuming when the daemon stays healthy', async () => {
        vi.useFakeTimers();
        const calls: string[] = [];
        serviceBackend.mockReturnValue(fakeService(calls));
        daemonHealth.mockReturnValue({ state: 'RUNNING (pid 42, heartbeat 1s ago)', healthy: true });
        const operation = vi.fn(async () => undefined);

        const result = withCapturePaused('purge', operation);
        await vi.advanceTimersByTimeAsync(CAPTURE_PAUSE_DEADLINE_MS);

        await expect(result).resolves.toBe(false);
        expect(operation).not.toHaveBeenCalled();
        expect(calls).toEqual(['stop', 'disable']);
        expect(error).toHaveBeenCalledWith('Refusing purge: a running daemon could not be paused automatically. Stop it and retry.');
        expect(process.exitCode).toBe(1);
    });

    it('resumes capture in finally when the operation throws', async () => {
        const calls: string[] = [];
        serviceBackend.mockReturnValue(fakeService(calls));
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

        await expect(
            withCapturePaused('purge', async () => {
                calls.push('operation');
                throw new Error('apply failed');
            }),
        ).rejects.toThrow('apply failed');

        expect(calls).toEqual(['stop', 'disable', 'operation', 'enable', 'start']);
        expect(log).toHaveBeenCalledWith('Capture resumed.');
    });
});
