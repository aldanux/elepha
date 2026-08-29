import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_HEALTH_CHECK_DEADLINE_MS } from '../../src/config/constants.js';
import {
    type DaemonHealthCheckRuntime,
    defaultLaunchdServicePaths,
    type LaunchctlExecutor,
    LaunchdBackend,
} from '../../src/install/launchd-backend.js';
import type { LauncherBackend } from '../../src/install/launcher.js';
import { defaultSystemdServicePaths, type SystemctlExecutor, SystemdBackend } from '../../src/install/systemd-backend.js';

const bin = '/opt/npm/bin/elepha';
const launcherMock = vi.hoisted(() => ({
    backend: { kind: 'standalone', command: '/usr/local/bin/elepha', node: '/usr/local/bin/node' } as LauncherBackend,
    text: '#!/bin/sh\nset -eu\n',
}));

// Vitest invokes these factories when the mocked modules are imported; the IDE cannot trace that use.
//noinspection JSUnusedGlobalSymbols
vi.mock('../../src/install/binary.js', () => ({
    hookCommand: (command: string, tool: 'claude-code' | 'codex', hook = 'session-start') => `${command} hook ${hook} --tool ${tool}`,
    resolveInstalledElephaBin: () => ({ bin, packageRoot: '/opt/npm/lib/node_modules/elepha' }),
}));

// Vitest invokes this factory when the mocked module is imported; the IDE cannot trace that use.
//noinspection JSUnusedGlobalSymbols
vi.mock('../../src/install/launcher.js', () => ({
    detectLauncherBackend: () => launcherMock.backend,
    renderLauncher: () => launcherMock.text,
    launcherHash: (text: string) => `hash:${text}`,
}));

// Vitest invokes this factory when the mocked module is imported; the IDE cannot trace that use.
//noinspection JSUnusedGlobalSymbols
vi.mock('../../src/install/config-file.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/install/config-file.js')>('../../src/install/config-file.js');
    return { ...actual, applyConfigTransaction: vi.fn(actual.applyConfigTransaction) };
});

const { installElepha, readRollbackJournal, serviceArtifactsMatchOrWrite, uninstallElepha } = await import(
    '../../src/install/installer.js'
);
const configFile = await import('../../src/install/config-file.js');

const savedEnvironment = { ...process.env };

afterEach(() => {
    process.env = { ...savedEnvironment };
    vi.restoreAllMocks();
});

beforeEach(() => {
    delete process.env.ELEPHA_SERVICE_LABEL;
    launcherMock.backend = { kind: 'standalone', command: '/usr/local/bin/elepha', node: '/usr/local/bin/node' };
    launcherMock.text = '#!/bin/sh\nset -eu\n';
});

function installPaths(root: string) {
    return {
        claudeSettings: path.join(root, '.claude', 'settings.json'),
        claudeMcp: path.join(root, '.claude.json'),
        codexConfig: path.join(root, '.codex', 'config.toml'),
    };
}

function createConfigDirectories(paths: ReturnType<typeof installPaths>): void {
    mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
    mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
}

function serviceRuntime(home: string, executor: LaunchctlExecutor, approvedRoots: number, healthCheck?: DaemonHealthCheckRuntime) {
    return {
        home,
        service: new LaunchdBackend(defaultLaunchdServicePaths(home), executor, 501, healthCheck),
        approvedRoots,
    };
}

class FakeSystemctl implements SystemctlExecutor {
    active = false;
    enabled = false;
    calls: string[][] = [];

    run(args: readonly string[]) {
        this.calls.push([...args]);
        const verb = args[1];
        if (verb === 'start') this.active = true;
        if (verb === 'stop') this.active = false;
        if (verb === 'enable') this.enabled = true;
        if (verb === 'disable') this.enabled = false;
        if (verb === 'is-active') {
            return { stdout: this.active ? 'active\n' : 'inactive\n', stderr: '', status: this.active ? 0 : 3 };
        }
        if (verb === 'is-enabled') {
            return { stdout: this.enabled ? 'enabled\n' : 'disabled\n', stderr: '', status: this.enabled ? 0 : 1 };
        }
        return { stdout: '', stderr: '', status: 0 };
    }
}

describe('three-file installer transaction', () => {
    it('reports the tool-agnostic integration registration phase', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-phase-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, '{}');
        writeFileSync(paths.codexConfig, '');
        const phases: string[] = [];

        installElepha(paths, {
            approvedRoots: 1,
            onPhase: (phase, event) => phases.push(`${event}:${phase}`),
        });

        expect(phases).toEqual([
            'start:Preparing hooks & MCP',
            'done:Preparing hooks & MCP',
            'start:Registering integrations',
            'done:Registering integrations',
        ]);
    });

    it('runs install and uninstall through the systemd backend on Linux', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-linux-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, '{}');
        writeFileSync(paths.codexConfig, '');
        const executor = new FakeSystemctl();
        const servicePaths = defaultSystemdServicePaths(root, {});
        const service = new SystemdBackend(servicePaths, executor);
        const runtime = {
            platform: 'linux' as const,
            home: root,
            service,
            serviceManager: { hasSystemd: true, isWsl: false },
            approvedRoots: 0,
        };

        expect(installElepha(paths, runtime).service).toBe('registered, awaiting consent');
        expect(existsSync(servicePaths.unit)).toBe(true);

        expect(uninstallElepha(paths, runtime).service).toBe('not installed');
        expect(existsSync(servicePaths.unit)).toBe(false);
        expect(executor.calls).toContainEqual(['--user', 'daemon-reload']);
        expect(executor.calls).toContainEqual(['--user', 'disable', 'elepha.service']);
    });

    it('rejects WSL without systemd before writing config, service artifacts, or a journal', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-wsl-preflight-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        const original = { claudeSettings: '{}', claudeMcp: '{}', codexConfig: '# untouched\n' };
        writeFileSync(paths.claudeSettings, original.claudeSettings);
        writeFileSync(paths.claudeMcp, original.claudeMcp);
        writeFileSync(paths.codexConfig, original.codexConfig);
        const executor = new FakeSystemctl();
        const servicePaths = defaultSystemdServicePaths(root, {});
        const service = new SystemdBackend(servicePaths, executor);

        expect(() =>
            installElepha(paths, {
                platform: 'linux',
                home: root,
                service,
                serviceManager: { hasSystemd: false, isWsl: true },
                approvedRoots: 0,
            }),
        ).toThrow('wsl --shutdown');

        expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(original.claudeSettings);
        expect(readFileSync(paths.claudeMcp, 'utf8')).toBe(original.claudeMcp);
        expect(readFileSync(paths.codexConfig, 'utf8')).toBe(original.codexConfig);
        expect(executor.calls).toEqual([]);
        expect(existsSync(servicePaths.unit)).toBe(false);
        expect(existsSync(servicePaths.transaction)).toBe(false);
    });

    it.each([
        ['install', installElepha],
        ['uninstall', uninstallElepha],
    ] as const)('refuses %s on Windows before touching lifecycle state', (_operation, lifecycle) => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-win32-'));

        expect(() => lifecycle(installPaths(root), { platform: 'win32', home: root, approvedRoots: 0 })).toThrow(
            'supported on macOS and Linux',
        );
    });

    it('rewrites managed artifacts when the freshly rendered launcher changes backend', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-launcher-refresh-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, '{}');
        writeFileSync(paths.codexConfig, '');
        const executor = {
            run(args: readonly string[]) {
                if (args[0] === 'print') return { stdout: '', stderr: '', status: 3 };
                if (args[0] === 'print-disabled') return { stdout: '"com.elepha.daemon" => true', stderr: '', status: 0 };
                return { stdout: '', stderr: '', status: 0 };
            },
        };

        installElepha(paths, serviceRuntime(root, executor, 0));
        const launcher = path.join(root, '.elepha', 'bin', 'elepha');
        expect(readFileSync(launcher, 'utf8')).toBe('#!/bin/sh\nset -eu\n');

        launcherMock.backend = {
            kind: 'homebrew',
            command: '/opt/homebrew/bin/elepha',
            node: '/opt/homebrew/bin/node',
            npmBin: '/opt/homebrew/bin',
        };
        launcherMock.text = '#!/bin/sh\nset -eu\n# homebrew\n';
        const service = new LaunchdBackend(defaultLaunchdServicePaths(root), executor);
        expect(serviceArtifactsMatchOrWrite(service, launcherMock.text)).toBe(false);
        const writeArtifacts = vi.spyOn(LaunchdBackend.prototype, 'install');
        installElepha(paths, serviceRuntime(root, executor, 0));

        expect(readFileSync(launcher, 'utf8')).toBe(launcherMock.text);
        expect(writeArtifacts).toHaveBeenCalledWith(launcherMock.text, launcherMock.backend);
    });

    it('leaves exact-match managed artifacts untouched on a repeated install', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-launcher-repeat-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, '{}');
        writeFileSync(paths.codexConfig, '');
        const executor = {
            run(args: readonly string[]) {
                if (args[0] === 'print') return { stdout: '', stderr: '', status: 3 };
                if (args[0] === 'print-disabled') return { stdout: '"com.elepha.daemon" => true', stderr: '', status: 0 };
                return { stdout: '', stderr: '', status: 0 };
            },
        };

        installElepha(paths, serviceRuntime(root, executor, 0));
        const service = new LaunchdBackend(defaultLaunchdServicePaths(root), executor);
        expect(serviceArtifactsMatchOrWrite(service, launcherMock.text)).toBe(true);
        const writeArtifacts = vi.spyOn(LaunchdBackend.prototype, 'install');
        installElepha(paths, serviceRuntime(root, executor, 0));

        expect(writeArtifacts).not.toHaveBeenCalled();
    });

    it('refuses to overwrite a user-modified managed artifact', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-launcher-modified-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, '{}');
        writeFileSync(paths.codexConfig, '');
        const executor = {
            run(args: readonly string[]) {
                if (args[0] === 'print') return { stdout: '', stderr: '', status: 3 };
                if (args[0] === 'print-disabled') return { stdout: '"com.elepha.daemon" => true', stderr: '', status: 0 };
                return { stdout: '', stderr: '', status: 0 };
            },
        };

        installElepha(paths, serviceRuntime(root, executor, 0));
        const launcher = path.join(root, '.elepha', 'bin', 'elepha');
        writeFileSync(launcher, '# user modified\n');
        const service = new LaunchdBackend(defaultLaunchdServicePaths(root), executor);

        expect(() => serviceArtifactsMatchOrWrite(service, launcherMock.text)).toThrow(
            'managed daemon service artifact was modified; refusing to overwrite it',
        );
    });

    it('runs the injected inert install -> approval projection -> uninstall lifecycle without a real launchctl domain', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-service-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, '{}');
        writeFileSync(paths.codexConfig, '');
        let loaded = false;
        let disabled = false;
        const executor = {
            run(args: readonly string[]) {
                if (args[0] === 'print') return { stdout: '', stderr: '', status: loaded ? 0 : 3 };
                if (args[0] === 'print-disabled') {
                    return { stdout: `"com.elepha.daemon" => ${disabled ? 'true' : 'false'}`, stderr: '', status: 0 };
                }
                if (args[0] === 'disable') disabled = true;
                if (args[0] === 'enable') disabled = false;
                if (args[0] === 'bootstrap') {
                    loaded = true;
                    writeFileSync(
                        path.join(root, '.elepha', 'daemon.heartbeat.json'),
                        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
                    );
                }
                if (args[0] === 'bootout') loaded = false;
                return { stdout: '', stderr: '', status: 0 };
            },
        };

        const inert = installElepha(paths, serviceRuntime(root, executor, 0));
        expect(inert.service).toBe('registered, awaiting consent');
        expect(disabled).toBe(true);
        expect(loaded).toBe(false);
        expect(readFileSync(paths.claudeSettings, 'utf8')).toContain(path.join(root, '.elepha', 'bin', 'elepha'));

        const active = installElepha(paths, serviceRuntime(root, executor, 1));
        expect(active.service).toBe('active');
        expect(loaded).toBe(true);
        expect(disabled).toBe(false);

        const uninstallRuntime = serviceRuntime(root, executor, 0);
        const uninstallService = uninstallRuntime.service;
        const originalUninstall = uninstallService.uninstall.bind(uninstallService);
        vi.spyOn(uninstallService, 'uninstall').mockImplementation(() => {
            expect(readRollbackJournal(uninstallService.transactionPath)).toMatchObject({
                service: { loaded: true, disabled: false, unknown: false },
            });
            originalUninstall();
        });

        const removed = uninstallElepha(paths, uninstallRuntime);
        expect(removed.service).toBe('not installed');
        expect(existsSync(path.join(root, '.elepha', 'bin', 'elepha'))).toBe(false);
        expect(existsSync(path.join(root, 'Library', 'LaunchAgents', 'com.elepha.daemon.plist'))).toBe(false);
        expect(existsSync(uninstallService.transactionPath)).toBe(false);
    });

    it('waits for a late managed heartbeat during install', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-late-heartbeat-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, '{}');
        writeFileSync(paths.codexConfig, '');
        const heartbeat = path.join(root, '.elepha', 'daemon.heartbeat.json');
        let loaded = false;
        let now = 0;
        const executor = {
            run(args: readonly string[]) {
                if (args[0] === 'print') return { stdout: '', stderr: '', status: loaded ? 0 : 3 };
                if (args[0] === 'print-disabled') return { stdout: '"com.elepha.daemon" => false', stderr: '', status: 0 };
                if (args[0] === 'bootstrap') loaded = true;
                if (args[0] === 'bootout') loaded = false;
                return { stdout: '', stderr: '', status: 0 };
            },
        };
        const phases: string[] = [];

        const result = installElepha(paths, {
            ...serviceRuntime(root, executor, 1, {
                now: () => now,
                sleep(milliseconds) {
                    now += milliseconds;
                    if (now === DAEMON_HEALTH_CHECK_DEADLINE_MS - 250) {
                        writeFileSync(
                            heartbeat,
                            JSON.stringify({
                                pid: process.pid,
                                startedAt: new Date(now).toISOString(),
                                updatedAt: new Date(now).toISOString(),
                            }),
                        );
                    }
                },
            }),
            onPhase: (phase, event) => phases.push(`${event}:${phase}`),
        });

        expect(result.service).toBe('active');
        expect(now).toBe(DAEMON_HEALTH_CHECK_DEADLINE_MS - 250);
        expect(phases).toEqual([
            'start:Preparing hooks & MCP',
            'done:Preparing hooks & MCP',
            'start:Registering integrations',
            'done:Registering integrations',
            'start:Starting the capture daemon',
            'done:Starting the capture daemon',
        ]);
    });

    it('waits for the complete deadline before failing the replacement and accepts a late rollback heartbeat', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-rollback-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        const original = { claudeSettings: '{"legacy":true}', claudeMcp: '{"legacy":true}', codexConfig: '# legacy\n' };
        writeFileSync(paths.claudeSettings, original.claudeSettings);
        writeFileSync(paths.claudeMcp, original.claudeMcp);
        writeFileSync(paths.codexConfig, original.codexConfig);
        const legacyLauncher = '#!/bin/sh\necho legacy\n';
        const legacyPlist = '<plist>legacy</plist>\n';
        const serviceRoot = path.join(root, '.elepha');
        const launcher = path.join(serviceRoot, 'bin', 'elepha');
        const plist = path.join(root, 'Library', 'LaunchAgents', 'com.elepha.daemon.plist');
        mkdirSync(path.dirname(launcher), { recursive: true });
        mkdirSync(path.dirname(plist), { recursive: true });
        writeFileSync(launcher, legacyLauncher);
        writeFileSync(plist, legacyPlist);
        writeFileSync(
            path.join(serviceRoot, 'daemon.heartbeat.json'),
            JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }),
        );
        mkdirSync(path.join(serviceRoot, 'logs'), { recursive: true });
        writeFileSync(path.join(serviceRoot, 'logs', 'daemon.stderr.log'), 'launchd daemon startup detail');
        let loaded = true;
        let disabled = false;
        let bootstrapCount = 0;
        let restoredBeforeLegacyBootstrap = false;
        let now = 0;
        const executor = {
            run(args: readonly string[]) {
                if (args[0] === 'print') return { stdout: '', stderr: '', status: loaded ? 0 : 3 };
                if (args[0] === 'print-disabled') {
                    return { stdout: `"com.elepha.daemon" => ${disabled ? 'true' : 'false'}`, stderr: '', status: 0 };
                }
                if (args[0] === 'disable') disabled = true;
                if (args[0] === 'enable') disabled = false;
                if (args[0] === 'bootout') loaded = false;
                if (args[0] === 'bootstrap') {
                    bootstrapCount++;
                    loaded = true;
                    if (bootstrapCount === 2) {
                        restoredBeforeLegacyBootstrap = readFileSync(plist, 'utf8') === legacyPlist;
                    }
                }
                return { stdout: '', stderr: '', status: 0 };
            },
        };

        expect(() =>
            installElepha(
                paths,
                serviceRuntime(root, executor, 1, {
                    now: () => now,
                    sleep(milliseconds) {
                        now += milliseconds;
                        if (bootstrapCount === 2 && now === DAEMON_HEALTH_CHECK_DEADLINE_MS + 30_000) {
                            writeFileSync(
                                path.join(serviceRoot, 'daemon.heartbeat.json'),
                                JSON.stringify({
                                    pid: process.pid,
                                    startedAt: new Date(now).toISOString(),
                                    updatedAt: new Date(now).toISOString(),
                                }),
                            );
                        }
                    },
                }),
            ),
        ).toThrow(
            /capture service did not produce a healthy heartbeat within 60s; launchctl bootstrap gui\/\d+ .* \(status 0; stderr: no stderr; stdout: no stdout\); post-bootstrap launchctl print gui\/\d+\/com\.elepha\.daemon \(status 0; stderr: no stderr; stdout: no stdout\) found service; daemon stderr log tail: launchd daemon startup detail/,
        );
        expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(original.claudeSettings);
        expect(readFileSync(paths.claudeMcp, 'utf8')).toBe(original.claudeMcp);
        expect(readFileSync(paths.codexConfig, 'utf8')).toBe(original.codexConfig);
        expect(readFileSync(launcher, 'utf8')).toBe(legacyLauncher);
        expect(readFileSync(plist, 'utf8')).toBe(legacyPlist);
        expect(existsSync(path.join(serviceRoot, 'service', 'install-state.json'))).toBe(false);
        expect(existsSync(path.join(serviceRoot, 'service', 'install-transaction.json'))).toBe(false);
        expect(loaded).toBe(true);
        expect(disabled).toBe(false);
        expect(bootstrapCount).toBe(2);
        expect(restoredBeforeLegacyBootstrap).toBe(true);
        expect(now).toBe(DAEMON_HEALTH_CHECK_DEADLINE_MS + 30_000);
    });

    it('keeps managed service artifacts and launchd state on failure when debug preservation is enabled', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-keep-failure-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, '{}');
        writeFileSync(paths.codexConfig, '');
        process.env.ELEPHA_SERVICE_KEEP_ON_FAILURE = '1';
        let loaded = false;
        const calls: string[][] = [];
        const executor = {
            run(args: readonly string[]) {
                calls.push([...args]);
                if (args[0] === 'print') return { stdout: '', stderr: loaded ? '' : 'not found', status: loaded ? 0 : 3 };
                if (args[0] === 'print-disabled') return { stdout: '"com.elepha.daemon" => false', stderr: '', status: 0 };
                if (args[0] === 'bootstrap') loaded = true;
                return { stdout: '', stderr: '', status: 0 };
            },
        };

        let now = 0;
        expect(() =>
            installElepha(
                paths,
                serviceRuntime(root, executor, 1, {
                    now: () => now,
                    sleep(milliseconds) {
                        now += milliseconds;
                    },
                }),
            ),
        ).toThrow('capture service did not produce a healthy heartbeat');
        expect(existsSync(path.join(root, '.elepha', 'bin', 'elepha'))).toBe(true);
        expect(existsSync(path.join(root, 'Library', 'LaunchAgents', 'com.elepha.daemon.plist'))).toBe(true);
        expect(existsSync(path.join(root, '.elepha', 'service', 'install-state.json'))).toBe(true);
        expect(loaded).toBe(true);
        expect(calls.some(([verb]) => verb === 'bootout')).toBe(false);
    });

    it('replays a leftover install journal before applying a new install', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-replay-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        const original = { claudeSettings: '{"before":true}', claudeMcp: '{"before":true}', codexConfig: '# before\n' };
        writeFileSync(paths.claudeSettings, original.claudeSettings);
        writeFileSync(paths.claudeMcp, original.claudeMcp);
        writeFileSync(paths.codexConfig, original.codexConfig);

        const serviceRoot = path.join(root, '.elepha');
        const launcher = path.join(serviceRoot, 'bin', 'elepha');
        const plist = path.join(root, 'Library', 'LaunchAgents', 'com.elepha.daemon.plist');
        const state = path.join(serviceRoot, 'service', 'install-state.json');
        const transaction = path.join(serviceRoot, 'service', 'install-transaction.json');
        const legacyLauncher = '#!/bin/sh\necho legacy\n';
        const legacyPlist = '<plist>legacy</plist>\n';
        mkdirSync(path.dirname(launcher), { recursive: true });
        mkdirSync(path.dirname(plist), { recursive: true });
        mkdirSync(path.dirname(transaction), { recursive: true });
        writeFileSync(launcher, legacyLauncher);
        writeFileSync(plist, legacyPlist);
        const crashedJournal = JSON.stringify({
            version: 1,
            files: [
                { file: paths.claudeSettings, exists: true, text: original.claudeSettings },
                { file: paths.claudeMcp, exists: true, text: original.claudeMcp },
                { file: paths.codexConfig, exists: true, text: original.codexConfig },
                { file: launcher, exists: true, text: legacyLauncher },
                { file: plist, exists: true, text: legacyPlist },
                { file: state, exists: false, text: '' },
            ],
            service: { loaded: true, disabled: false },
        });
        writeFileSync(transaction, crashedJournal);
        writeFileSync(paths.claudeSettings, '{"crashed":true}');
        writeFileSync(paths.claudeMcp, '{"crashed":true}');
        writeFileSync(paths.codexConfig, '# crashed\n');
        writeFileSync(launcher, '#!/bin/sh\necho crashed\n');
        writeFileSync(plist, '<plist>crashed</plist>\n');
        writeFileSync(state, '{"crashed":true}');

        let loaded = false;
        let disabled = true;
        let bootstraps = 0;
        const executor = {
            run(args: readonly string[]) {
                if (args[0] === 'print') return { stdout: '', stderr: '', status: loaded ? 0 : 3 };
                if (args[0] === 'print-disabled') {
                    return { stdout: `"com.elepha.daemon" => ${disabled ? 'true' : 'false'}`, stderr: '', status: 0 };
                }
                if (args[0] === 'bootout') loaded = false;
                if (args[0] === 'disable') disabled = true;
                if (args[0] === 'enable') disabled = false;
                if (args[0] === 'bootstrap') {
                    bootstraps++;
                    loaded = true;
                    writeFileSync(
                        path.join(serviceRoot, 'daemon.heartbeat.json'),
                        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
                    );
                }
                return { stdout: '', stderr: '', status: 0 };
            },
        };
        const apply = vi.mocked(configFile.applyConfigTransaction);
        const applyOriginal = apply.getMockImplementation();
        if (!applyOriginal) throw new Error('missing config transaction implementation');
        apply.mockImplementationOnce((changes) => {
            expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(original.claudeSettings);
            expect(readFileSync(paths.claudeMcp, 'utf8')).toBe(original.claudeMcp);
            expect(readFileSync(paths.codexConfig, 'utf8')).toBe(original.codexConfig);
            expect(readFileSync(launcher, 'utf8')).toBe(legacyLauncher);
            expect(readFileSync(plist, 'utf8')).toBe(legacyPlist);
            expect(existsSync(state)).toBe(false);
            // Recovery removes the crashed journal before the new install
            // writes its own transaction record for this fresh attempt.
            expect(readFileSync(transaction, 'utf8')).not.toBe(crashedJournal);
            expect(loaded).toBe(true);
            expect(disabled).toBe(false);
            return applyOriginal(changes);
        });

        const result = installElepha(paths, serviceRuntime(root, executor, 1));

        expect(result.service).toBe('active');
        expect(bootstraps).toBe(2);
        expect(existsSync(transaction)).toBe(false);
    });

    it('restores files and clears the journal when the prior daemon stays unhealthy, allowing the next install to proceed', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-n2-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        const original = { claudeSettings: '{}\n', claudeMcp: '{}\n' };
        writeFileSync(paths.claudeSettings, original.claudeSettings);
        writeFileSync(paths.claudeMcp, original.claudeMcp);
        const servicePaths = defaultLaunchdServicePaths(root);
        const legacyLauncher = '#!/bin/sh\necho legacy\n';
        let loaded = true;
        let disabled = false;
        let healthy = false;
        let now = 0;
        const executor = {
            run(args: readonly string[]) {
                if (args[0] === 'print') return { stdout: '', stderr: '', status: loaded ? 0 : 3 };
                if (args[0] === 'print-disabled') {
                    return { stdout: `"com.elepha.daemon" => ${disabled ? 'true' : 'false'}`, stderr: '', status: 0 };
                }
                if (args[0] === 'bootout') loaded = false;
                if (args[0] === 'disable') disabled = true;
                if (args[0] === 'enable') disabled = false;
                if (args[0] === 'bootstrap') {
                    loaded = true;
                    if (healthy) {
                        writeFileSync(
                            servicePaths.heartbeat,
                            JSON.stringify({
                                pid: process.pid,
                                startedAt: new Date(now).toISOString(),
                                updatedAt: new Date(now).toISOString(),
                            }),
                        );
                    }
                }
                return { stdout: '', stderr: '', status: 0 };
            },
        };
        // Structural health-check fixture passed to LaunchdBackend; its members are invoked by the service.
        //noinspection JSUnusedGlobalSymbols
        const healthCheck = {
            now: () => now,
            sleep(milliseconds: number) {
                now += milliseconds;
            },
        };
        new LaunchdBackend(servicePaths, executor, 501, healthCheck).install(legacyLauncher, launcherMock.backend);
        launcherMock.text = '#!/bin/sh\necho new\n';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const phases: string[] = [];

        expect(() =>
            installElepha(paths, {
                ...serviceRuntime(root, executor, 1, healthCheck),
                onPhase: (phase, event) => phases.push(`${event}:${phase}`),
            }),
        ).toThrow('capture service did not produce a healthy heartbeat');
        expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(original.claudeSettings);
        expect(readFileSync(paths.claudeMcp, 'utf8')).toBe(original.claudeMcp);
        expect(readFileSync(servicePaths.launcher, 'utf8')).toBe(legacyLauncher);
        expect(existsSync(servicePaths.transaction)).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('service reconciliation failed'));
        expect(phases).toEqual([
            'start:Preparing hooks & MCP',
            'done:Preparing hooks & MCP',
            'start:Registering integrations',
            'done:Registering integrations',
            'start:Starting the capture daemon',
            'fail:Starting the capture daemon',
        ]);

        healthy = true;
        expect(installElepha(paths, serviceRuntime(root, executor, 1, healthCheck)).service).toBe('active');
        expect(existsSync(servicePaths.transaction)).toBe(false);
    });

    it('defaults the optional journal unknown state to false', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-journal-'));
        const transaction = path.join(root, 'install-transaction.json');
        writeFileSync(
            transaction,
            JSON.stringify({
                version: 1,
                files: [],
                service: { loaded: false, disabled: true },
            }),
        );

        expect(readRollbackJournal(transaction)?.service).toEqual({ loaded: false, disabled: true, unknown: false });
    });

    it('leaves the service stopped and disabled when install rollback began from an unknown state', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-unknown-service-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        const original = { claudeSettings: '{}\n', claudeMcp: '{}\n', codexConfig: '# unchanged\n' };
        writeFileSync(paths.claudeSettings, original.claudeSettings);
        writeFileSync(paths.claudeMcp, original.claudeMcp);
        writeFileSync(paths.codexConfig, original.codexConfig);
        const calls: string[][] = [];
        const executor = {
            run(args: readonly string[]) {
                calls.push([...args]);
                if (args[1] === 'is-enabled' || args[1] === 'is-active') {
                    return { stdout: '', stderr: 'probe failed', status: 1 };
                }
                return { stdout: '', stderr: '', status: 0 };
            },
        };
        const servicePaths = defaultSystemdServicePaths(root, {});
        const service = new SystemdBackend(servicePaths, executor);
        const apply = vi.mocked(configFile.applyConfigTransaction);
        const applyOriginal = apply.getMockImplementation();
        if (!applyOriginal) throw new Error('missing config transaction implementation');
        apply.mockImplementationOnce((changes) => {
            applyOriginal(changes);
            throw new Error('forced install failure');
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(() =>
            installElepha(paths, {
                platform: 'linux',
                home: root,
                service,
                serviceManager: { hasSystemd: true, isWsl: false },
                approvedRoots: 1,
            }),
        ).toThrow('forced install failure');

        expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(original.claudeSettings);
        expect(readFileSync(paths.claudeMcp, 'utf8')).toBe(original.claudeMcp);
        expect(readFileSync(paths.codexConfig, 'utf8')).toBe(original.codexConfig);
        expect(calls).toEqual([
            ['--user', 'is-enabled', 'elepha.service'],
            ['--user', 'is-active', 'elepha.service'],
            ['--user', 'stop', 'elepha.service'],
            ['--user', 'disable', 'elepha.service'],
        ]);
        expect(calls.some((args) => args[1] === 'enable' || args[1] === 'start')).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('prior service state was unknown'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('elepha status'));
        expect(existsSync(servicePaths.transaction)).toBe(false);
    });

    it('replays and clears a leftover journal before uninstalling', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-uninstall-journal-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{"partial":true}\n');
        const servicePaths = defaultLaunchdServicePaths(root);
        mkdirSync(path.dirname(servicePaths.transaction), { recursive: true });
        writeFileSync(
            servicePaths.transaction,
            JSON.stringify({
                version: 1,
                files: [{ file: paths.claudeSettings, exists: true, text: '{}\n' }],
                service: { loaded: false, disabled: true },
            }),
        );
        const executor = {
            run(args: readonly string[]) {
                if (args[0] === 'print') return { stdout: '', stderr: '', status: 3 };
                if (args[0] === 'print-disabled') return { stdout: '"com.elepha.daemon" => true', stderr: '', status: 0 };
                return { stdout: '', stderr: '', status: 0 };
            },
        };

        uninstallElepha(paths, serviceRuntime(root, executor, 1));

        expect(readFileSync(paths.claudeSettings, 'utf8')).toBe('{}\n');
        expect(existsSync(servicePaths.transaction)).toBe(false);
    });

    it('journals a failed uninstall and replays its installed state before the next lifecycle operation', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-uninstall-recovery-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{}\n');
        writeFileSync(paths.claudeMcp, '{}\n');
        writeFileSync(paths.codexConfig, '');
        const servicePaths = defaultLaunchdServicePaths(root);
        let loaded = false;
        let disabled = true;
        let failBootout = false;
        const executor = {
            run(args: readonly string[]) {
                if (args[0] === 'print') return { stdout: '', stderr: '', status: loaded ? 0 : 3 };
                if (args[0] === 'print-disabled') {
                    return { stdout: `"com.elepha.daemon" => ${disabled ? 'true' : 'false'}`, stderr: '', status: 0 };
                }
                if (args[0] === 'bootout') {
                    if (failBootout) throw new Error('forced service teardown failure');
                    loaded = false;
                }
                if (args[0] === 'disable') disabled = true;
                if (args[0] === 'enable') disabled = false;
                if (args[0] === 'bootstrap') {
                    loaded = true;
                    writeFileSync(
                        servicePaths.heartbeat,
                        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
                    );
                }
                return { stdout: '', stderr: '', status: 0 };
            },
        };

        installElepha(paths, serviceRuntime(root, executor, 0));
        const installed = {
            claudeSettings: readFileSync(paths.claudeSettings, 'utf8'),
            claudeMcp: readFileSync(paths.claudeMcp, 'utf8'),
            codexConfig: readFileSync(paths.codexConfig, 'utf8'),
            launcher: readFileSync(servicePaths.launcher, 'utf8'),
            plist: readFileSync(servicePaths.plist, 'utf8'),
            state: readFileSync(servicePaths.state, 'utf8'),
        };
        loaded = true;
        disabled = false;
        failBootout = true;

        expect(() => uninstallElepha(paths, serviceRuntime(root, executor, 1))).toThrow('forced service teardown failure');

        const journal = readRollbackJournal(servicePaths.transaction);
        expect(journal?.service).toEqual({ loaded: true, disabled: false, unknown: false });
        expect(journal?.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ file: paths.claudeSettings, exists: true, text: installed.claudeSettings }),
                expect.objectContaining({ file: paths.claudeMcp, exists: true, text: installed.claudeMcp }),
                expect.objectContaining({ file: paths.codexConfig, exists: true, text: installed.codexConfig }),
                expect.objectContaining({ file: servicePaths.launcher, exists: true, text: installed.launcher }),
                expect.objectContaining({ file: servicePaths.plist, exists: true, text: installed.plist }),
                expect.objectContaining({ file: servicePaths.state, exists: true, text: installed.state }),
            ]),
        );
        expect(readFileSync(paths.claudeSettings, 'utf8')).not.toContain('elepha');

        failBootout = false;
        const apply = vi.mocked(configFile.applyConfigTransaction);
        const applyOriginal = apply.getMockImplementation();
        if (!applyOriginal) throw new Error('missing config transaction implementation');
        apply.mockImplementationOnce((changes) => {
            expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(installed.claudeSettings);
            expect(readFileSync(paths.claudeMcp, 'utf8')).toBe(installed.claudeMcp);
            expect(readFileSync(paths.codexConfig, 'utf8')).toBe(installed.codexConfig);
            expect(readFileSync(servicePaths.launcher, 'utf8')).toBe(installed.launcher);
            expect(readFileSync(servicePaths.plist, 'utf8')).toBe(installed.plist);
            expect(readFileSync(servicePaths.state, 'utf8')).toBe(installed.state);
            expect(loaded).toBe(true);
            expect(disabled).toBe(false);
            return applyOriginal(changes);
        });

        expect(installElepha(paths, serviceRuntime(root, executor, 0)).service).toBe('registered, awaiting consent');
        expect(existsSync(servicePaths.transaction)).toBe(false);
    });

    it('refuses to install when a leftover rollback journal is malformed', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-malformed-journal-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{"before":true}');
        writeFileSync(paths.claudeMcp, '{}');
        writeFileSync(paths.codexConfig, '');
        const transaction = path.join(root, '.elepha', 'service', 'install-transaction.json');
        mkdirSync(path.dirname(transaction), { recursive: true });
        writeFileSync(transaction, '{');

        expect(() => installElepha(paths, { home: root, approvedRoots: 1 })).toThrow(
            `install rollback journal is unreadable or malformed: ${transaction}; refusing to proceed with a possibly partial install`,
        );
        expect(readFileSync(paths.claudeSettings, 'utf8')).toBe('{"before":true}');
        expect(existsSync(transaction)).toBe(true);
    });

    it('both-present registers both tools and removes only mcpServers.elepha from the user-scoped Claude config', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        const claudeConfig = {
            projects: { '/Users/test/Sites/example': { hasTrustDialogAccepted: true } },
            mcpServers: { phpstorm: { type: 'stdio', command: '/Applications/PhpStorm.app/Contents/bin/phpstorm' } },
            preferences: { verbose: false },
        };
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, JSON.stringify(claudeConfig));
        writeFileSync(paths.codexConfig, '');

        const result = installElepha(paths, { approvedRoots: 1 });
        expect(result.status.claudeHook).toBe('active');
        expect(result.status.claudeUserPromptSubmitHook).toBe('active');
        expect(result.status.claudeMcp).toBe('registered');
        expect(result.status.codexHook).toBe('awaiting approval');
        expect(result.status.codexUserPromptSubmitHook).toBe('awaiting approval');
        expect(result.status.codexMcp).toBe('registered');
        const installed = JSON.parse(readFileSync(paths.claudeMcp, 'utf8')) as Record<string, unknown>;
        const { elepha: _elepha, ...unrelatedServers } = installed.mcpServers as Record<string, unknown>;
        expect({ ...installed, mcpServers: unrelatedServers }).toEqual(claudeConfig);

        expect(uninstallElepha(paths, { approvedRoots: 1 }).status.claudeMcp).toBe('not installed');
        expect(JSON.parse(readFileSync(paths.claudeMcp, 'utf8'))).toEqual(claudeConfig);
        expect(existsSync(path.join(root, '.mcp.json'))).toBe(false);
    });

    it('Claude-only registers Claude without creating or modifying the absent Codex config', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-'));
        const paths = installPaths(root);
        mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });

        const result = installElepha(paths, { approvedRoots: 1 });

        expect(result.status.claudeHook).toBe('active');
        expect(result.status.claudeMcp).toBe('registered');
        expect(result.status.codexHook).toBe('not present');
        expect(result.status.codexMcp).toBe('not present');
        expect(result.status.ready).toBe(true);
        expect(existsSync(paths.codexConfig)).toBe(false);
    });

    it('uninstalls a single-tool Claude installation without reading the absent Codex config', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-h1-'));
        const paths = installPaths(root);
        mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
        writeFileSync(paths.claudeSettings, '{}');

        installElepha(paths, { home: root, approvedRoots: 1 });
        expect(() => uninstallElepha(paths, { home: root, approvedRoots: 1 })).not.toThrow();

        expect(existsSync(paths.codexConfig)).toBe(false);
        expect(uninstallElepha(paths, { home: root, approvedRoots: 1 }).status.claudeHook).toBe('not installed');
    });

    it('deletes a settings file created by elepha when uninstall restores an absent original', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-h2-'));
        const paths = installPaths(root);
        mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });

        installElepha(paths, { home: root, approvedRoots: 1 });
        expect(existsSync(paths.claudeSettings)).toBe(true);
        uninstallElepha(paths, { home: root, approvedRoots: 1 });

        expect(existsSync(paths.claudeSettings)).toBe(false);
    });

    it('refreshes snapshots on a second install so a later uninstall preserves the user edit', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-h3-'));
        const paths = installPaths(root);
        mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, JSON.stringify({ mcpServers: { original: { command: 'original' } } }));

        installElepha(paths, { home: root, approvedRoots: 1 });
        uninstallElepha(paths, { home: root, approvedRoots: 1 });
        const userEdit = JSON.stringify({ mcpServers: { original: { command: 'original' }, userServer: { command: 'user' } } });
        writeFileSync(paths.claudeMcp, userEdit);
        installElepha(paths, { home: root, approvedRoots: 1 });
        uninstallElepha(paths, { home: root, approvedRoots: 1 });

        expect(readFileSync(paths.claudeMcp, 'utf8')).toBe(userEdit);
    });

    it('removes elepha from a re-install snapshot while preserving a user-added hook group', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-n1-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{}\n');
        writeFileSync(paths.claudeMcp, '{}\n');
        writeFileSync(paths.codexConfig, '');

        installElepha(paths, { home: root, approvedRoots: 1 });
        const afterFirst = JSON.parse(readFileSync(paths.claudeSettings, 'utf8')) as {
            hooks: { SessionStart: Array<Record<string, unknown>> };
        };
        afterFirst.hooks.SessionStart.push({ matcher: 'startup', hooks: [{ type: 'command', command: 'other-tool hook' }] });
        writeFileSync(paths.claudeSettings, `${JSON.stringify(afterFirst, null, 2)}\n`);

        expect(installElepha(paths, { home: root, approvedRoots: 1 }).changed).toBe(true);
        const result = uninstallElepha(paths, { home: root, approvedRoots: 1 });
        const settings = JSON.parse(readFileSync(paths.claudeSettings, 'utf8')) as {
            hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
        };

        expect(settings.hooks.SessionStart).toEqual([{ matcher: 'startup', hooks: [{ type: 'command', command: 'other-tool hook' }] }]);
        expect(readFileSync(paths.claudeSettings, 'utf8')).not.toContain('elepha');
        expect(readFileSync(paths.claudeMcp, 'utf8')).not.toContain('elepha');
        expect(readFileSync(paths.codexConfig, 'utf8')).not.toContain('elepha');
        expect(result.status.claudeHook).toBe('not installed');
        expect(result.status.claudeUserPromptSubmitHook).toBe('not installed');
        expect(result.status.claudeMcp).toBe('not installed');
        expect(result.status.codexHook).toBe('not configured');
        expect(result.status.codexMcp).toBe('not installed');
    });

    it('keeps config snapshots private to elepha and leaves no sibling backups after install', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-m8-'));
        const paths = installPaths(root);
        mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
        writeFileSync(paths.claudeSettings, '{}');

        installElepha(paths, { home: root, approvedRoots: 1 });

        expect(existsSync(`${paths.claudeSettings}.bak`)).toBe(false);
        expect(existsSync(`${paths.claudeSettings}.elepha-install.bak`)).toBe(false);
        const snapshots = path.join(root, '.elepha', 'install-snapshots');
        expect(existsSync(snapshots)).toBe(true);
        expect(statSync(path.join(snapshots, readdirSync(snapshots)[0])).mode & 0o777).toBe(0o600);
    });

    it('preserves a symlinked config file when a transaction writes it', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-m9-'));
        const paths = installPaths(root);
        const target = path.join(root, 'dotfiles', 'settings.json');
        mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, '{}');
        symlinkSync(target, paths.claudeSettings);

        installElepha(paths, { home: root, approvedRoots: 1 });

        expect(lstatSync(paths.claudeSettings).isSymbolicLink()).toBe(true);
    });

    it('leaves a running launchd service untouched when the uninstall config transaction fails', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-uninstall-ordering-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, '{}');
        writeFileSync(paths.codexConfig, '');
        let loaded = true;
        let disabled = false;
        const calls: string[][] = [];
        const executor = {
            run(args: readonly string[]) {
                calls.push([...args]);
                if (args[0] === 'print') return { stdout: '', stderr: '', status: loaded ? 0 : 3 };
                if (args[0] === 'print-disabled')
                    return { stdout: `"com.elepha.daemon" => ${disabled ? 'true' : 'false'}`, stderr: '', status: 0 };
                if (args[0] === 'bootout') loaded = false;
                if (args[0] === 'disable') disabled = true;
                return { stdout: '', stderr: '', status: 0 };
            },
        };
        vi.mocked(configFile.applyConfigTransaction).mockImplementationOnce(() => {
            throw new Error('forced config transaction failure');
        });

        expect(() => uninstallElepha(paths, serviceRuntime(root, executor, 1))).toThrow('forced config transaction failure');

        expect(loaded).toBe(true);
        expect(disabled).toBe(false);
        expect(calls.some(([verb]) => verb === 'bootout' || verb === 'disable')).toBe(false);
    });

    it('Codex-only registers Codex without writing either Claude config', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-'));
        const paths = installPaths(root);
        mkdirSync(path.dirname(paths.codexConfig), { recursive: true });

        const result = installElepha(paths, { approvedRoots: 1 });

        expect(result.status.claudeHook).toBe('not present');
        expect(result.status.claudeMcp).toBe('not present');
        expect(result.status.codexHook).toBe('awaiting approval');
        expect(result.status.codexMcp).toBe('registered');
        expect(existsSync(paths.claudeSettings)).toBe(false);
        expect(existsSync(paths.claudeMcp)).toBe(false);
    });

    it('refuses when neither supported tool is present without writing a config', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-'));
        const paths = installPaths(root);

        expect(() => installElepha(paths, { approvedRoots: 1 })).toThrow('no supported tool found; install Claude Code or Codex first');
        expect(existsSync(paths.claudeSettings)).toBe(false);
        expect(existsSync(paths.claudeMcp)).toBe(false);
        expect(existsSync(paths.codexConfig)).toBe(false);
    });

    it.each([
        ['malformed', '{'],
        ['user-owned conflict', JSON.stringify({ mcpServers: { elepha: { command: 'other' } } })],
    ])('refuses a %s Claude user config before writing any transaction file', (_case, claudeMcp) => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        const before = { claudeSettings: '{\n}', claudeMcp, codexConfig: '# retain\n' };
        writeFileSync(paths.claudeSettings, before.claudeSettings);
        writeFileSync(paths.claudeMcp, before.claudeMcp);
        writeFileSync(paths.codexConfig, before.codexConfig);

        expect(() => installElepha(paths, { approvedRoots: 1 })).toThrow();
        expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(before.claudeSettings);
        expect(readFileSync(paths.claudeMcp, 'utf8')).toBe(before.claudeMcp);
        expect(readFileSync(paths.codexConfig, 'utf8')).toBe(before.codexConfig);
    });

    it('preserves a sanitized real-world Codex config when uninstalling an approved elepha hook', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-installer-'));
        const paths = installPaths(root);
        createConfigDirectories(paths);
        const codexConfig = `[mcp_servers.docs]
command = "/opt/tools/docs-mcp"
args = ["serve"]

[mcp_servers.browser]
command = "/opt/tools/browser-mcp"
enabled = true

[mcp_servers.database]
command = "/opt/tools/database-mcp"
args = ["--readonly"]

[hooks.state."/sanitized/config.toml:pre_tool_use:0:0"]
trusted_hash = "sha256:pre-tool-use"

[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "/opt/tools/pre-tool-use"

[auto_review]
policy = """
Allow read-only commands.
Require confirmation for writes.
"""

[projects."/sanitized/sites/alpha"]
trust_level = "trusted"

[projects."/sanitized/sites/beta"]
trust_level = "trusted"

[projects."/sanitized/sites/gamma"]
trust_level = "untrusted"
`;
        const nonElepha = parse(codexConfig);
        writeFileSync(paths.claudeSettings, '{}');
        writeFileSync(paths.claudeMcp, '{}');
        writeFileSync(paths.codexConfig, codexConfig);

        installElepha(paths, { approvedRoots: 1 });
        const approvedKey = `${paths.codexConfig}:session_start:0:0`;
        const installed = readFileSync(paths.codexConfig, 'utf8');
        const approval = `[hooks.state."${approvedKey}"]
trusted_hash = "sha256:elepha-session-start"

`;
        writeFileSync(paths.codexConfig, installed.replace('[[hooks.PreToolUse]]', `${approval}[[hooks.PreToolUse]]`));

        uninstallElepha(paths, { approvedRoots: 1 });
        const uninstalled = readFileSync(paths.codexConfig, 'utf8');

        expect(parse(uninstalled)).toEqual(nonElepha);
        expect(uninstalled).toContain('trusted_hash = "sha256:pre-tool-use"');
        expect(uninstalled).toContain('[[hooks.PreToolUse]]');
        expect(uninstalled).toContain('policy = """\nAllow read-only commands.\nRequire confirmation for writes.\n"""');
        expect(uninstalled).toContain('[projects."/sanitized/sites/alpha"]');
        expect(uninstalled).toContain('[projects."/sanitized/sites/beta"]');
        expect(uninstalled).toContain('[projects."/sanitized/sites/gamma"]');
        expect(uninstalled).toContain('[mcp_servers.docs]');
        expect(uninstalled).toContain('[mcp_servers.browser]');
        expect(uninstalled).toContain('[mcp_servers.database]');
        expect(uninstalled).not.toContain('elepha-session-start');
        expect(uninstalled).not.toContain('mcp_servers.elepha');
    });
});
