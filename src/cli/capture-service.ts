import { DAEMON_HEALTH_CHECK_DEADLINE_MS } from '../config/constants.js';
import type { Heartbeat } from '../daemon/heartbeat.js';
import { type DaemonHealthCheckRuntime, defaultDaemonHealthCheckRuntime, waitForHealthyHeartbeat } from '../install/daemon-health.js';
import { type DaemonHealth, daemonHealth } from '../install/health-checks.js';
import { isSupportedPlatform } from '../install/platform.js';
import { type ServiceBackend, serviceBackend } from '../install/service-backend.js';
import { errorMessage } from '../util/error.js';

export interface DaemonControlRuntime extends DaemonHealthCheckRuntime {
    platform: NodeJS.Platform;
    createService(): ServiceBackend;
    hasServiceArtifacts(service: ServiceBackend): boolean;
    daemonHealth(): DaemonHealth;
}

export interface CaptureServiceTransition {
    changed: boolean;
    state: ReturnType<ServiceBackend['status']>;
}

interface ResumeCaptureServiceTransition extends CaptureServiceTransition {
    health: DaemonHealth;
}

export const defaultDaemonControlRuntime: DaemonControlRuntime = {
    ...defaultDaemonHealthCheckRuntime,
    platform: process.platform,
    createService: serviceBackend,
    hasServiceArtifacts: (service) => service.isInstalled(),
    daemonHealth: () => daemonHealth(),
};

// Resolves the installed managed service without printing command-specific guidance.
export function resolveCaptureService(runtime: DaemonControlRuntime = defaultDaemonControlRuntime): ServiceBackend | undefined {
    if (!isSupportedPlatform(runtime.platform)) {
        return undefined;
    }
    const service = runtime.createService();
    return runtime.hasServiceArtifacts(service) ? service : undefined;
}

// Stops capture before disabling automatic restarts.
export function pauseCaptureService(service: ServiceBackend): CaptureServiceTransition {
    const before = service.status();
    if (!before.loaded && before.disabled && !before.unknown) {
        return { changed: false, state: before };
    }
    try {
        service.stop();
        service.disable();
    } catch (error) {
        const state = service.status();
        const unknown = state.unknown ? ', unknown: true' : '';
        throw new Error(
            `Failed to pause capture: ${errorMessage(error)}. Actual service state: loaded: ${state.loaded}, disabled: ${state.disabled}${unknown}. Capture may restart at the next login.`,
        );
    }
    const state = service.status();
    if (!state.disabled || state.unknown) {
        const unknown = state.unknown ? ', unknown: true' : '';
        throw new Error(
            `Failed to pause capture: the service did not reach a proven disabled state. Actual service state: loaded: ${state.loaded}, disabled: ${state.disabled}${unknown}. Capture may restart at the next login.`,
        );
    }
    return { changed: true, state };
}

function isFreshHeartbeat(heartbeat: Heartbeat | undefined, previous: Heartbeat | undefined): boolean {
    if (!heartbeat) {
        return false;
    }
    if (!previous || heartbeat.pid !== previous.pid) {
        return true;
    }
    return new Date(heartbeat.startedAt).getTime() > new Date(previous.startedAt).getTime();
}

// Enables capture before starting the managed service.
export function resumeCaptureService(
    service: ServiceBackend,
    runtime: Pick<DaemonControlRuntime, 'daemonHealth' | 'now' | 'sleep'> = defaultDaemonControlRuntime,
): ResumeCaptureServiceTransition {
    const before = service.status();
    const initialHealth = runtime.daemonHealth();
    if (before.loaded && !before.disabled && !before.unknown && initialHealth.healthy) {
        return { changed: false, state: before, health: initialHealth };
    }
    if (before.loaded && initialHealth.healthy) {
        service.enable();
        return { changed: true, state: service.status(), health: initialHealth };
    }
    if (!before.loaded && initialHealth.healthy) {
        const pid = initialHealth.heartbeat?.pid ?? 'unknown';
        throw new Error(
            `Refusing to resume: daemon pid ${pid} is running while the managed service is not loaded; stop that daemon before resuming.`,
        );
    }
    service.enable();
    service.start();

    let health = initialHealth;
    const healthy = waitForHealthyHeartbeat(() => {
        health = runtime.daemonHealth();
        return health.healthy && isFreshHeartbeat(health.heartbeat, initialHealth.heartbeat);
    }, runtime);
    if (!healthy) {
        throw new Error(
            `Capture daemon did not become healthy within ${DAEMON_HEALTH_CHECK_DEADLINE_MS / 1000}s (${health.state}). Run \`elepha doctor\`.`,
        );
    }

    return { changed: true, state: service.status(), health };
}
