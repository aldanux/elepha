import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import {
    DAEMON_BOOTOUT_DEADLINE_MS,
    DAEMON_HEALTH_CHECK_POLL_MS,
    DAEMON_STATE_CHECK_ATTEMPTS,
    PLIST_PATH,
    PLIST_THROTTLE_INTERVAL_SECONDS,
    PLIST_UMASK,
    PRIVATE_DIR_MODE,
    PRIVATE_FILE_MODE,
} from '../config/constants.js';
import { elephaPaths, elephaServiceLabel } from '../config/paths.js';
import { clearHeartbeat } from '../daemon/heartbeat.js';
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

export type { DaemonHealthCheckRuntime } from './daemon-health.js';
export { physicalInstallPath } from './service-manifest.js';

export interface LaunchctlExecutor {
    run(args: readonly string[]): { stdout: string; stderr: string; status: number };
}

export interface LaunchdServicePaths {
    home: string;
    label: string;
    launcher: string;
    plist: string;
    state: string;
    transaction: string;
    heartbeat: string;
    stdout: string;
    stderr: string;
}

export interface ServiceManifest {
    version: 1;
    backend: LauncherBackend;
    launcherHash: string;
    launcherMode: number;
    plistHash: string;
    plistMode: number;
}

interface BootstrapAttempt {
    args: readonly string[];
    result?: { stdout: string; stderr: string; status: number };
    print: { stdout: string; stderr: string; status: number };
}

export function defaultLaunchdServicePaths(home = homedir()): LaunchdServicePaths {
    const elepha = elephaPaths(home);
    const label = elephaServiceLabel();
    return {
        home,
        label,
        launcher: elepha.launcher,
        plist: elepha.launchAgent,
        state: elepha.installState,
        transaction: elepha.installTransaction,
        heartbeat: elepha.heartbeat,
        stdout: elepha.stdout,
        stderr: elepha.stderr,
    };
}

export function serviceDomain(uid = process.getuid?.()): string {
    if (typeof uid !== 'number') {
        throw new Error('launchd requires a numeric user id');
    }
    return `gui/${uid}`;
}

export function serviceTarget(uid = process.getuid?.(), label = elephaServiceLabel()): string {
    return `${serviceDomain(uid)}/${label}`;
}

function xml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// The launchd process starts with a minimal environment. Propagate only
// location overrides needed to keep an explicitly isolated install together;
// secrets remain in the daemon's isolated .env file and never enter a plist.
// Values are rendered physical and absolute so the plist hash does not depend
// on how the installing shell spelled them.
export function managedPlistEnvironment(environment: NodeJS.ProcessEnv = process.env): Array<[string, string]> {
    return managedServiceEnvironment(environment);
}

// Deterministic plist with no Node/package/repository path.
export function renderDaemonPlist(paths: LaunchdServicePaths, environment: NodeJS.ProcessEnv = process.env): string {
    const string = (value: string) => `<string>${xml(value)}</string>`;
    const physical = (value: string) => string(physicalInstallPath(value));
    const overrides = managedPlistEnvironment(environment)
        .map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`)
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(paths.label)}
<key>ProgramArguments</key><array>${physical(paths.launcher)}${string('start')}</array>
<key>WorkingDirectory</key>${physical(paths.home)}
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>${PLIST_THROTTLE_INTERVAL_SECONDS}</integer>
<key>ProcessType</key>${string('Background')}
<key>Umask</key><integer>${PLIST_UMASK}</integer>
<key>StandardOutPath</key>${physical(paths.stdout)}
<key>StandardErrorPath</key>${physical(paths.stderr)}
<key>EnvironmentVariables</key><dict><key>HOME</key>${physical(paths.home)}<key>PATH</key>${string(PLIST_PATH)}<key>ELEPHA_SERVICE</key>${string('1')}${overrides}</dict>
</dict></plist>
`;
}

export function readServiceManifest(file: string): ServiceManifest | undefined {
    const manifest = readJson<ServiceManifest>(file);
    return manifest?.version === 1 ? manifest : undefined;
}

export function launchdArtifactsMatch(paths: LaunchdServicePaths): boolean {
    const manifest = readServiceManifest(paths.state);
    if (!manifest || !existsSync(paths.launcher) || !existsSync(paths.plist)) {
        return false;
    }
    return (
        launcherHash(readFileSync(paths.launcher, 'utf8')) === manifest.launcherHash &&
        launcherHash(readFileSync(paths.plist, 'utf8')) === manifest.plistHash &&
        (statSync(paths.launcher).mode & 0o777) === manifest.launcherMode &&
        (statSync(paths.plist).mode & 0o777) === manifest.plistMode
    );
}

export class LaunchdBackend implements ServiceBackend {
    private lastBootstrapAttempt: BootstrapAttempt | undefined;

    constructor(
        readonly paths: LaunchdServicePaths = defaultLaunchdServicePaths(),
        private readonly executor: LaunchctlExecutor,
        private readonly uid: number | undefined = process.getuid?.(),
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
        return [this.paths.launcher, this.paths.plist, this.paths.state];
    }

    private target(): string {
        return serviceTarget(this.uid, this.paths.label);
    }

    isLoaded(): boolean {
        return this.executor.run(['print', this.target()]).status === 0;
    }

    isDisabled(): boolean {
        const result = this.executor.run(['print-disabled', serviceDomain(this.uid)]);
        const label = this.paths.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return result.status === 0 && new RegExp(`^\\s*"${label}"\\s*=>\\s*(?:true|disabled)\\s*$`, 'm').test(result.stdout);
    }

    status(): ServiceStatus {
        return { loaded: this.isLoaded(), disabled: this.isDisabled(), unknown: false };
    }

    private waitFor(condition: () => boolean): boolean {
        // launchctl applies these per-user state changes synchronously in the
        // normal case. Re-reading a bounded number of times still covers the
        // short propagation window without turning lifecycle calls into an
        // unbounded wait.
        for (let attempt = 0; attempt < DAEMON_STATE_CHECK_ATTEMPTS; attempt++) {
            if (condition()) {
                return true;
            }
        }
        return false;
    }

    private boundedOutput(output: string): string {
        return boundedDaemonOutput(output);
    }

    private formatLaunchctlResult(args: readonly string[], result: { stdout: string; stderr: string; status: number }): string {
        const stderr = this.boundedOutput(result.stderr);
        const stdout = this.boundedOutput(result.stdout);
        return `launchctl ${args.join(' ')} (status ${result.status}; stderr: ${stderr || 'no stderr'}; stdout: ${stdout || 'no stdout'})`;
    }

    private launchctlFailure(
        args: readonly string[],
        result: { stdout: string; stderr: string; status: number },
        details: readonly string[] = [],
    ): Error {
        return new Error(`${this.formatLaunchctlResult(args, result)} failed${details.length > 0 ? `; ${details.join('; ')}` : ''}`);
    }

    stop(): void {
        if (!this.isLoaded()) {
            return;
        }
        const result = this.executor.run(['bootout', this.target()]);
        const deadline = this.healthCheck.now() + DAEMON_BOOTOUT_DEADLINE_MS;
        while (this.isLoaded()) {
            const remaining = deadline - this.healthCheck.now();
            if (remaining <= 0) {
                if (result.status !== 0) {
                    throw new Error('launchctl bootout failed');
                }
                throw new Error('launchctl bootout did not unload the service within 20s');
            }
            this.healthCheck.sleep(Math.min(DAEMON_HEALTH_CHECK_POLL_MS, remaining));
        }
        clearHeartbeat(this.paths.heartbeat);
    }

    disable(): void {
        if (this.isDisabled()) {
            return;
        }
        const result = this.executor.run(['disable', this.target()]);
        // An unloaded target can still be enabled for the next login. Only
        // launchd's explicit disabled state proves automatic restart is off.
        if (!this.waitFor(() => this.isDisabled())) {
            throw this.launchctlFailure(['disable', this.target()], result);
        }
    }

    enable(): void {
        const result = this.executor.run(['enable', this.target()]);
        if (result.status !== 0 || this.isDisabled()) {
            throw this.launchctlFailure(['enable', this.target()], result);
        }
    }

    start(): void {
        const target = this.target();
        const args = ['bootstrap', serviceDomain(this.uid), this.paths.plist] as const;
        const before = this.executor.run(['print', target]);
        if (before.status === 0) {
            this.lastBootstrapAttempt = { args, print: before };
            return;
        }
        const result = this.executor.run(args);
        const print = this.executor.run(['print', target]);
        this.lastBootstrapAttempt = { args, result, print };
        if (result.status !== 0 || print.status !== 0) {
            throw this.launchctlFailure(args, result, [
                `post-bootstrap ${this.formatLaunchctlResult(['print', target], print)} ${print.status === 0 ? 'found service' : 'did not find service'}`,
            ]);
        }
    }

    restart(): void {
        this.stop();
        this.start();
    }

    hasArtifacts(): boolean {
        return existsSync(this.paths.state);
    }

    isInstalled(): boolean {
        return launchdArtifactsMatch(this.paths);
    }

    installationMatches(renderedLauncher: string): boolean {
        const manifest = readServiceManifest(this.paths.state);
        if (!manifest || !existsSync(this.paths.launcher) || !existsSync(this.paths.plist)) {
            return false;
        }
        if (!this.isInstalled()) {
            throw new Error('managed daemon service artifact was modified; refusing to overwrite it');
        }
        const renderedPlist = renderDaemonPlist(this.paths);
        return !(manifest.launcherHash !== launcherHash(renderedLauncher) || manifest.plistHash !== launcherHash(renderedPlist));
    }

    install(launcher: string, backend: LauncherBackend): void {
        const plist = renderDaemonPlist(this.paths);
        atomicWrite(this.paths.launcher, launcher, PRIVATE_DIR_MODE);
        atomicWrite(this.paths.plist, plist, PRIVATE_FILE_MODE);
        const manifest: ServiceManifest = {
            version: 1,
            backend,
            launcherHash: launcherHash(launcher),
            launcherMode: PRIVATE_DIR_MODE,
            plistHash: launcherHash(plist),
            plistMode: PRIVATE_FILE_MODE,
        };
        atomicWrite(this.paths.state, `${JSON.stringify(manifest)}\n`, PRIVATE_FILE_MODE);
    }

    uninstall(): void {
        for (const file of [this.paths.state, this.paths.plist, this.paths.launcher]) {
            if (existsSync(file)) {
                unlinkSync(file);
            }
        }
    }

    healthy(): boolean {
        return healthyHeartbeat(this.paths.heartbeat, this.healthCheck.now());
    }

    // Wait for launchd's launcher and daemon to produce a fresh healthy heartbeat.
    waitForHealthy(): boolean {
        return waitForHealthyHeartbeat(() => this.healthy(), this.healthCheck);
    }

    healthFailure(): Error {
        const bootstrap = this.lastBootstrapAttempt;
        const bootstrapDetail = bootstrap
            ? bootstrap.result
                ? this.formatLaunchctlResult(bootstrap.args, bootstrap.result)
                : `launchctl ${bootstrap.args.join(' ')} skipped because the service was already loaded`
            : 'launchctl bootstrap was not attempted';
        const printDetail = bootstrap
            ? `post-bootstrap ${this.formatLaunchctlResult(['print', this.target()], bootstrap.print)} ${
                  bootstrap.print.status === 0 ? 'found service' : 'did not find service'
              }`
            : `post-bootstrap launchctl print ${this.target()} was not recorded`;
        return daemonHealthFailure(this.paths.stderr, [bootstrapDetail, printDetail]);
    }
}
