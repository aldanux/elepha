import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStop, type StopCommandRuntime } from '../../src/cli/commands/stop.js';
import { DAEMON_BOOTOUT_DEADLINE_MS, DAEMON_HEALTH_CHECK_POLL_MS } from '../../src/config/constants.js';
import type { DaemonHealth } from '../../src/install/health-checks.js';
import type { ServiceBackend } from '../../src/install/service-backend.js';

function fixture() {
    let now = 0;
    const service = {
        launcherPath: '',
        manifestPath: '',
        transactionPath: '',
        artifactPaths: [],
        hasArtifacts: () => true,
        isInstalled: () => true,
        installationMatches: () => true,
        install: vi.fn(),
        uninstall: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        restart: vi.fn(),
        status: () => ({ loaded: false, disabled: false, unknown: false }),
        healthy: () => false,
        waitForHealthy: () => false,
        healthFailure: () => new Error('unhealthy'),
        enable: vi.fn(),
        disable: vi.fn(),
    } satisfies ServiceBackend;
    const runtime = {
        platform: 'darwin',
        createService: () => service,
        hasServiceArtifacts: () => true,
        daemonHealth: vi.fn<() => DaemonHealth>(() => ({ state: 'not running', healthy: false })),
        isPidAlive: vi.fn(() => false),
        now: () => now,
        sleep: vi.fn((milliseconds: number) => {
            now += milliseconds;
        }),
    } satisfies StopCommandRuntime;
    return { service, runtime };
}

async function run(runtime: StopCommandRuntime) {
    const program = new Command();
    registerStop(program, runtime);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    await program.parseAsync(['node', 'elepha', 'stop']);
    return { stdout: log.mock.calls.flat().join('\n'), stderr: error.mock.calls.flat().join('\n'), exitCode: process.exitCode };
}

afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
});

describe('elepha stop', () => {
    it.each(['darwin', 'linux'] as const)('stops the %s backend without disabling capture or changing consent', async (platform) => {
        const { service, runtime } = fixture();
        const result = await run({ ...runtime, platform });

        expect(service.stop).toHaveBeenCalledOnce();
        expect(service.disable).not.toHaveBeenCalled();
        expect(service.enable).not.toHaveBeenCalled();
        expect(service.start).not.toHaveBeenCalled();
        expect(service.uninstall).not.toHaveBeenCalled();
        expect(result.exitCode).toBeUndefined();
        expect(result.stdout).toMatch(/daemon stopped/i);
    });

    it('waits for the previous PID to exit even after stop clears a stale heartbeat', async () => {
        const { service, runtime } = fixture();
        runtime.daemonHealth.mockReturnValueOnce({
            state: 'stuck',
            healthy: false,
            heartbeat: { pid: 42, startedAt: 'old', updatedAt: 'old' },
        });
        runtime.isPidAlive.mockReturnValueOnce(true).mockReturnValueOnce(false);

        const result = await run(runtime);

        expect(service.stop).toHaveBeenCalledOnce();
        expect(runtime.isPidAlive).toHaveBeenNthCalledWith(1, 42);
        expect(runtime.isPidAlive).toHaveBeenNthCalledWith(2, 42);
        expect(runtime.sleep).toHaveBeenCalledExactlyOnceWith(DAEMON_HEALTH_CHECK_POLL_MS);
        expect(result.exitCode).toBeUndefined();
        expect(result.stdout).toMatch(/daemon stopped/i);
    });

    it('fails without a success message when the daemon remains alive after stop', async () => {
        const { runtime } = fixture();
        runtime.daemonHealth.mockReturnValueOnce({
            state: 'running',
            healthy: true,
            heartbeat: { pid: 42, startedAt: 'now', updatedAt: 'now' },
        });
        runtime.isPidAlive.mockReturnValue(true);

        const result = await run(runtime);

        expect(runtime.now()).toBe(DAEMON_BOOTOUT_DEADLINE_MS);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/pid 42.*still running/i);
    });

    it('checks a replacement heartbeat PID before confirming shutdown', async () => {
        const { runtime } = fixture();
        runtime.daemonHealth.mockReturnValueOnce({ state: 'not running', healthy: false }).mockReturnValue({
            state: 'running',
            healthy: true,
            heartbeat: { pid: 43, startedAt: 'now', updatedAt: 'now' },
        });
        runtime.isPidAlive.mockReturnValue(true);

        const result = await run(runtime);

        expect(runtime.isPidAlive).toHaveBeenCalledWith(43);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
    });

    it('reports backend failures without claiming shutdown succeeded', async () => {
        const { service, runtime } = fixture();
        service.stop.mockImplementation(() => {
            throw new Error('service stop failed');
        });

        const result = await run(runtime);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('service stop failed');
    });

    it('reports installation guidance when no managed service exists', async () => {
        const { service, runtime } = fixture();

        const result = await run({ ...runtime, hasServiceArtifacts: () => false });

        expect(service.stop).not.toHaveBeenCalled();
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('elepha install');
    });
});
