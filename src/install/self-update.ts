import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MINIMUM_NODE_VERSION } from '../config/constants.js';
import { updateAvailablePath } from '../config/paths.js';
import { npmInstallGlobalElephaAsync, npmInvocationForBackend, npmViewElephaLatestAsync } from '../security/subprocess-allowlist.js';
import { defaultDbPath } from '../storage/db.js';
import { errorMessage } from '../util/error.js';
import { removeFileIfExists } from '../util/fs.js';
import { type ResolvedElephaBin, resolveInstalledElephaBin } from './binary.js';
import { migrateDatabaseForInstall } from './database-migration.js';
import { detectLauncherBackend, type LauncherBackend } from './launcher.js';
import { isSupportedPlatform } from './platform.js';
import { reconcileCaptureServiceAsync, type ServiceBackend, serviceBackend } from './service-backend.js';

export interface SelfUpdateNpm {
    latestVersion(): string | Promise<string>;
    installLatest(): void | Promise<void>;
    installVersion(version: string): void | Promise<void>;
}

type ReconcileStatus = 'not installed' | 'awaiting consent' | 'active';
type Reconcile = (service: ServiceBackend, approvedRoots: number) => ReconcileStatus | Promise<ReconcileStatus>;

export interface SelfUpdateRuntime {
    platform?: NodeJS.Platform;
    resolveInstalledBin?: () => ResolvedElephaBin;
    readPackageVersion?: (packageRoot: string) => string;
    detectBackend?: (options: { packageRoot: string; sourceBin: string; minimumNodeVersion: string }) => LauncherBackend;
    npm?: SelfUpdateNpm;
    service?: ServiceBackend;
    approvedRoots?: number;
    readApprovedRoots?: () => Promise<number>;
    reconcile?: Reconcile;
    migrateDatabase?: () => Promise<unknown>;
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

// The daemon also uses this registry query. It remains asynchronous so update
// checks do not block ingestion or foreground progress rendering.
export async function installedAndLatestElephaVersionAsync(
    runtime: Pick<SelfUpdateRuntime, 'resolveInstalledBin' | 'readPackageVersion' | 'detectBackend'> = {},
): Promise<{ installedVersion: string; latestVersion: string }> {
    const resolved = (runtime.resolveInstalledBin ?? resolveInstalledElephaBin)();
    const installedVersion = (runtime.readPackageVersion ?? packageVersion)(resolved.packageRoot);
    const backend = (runtime.detectBackend ?? detectLauncherBackend)({
        packageRoot: resolved.packageRoot,
        sourceBin: resolved.bin,
        minimumNodeVersion: MINIMUM_NODE_VERSION,
    });
    const latestVersion = await npmViewElephaLatestAsync(npmInvocationForBackend(backend));
    return { installedVersion, latestVersion };
}

function defaultNpm(backend: LauncherBackend): SelfUpdateNpm {
    const invocation = npmInvocationForBackend(backend);
    return {
        latestVersion: () => npmViewElephaLatestAsync(invocation),
        installLatest: () => npmInstallGlobalElephaAsync(invocation, 'latest'),
        installVersion: (version) => npmInstallGlobalElephaAsync(invocation, version),
    };
}

class ServiceNotInstalledError extends Error {
    constructor() {
        super('capture service did not become active after restart (not installed)');
    }
}

async function restart(
    service: ServiceBackend,
    readApprovedRoots: () => Promise<number>,
    reconcile: Reconcile,
    migrateDatabase: () => Promise<unknown>,
): Promise<void> {
    service.stop();
    await migrateDatabase();
    const approvedRoots = await readApprovedRoots();
    const status = await reconcile(service, approvedRoots);
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
export function selfUpdate(runtime: SelfUpdateRuntime): Promise<SelfUpdateResult>;
export async function selfUpdate(runtime: SelfUpdateRuntime = missingApprovedRoots()): Promise<SelfUpdateResult> {
    const platform = runtime.platform ?? process.platform;
    if (!isSupportedPlatform(platform)) {
        throw new Error('elepha self-update is supported on macOS and Linux.');
    }

    const resolved = (runtime.resolveInstalledBin ?? resolveInstalledElephaBin)();
    const previousVersion = (runtime.readPackageVersion ?? packageVersion)(resolved.packageRoot);
    const backend = (runtime.detectBackend ?? detectLauncherBackend)({
        packageRoot: resolved.packageRoot,
        sourceBin: resolved.bin,
        minimumNodeVersion: MINIMUM_NODE_VERSION,
    });
    const npm = runtime.npm ?? defaultNpm(backend);
    const service = runtime.service ?? serviceBackend({ platform });
    const reconcile: Reconcile = runtime.reconcile ?? reconcileCaptureServiceAsync;
    const migrateDatabase =
        runtime.migrateDatabase ?? (() => migrateDatabaseForInstall(defaultDbPath(), { resolveInstalledBin: () => resolved }));
    const readApprovedRoots =
        runtime.readApprovedRoots ??
        (async () => {
            if (runtime.approvedRoots === undefined) {
                throw new Error('selfUpdate requires an approved-root count reader');
            }
            return runtime.approvedRoots;
        });

    let latestVersion: string;
    try {
        latestVersion = await npm.latestVersion();
    } catch (error) {
        throw new Error(`self-update preflight failed: could not resolve elepha@latest: ${errorMessage(error)}`);
    }

    if (latestVersion === previousVersion) {
        removeFileIfExists(updateAvailablePath());
        return { status: 'current', version: previousVersion };
    }

    try {
        await npm.installLatest();
    } catch (error) {
        throw new Error(`self-update failed while installing elepha@latest: ${errorMessage(error)}`);
    }

    let installedVersion: string;
    try {
        await restart(service, readApprovedRoots, reconcile, migrateDatabase);
        installedVersion = (runtime.readPackageVersion ?? packageVersion)(resolved.packageRoot);
    } catch (updateError) {
        const updateFailure = errorMessage(updateError);
        const prefix = `self-update failed after installing ${latestVersion}: ${updateFailure}`;
        // Package revert and service restart are reported separately: a
        // reverted package whose service merely is not installed (manifest
        // missing or modified) is not a failed rollback, and the next step is
        // elepha install, not doctor.
        try {
            await npm.installVersion(previousVersion);
        } catch (rollbackError) {
            throw new Error(`${prefix}; rollback to ${previousVersion} failed: ${errorMessage(rollbackError)}; run elepha doctor`);
        }
        try {
            await restart(service, readApprovedRoots, reconcile, migrateDatabase);
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
    throw new Error('selfUpdate requires an injected approved-root count reader');
}
