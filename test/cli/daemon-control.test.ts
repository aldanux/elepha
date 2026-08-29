import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeCaptureService } from '../../src/cli/capture-service.js';
import { type DaemonControlRuntime, registerDaemonControl } from '../../src/cli/commands/daemon-control.js';
import { DAEMON_HEALTH_CHECK_DEADLINE_MS, DAEMON_HEALTH_CHECK_POLL_MS } from '../../src/config/constants.js';
import type { Heartbeat } from '../../src/daemon/heartbeat.js';
import type { DaemonHealth } from '../../src/install/health-checks.js';
import { defaultLaunchdServicePaths, type LaunchctlExecutor, LaunchdBackend } from '../../src/install/launchd-backend.js';
import type { ServiceBackend } from '../../src/install/service-backend.js';
import { defaultSystemdServicePaths, type SystemctlExecutor, SystemdBackend } from '../../src/install/systemd-backend.js';

const STARTED_AT = '2026-08-28T00:00:00.000Z';

function heartbeat(pid = 42, startedAt = STARTED_AT, updatedAt = startedAt): Heartbeat {
    return { pid, startedAt, updatedAt };
}

function runningHealth(value = heartbeat()): DaemonHealth {
    return { state: `RUNNING (pid ${value.pid}, heartbeat 0s ago)`, healthy: true, heartbeat: value };
}

class FakeLaunchctl implements LaunchctlExecutor {
    calls: string[][] = [];

    constructor(
        private loaded: boolean,
        private disabled: boolean,
    ) {}

    run(args: readonly string[]) {
        this.calls.push([...args]);
        if (args[0] === 'print') return { stdout: '', stderr: '', status: this.loaded ? 0 : 3 };
        if (args[0] === 'print-disabled') {
            return { stdout: `"com.elepha.daemon" => ${this.disabled ? 'true' : 'false'}`, stderr: '', status: 0 };
        }
        if (args[0] === 'disable') this.disabled = true;
        if (args[0] === 'enable') this.disabled = false;
        if (args[0] === 'bootout') this.loaded = false;
        if (args[0] === 'bootstrap') this.loaded = true;
        return { stdout: '', stderr: '', status: 0 };
    }
}

function runtimeFor(executor: LaunchctlExecutor, overrides: Partial<DaemonControlRuntime> = {}): DaemonControlRuntime {
    const service = new LaunchdBackend(defaultLaunchdServicePaths('/tmp/elepha-daemon-control'), executor, 501);
    let now = 0;
    return {
        platform: 'darwin',
        createService: () => service,
        hasServiceArtifacts: () => true,
        daemonHealth: () => runningHealth(),
        now: () => now,
        sleep: (milliseconds) => {
            now += milliseconds;
        },
        ...overrides,
    };
}

class FakeSystemctl implements SystemctlExecutor {
    calls: string[][] = [];

    constructor(
        private active: boolean,
        private enabled: boolean,
    ) {}

    run(args: readonly string[]) {
        this.calls.push([...args]);
        const verb = args[1];
        if (verb === 'stop') this.active = false;
        if (verb === 'start') this.active = true;
        if (verb === 'disable') this.enabled = false;
        if (verb === 'enable') this.enabled = true;
        if (verb === 'is-active') {
            return { stdout: this.active ? 'active\n' : 'inactive\n', stderr: '', status: this.active ? 0 : 3 };
        }
        if (verb === 'is-enabled') {
            return { stdout: this.enabled ? 'enabled\n' : 'disabled\n', stderr: '', status: this.enabled ? 0 : 1 };
        }
        return { stdout: '', stderr: '', status: 0 };
    }
}

class TransportFailingSystemctl implements SystemctlExecutor {
    calls: string[][] = [];

    run(args: readonly string[]) {
        this.calls.push([...args]);
        return { stdout: args[1] === 'stop' ? '' : 'unknown\n', stderr: 'Failed to connect to bus', status: 1 };
    }
}

function linuxRuntime(
    executor: FakeSystemctl | TransportFailingSystemctl,
    paths = defaultSystemdServicePaths('/tmp/elepha-daemon-control-linux', {}),
): DaemonControlRuntime {
    const service = new SystemdBackend(paths, executor);
    let now = 0;
    return {
        platform: 'linux',
        createService: () => service,
        hasServiceArtifacts: () => true,
        daemonHealth: () =>
            executor.calls.some((args) => args[1] === 'start')
                ? runningHealth()
                : { state: 'NOT RUNNING (no heartbeat file)', healthy: false },
        now: () => now,
        sleep: (milliseconds) => {
            now += milliseconds;
        },
    };
}

async function runDaemonControl(
    command: 'pause' | 'resume' | 'restart',
    runtime: DaemonControlRuntime,
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((message) => stdout.push(String(message)));
    const error = vi.spyOn(console, 'error').mockImplementation((message) => stderr.push(String(message)));
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const program = new Command();
    registerDaemonControl(program, runtime);
    try {
        await program.parseAsync(['node', 'elepha', command]);
        return { stdout: `${stdout.join('\n')}\n`, stderr: `${stderr.join('\n')}\n`, exitCode: process.exitCode };
    } finally {
        process.exitCode = previousExitCode;
        log.mockRestore();
        error.mockRestore();
    }
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('elepha pause and resume', () => {
    it('pauses the systemd service on Linux', async () => {
        const executor = new FakeSystemctl(true, true);

        const result = await runDaemonControl('pause', linuxRuntime(executor));

        expect(result.exitCode).toBeUndefined();
        expect(executor.calls).toContainEqual(['--user', 'disable', 'elepha.service']);
        expect(executor.calls).toContainEqual(['--user', 'stop', 'elepha.service']);
    });

    it('resumes the systemd service on Linux', async () => {
        const executor = new FakeSystemctl(false, false);

        const result = await runDaemonControl('resume', linuxRuntime(executor));

        expect(result.exitCode).toBeUndefined();
        expect(executor.calls).toContainEqual(['--user', 'enable', 'elepha.service']);
        expect(executor.calls).toContainEqual(['--user', 'start', 'elepha.service']);
    });

    it('boots out then disables the live capture service and reports the paused state', async () => {
        const executor = new FakeLaunchctl(true, false);

        const result = await runDaemonControl('pause', runtimeFor(executor));

        expect(result.exitCode).toBeUndefined();
        expect(result.stdout).toContain('Capture daemon paused (loaded: false, disabled: true).');
        expect(executor.calls.filter(([verb]) => verb === 'disable' || verb === 'bootout').map(([verb]) => verb)).toEqual([
            'bootout',
            'disable',
        ]);
    });

    it('stops before disabling, so a loaded-only disable failure cannot leave capture running', async () => {
        const calls: string[] = [];
        let loaded = true;
        let disabled = false;
        const service: ServiceBackend = {
            launcherPath: '',
            manifestPath: '',
            transactionPath: '',
            artifactPaths: [],
            hasArtifacts: () => true,
            isInstalled: () => true,
            installationMatches: () => true,
            install: () => {},
            uninstall: () => {},
            start: () => {},
            stop: () => {
                calls.push('stop');
                loaded = false;
            },
            restart: () => {},
            status: () => ({ loaded, disabled, unknown: false }),
            healthy: () => true,
            waitForHealthy: () => true,
            healthFailure: () => new Error('unhealthy'),
            enable: () => {},
            disable: () => {
                calls.push('disable');
                if (loaded) {
                    throw new Error('disable cannot confirm state while loaded');
                }
                disabled = true;
            },
        };
        const runtime: DaemonControlRuntime = {
            platform: 'darwin',
            createService: () => service,
            hasServiceArtifacts: () => true,
            daemonHealth: () => runningHealth(),
            now: () => 0,
            sleep: () => {},
        };

        const result = await runDaemonControl('pause', runtime);

        expect(result.exitCode).toBeUndefined();
        expect(calls).toEqual(['stop', 'disable']);
        expect(result.stdout).toContain('Capture daemon paused (loaded: false, disabled: true).');
    });

    it('reports an already unloaded service as already paused without mutating launchctl state', async () => {
        const executor = new FakeLaunchctl(false, true);

        const result = await runDaemonControl('pause', runtimeFor(executor));

        expect(result.exitCode).toBeUndefined();
        expect(result.stdout).toContain('Capture daemon already paused');
        expect(executor.calls.some(([verb]) => verb === 'disable' || verb === 'bootout')).toBe(false);
    });

    it('disables an unloaded but enabled service instead of reporting it already paused', async () => {
        const calls: string[] = [];
        let disabled = false;
        const service: ServiceBackend = {
            launcherPath: '',
            manifestPath: '',
            transactionPath: '',
            artifactPaths: [],
            hasArtifacts: () => true,
            isInstalled: () => true,
            installationMatches: () => true,
            install: () => {},
            uninstall: () => {},
            start: () => {},
            stop: () => {
                calls.push('stop');
            },
            restart: () => {},
            status: () => ({ loaded: false, disabled, unknown: false }),
            healthy: () => true,
            waitForHealthy: () => true,
            healthFailure: () => new Error('unhealthy'),
            enable: () => {},
            disable: () => {
                calls.push('disable');
                disabled = true;
            },
        };
        const runtime: DaemonControlRuntime = {
            platform: 'linux',
            createService: () => service,
            hasServiceArtifacts: () => true,
            daemonHealth: () => runningHealth(),
            now: () => 0,
            sleep: () => {},
        };

        const result = await runDaemonControl('pause', runtime);

        expect(result.exitCode).toBeUndefined();
        expect(calls).toContain('disable');
        expect(result.stdout).toContain('Capture daemon paused (loaded: false, disabled: true).');
        expect(result.stdout).not.toContain('Capture daemon already paused');
    });

    it('fails loudly when launchd cannot prove the stopped service is disabled', async () => {
        let loaded = true;
        const executor: LaunchctlExecutor = {
            run(args) {
                if (args[0] === 'print') return { stdout: '', stderr: '', status: loaded ? 0 : 3 };
                if (args[0] === 'print-disabled') {
                    return { stdout: '\t\t"com.elepha.daemon" => enabled', stderr: '', status: 0 };
                }
                if (args[0] === 'bootout') {
                    loaded = false;
                    return { stdout: '', stderr: '', status: 0 };
                }
                if (args[0] === 'disable') {
                    return { stdout: '', stderr: 'Could not find service', status: 113 };
                }
                return { stdout: '', stderr: '', status: 0 };
            },
        };

        const result = await runDaemonControl('pause', runtimeFor(executor));

        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain('Capture daemon paused (');
        expect(result.stderr).toContain('launchctl disable');
        expect(result.stderr).toContain('status 113');
        expect(result.stderr).toContain('Could not find service');
        expect(result.stderr).toContain('loaded: false, disabled: false');
        expect(result.stderr).toContain('Capture may restart at the next login.');
    });

    it('fails an indeterminate systemd pause without clearing the heartbeat', async () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-daemon-control-linux-'));
        const paths = defaultSystemdServicePaths(home, {});
        const executor = new TransportFailingSystemctl();
        mkdirSync(path.dirname(paths.heartbeat), { recursive: true });
        writeFileSync(paths.heartbeat, '{}');

        const result = await runDaemonControl('pause', linuxRuntime(executor, paths));

        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain('Capture daemon already paused');
        expect(result.stdout).not.toContain('Capture daemon paused (');
        expect(result.stderr).toContain('systemctl --user stop');
        expect(existsSync(paths.heartbeat)).toBe(true);
        expect(executor.calls).toContainEqual(['--user', 'stop', 'elepha.service']);
        expect(executor.calls).not.toContainEqual(['--user', 'disable', 'elepha.service']);
    });

    it('refuses to resume an unloaded service while a foreign daemon is healthy', async () => {
        const executor = new FakeLaunchctl(false, true);
        const daemonHealth = vi.fn(() => runningHealth(heartbeat(7319)));

        const result = await runDaemonControl('resume', runtimeFor(executor, { daemonHealth }));

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('pid 7319');
        expect(result.stderr).toContain('stop that daemon before resuming');
        expect(daemonHealth).toHaveBeenCalledOnce();
        expect(executor.calls.some(([verb]) => verb === 'enable' || verb === 'bootstrap')).toBe(false);
    });

    it('does not accept the same pre-start heartbeat identity and times out with the real state', async () => {
        const executor = new FakeLaunchctl(false, true);
        const initialHeartbeat = heartbeat(42, STARTED_AT, '2026-08-28T00:00:00.000Z');
        const refreshedHeartbeat = { ...initialHeartbeat, updatedAt: '2026-08-28T00:01:00.000Z' };
        let healthChecks = 0;
        let now = 0;
        const runtime = runtimeFor(executor, {
            daemonHealth: () => {
                healthChecks += 1;
                return healthChecks === 1
                    ? {
                          state: 'STUCK (pid 42 alive, but heartbeat is 2m old - process may be hung)',
                          healthy: false,
                          heartbeat: initialHeartbeat,
                      }
                    : runningHealth(refreshedHeartbeat);
            },
            now: () => now,
            sleep: (milliseconds) => {
                now += milliseconds;
            },
        });

        const result = await runDaemonControl('resume', runtime);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('RUNNING (pid 42, heartbeat 0s ago)');
        expect(result.stderr).toContain('elepha doctor');
        expect(now).toBe(DAEMON_HEALTH_CHECK_DEADLINE_MS);
        expect(executor.calls.filter(([verb]) => verb === 'enable' || verb === 'bootstrap').map(([verb]) => verb)).toEqual([
            'enable',
            'bootstrap',
        ]);
    });

    it('accepts a fresh heartbeat identity after ignoring an updated old identity', async () => {
        const executor = new FakeLaunchctl(false, true);
        const initialHeartbeat = heartbeat(42, STARTED_AT, '2026-08-28T00:00:00.000Z');
        const sameIdentity = { ...initialHeartbeat, updatedAt: '2026-08-28T00:01:00.000Z' };
        const freshIdentity = heartbeat(42, '2026-08-28T00:02:00.000Z', '2026-08-28T00:02:00.000Z');
        let healthChecks = 0;
        let now = 0;
        const sleeps: number[] = [];
        const runtime = runtimeFor(executor, {
            daemonHealth: () => {
                healthChecks += 1;
                if (healthChecks === 1) {
                    return {
                        state: 'STUCK (pid 42 alive, but heartbeat is 2m old - process may be hung)',
                        healthy: false,
                        heartbeat: initialHeartbeat,
                    };
                }
                return runningHealth(healthChecks === 2 ? sameIdentity : freshIdentity);
            },
            now: () => now,
            sleep: (milliseconds) => {
                sleeps.push(milliseconds);
                now += milliseconds;
            },
        });

        const result = await runDaemonControl('resume', runtime);

        expect(result.exitCode).toBeUndefined();
        expect(result.stdout).toContain('Capture daemon running (RUNNING (pid 42, heartbeat 0s ago)).');
        expect(healthChecks).toBe(3);
        expect(sleeps).toEqual([DAEMON_HEALTH_CHECK_POLL_MS]);
    });

    it('reports running only when the daemon becomes healthy on the third poll', async () => {
        const executor = new FakeLaunchctl(false, true);
        let now = 0;
        let polls = 0;
        const sleeps: number[] = [];
        const runtime = runtimeFor(executor, {
            daemonHealth: () => {
                if (!executor.calls.some(([verb]) => verb === 'bootstrap')) {
                    return { state: 'NOT RUNNING (no heartbeat file)', healthy: false };
                }
                polls += 1;
                return polls >= 3 ? runningHealth() : { state: 'NOT RUNNING (no heartbeat file)', healthy: false };
            },
            now: () => now,
            sleep: (milliseconds) => {
                sleeps.push(milliseconds);
                now += milliseconds;
            },
        });

        const result = await runDaemonControl('resume', runtime);

        expect(result.exitCode).toBeUndefined();
        expect(result.stdout).toContain('Capture daemon running (RUNNING (pid 42, heartbeat 0s ago)).');
        expect(polls).toBe(3);
        expect(sleeps).toEqual([DAEMON_HEALTH_CHECK_POLL_MS, DAEMON_HEALTH_CHECK_POLL_MS]);
        expect(executor.calls.filter(([verb]) => verb === 'enable' || verb === 'bootstrap').map(([verb]) => verb)).toEqual([
            'enable',
            'bootstrap',
        ]);
    });

    it('reports already running only when the service and heartbeat are healthy', async () => {
        const executor = new FakeLaunchctl(true, false);
        const runtime = runtimeFor(executor);
        const transition = resumeCaptureService(runtime.createService(), runtime);

        const result = await runDaemonControl('resume', runtime);

        expect(transition.changed).toBe(false);
        expect(result.exitCode).toBeUndefined();
        expect(result.stdout).toContain('Capture daemon already running (RUNNING (pid 42, heartbeat 0s ago)).');
        expect(executor.calls.some(([verb]) => verb === 'enable' || verb === 'bootstrap')).toBe(false);
    });

    it('enables a loaded disabled healthy service without restarting or requiring a new identity', () => {
        const executor = new FakeLaunchctl(true, true);
        const daemonHealth = vi.fn(() => runningHealth());
        const runtime = runtimeFor(executor, { daemonHealth });

        const transition = resumeCaptureService(runtime.createService(), runtime);

        expect(transition.changed).toBe(true);
        expect(daemonHealth).toHaveBeenCalledOnce();
        expect(executor.calls.filter(([verb]) => verb === 'enable' || verb === 'bootstrap').map(([verb]) => verb)).toEqual(['enable']);
    });

    it('reports the final unhealthy state and doctor hint when resume times out', async () => {
        const executor = new FakeLaunchctl(true, false);
        let now = 0;
        const runtime = runtimeFor(executor, {
            daemonHealth: () => ({
                state: 'STUCK (pid 42 alive, but heartbeat is 2m old - process may be hung)',
                healthy: false,
                heartbeat: heartbeat(),
            }),
            now: () => now,
            sleep: (milliseconds) => {
                now += milliseconds;
            },
        });
        const start = vi.spyOn(runtime.createService(), 'start');

        const result = await runDaemonControl('resume', runtime);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain('Capture daemon running');
        expect(result.stdout).not.toContain('Capture daemon already running');
        expect(result.stderr).toContain('STUCK (pid 42 alive, but heartbeat is 2m old - process may be hung)');
        expect(result.stderr).toContain('elepha doctor');
        expect(now).toBe(DAEMON_HEALTH_CHECK_DEADLINE_MS);
        expect(executor.calls.some(([verb]) => verb === 'enable')).toBe(true);
        expect(start).toHaveBeenCalledOnce();
    });

    it('restarts capture by pausing then resuming and reports the running state', async () => {
        const executor = new FakeLaunchctl(true, false);
        const runtime = runtimeFor(executor, {
            daemonHealth: () =>
                executor.calls.some(([verb]) => verb === 'bootstrap')
                    ? runningHealth(heartbeat(43, '2026-08-28T00:01:00.000Z'))
                    : { state: 'NOT RUNNING (no heartbeat file)', healthy: false },
        });

        const result = await runDaemonControl('restart', runtime);

        expect(result.exitCode).toBeUndefined();
        expect(result.stdout).toBe('Capture daemon restarted (RUNNING (pid 43, heartbeat 0s ago)).\n');
        expect(
            executor.calls.filter(([verb]) => ['bootout', 'disable', 'enable', 'bootstrap'].includes(verb)).map(([verb]) => verb),
        ).toEqual(['bootout', 'disable', 'enable', 'bootstrap']);
    });

    it('enables without restarting when the loaded service state is indeterminate but healthy', async () => {
        const calls: string[] = [];
        const service: ServiceBackend = {
            launcherPath: '',
            manifestPath: '',
            transactionPath: '',
            artifactPaths: [],
            hasArtifacts: () => true,
            isInstalled: () => true,
            installationMatches: () => true,
            install: () => {},
            uninstall: () => {},
            start: () => calls.push('start'),
            stop: () => {},
            restart: () => {},
            status: () => ({ loaded: true, disabled: false, unknown: true }),
            healthy: () => true,
            waitForHealthy: () => true,
            healthFailure: () => new Error('unhealthy'),
            enable: () => calls.push('enable'),
            disable: () => {},
        };
        const runtime: DaemonControlRuntime = {
            platform: 'linux',
            createService: () => service,
            hasServiceArtifacts: () => true,
            daemonHealth: () => runningHealth(),
            now: () => 0,
            sleep: () => {},
        };

        const result = await runDaemonControl('resume', runtime);

        expect(result.exitCode).toBeUndefined();
        expect(calls).toEqual(['enable']);
        expect(result.stdout).toContain('Capture daemon running (RUNNING (pid 42, heartbeat 0s ago)).');
    });

    it.each([
        { name: 'Windows pause', command: 'pause' as const, platform: 'win32' as const, installed: true },
        { name: 'Windows resume', command: 'resume' as const, platform: 'win32' as const, installed: true },
        { name: 'uninstalled', command: 'pause' as const, platform: 'darwin' as const, installed: false },
        { name: 'uninstalled restart', command: 'restart' as const, platform: 'darwin' as const, installed: false },
    ])('$name exits with installation guidance and does not call the service backend', async ({ command, platform, installed }) => {
        const executor = new FakeLaunchctl(true, false);
        const runtime = runtimeFor(executor, { platform, hasServiceArtifacts: () => installed });

        const result = await runDaemonControl(command, runtime);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('elepha capture service control is available on macOS and Linux after `elepha install`');
        expect(executor.calls).toEqual([]);
    });
});
