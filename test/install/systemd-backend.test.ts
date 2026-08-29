import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, SYSTEMD_SERVICE_NAME } from '../../src/config/constants.js';
import { elephaPaths } from '../../src/config/paths.js';
import { launcherHash } from '../../src/install/launcher.js';
import { physicalInstallPath } from '../../src/install/service-manifest.js';
import {
    defaultSystemdServicePaths,
    renderDaemonUnit,
    type SystemctlExecutor,
    SystemdBackend,
    systemdArtifactsMatch,
} from '../../src/install/systemd-backend.js';

const savedEnvironment = { ...process.env };
const propagatedEnvironmentKeys = [
    'ELEPHA_HOME',
    'ELEPHA_DB_PATH',
    'ELEPHA_ENV_FILE',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'ELEPHA_CLAUDE_MCP_PATH',
] as const;

afterEach(() => {
    process.env = { ...savedEnvironment };
});

beforeEach(() => {
    for (const key of propagatedEnvironmentKeys) {
        delete process.env[key];
    }
});

class FakeSystemctl implements SystemctlExecutor {
    active = false;
    enabled = false;
    known = true;
    calls: string[][] = [];

    run(args: readonly string[]) {
        this.calls.push([...args]);
        const verb = args[1];
        if (verb === 'start' || verb === 'restart') this.active = true;
        if (verb === 'stop') this.active = false;
        if (verb === 'enable') this.enabled = true;
        if (verb === 'disable') this.enabled = false;
        if (verb === 'is-active') {
            if (!this.known) return { stdout: 'unknown\n', stderr: '', status: 4 };
            return { stdout: this.active ? 'active\n' : 'inactive\n', stderr: '', status: this.active ? 0 : 3 };
        }
        if (verb === 'is-enabled') {
            if (!this.known) return { stdout: 'not-found\n', stderr: '', status: 4 };
            return { stdout: this.enabled ? 'enabled\n' : 'disabled\n', stderr: '', status: this.enabled ? 0 : 1 };
        }
        return { stdout: '', stderr: '', status: 0 };
    }
}

class ScriptedSystemctl implements SystemctlExecutor {
    calls: string[][] = [];

    constructor(private readonly results: ReturnType<SystemctlExecutor['run']>[]) {}

    run(args: readonly string[]) {
        this.calls.push([...args]);
        const result = this.results.shift();
        if (!result) throw new Error('unexpected systemctl call');
        return result;
    }
}

describe('systemd service ownership', () => {
    it('uses XDG_CONFIG_HOME only for the user unit and keeps other artifacts under ELEPHA_HOME', () => {
        const home = '/home/test';
        const layout = elephaPaths(home);
        const paths = defaultSystemdServicePaths(home, { XDG_CONFIG_HOME: '/var/lib/test-config' });

        expect(paths).toEqual({
            home,
            launcher: layout.launcher,
            unit: path.join('/var/lib/test-config', 'systemd', 'user', SYSTEMD_SERVICE_NAME),
            state: layout.installState,
            transaction: layout.installTransaction,
            heartbeat: layout.heartbeat,
            stdout: layout.stdout,
            stderr: layout.stderr,
        });
        expect(defaultSystemdServicePaths(home, {}).unit).toBe(path.join(home, '.config', 'systemd', 'user', SYSTEMD_SERVICE_NAME));
    });

    it('renders a deterministic, hash-stable user unit around the shared launcher', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-systemd-'));
        const paths = defaultSystemdServicePaths(home, {});
        const environment = {
            ELEPHA_HOME: path.join(home, 'isolated-elepha'),
            CODEX_HOME: path.join(home, 'isolated-codex'),
            ANTHROPIC_API_KEY: 'must-not-enter-a-unit',
        };

        const first = renderDaemonUnit(paths, environment);
        const second = renderDaemonUnit(paths, environment);

        expect(second).toBe(first);
        expect(launcherHash(second)).toBe(launcherHash(first));
        expect(first).toContain('[Unit]\n');
        expect(first).toContain(`[Service]\nExecStart=${physicalInstallPath(paths.launcher)} start\n`);
        expect(first).toContain('Restart=on-failure\nRestartSec=30\nUMask=0077\n');
        expect(first).toContain('[Install]\nWantedBy=default.target\n');
        expect(first).toContain(`Environment="ELEPHA_HOME=${physicalInstallPath(environment.ELEPHA_HOME)}"`);
        expect(first).not.toContain('must-not-enter-a-unit');
        expect(first).not.toContain('/node_modules/');
    });

    it('writes matching private artifacts, reloads systemd, and detects launcher or unit drift', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-systemd-'));
        const paths = defaultSystemdServicePaths(home, {});
        const executor = new FakeSystemctl();
        const service = new SystemdBackend(paths, executor);
        const launcher = '#!/bin/sh\nset -eu\n';

        service.install(launcher, { kind: 'standalone', command: '/usr/bin/elepha', node: '/usr/bin/node' });

        expect(executor.calls).toEqual([['--user', 'daemon-reload']]);
        expect(readFileSync(paths.unit, 'utf8')).toBe(renderDaemonUnit(paths));
        expect(statSync(paths.launcher).mode & 0o777).toBe(PRIVATE_DIR_MODE);
        expect(statSync(paths.unit).mode & 0o777).toBe(PRIVATE_FILE_MODE);
        expect(systemdArtifactsMatch(paths)).toBe(true);
        expect(service.installationMatches(launcher)).toBe(true);
        expect(service.installationMatches('#!/bin/sh\n# changed\n')).toBe(false);

        writeFileSync(paths.unit, `${readFileSync(paths.unit, 'utf8')}# modified\n`);
        expect(systemdArtifactsMatch(paths)).toBe(false);
        expect(() => service.installationMatches(launcher)).toThrow(
            'managed daemon service artifact was modified; refusing to overwrite it',
        );
    });

    it('runs install and uninstall lifecycle verbs in order, including both daemon reloads', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-systemd-'));
        const paths = defaultSystemdServicePaths(home, {});
        const executor = new FakeSystemctl();
        const service = new SystemdBackend(paths, executor);

        service.install('#!/bin/sh\n', { kind: 'standalone', command: '/usr/bin/elepha', node: '/usr/bin/node' });
        service.uninstall();

        expect(executor.calls).toEqual([
            ['--user', 'daemon-reload'],
            ['--user', 'stop', SYSTEMD_SERVICE_NAME],
            ['--user', 'disable', SYSTEMD_SERVICE_NAME],
            ['--user', 'daemon-reload'],
        ]);
        expect(existsSync(paths.launcher)).toBe(false);
        expect(existsSync(paths.unit)).toBe(false);
        expect(existsSync(paths.state)).toBe(false);
    });

    it('maps every control method to its fixed systemctl user-service invocation', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-systemd-'));
        const executor = new FakeSystemctl();
        const service = new SystemdBackend(defaultSystemdServicePaths(home, {}), executor);

        service.start();
        service.stop();
        service.restart();
        service.enable();
        service.disable();

        expect(executor.calls).toEqual([
            ['--user', 'start', SYSTEMD_SERVICE_NAME],
            ['--user', 'stop', SYSTEMD_SERVICE_NAME],
            ['--user', 'restart', SYSTEMD_SERVICE_NAME],
            ['--user', 'enable', SYSTEMD_SERVICE_NAME],
            ['--user', 'disable', SYSTEMD_SERVICE_NAME],
        ]);
    });

    it('decides failed stop outcomes from observed active state and preserves heartbeat on refusal', () => {
        const cases = [
            { state: 'inactive', probe: { stdout: 'inactive\n', stderr: '', status: 3 }, rejects: false },
            { state: 'active', probe: { stdout: 'active\n', stderr: '', status: 0 }, rejects: true },
            { state: 'unknown', probe: { stdout: 'unknown\n', stderr: 'Failed to connect to bus', status: 1 }, rejects: true },
        ] as const;

        for (const testCase of cases) {
            const home = mkdtempSync(path.join(tmpdir(), 'elepha-systemd-'));
            const paths = defaultSystemdServicePaths(home, {});
            const executor = new ScriptedSystemctl([{ stdout: '', stderr: 'Unit elepha.service not loaded.', status: 5 }, testCase.probe]);
            const service = new SystemdBackend(paths, executor);
            mkdirSync(path.dirname(paths.heartbeat), { recursive: true });
            writeFileSync(paths.heartbeat, '{}');

            if (testCase.rejects) {
                expect(() => service.stop(), testCase.state).toThrow('systemctl --user stop');
            } else {
                expect(() => service.stop(), testCase.state).not.toThrow();
            }

            expect(existsSync(paths.heartbeat), testCase.state).toBe(testCase.rejects);
            expect(executor.calls).toEqual([
                ['--user', 'stop', SYSTEMD_SERVICE_NAME],
                ['--user', 'is-active', SYSTEMD_SERVICE_NAME],
            ]);
        }
    });

    it('decides failed disable outcomes from observed enabled state and refuses unknown state', () => {
        const cases = [
            { state: 'disabled', probe: { stdout: 'disabled\n', stderr: '', status: 1 }, rejects: false },
            { state: 'enabled', probe: { stdout: 'enabled\n', stderr: '', status: 0 }, rejects: true },
            { state: 'unknown', probe: { stdout: '', stderr: 'Failed to connect to bus', status: 1 }, rejects: true },
        ] as const;

        for (const testCase of cases) {
            const home = mkdtempSync(path.join(tmpdir(), 'elepha-systemd-'));
            const executor = new ScriptedSystemctl([{ stdout: '', stderr: '', status: 1 }, testCase.probe]);
            const service = new SystemdBackend(defaultSystemdServicePaths(home, {}), executor);

            if (testCase.rejects) {
                expect(() => service.disable(), testCase.state).toThrow('systemctl --user disable');
            } else {
                expect(() => service.disable(), testCase.state).not.toThrow();
            }
            expect(executor.calls).toEqual([
                ['--user', 'disable', SYSTEMD_SERVICE_NAME],
                ['--user', 'is-enabled', SYSTEMD_SERVICE_NAME],
            ]);
        }
    });

    it('maps enabled, disabled, and unknown unit states without treating inactivity as absence', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-systemd-'));
        const executor = new FakeSystemctl();
        const service = new SystemdBackend(defaultSystemdServicePaths(home, {}), executor);

        executor.active = true;
        executor.enabled = true;
        expect(service.status()).toEqual({ loaded: true, disabled: false, unknown: false });

        executor.active = false;
        executor.enabled = false;
        expect(service.status()).toEqual({ loaded: true, disabled: true, unknown: false });

        executor.known = false;
        expect(service.status()).toEqual({ loaded: true, disabled: false, unknown: true });
        expect(executor.calls.slice(-2)).toEqual([
            ['--user', 'is-enabled', SYSTEMD_SERVICE_NAME],
            ['--user', 'is-active', SYSTEMD_SERVICE_NAME],
        ]);
    });

    it('uses the shared heartbeat waiter instead of systemctl status', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-systemd-'));
        const executor = new FakeSystemctl();
        let now = 0;
        const service = new SystemdBackend(defaultSystemdServicePaths(home, {}), executor, {
            now: () => now,
            sleep(milliseconds) {
                now += milliseconds;
            },
        });
        vi.spyOn(service, 'healthy').mockImplementation(() => now >= 500);

        expect(service.waitForHealthy()).toBe(true);
        expect(now).toBe(500);
        expect(executor.calls).toEqual([]);
    });
});
