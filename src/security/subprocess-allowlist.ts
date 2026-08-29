// The ONLY module in this codebase permitted to spawn a subprocess.
// Security Rule 2. Enforced two ways: a Biome GritQL plugin
// (.biome-plugins/no-raw-subprocess.grit) bans exec/execSync/spawn/spawnSync
// calls and the shell option everywhere else, and
// test/security/subprocess-allowlist.test.ts asserts this file's actual call
// sites match the five documented here.
//
// Both commands take a fixed, hardcoded argv - the only variable is `cwd`,
// which every caller must source from a canonicalized, consent-checked
// project record. Never pass a value read out of a transcript as `cwd`:
// a Codex rollout's own `cwd` field IS transcript content.

import { execFile, execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { SYSTEMD_SERVICE_NAME } from '../config/constants.js';
import { daemonLaunchAgentPath, elephaServiceLabel } from '../config/paths.js';
import type { LauncherBackend } from '../install/launcher.js';

// `cwd` above is transcript content (see memory-store.ts:upsertProject), so it
// is effectively attacker-controlled - an attacker who can place a
// directory anywhere under a watched store also controls that directory's
// .git/config. Git's config precedence is
//   system < global < local (repo) < worktree < -c (command line) < env
// so an explicit `-c key=value` for every config key known to make git spawn
// a subprocess wins over whatever a hostile local config says, regardless of
// which directory git runs in. This is the actual fix - path/existence
// validation alone would not be, since the attacker plants the directory
// itself, real or not.
const HARDENING_CONFIG: ReadonlyArray<readonly [string, string]> = [
    ['core.fsmonitor', ''],
    ['core.sshCommand', ''],
    ['core.pager', 'cat'],
    ['core.editor', 'true'],
    ['credential.helper', ''],
    ['core.hooksPath', '/dev/null'],
    ['protocol.ext.allow', 'never'],
    ['uploadpack.packObjectsHook', ''],
];
const HARDENING_ARGS = HARDENING_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]);

// GIT_CONFIG_GLOBAL/_NOSYSTEM aren't the primary defense (the -c overrides
// above are, since they beat repo-local config too) but are cheap insurance
// against the same class of key living in a global/system gitconfig this
// process can otherwise see. GIT_TERMINAL_PROMPT=0 stops git from ever
// blocking on a credential prompt against a non-interactive stdio pipe.
const LOCAL_SUBPROCESS_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

const NETWORK_SUBPROCESS_ENV_KEYS = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'NO_PROXY',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
] as const;

function copySubprocessEnv(keys: readonly string[]): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of keys) {
        const value = process.env[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }
    return environment;
}

/** Local-only subprocesses receive no network proxy or CA credentials. */
function localSubprocessEnv(): NodeJS.ProcessEnv {
    return copySubprocessEnv(LOCAL_SUBPROCESS_ENV_KEYS);
}

/**
 * npm never inherits the complete CLI environment: it can contain credentials
 * loaded from elepha's .env. Proxy URLs may contain credentials, so this
 * network-capable environment belongs only to npm. Do not add broad prefixes:
 * npm_config_* can contain registry auth tokens.
 */
function baseSubprocessEnv(): NodeJS.ProcessEnv {
    return {
        ...localSubprocessEnv(),
        ...copySubprocessEnv(NETWORK_SUBPROCESS_ENV_KEYS),
    };
}

// systemctl --user needs these coordinates to locate the caller's session bus.
function systemdUserEnv(): NodeJS.ProcessEnv {
    const environment = localSubprocessEnv();
    for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const) {
        const value = process.env[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }
    return environment;
}

function hardenedGitEnv(): NodeJS.ProcessEnv {
    return {
        ...localSubprocessEnv(),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
    };
}

const TRUSTED_GIT_EXECUTABLES = ['/usr/bin/git', '/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'] as const;
let cachedGitExecutable: string | null | undefined;

function trustedGitExecutable(): string | null {
    if (cachedGitExecutable !== undefined) {
        return cachedGitExecutable;
    }
    for (const executable of TRUSTED_GIT_EXECUTABLES) {
        try {
            const stat = statSync(executable);
            if (stat.isFile() && (stat.mode & 0o111) !== 0) {
                cachedGitExecutable = executable;
                return executable;
            }
        } catch {
            // Continue probing fixed trusted locations; PATH is never a fallback.
        }
    }
    cachedGitExecutable = null;
    return null;
}

function runGit(args: string[], cwd: string): string | null {
    const executable = trustedGitExecutable();
    if (executable === null) {
        return null;
    }
    try {
        return (
            execFileSync(executable, [...HARDENING_ARGS, ...args], {
                cwd,
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 3000,
                env: hardenedGitEnv(),
            })
                .toString('utf8')
                .trim() || null
        );
    } catch {
        return null;
    }
}

function runGitAsync(args: string[], cwd: string, signal: AbortSignal): Promise<string | null> {
    const executable = trustedGitExecutable();
    if (executable === null) {
        return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
        execFile(
            executable,
            [...HARDENING_ARGS, ...args],
            {
                cwd,
                env: hardenedGitEnv(),
                signal,
                shell: false,
            },
            (error, stdout) => {
                resolve(error ? null : String(stdout).trim() || null);
            },
        );
    }).catch(() => null);
}

// Git is local-only today. Any future networked Git command must explicitly
// opt into the proxy/CA environment instead of broadening hardenedGitEnv().

export function gitRevParseShowToplevel(cwd: string): string | null {
    return runGit(['rev-parse', '--show-toplevel'], cwd);
}

export function gitRemoteGetUrlOrigin(cwd: string): string | null {
    return runGit(['remote', 'get-url', 'origin'], cwd);
}

/** Current branch for a consent-checked, stored project directory only. */
export function gitRevParseAbbrevRefHead(cwd: string): string | null {
    return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

/** Async current branch probe for latency-sensitive hook paths. */
export function gitRevParseAbbrevRefHeadAsync(cwd: string, signal: AbortSignal): Promise<string | null> {
    return runGitAsync(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, signal);
}

/** Commit count at a segment boundary. Non-integers are not evidence. */
export function gitRevListCountHead(cwd: string): number | null {
    const value = runGit(['rev-list', '--count', 'HEAD'], cwd);
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

/** Async commit count probe for latency-sensitive hook paths. */
export async function gitRevListCountHeadAsync(cwd: string, signal: AbortSignal): Promise<number | null> {
    const value = await runGitAsync(['rev-list', '--count', 'HEAD'], cwd, signal);
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

/** Stable repository identity when an origin remote is absent or changes. */
export function gitRootCommit(cwd: string): string | null {
    const value = runGit(['rev-list', '--max-parents=0', 'HEAD'], cwd);
    if (value === null) {
        return null;
    }
    const hashes = value
        .split('\n')
        .map((hash) => hash.trim())
        .filter(Boolean)
        .sort();
    return hashes.length > 0 ? hashes.join(',') : null;
}

export type LaunchctlVerb = 'print' | 'print-disabled' | 'enable' | 'disable' | 'bootstrap' | 'bootout' | 'kickstart';

function canonicalLaunchctlTargets(): { domain: string; service: string; plist: string } | null {
    const uid = process.getuid?.();
    if (typeof uid !== 'number') {
        return null;
    }
    try {
        const label = elephaServiceLabel();
        const domain = `gui/${uid}`;
        return {
            domain,
            service: `${domain}/${label}`,
            plist: daemonLaunchAgentPath(label),
        };
    } catch {
        return null;
    }
}

/**
 * The sole launchd boundary. Callers pass only canonical targets built from
 * process.getuid(), the fixed elepha label, and the canonical plist path.
 */
export function launchctl(args: readonly string[]): { stdout: string; stderr: string; status: number } {
    const verb = args[0] as LaunchctlVerb | undefined;
    const targets = canonicalLaunchctlTargets();
    const valid =
        targets !== null &&
        ((verb === 'print-disabled' && args.length === 2 && args[1] === targets.domain) ||
            ((verb === 'print' || verb === 'enable' || verb === 'disable' || verb === 'bootout') &&
                args.length === 2 &&
                args[1] === targets.service) ||
            (verb === 'bootstrap' && args.length === 3 && args[1] === targets.domain && args[2] === targets.plist) ||
            (verb === 'kickstart' && args.length === 3 && args[1] === '-k' && args[2] === targets.service));
    if (!valid) {
        throw new Error('launchctl invocation is outside elepha allowlist');
    }
    try {
        const stdout = execFileSync('/bin/launchctl', [...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 2000,
            maxBuffer: 32 * 1024,
            env: localSubprocessEnv(),
        });
        return { stdout, stderr: '', status: 0 };
    } catch (error) {
        const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
        return {
            stdout: failure.stdout?.toString() ?? '',
            stderr: failure.stderr?.toString() ?? '',
            status: typeof failure.status === 'number' ? failure.status : 1,
        };
    }
}

export type SystemctlVerb = 'daemon-reload' | 'enable' | 'disable' | 'start' | 'stop' | 'restart' | 'is-active' | 'is-enabled' | 'show';

const SYSTEMCTL_TARGET_VERBS: ReadonlySet<SystemctlVerb> = new Set([
    'enable',
    'disable',
    'start',
    'stop',
    'restart',
    'is-active',
    'is-enabled',
    'show',
]);

/** The sole systemd boundary: one user service and no caller-defined arguments. */
export function systemctl(args: readonly string[]): { stdout: string; stderr: string; status: number } {
    const verb = args[1] as SystemctlVerb | undefined;
    const valid =
        args[0] === '--user' &&
        ((verb === 'daemon-reload' && args.length === 2) ||
            (!!verb && SYSTEMCTL_TARGET_VERBS.has(verb) && args.length === 3 && args[2] === SYSTEMD_SERVICE_NAME));
    if (!valid) {
        throw new Error('systemctl invocation is outside elepha allowlist');
    }
    try {
        const stdout = execFileSync('/usr/bin/systemctl', [...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 2000,
            maxBuffer: 32 * 1024,
            env: systemdUserEnv(),
        });
        return { stdout, stderr: '', status: 0 };
    } catch (error) {
        const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
        return {
            stdout: failure.stdout?.toString() ?? '',
            stderr: failure.stderr?.toString() ?? '',
            status: typeof failure.status === 'number' ? failure.status : 1,
        };
    }
}

export interface NpmInvocation {
    executable: string;
    argsPrefix: readonly string[];
    environment: NodeJS.ProcessEnv;
    cwd?: string;
}

function validPackageVersion(value: string): boolean {
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function requiredBackendPath(value: string | undefined, label: string): string {
    if (!value || !path.isAbsolute(value)) {
        throw new Error(`npm backend is missing a resolved ${label} path`);
    }
    return value;
}

function resolvedNpmExecutable(npmBin: string | undefined): string {
    const executable = path.join(requiredBackendPath(npmBin, 'npm bin'), 'npm');
    try {
        const stat = statSync(executable);
        if (stat.isFile() && (stat.mode & 0o111) !== 0) {
            return executable;
        }
    } catch {
        // Missing or unreadable is the same preflight failure as non-executable.
    }
    throw new Error('npm backend is missing an executable npm path');
}

/**
 * Maps the already-validated launcher backend to the same manager-controlled
 * npm command. Nothing supplied by a transcript, consent record, or config
 * reaches this command or its argv.
 */
export function npmInvocationForBackend(backend: LauncherBackend): NpmInvocation {
    if (backend.kind === 'nvm') {
        return {
            executable: requiredBackendPath(backend.command, 'nvm-exec'),
            argsPrefix: ['npm'],
            environment: { ...baseSubprocessEnv(), NVM_DIR: requiredBackendPath(backend.root, 'nvm root'), NODE_VERSION: 'default' },
            cwd: homedir(),
        };
    }
    if (backend.kind === 'fnm') {
        return {
            executable: requiredBackendPath(backend.command, 'fnm'),
            argsPrefix: ['exec', '--using=default', '--', 'npm'],
            environment: { ...baseSubprocessEnv(), FNM_DIR: requiredBackendPath(backend.root, 'fnm root') },
            cwd: homedir(),
        };
    }
    if (backend.kind === 'asdf') {
        return {
            executable: requiredBackendPath(backend.command, 'asdf'),
            argsPrefix: ['exec', 'npm'],
            environment: { ...baseSubprocessEnv(), ASDF_DATA_DIR: requiredBackendPath(backend.root, 'asdf root') },
            cwd: homedir(),
        };
    }
    return {
        executable: resolvedNpmExecutable(backend.npmBin),
        argsPrefix: [],
        environment: baseSubprocessEnv(),
        cwd: homedir(),
    };
}

function formatNpmFailure(args: readonly string[], error: unknown): Error {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number; message?: string };
    const stdout = failure.stdout?.toString() ?? '';
    const stderr = failure.stderr?.toString() ?? '';
    const details = [stderr, stdout, failure.message ?? ''].filter(Boolean).join('\n');
    const status = typeof failure.status === 'number' ? ` (status ${failure.status})` : '';
    return new Error(`npm ${args.join(' ')}${status} failed${details ? `: ${details}` : ''}`);
}

function runNpm(invocation: NpmInvocation, args: readonly string[]): string {
    if (!path.isAbsolute(invocation.executable)) {
        throw new Error('npm invocation is outside elepha allowlist');
    }
    try {
        return execFileSync(invocation.executable, [...invocation.argsPrefix, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60_000,
            maxBuffer: 128 * 1024,
            env: invocation.environment,
            cwd: invocation.cwd,
        });
    } catch (error) {
        throw formatNpmFailure(args, error);
    }
}

function runNpmAsync(invocation: NpmInvocation, args: readonly string[]): Promise<string> {
    if (!path.isAbsolute(invocation.executable)) {
        return Promise.reject(new Error('npm invocation is outside elepha allowlist'));
    }
    return new Promise((resolve, reject) => {
        execFile(
            invocation.executable,
            [...invocation.argsPrefix, ...args],
            {
                encoding: 'utf8',
                timeout: 10_000,
                maxBuffer: 128 * 1024,
                env: invocation.environment,
                cwd: invocation.cwd,
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(formatNpmFailure(args, { ...error, stdout, stderr }));
                    return;
                }
                resolve(stdout);
            },
        );
    });
}

function parseNpmLatestVersion(output: string): string {
    let version: unknown;
    try {
        version = JSON.parse(output);
    } catch {
        throw new Error(`npm view elepha@latest returned an invalid version: ${output}`);
    }
    if (typeof version !== 'string' || !validPackageVersion(version)) {
        throw new Error(`npm view elepha@latest returned an invalid version: ${output}`);
    }
    return version;
}

/** Resolve the registry's current dist-tag before any daemon lifecycle mutation. */
export function npmViewElephaLatest(invocation: NpmInvocation): string {
    return parseNpmLatestVersion(runNpm(invocation, ['view', 'elepha@latest', 'version', '--json']).trim());
}

/** Resolve the registry's current dist-tag without blocking the daemon event loop. */
export async function npmViewElephaLatestAsync(invocation: NpmInvocation): Promise<string> {
    return parseNpmLatestVersion((await runNpmAsync(invocation, ['view', 'elepha@latest', 'version', '--json'])).trim());
}

/** Install only elepha's registry package at a validated immutable version. */
export function npmInstallGlobalElepha(invocation: NpmInvocation, version: string | 'latest'): void {
    if (version !== 'latest' && !validPackageVersion(version)) {
        throw new Error('npm installation version is outside elepha allowlist');
    }
    runNpm(invocation, ['install', '-g', `elepha@${version}`]);
}
