import { existsSync, readFileSync, statSync } from 'node:fs';
import { PRIVATE_DIR_MODE } from '../config/constants.js';
import { claudeMcpPath, claudeSettingsPath, codexConfigPath, daemonHeartbeatPath, elephaLauncherPath } from '../config/paths.js';
import { HEARTBEAT_STALE_MS, type Heartbeat, isPidAlive, readHeartbeat } from '../daemon/heartbeat.js';
import { errorMessage } from '../util/error.js';
import { readJson } from '../util/fs.js';
import { resolveInstalledElephaBin } from './binary.js';
import { launcherHash } from './launcher.js';
import { LAUNCHER_MARKER } from './markers.js';
import { detectPresentTools, type PresentTools, type ToolConfigPaths } from './present-tools.js';
import { type ServiceBackend, serviceBackend } from './service-backend.js';
import { type InstallStatus, installationStatus } from './status.js';

export interface DaemonHealth {
    state: string;
    healthy: boolean;
    heartbeat?: Heartbeat;
}

export interface IntegrationHealth {
    bin: string;
    status: InstallStatus;
    present: PresentTools;
}

export interface LauncherHealth {
    healthy: boolean;
    detail: string;
}

function humanAge(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours}h`;
    }
    return `${Math.round(hours / 24)}d`;
}

/** The heartbeat verdict shared by status, doctor, and rollup's rebuild guard. */
export function daemonHealth(heartbeatPath = daemonHeartbeatPath(), now = Date.now()): DaemonHealth {
    const heartbeat = readHeartbeat(heartbeatPath);
    if (!heartbeat) {
        return { state: 'NOT RUNNING (no heartbeat file)', healthy: false };
    }
    if (!isPidAlive(heartbeat.pid)) {
        return { state: `NOT RUNNING (pid ${heartbeat.pid} from last heartbeat is gone - crashed?)`, healthy: false, heartbeat };
    }
    const ageMs = now - new Date(heartbeat.updatedAt).getTime();
    if (ageMs >= HEARTBEAT_STALE_MS) {
        return {
            state: `STUCK (pid ${heartbeat.pid} alive, but heartbeat is ${humanAge(ageMs)} old - process may be hung)`,
            healthy: false,
            heartbeat,
        };
    }
    return { state: `RUNNING (pid ${heartbeat.pid}, heartbeat ${humanAge(ageMs)} ago)`, healthy: true, heartbeat };
}

function text(file: string, fallback: string): string {
    return existsSync(file) ? readFileSync(file, 'utf8') : fallback;
}

export function integrationHealth(
    paths: ToolConfigPaths = {
        claudeSettings: claudeSettingsPath(),
        claudeMcp: claudeMcpPath(),
        codexConfig: codexConfigPath(),
    },
): IntegrationHealth {
    const bin = existsSync(elephaLauncherPath()) ? elephaLauncherPath() : resolveInstalledElephaBin().bin;
    const present = detectPresentTools(paths);
    return {
        bin,
        present,
        status: installationStatus(
            text(paths.claudeSettings, '{}'),
            text(paths.claudeMcp, '{}'),
            text(paths.codexConfig, ''),
            paths.codexConfig,
            bin,
            present,
        ),
    };
}

/** Checks the managed launcher itself, without executing it or a shell. */
export function managedLauncherHealth(service: ServiceBackend = serviceBackend()): LauncherHealth {
    try {
        const manifest = readJson<{
            version?: unknown;
            launcherHash: string;
            launcherMode: number;
        }>(service.manifestPath);
        if (!existsSync(service.launcherPath)) {
            return { healthy: false, detail: `missing ${service.launcherPath}` };
        }
        if (manifest?.version !== 1) {
            return { healthy: false, detail: `missing or invalid managed launcher manifest at ${service.manifestPath}` };
        }
        if (manifest.launcherMode !== PRIVATE_DIR_MODE) {
            return { healthy: false, detail: `${service.manifestPath} declares an invalid managed launcher mode` };
        }
        const launcher = readFileSync(service.launcherPath, 'utf8');
        const [shebang, marker] = launcher.split('\n');
        if (shebang !== '#!/bin/sh' || marker !== LAUNCHER_MARKER) {
            return { healthy: false, detail: `${service.launcherPath} is not an elepha managed launcher` };
        }
        if ((statSync(service.launcherPath).mode & 0o777) !== manifest.launcherMode || launcherHash(launcher) !== manifest.launcherHash) {
            return { healthy: false, detail: `${service.launcherPath} does not match its managed launcher manifest` };
        }
        return { healthy: true, detail: 'managed launcher is valid' };
    } catch (error) {
        return { healthy: false, detail: errorMessage(error) };
    }
}
