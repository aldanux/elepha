import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { defaultDbPath, hasPlaintextDatabaseHeader } from '../storage/db.js';
import { errorMessage } from '../util/error.js';
import { type ResolvedElephaBin, resolveInstalledElephaBin } from './binary.js';
import { retireLegacyMcpReaders } from './legacy-mcp.js';

export interface NpmPostinstallRuntime {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    cwd?: string;
    databasePath?: () => string;
    retireReaders?: typeof retireLegacyMcpReaders;
    report?: (message: string) => void;
}

export function npmPostinstallFailureMessage(detail: string): string {
    return `elepha could not retire a legacy MCP during npm upgrade: ${detail}. Run elepha install to retry.`;
}

export function npmPostinstallRetiredMessage(count: number): string {
    return `Retired ${count} stale elepha MCP process(es) during npm upgrade.`;
}

function globalInstallation(packageRoot: string, env: NodeJS.ProcessEnv, cwd: string): ResolvedElephaBin | undefined {
    const prefix = env.npm_config_global_prefix;
    const manifest = env.npm_package_json;
    if (env.npm_package_name !== 'elepha' || prefix === undefined || !path.isAbsolute(prefix) || manifest === undefined) {
        return undefined;
    }
    const expected = path.join(prefix, 'lib', 'node_modules', 'elepha');
    // npm link and copied/repository entrypoints are not a global package
    // replacement, even if their caller supplies lifecycle environment flags.
    if (lstatSync(expected).isSymbolicLink()) {
        return undefined;
    }
    const root = realpathSync(packageRoot);
    if (
        root !== path.join(realpathSync(prefix), 'lib', 'node_modules', 'elepha') ||
        realpathSync(expected) !== root ||
        realpathSync(cwd) !== root ||
        realpathSync(manifest) !== path.join(root, 'package.json')
    ) {
        return undefined;
    }
    const installed = resolveInstalledElephaBin({
        pathValue: path.join(prefix, 'bin'),
        argvEntrypoint: path.join(root, 'bin', 'elepha.js'),
    });
    return installed.packageRoot === root ? installed : undefined;
}

// A pre-fix self-updater resumes its old JavaScript after npm returns. The
// newly installed package can release proven old MCP readers here, before
// that updater attempts its unchanged migration. Never open SQLite or run
// migration/service/configuration writes from an npm lifecycle script.
export async function runNpmPostinstall(packageRoot: string, runtime: NpmPostinstallRuntime = {}): Promise<number> {
    const env = runtime.env ?? process.env;
    const platform = runtime.platform ?? process.platform;
    if (env.npm_config_global !== 'true' || env.npm_lifecycle_event !== 'postinstall' || !['darwin', 'linux'].includes(platform)) {
        return 0;
    }
    const report = runtime.report ?? console.error;
    try {
        const installed = globalInstallation(packageRoot, env, runtime.cwd ?? process.cwd());
        if (installed === undefined) {
            return 0;
        }
        const databasePath = (runtime.databasePath ?? defaultDbPath)();
        let database: ReturnType<typeof statSync>;
        try {
            database = statSync(databasePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return 0;
            }
            throw error;
        }
        if (!database.isFile() || database.uid !== process.getuid?.() || !hasPlaintextDatabaseHeader(databasePath)) {
            return 0;
        }
        const count = await (runtime.retireReaders ?? retireLegacyMcpReaders)(databasePath, installed);
        if (count > 0) {
            report(npmPostinstallRetiredMessage(count));
        }
        return count;
    } catch (error) {
        report(npmPostinstallFailureMessage(errorMessage(error)));
        return 0;
    }
}
