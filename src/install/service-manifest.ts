import { realpathSync } from 'node:fs';
import path from 'node:path';

const SERVICE_PROPAGATED_ENV = [
    'ELEPHA_HOME',
    'ELEPHA_DB_PATH',
    'ELEPHA_ENV_FILE',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'ELEPHA_CLAUDE_MCP_PATH',
] as const;

/**
 * Absolute, symlink-free form of an install path. The service-manifest hash is
 * compared against the installation state on every install, so a path must
 * render identically whether the installing shell expressed it relative,
 * through a symlink, or physically; otherwise each shell triggers a spurious
 * rewrite and restart. A leaf that does not exist yet resolves through its
 * nearest existing ancestor, which is what it will resolve to once created.
 */
export function physicalInstallPath(candidate: string): string {
    const absolute = path.resolve(candidate);
    try {
        return realpathSync(absolute);
    } catch {
        const parent = path.dirname(absolute);
        return parent === absolute ? absolute : path.join(physicalInstallPath(parent), path.basename(absolute));
    }
}

/** Only location overrides needed to keep an explicitly isolated install together. */
export function managedServiceEnvironment(environment: NodeJS.ProcessEnv = process.env): Array<[string, string]> {
    return SERVICE_PROPAGATED_ENV.flatMap((key) => {
        const value = environment[key]?.trim();
        return value ? [[key, physicalInstallPath(value)]] : [];
    });
}
