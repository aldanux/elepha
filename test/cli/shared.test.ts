import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cliProgress from '../../src/cli/progress.js';
import { CAPTURE_PAUSE_DEADLINE_MS, DAEMON_HEALTH_CHECK_POLL_MS } from '../../src/config/constants.js';
import type { ServiceBackend } from '../../src/install/service-backend.js';
import type { openUnmanagedDb } from '../../src/storage/db.js';
import { withTempDir } from '../helpers/tmp.js';

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
    let db: ReturnType<typeof openUnmanagedDb>;
    let error: ReturnType<typeof vi.spyOn>;
    let log: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        root = withTempDir('elepha-destructive-apply-');
        const dbPath = path.join(root, 'elepha.db');
        defaultDbPath.mockReturnValue(dbPath);
        writeFileSync(dbPath, 'database');
        db = { pragma: vi.fn() } as unknown as ReturnType<typeof openUnmanagedDb>;
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
        vi.restoreAllMocks();
        vi.useRealTimers();
        process.exitCode = undefined;
    });

    it('pauses a healthy managed writer, runs the operation, and resumes it', async () => {
        const calls: string[] = [];
        const progress = vi.spyOn(cliProgress, 'startCliProgress').mockImplementation(() => {
            calls.push('progress');
            return { done: () => calls.push('done'), fail: vi.fn() };
        });
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
            withCapturePaused(
                'purge',
                async () => {
                    calls.push('operation');
                },
                console,
                () => {
                    calls.push('release');
                },
            ),
        ).resolves.toBe(true);

        expect(calls).toEqual(['progress', 'stop', 'disable', 'done', 'operation', 'progress', 'release', 'enable', 'start', 'done']);
        expect(progress).toHaveBeenCalledTimes(2);
    });

    it('does not resolve until capture resume completes', async () => {
        vi.useFakeTimers();
        const pause = { done: vi.fn(), fail: vi.fn() };
        const resume = { done: vi.fn(), fail: vi.fn() };
        vi.spyOn(cliProgress, 'startCliProgress').mockReturnValueOnce(pause).mockReturnValueOnce(resume);
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
                state: 'NOT RUNNING (no heartbeat file)',
                healthy: false,
            })
            .mockReturnValueOnce({
                state: 'RUNNING (pid 43, heartbeat 0s ago)',
                healthy: true,
                heartbeat: { pid: 43, startedAt: '2026-08-28T00:01:00.000Z', updatedAt: '2026-08-28T00:01:00.000Z' },
            });

        let settled = false;
        const result = withCapturePaused('purge', async () => {
            calls.push('operation');
        });
        void result.then(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        expect(pause.done).toHaveBeenCalledOnce();
        expect(resume.done).not.toHaveBeenCalled();
        expect(calls).toEqual(['stop', 'disable', 'operation', 'enable', 'start']);

        await vi.advanceTimersByTimeAsync(DAEMON_HEALTH_CHECK_POLL_MS);
        await expect(result).resolves.toBe(true);
        expect(settled).toBe(true);
        expect(resume.done).toHaveBeenCalledOnce();
        expect(resume.fail).not.toHaveBeenCalled();
    });

    it('leaves capture paused when no healthy writer was running', async () => {
        const operation = vi.fn(async () => undefined);
        daemonHealth.mockReturnValue({ state: 'NOT RUNNING (no heartbeat file)', healthy: false });

        await expect(withCapturePaused('purge', operation)).resolves.toBe(true);

        expect(operation).toHaveBeenCalledOnce();
        expect(serviceBackend).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });

    it('refuses without running or resuming when the daemon stays healthy', async () => {
        vi.useFakeTimers();
        const progress = { done: vi.fn(), fail: vi.fn() };
        vi.spyOn(cliProgress, 'startCliProgress').mockReturnValueOnce(progress);
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
        expect(progress.fail).toHaveBeenCalledOnce();
        expect(progress.done).not.toHaveBeenCalled();
    });

    it('keeps non-TTY transitions silent while still pausing and resuming', async () => {
        const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        const calls: string[] = [];
        const service = fakeService(calls);
        serviceBackend.mockReturnValue(service);
        daemonHealth.mockImplementation(() => ({
            healthy: service.status().loaded,
            state: 'test service',
            heartbeat: service.status().loaded ? { pid: 42, startedAt: '2026-08-28T00:00:00.000Z' } : undefined,
        }));
        try {
            await expect(
                withCapturePaused('purge', async () => {
                    calls.push('operation');
                }),
            ).resolves.toBe(true);
            expect(calls).toEqual(['stop', 'disable', 'operation', 'enable', 'start']);
            expect(write).not.toHaveBeenCalled();
            expect(log).not.toHaveBeenCalled();
        } finally {
            if (tty) {
                Object.defineProperty(process.stdout, 'isTTY', tty);
            } else {
                Reflect.deleteProperty(process.stdout, 'isTTY');
            }
        }
    });

    it('fails resume progress and propagates a service failure with a failing exit code', async () => {
        const calls: string[] = [];
        const service = fakeService(calls);
        const failure = new Error('service start failed');
        service.start = () => {
            throw failure;
        };
        serviceBackend.mockReturnValue(service);
        daemonHealth.mockImplementation(() => ({
            healthy: service.status().loaded,
            state: 'test service',
            heartbeat: service.status().loaded ? { pid: 42, startedAt: '2026-08-28T00:00:00.000Z' } : undefined,
        }));
        const pause = { done: vi.fn(), fail: vi.fn() };
        const resume = { done: vi.fn(), fail: vi.fn() };
        vi.spyOn(cliProgress, 'startCliProgress').mockReturnValueOnce(pause).mockReturnValueOnce(resume);

        await expect(
            withCapturePaused('purge', async () => {
                calls.push('operation');
            }),
        ).rejects.toBe(failure);

        expect(calls).toEqual(['stop', 'disable', 'operation', 'enable']);
        expect(pause.done).toHaveBeenCalledOnce();
        expect(resume.fail).toHaveBeenCalledOnce();
        expect(resume.done).not.toHaveBeenCalled();
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
    });
});
