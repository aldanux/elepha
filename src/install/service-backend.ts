import { launchctl } from '../security/subprocess-allowlist.js';
import { defaultLaunchdServicePaths, LaunchdBackend } from './launchd-backend.js';
import type { LauncherBackend } from './launcher.js';
import { defaultSystemdServicePaths, SystemdBackend } from './systemd-backend.js';

export interface ServiceStatus {
    loaded: boolean;
    disabled: boolean;
    unknown: boolean;
}

export interface ServiceBackend {
    readonly launcherPath: string;
    readonly manifestPath: string;
    readonly transactionPath: string;
    readonly artifactPaths: readonly string[];

    hasArtifacts(): boolean;
    isInstalled(): boolean;
    installationMatches(renderedLauncher: string): boolean;
    install(renderedLauncher: string, launcherBackend: LauncherBackend): void;
    uninstall(): void;
    start(): void;
    stop(): void;
    restart(): void;
    status(): ServiceStatus;
    healthy(): boolean;
    waitForHealthy(): boolean;
    healthFailure(): Error;
    enable(): void;
    disable(): void;
}

export interface ServiceBackendOptions {
    platform?: NodeJS.Platform;
    home?: string;
}

function launchdBackend(home?: string): LaunchdBackend {
    return new LaunchdBackend(defaultLaunchdServicePaths(home), { run: launchctl });
}

export function serviceBackend(options: ServiceBackendOptions = {}): ServiceBackend {
    switch (options.platform ?? process.platform) {
        case 'darwin':
            return launchdBackend(options.home);
        case 'linux':
            return new SystemdBackend(defaultSystemdServicePaths(options.home));
        default:
            // Platform guards remain at the lifecycle entry points. Unguarded
            // callers on other platforms retain their historical launchd behavior.
            return launchdBackend(options.home);
    }
}

// Called after consent mutations; an absent service is intentionally a no-op.
export function reconcileCaptureService(service: ServiceBackend, approvedRoots: number): 'not installed' | 'awaiting consent' | 'active' {
    if (!service.isInstalled()) {
        return 'not installed';
    }
    if (approvedRoots === 0) {
        service.stop();
        service.disable();
        return 'awaiting consent';
    }
    service.enable();
    service.start();
    if (!service.waitForHealthy()) {
        throw service.healthFailure();
    }
    return 'active';
}
