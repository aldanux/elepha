import { createHash } from 'node:crypto';
import { accessSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { LAUNCHER_MARKER } from './markers.js';

export type LauncherBackendKind = 'nvm' | 'fnm' | 'asdf' | 'homebrew' | 'standalone';

export interface LauncherBackend {
    kind: LauncherBackendKind;
    // Stable executable/control path, never a Node-version installation path.
    command: string;
    root?: string;
    npmBin?: string;
    node?: string;
}

export interface LauncherOptions {
    execPath?: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
    packageRoot: string;
    sourceBin: string;
    minimumNodeMajor: number;
}

const VERSION_STORE = /(?:^|\/)(?:versions\/node|node-versions|installs\/nodejs|Cellar\/node[^/]*)\//;
const FIXED_PROBE = "var n=+process.versions.node.split('.')[0],m=+process.argv[1];process.exit(n>=m?0:65)";

function executable(file: string): boolean {
    try {
        return statSync(file).isFile() && (statSync(file).mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

function executableOnPath(name: string, value: string | undefined): string | undefined {
    return value
        ?.split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.resolve(directory, name))
        .find(executable);
}

function readable(file: string): boolean {
    try {
        accessSync(file, 4);
        return true;
    } catch {
        return false;
    }
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function readNodeMajor(packageRoot: string): number {
    let engines: unknown;
    try {
        engines = (JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { engines?: unknown }).engines;
    } catch {
        throw new Error('package-invalid: elepha package.json is unreadable');
    }
    const node = engines && typeof engines === 'object' ? (engines as Record<string, unknown>).node : undefined;
    const match = typeof node === 'string' ? /^>=(\d+)$/.exec(node) : null;
    if (!match) {
        throw new Error('package-invalid: elepha engines.node must use the canonical >=N form');
    }
    return Number(match[1]);
}

function resolveDefaultNvm(root: string): string | undefined {
    const aliasDir = path.join(root, 'alias');
    const defaultPath = path.join(aliasDir, 'default');
    if (!readable(defaultPath)) {
        return undefined;
    }
    let value = readFileSync(defaultPath, 'utf8').trim();
    const seen = new Set<string>();
    for (let depth = 0; depth < 16; depth++) {
        if (seen.has(value)) {
            return undefined;
        }
        seen.add(value);
        if (value === 'node') {
            return readVersions(path.join(root, 'versions', 'node')).at(-1);
        }
        if (value.startsWith('lts/')) {
            const lts = path.join(aliasDir, 'lts', value.slice(4));
            if (!readable(lts)) {
                return undefined;
            }
            value = readFileSync(lts, 'utf8').trim();
            continue;
        }
        const alias = path.join(aliasDir, value);
        if (readable(alias)) {
            value = readFileSync(alias, 'utf8').trim();
            continue;
        }
        const versions = readVersions(path.join(root, 'versions', 'node'));
        const partial = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
        if (!partial) {
            return undefined;
        }
        const [, major, minor, patch] = partial;
        return versions
            .filter((version) => {
                const installed = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
                return !!installed && installed[1] === major && (!minor || installed[2] === minor) && (!patch || installed[3] === patch);
            })
            .at(-1);
    }
    return undefined;
}

function readVersions(dir: string): string[] {
    try {
        return readdirSync(dir)
            .filter((entry) => /^v\d+\.\d+\.\d+$/.test(entry))
            .sort(compareNodeVersions);
    } catch {
        return [];
    }
}

function compareNodeVersions(left: string, right: string): number {
    const leftParts = left.slice(1).split('.').map(Number);
    const rightParts = right.slice(1).split('.').map(Number);
    return leftParts[0] - rightParts[0] || leftParts[1] - rightParts[1] || leftParts[2] - rightParts[2];
}

function nvmDefaultMismatchError(defaultVersion: string | undefined, activeVersion: string): Error {
    return new Error(
        `elepha install must run from the Node manager's default (default resolves to ${defaultVersion ?? 'no installed version'}, active is ${activeVersion}); switch to that default or reinstall elepha under it.`,
    );
}

// Select the manager that owns process.execPath. Discovery is only metadata and
// stable control files; no manager binary or shell is executed here.
export function detectLauncherBackend(options: LauncherOptions): LauncherBackend {
    const execPath = realpathSync(options.execPath ?? process.execPath);
    const env = options.env ?? process.env;
    const home = options.home ?? env.HOME;
    const min = readNodeMajor(options.packageRoot);
    if (min !== options.minimumNodeMajor) {
        throw new Error('package-invalid: launcher minimum Node major disagrees with package');
    }

    const nvmMarker = '/versions/node/';
    const nvmIndex = execPath.indexOf(nvmMarker);
    if (nvmIndex >= 0) {
        const root = execPath.slice(0, nvmIndex);
        const active = path.basename(path.dirname(path.dirname(execPath)));
        const nvmExec = path.join(root, 'nvm-exec');
        const defaultVersion = resolveDefaultNvm(root);
        if (executable(nvmExec) && readable(path.join(root, 'nvm.sh')) && defaultVersion === active) {
            return { kind: 'nvm', command: nvmExec, root };
        }
        throw nvmDefaultMismatchError(defaultVersion, active);
    }

    const fnmMarker = '/node-versions/';
    const fnmIndex = execPath.indexOf(fnmMarker);
    if (fnmIndex >= 0) {
        const root = execPath.slice(0, fnmIndex);
        const fnm = env.FNM_DIR ? path.join(env.FNM_DIR, 'fnm') : undefined;
        const stable = [executableOnPath('fnm', env.PATH), fnm, '/opt/homebrew/bin/fnm', '/usr/local/bin/fnm'].find(
            (candidate): candidate is string => !!candidate && executable(candidate),
        );
        if (!stable || !readable(path.join(root, 'aliases', 'default'))) {
            throw new Error("elepha install must run from the selected Node manager's current default");
        }
        return { kind: 'fnm', command: stable, root };
    }

    const asdfMarker = '/installs/nodejs/';
    const asdfIndex = execPath.indexOf(asdfMarker);
    if (asdfIndex >= 0) {
        const root = execPath.slice(0, asdfIndex);
        const asdf = [executableOnPath('asdf', env.PATH), '/opt/homebrew/bin/asdf', '/usr/local/bin/asdf', path.join(root, 'asdf')].find(
            (candidate): candidate is string => !!candidate && executable(candidate),
        );
        const toolVersions = home ? path.join(home, '.tool-versions') : '';
        const active = path.basename(path.dirname(path.dirname(execPath)));
        const nodeVersion = readable(toolVersions) ? /^nodejs\s+(\S+)/m.exec(readFileSync(toolVersions, 'utf8'))?.[1] : undefined;
        if (!asdf || !nodeVersion || nodeVersion !== active || !executable(path.join(root, 'shims', 'elepha'))) {
            throw new Error("elepha install must run from the selected Node manager's current default");
        }
        return { kind: 'asdf', command: asdf, root };
    }

    const cellar = /^(\/opt\/homebrew|\/usr\/local)\/Cellar\/(node[^/]*)\/[^/]+\/bin\/node$/.exec(execPath);
    if (cellar) {
        const opt = path.join(cellar[1], 'opt', cellar[2]);
        const node = path.join(opt, 'bin', 'node');
        if (!executable(node) || VERSION_STORE.test(options.sourceBin)) {
            throw new Error('unsupported or ambiguous Node installation');
        }
        return { kind: 'homebrew', command: options.sourceBin, node, npmBin: path.dirname(options.sourceBin) };
    }

    if (
        (execPath === '/usr/local/bin/node' || execPath === '/usr/bin/node') &&
        ['/usr/local/bin', '/usr/bin'].includes(path.dirname(options.sourceBin))
    ) {
        return { kind: 'standalone', command: options.sourceBin, node: execPath, npmBin: path.dirname(options.sourceBin) };
    }
    throw new Error('unsupported or ambiguous Node installation');
}

function probe(backend: LauncherBackend, executableName: 'node' | 'elepha', args: string): string {
    const quotedArgs = args;
    if (backend.kind === 'nvm') {
        return `NVM_DIR=${shellQuote(requiredPath(backend.root))} NODE_VERSION=default ${shellQuote(backend.command)} ${executableName} ${quotedArgs}`;
    }
    if (backend.kind === 'fnm') {
        return `FNM_DIR=${shellQuote(requiredPath(backend.root))} ${shellQuote(backend.command)} exec --using=default -- ${executableName} ${quotedArgs}`;
    }
    if (backend.kind === 'asdf') {
        return `(cd "$HOME" && ASDF_DATA_DIR=${shellQuote(requiredPath(backend.root))} ${shellQuote(backend.command)} exec ${executableName} ${quotedArgs})`;
    }
    if (executableName === 'node') {
        return `${shellQuote(requiredPath(backend.node))} ${quotedArgs}`;
    }
    return `${shellQuote(backend.command)} ${quotedArgs}`;
}

function run(backend: LauncherBackend): string {
    if (backend.kind === 'nvm') {
        return `NVM_DIR=${shellQuote(requiredPath(backend.root))} NODE_VERSION=default exec ${shellQuote(backend.command)} elepha "$@"`;
    }
    if (backend.kind === 'fnm') {
        return `FNM_DIR=${shellQuote(requiredPath(backend.root))} exec ${shellQuote(backend.command)} exec --using=default -- elepha "$@"`;
    }
    if (backend.kind === 'asdf') {
        return `cd "$HOME" && ASDF_DATA_DIR=${shellQuote(requiredPath(backend.root))} exec ${shellQuote(backend.command)} exec elepha "$@"`;
    }
    return `exec ${shellQuote(backend.command)} "$@"`;
}

function requiredPath(value: string | undefined): string {
    if (!value) {
        throw new Error('launcher backend is missing its required stable path');
    }
    return value;
}

// Render the stable, version-free POSIX launcher.
export function renderLauncher(backend: LauncherBackend, minimumNodeMajor: number): string {
    const versionProbe = `${shellQuote('-e')} ${shellQuote(FIXED_PROBE)} ${minimumNodeMajor}`;
    const packageProbe = `internal launcher-probe ${minimumNodeMajor}`;
    const launch = run(backend);
    const base = ['#!/bin/sh', LAUNCHER_MARKER, 'set -eu', 'umask 077', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'export PATH'];
    if (backend.npmBin) {
        base.push(`PATH=${shellQuote(backend.npmBin)}:$PATH`, 'export PATH');
    }
    base.push(
        `if [ "\${ELEPHA_MANAGED_LAUNCHER:-}" = "1" ]; then printf "%s\\n" "elepha launcher failed: recursion" >&2; exit 126; fi`,
        'export ELEPHA_MANAGED_LAUNCHER=1',
        `if ! ${probe(backend, 'node', versionProbe)} >/dev/null 2>&1; then printf "%s\\n" "elepha launcher failed: default-missing" >&2; exit 69; fi`,
        `if ! ${probe(backend, 'elepha', packageProbe)} >/dev/null 2>&1; then printf "%s\\n" "elepha launcher failed: package-invalid" >&2; exit 66; fi`,
        launch,
        '',
    );
    return base.join('\n');
}

export function launcherHash(text: string): string {
    // Hashing is implemented without exposing a parser/executor surface.
    return createHash('sha256').update(text).digest('hex');
}
