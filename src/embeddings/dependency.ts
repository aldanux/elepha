import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MINIMUM_NODE_VERSION } from '../config/constants.js';
import { elephaPaths } from '../config/paths.js';
import { resolveInstalledElephaBin } from '../install/binary.js';
import { detectLauncherBackend, type LauncherBackend } from '../install/launcher.js';
import { npmInstallMemoryPlusAsync, npmInvocationForBackend, npmViewMemoryPlusLatestAsync } from '../security/subprocess-allowlist.js';

export interface MemoryPlusNpm {
    latestVersion(): Promise<string>;
    installedVersion(): string | undefined;
    installVersion(version: string): Promise<void>;
}

export function memoryPlusPackagePath(): string {
    return path.join(elephaPaths().memoryPlus, 'node_modules', '@huggingface', 'transformers');
}

export function memoryPlusNpm(backend?: LauncherBackend): MemoryPlusNpm {
    if (backend === undefined) {
        const resolved = resolveInstalledElephaBin();
        backend = detectLauncherBackend({
            packageRoot: resolved.packageRoot,
            sourceBin: resolved.bin,
            minimumNodeVersion: MINIMUM_NODE_VERSION,
        });
    }
    const invocation = npmInvocationForBackend(backend);
    return {
        latestVersion: () => npmViewMemoryPlusLatestAsync(invocation),
        installedVersion() {
            let manifest: { version?: unknown };
            try {
                manifest = JSON.parse(readFileSync(path.join(memoryPlusPackagePath(), 'package.json'), 'utf8'));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return undefined;
                }
                throw error;
            }
            if (typeof manifest.version !== 'string') {
                throw new Error('elepha Memory Plus package has an invalid version');
            }
            return manifest.version;
        },
        installVersion: (version) => npmInstallMemoryPlusAsync(invocation, version),
    };
}

export async function installMemoryPlusDependency(): Promise<void> {
    const npm = memoryPlusNpm();
    await npm.installVersion(await npm.latestVersion());
}
