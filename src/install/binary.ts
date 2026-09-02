import { accessSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ResolvedElephaBin {
    // Stable npm shim/candidate path. Never the package-store realpath.
    bin: string;
    packageRoot: string;
}

export interface BinaryResolutionOptions {
    argvEntrypoint?: string;
    pathValue?: string;
    platform?: NodeJS.Platform;
}

function quotePosix(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

// The command lives in a client shell field, so quote only the executable path.
export type HookCommandName = 'session-start' | 'user-prompt-submit';

export function hookCommand(bin: string, tool: 'claude-code' | 'codex', hook: HookCommandName = 'session-start'): string {
    return `${quotePosix(bin)} hook ${hook} --tool ${tool}`;
}

function packageRootFor(target: string): string | undefined {
    let cursor = path.dirname(target);
    while (true) {
        if (path.basename(cursor) === 'elepha' && path.basename(path.dirname(cursor)) === 'node_modules') {
            return cursor;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) {
            return undefined;
        }
        cursor = parent;
    }
}

// Validate an executable without spawning it. This deliberately accepts an npm
// shim path while checking its resolved target belongs to the installed package.
function resolveCandidate(candidate: string): ResolvedElephaBin | undefined {
    try {
        lstatSync(candidate);
        accessSync(candidate, 1);
        const target = realpathSync(candidate);
        if (!statSync(target).isFile()) {
            return undefined;
        }
        const packageRoot = packageRootFor(target);
        if (!packageRoot) {
            return undefined;
        }
        const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
            name?: unknown;
            bin?: unknown;
        };
        if (manifest.name !== 'elepha' || !manifest.bin || typeof manifest.bin !== 'object' || Array.isArray(manifest.bin)) {
            return undefined;
        }
        const declared = (manifest.bin as Record<string, unknown>).elepha;
        if (typeof declared !== 'string' || realpathSync(path.join(packageRoot, declared)) !== target) {
            return undefined;
        }
        return { bin: path.resolve(candidate), packageRoot };
    } catch {
        return undefined;
    }
}

export function resolveInstalledElephaBin(options: BinaryResolutionOptions = {}): ResolvedElephaBin {
    if ((options.platform ?? process.platform) === 'win32') {
        throw new Error('elepha install is not supported on win32 yet.');
    }
    const pathValue = options.pathValue ?? process.env.PATH ?? '';
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
        const resolved = resolveCandidate(path.join(directory, 'elepha'));
        if (resolved) {
            return resolved;
        }
    }
    const fallback = options.argvEntrypoint ?? process.argv[1];
    if (fallback) {
        const resolved = resolveCandidate(path.resolve(fallback));
        if (resolved) {
            return resolved;
        }
    }
    throw new Error('elepha install must be run from an npm-installed elepha binary; no valid elepha npm bin was found.');
}
