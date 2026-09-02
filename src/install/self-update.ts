import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MINIMUM_NODE_MAJOR } from '../config/constants.js';
import { updateAvailablePath } from '../config/paths.js';
import {
    npmInstallGlobalElepha,
    npmInvocationForBackend,
    npmViewElephaLatest,
    npmViewElephaLatestAsync,
} from '../security/subprocess-allowlist.js';
import { errorMessage } from '../util/error.js';
import { removeFileIfExists } from '../util/fs.js';
import { type ResolvedElephaBin, resolveInstalledElephaBin } from './binary.js';
import { detectLauncherBackend, type LauncherBackend } from './launcher.js';
import { isSupportedPlatform } from './platform.js';
import { reconcileCaptureService, type ServiceBackend, serviceBackend } from './service-backend.js';

export interface SelfUpdateNpm {
    latestVersion(): string;
    installLatest(): void;
    installVersion(version: string): void;
}

type Reconcile = (service: ServiceBackend, approvedRoots: number) => 'not installed' | 'awaiting consent' | 'active';

export interface SelfUpdateRuntime {
    platform?: NodeJS.Platform;
    resolveInstalledBin?: () => ResolvedElephaBin;
    readPackageVersion?: (packageRoot: string) => string;
    detectBackend?: (options: { packageRoot: string; sourceBin: string; minimumNodeMajor: number }) => LauncherBackend;
    npm?: SelfUpdateNpm;
    service?: ServiceBackend;
    approvedRoots: number;
    reconcile?: Reconcile;
}

export type SelfUpdateResult =
    | { status: 'updated'; previousVersion: string; version: string }
    | { status: 'current'; version: string }
    | { status: 'rolled-back'; previousVersion: string; attemptedVersion: string; failure: string };

export function packageVersion(packageRoot: string): string {
    let manifest: { version?: unknown };
    try {
        manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown };
    } catch (error) {
        throw new Error(`installed elepha package.json is unreadable: ${errorMessage(error)}`);
    }
    if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
        throw new Error('installed elepha package.json has an invalid version');
    }
    return manifest.version;
}

// Daemon-only registry query. Foreground self-update remains synchronous.
export async function installedAndLatestElephaVersionAsync(
    runtime: Pick<SelfUpdateRuntime, 'resolveInstalledBin' | 'readPackageVersion' | 'detectBackend'> = {},
): Promise<{ installedVersion: string; latestVersion: string }> {
    const resolved = (runtime.resolveInstalledBin ?? resolveInstalledElephaBin)();
    const installedVersion = (runtime.readPackageVersion ?? packageVersion)(resolved.packageRoot);
    const backend = (runtime.detectBackend ?? detectLauncherBackend)({
        packageRoot: resolved.packageRoot,
        sourceBin: resolved.bin,
        minimumNodeMajor: MINIMUM_NODE_MAJOR,
    });
    const latestVersion = await npmViewElephaLatestAsync(npmInvocationForBackend(backend));
    return { installedVersion, latestVersion };
}

function defaultNpm(backend: LauncherBackend): SelfUpdateNpm {
    const invocation = npmInvocationForBackend(backend);
    return {
        latestVersion: () => npmViewElephaLatest(invocation),
        installLatest: () => npmInstallGlobalElepha(invocation, 'latest'),
        installVersion: (version) => npmInstallGlobalElepha(invocation, version),
    };
}

class ServiceNotInstalledError extends Error {
    constructor() {
        super('capture service did not become active after restart (not installed)');
    }
}

function restart(service: ServiceBackend, approvedRoots: number, reconcile: Reconcile): void {
    service.stop();
    const status = reconcile(service, approvedRoots);
    if (status === 'not installed') {
        throw new ServiceNotInstalledError();
    }
    if (status !== 'active' && status !== 'awaiting consent') {
        throw new Error(`capture service did not become active after restart (${status})`);
    }
}

// Updates the globally-installed elepha package and restarts its managed
// capture service. Rollback restores only the prior code and healthy service;
// additive schema migrations are intentionally left in place.
export function selfUpdate(runtime: SelfUpdateRuntime): SelfUpdateResult;
export function selfUpdate(runtime: SelfUpdateRuntime = missingApprovedRoots()): SelfUpdateResult {
    const platform = runtime.platform ?? process.platform;
    if (!isSupportedPlatform(platform)) {
        throw new Error('elepha self-update is supported on macOS and Linux.');
    }

    const resolved = (runtime.resolveInstalledBin ?? resolveInstalledElephaBin)();
    const previousVersion = (runtime.readPackageVersion ?? packageVersion)(resolved.packageRoot);
    const backend = (runtime.detectBackend ?? detectLauncherBackend)({
        packageRoot: resolved.packageRoot,
        sourceBin: resolved.bin,
        minimumNodeMajor: MINIMUM_NODE_MAJOR,
    });
    const npm = runtime.npm ?? defaultNpm(backend);
    const service = runtime.service ?? serviceBackend({ platform });
    const approvedRoots = runtime.approvedRoots;
    const reconcile: Reconcile = runtime.reconcile ?? reconcileCaptureService;

    let latestVersion: string;
    try {
        latestVersion = npm.latestVersion();
    } catch (error) {
        throw new Error(`self-update preflight failed: could not resolve elepha@latest: ${errorMessage(error)}`);
    }

    if (latestVersion === previousVersion) {
        removeFileIfExists(updateAvailablePath());
        return { status: 'current', version: previousVersion };
    }

    try {
        npm.installLatest();
    } catch (error) {
        throw new Error(`self-update failed while installing elepha@latest: ${errorMessage(error)}`);
    }

    let installedVersion: string;
    try {
        restart(service, approvedRoots, reconcile);
        installedVersion = (runtime.readPackageVersion ?? packageVersion)(resolved.packageRoot);
    } catch (updateError) {
        const updateFailure = errorMessage(updateError);
        const prefix = `self-update failed after installing ${latestVersion}: ${updateFailure}`;
        // Package revert and service restart are reported separately: a
        // reverted package whose service merely is not installed (manifest
        // missing or modified) is not a failed rollback, and the next step is
        // elepha install, not doctor.
        try {
            npm.installVersion(previousVersion);
        } catch (rollbackError) {
            throw new Error(`${prefix}; rollback to ${previousVersion} failed: ${errorMessage(rollbackError)}; run elepha doctor`);
        }
        try {
            restart(service, approvedRoots, reconcile);
        } catch (serviceError) {
            if (serviceError instanceof ServiceNotInstalledError) {
                throw new Error(
                    `${prefix}; package reverted to ${previousVersion}; capture service is not installed (managed service manifest is missing or modified); run elepha install`,
                );
            }
            throw new Error(
                `${prefix}; package reverted to ${previousVersion} but capture service did not restart: ${errorMessage(serviceError)}; run elepha doctor`,
            );
        }
        return { status: 'rolled-back', previousVersion, attemptedVersion: latestVersion, failure: updateFailure };
    }

    removeFileIfExists(updateAvailablePath());
    return { status: 'updated', previousVersion, version: installedVersion };
}

function missingApprovedRoots(): never {
    throw new Error('selfUpdate requires an injected approved-root count');
}
