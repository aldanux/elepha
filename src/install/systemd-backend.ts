import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
    PLIST_PATH,
    PRIVATE_DIR_MODE,
    PRIVATE_FILE_MODE,
    SYSTEMD_RESTART_SECONDS,
    SYSTEMD_SERVICE_NAME,
    SYSTEMD_UMASK,
} from '../config/constants.js';
import { elephaPaths } from '../config/paths.js';
import { clearHeartbeat } from '../daemon/heartbeat.js';
import { systemctl } from '../security/subprocess-allowlist.js';
import { atomicWrite, readJson } from '../util/fs.js';
import {
    boundedDaemonOutput,
    type DaemonHealthCheckRuntime,
    daemonHealthFailure,
    defaultDaemonHealthCheckRuntime,
    healthyHeartbeat,
    waitForHealthyHeartbeat,
} from './daemon-health.js';
import { type LauncherBackend, launcherHash } from './launcher.js';
import type { ServiceBackend, ServiceStatus } from './service-backend.js';
import { managedServiceEnvironment, physicalInstallPath } from './service-manifest.js';

export interface SystemctlExecutor {
    run(args: readonly string[]): { stdout: string; stderr: string; status: number };
}

export interface SystemdServicePaths {
    home: string;
    launcher: string;
    unit: string;
    state: string;
    transaction: string;
    heartbeat: string;
    stdout: string;
    stderr: string;
}

export interface SystemdServiceManifest {
    version: 1;
    backend: LauncherBackend;
    launcherHash: string;
    launcherMode: number;
    unitHash: string;
    unitMode: number;
}

type ActiveState = 'RUNNING' | 'STOPPED' | 'UNKNOWN';
type EnabledState = 'ENABLED' | 'DISABLED' | 'UNKNOWN';

interface SystemctlResult {
    stdout: string;
    stderr: string;
    status: number;
}

function classifyActive(result: SystemctlResult): ActiveState {
    const state = result.stdout.trim();
    if (result.status === 0 || ['active', 'activating', 'reloading', 'deactivating'].includes(state)) {
        return 'RUNNING';
    }
    if (['inactive', 'failed'].includes(state)) {
        return 'STOPPED';
    }
    return 'UNKNOWN';
}

function classifyEnabled(result: SystemctlResult): EnabledState {
    const state = result.stdout.trim();
    if (result.status === 0 && ['enabled', 'enabled-runtime'].includes(state)) {
        return 'ENABLED';
    }
    if (['disabled', 'masked', 'not-found'].includes(state)) {
        return 'DISABLED';
    }
    return 'UNKNOWN';
}

export function defaultSystemdServicePaths(home = homedir(), environment: NodeJS.ProcessEnv = process.env): SystemdServicePaths {
    const elepha = elephaPaths(home);
    const configuredRoot = environment.XDG_CONFIG_HOME?.trim();
    const configRoot = configuredRoot && path.isAbsolute(configuredRoot) ? configuredRoot : path.join(home, '.config');
    return {
        home,
        launcher: elepha.launcher,
        unit: path.join(configRoot, 'systemd', 'user', SYSTEMD_SERVICE_NAME),
        state: elepha.installState,
        transaction: elepha.installTransaction,
        heartbeat: elepha.heartbeat,
        stdout: elepha.stdout,
        stderr: elepha.stderr,
    };
}

function systemdQuoted(value: string): string {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function systemdExecutable(value: string): string {
    const escaped = value.replaceAll('%', '%%');
    return /[\s"\\]/.test(escaped) ? systemdQuoted(value) : escaped;
}

/** Deterministic user unit with no Node, package, or repository path. */
export function renderDaemonUnit(paths: SystemdServicePaths, environment: NodeJS.ProcessEnv = process.env): string {
    const serviceEnvironment = [
        ['HOME', physicalInstallPath(paths.home)],
        ['PATH', PLIST_PATH],
        ['ELEPHA_SERVICE', '1'],
        ...managedServiceEnvironment(environment),
    ]
        .map(([key, value]) => `Environment=${systemdQuoted(`${key}=${value}`)}`)
        .join('\n');
    return `[Unit]
Description=Elepha capture daemon

[Service]
ExecStart=${systemdExecutable(physicalInstallPath(paths.launcher))} start
Restart=on-failure
RestartSec=${SYSTEMD_RESTART_SECONDS}
UMask=${SYSTEMD_UMASK}
${serviceEnvironment}

[Install]
WantedBy=default.target
`;
}

export function readSystemdServiceManifest(file: string): SystemdServiceManifest | undefined {
    const manifest = readJson<SystemdServiceManifest>(file);
    return manifest?.version === 1 ? manifest : undefined;
}

export function systemdArtifactsMatch(paths: SystemdServicePaths): boolean {
    const manifest = readSystemdServiceManifest(paths.state);
    if (!manifest || !existsSync(paths.launcher) || !existsSync(paths.unit)) {
        return false;
    }
    return (
        launcherHash(readFileSync(paths.launcher, 'utf8')) === manifest.launcherHash &&
        launcherHash(readFileSync(paths.unit, 'utf8')) === manifest.unitHash &&
        (statSync(paths.launcher).mode & 0o777) === manifest.launcherMode &&
        (statSync(paths.unit).mode & 0o777) === manifest.unitMode
    );
}

export class SystemdBackend implements ServiceBackend {
    constructor(
        readonly paths: SystemdServicePaths = defaultSystemdServicePaths(),
        private readonly executor: SystemctlExecutor = { run: systemctl },
        private readonly healthCheck: DaemonHealthCheckRuntime = defaultDaemonHealthCheckRuntime,
    ) {}

    get launcherPath(): string {
        return this.paths.launcher;
    }

    get manifestPath(): string {
        return this.paths.state;
    }

    get transactionPath(): string {
        return this.paths.transaction;
    }

    get artifactPaths(): readonly string[] {
        return [this.paths.launcher, this.paths.unit, this.paths.state];
    }

    private failure(args: readonly string[], result: SystemctlResult): Error {
        const stderr = boundedDaemonOutput(result.stderr);
        const stdout = boundedDaemonOutput(result.stdout);
        return new Error(
            `systemctl ${args.join(' ')} (status ${result.status}; stderr: ${stderr || 'no stderr'}; stdout: ${stdout || 'no stdout'}) failed`,
        );
    }

    private run(args: readonly string[]): void {
        const result = this.executor.run(args);
        if (result.status !== 0) {
            throw this.failure(args, result);
        }
    }

    private daemonReload(): void {
        this.run(['--user', 'daemon-reload']);
    }

    start(): void {
        this.run(['--user', 'start', SYSTEMD_SERVICE_NAME]);
    }

    stop(): void {
        const args = ['--user', 'stop', SYSTEMD_SERVICE_NAME] as const;
        const result = this.executor.run(args);
        if (result.status !== 0) {
            const active = this.executor.run(['--user', 'is-active', SYSTEMD_SERVICE_NAME]);
            // As with launchd, the inactive end-state, not the idempotent mutation exit, is the contract.
            if (classifyActive(active) !== 'STOPPED') {
                throw this.failure(args, result);
            }
        }
        clearHeartbeat(this.paths.heartbeat);
    }

    restart(): void {
        this.run(['--user', 'restart', SYSTEMD_SERVICE_NAME]);
    }

    enable(): void {
        this.run(['--user', 'enable', SYSTEMD_SERVICE_NAME]);
    }

    disable(): void {
        const args = ['--user', 'disable', SYSTEMD_SERVICE_NAME] as const;
        const result = this.executor.run(args);
        if (result.status !== 0) {
            const enabled = this.executor.run(['--user', 'is-enabled', SYSTEMD_SERVICE_NAME]);
            // As with launchd, the disabled end-state, not the idempotent mutation exit, is the contract.
            if (classifyEnabled(enabled) !== 'DISABLED') {
                throw this.failure(args, result);
            }
        }
    }

    status(): ServiceStatus {
        const enabled = this.executor.run(['--user', 'is-enabled', SYSTEMD_SERVICE_NAME]);
        const active = this.executor.run(['--user', 'is-active', SYSTEMD_SERVICE_NAME]);
        const enabledState = classifyEnabled(enabled);
        const activeState = classifyActive(active);
        if (enabledState === 'UNKNOWN' || activeState === 'UNKNOWN') {
            return { loaded: true, disabled: false, unknown: true };
        }
        return {
            loaded: activeState === 'RUNNING' || activeState === 'STOPPED',
            disabled: enabledState === 'DISABLED',
            unknown: false,
        };
    }

    hasArtifacts(): boolean {
        return existsSync(this.paths.state);
    }

    isInstalled(): boolean {
        return systemdArtifactsMatch(this.paths);
    }

    installationMatches(renderedLauncher: string): boolean {
        const manifest = readSystemdServiceManifest(this.paths.state);
        if (!manifest || !existsSync(this.paths.launcher) || !existsSync(this.paths.unit)) {
            return false;
        }
        if (!this.isInstalled()) {
            throw new Error('managed daemon service artifact was modified; refusing to overwrite it');
        }
        const renderedUnit = renderDaemonUnit(this.paths);
        return manifest.launcherHash === launcherHash(renderedLauncher) && manifest.unitHash === launcherHash(renderedUnit);
    }

    install(launcher: string, backend: LauncherBackend): void {
        const unit = renderDaemonUnit(this.paths);
        atomicWrite(this.paths.launcher, launcher, PRIVATE_DIR_MODE);
        atomicWrite(this.paths.unit, unit, PRIVATE_FILE_MODE);
        this.daemonReload();
        const manifest: SystemdServiceManifest = {
            version: 1,
            backend,
            launcherHash: launcherHash(launcher),
            launcherMode: PRIVATE_DIR_MODE,
            unitHash: launcherHash(unit),
            unitMode: PRIVATE_FILE_MODE,
        };
        atomicWrite(this.paths.state, `${JSON.stringify(manifest)}\n`, PRIVATE_FILE_MODE);
    }

    uninstall(): void {
        this.stop();
        this.disable();
        for (const file of [this.paths.state, this.paths.unit, this.paths.launcher]) {
            if (existsSync(file)) {
                unlinkSync(file);
            }
        }
        this.daemonReload();
    }

    healthy(): boolean {
        return healthyHeartbeat(this.paths.heartbeat, this.healthCheck.now());
    }

    waitForHealthy(): boolean {
        return waitForHealthyHeartbeat(() => this.healthy(), this.healthCheck);
    }

    healthFailure(): Error {
        return daemonHealthFailure(this.paths.stderr);
    }
}
