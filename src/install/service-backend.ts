import { launchctl } from '../security/subprocess-allowlist.js';
import { type AsyncDaemonHealthCheckRuntime, waitForHealthyHeartbeatAsync } from './daemon-health.js';
import { defaultLaunchdServicePaths, LaunchdBackend } from './launchd-backend.js';
import type { LauncherBackend } from './launcher.js';
import { defaultSystemdServicePaths, SystemdBackend } from './systemd-backend.js';

export const SERVICE_BACKEND_PLATFORM_ERROR = 'elepha service management is supported on macOS and Linux.';

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
            throw new Error(SERVICE_BACKEND_PLATFORM_ERROR);
    }
}

// Called after consent mutations; an absent service is intentionally a no-op.
type ReconcileStatus = 'not installed' | 'awaiting consent' | 'active';

function prepareCaptureService(service: ServiceBackend, approvedRoots: number): ReconcileStatus {
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
    return 'active';
}

export function reconcileCaptureService(service: ServiceBackend, approvedRoots: number): ReconcileStatus {
    const status = prepareCaptureService(service, approvedRoots);
    if (status !== 'active') {
        return status;
    }
    if (!service.waitForHealthy()) {
        throw service.healthFailure();
    }
    return 'active';
}

export async function reconcileCaptureServiceAsync(
    service: ServiceBackend,
    approvedRoots: number,
    healthCheck?: AsyncDaemonHealthCheckRuntime,
): Promise<ReconcileStatus> {
    const status = prepareCaptureService(service, approvedRoots);
    if (status !== 'active') {
        return status;
    }
    if (!(await waitForHealthyHeartbeatAsync(() => service.healthy(), healthCheck))) {
        throw service.healthFailure();
    }
    return 'active';
}
