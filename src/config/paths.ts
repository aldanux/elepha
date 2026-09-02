// Where the watched CLIs keep their session transcripts.
//
// Both tools support relocating their config/state directory via an env var.
// Hardcoding ~/.claude and ~/.codex makes every user with a non-default setup
// silently invisible to elepha - the daemon watches a directory that never
// receives writes and reports RUNNING forever. Every path into either tool
// must resolve through here.
//
// Case handling follows platform filesystem defaults: macOS and Windows are
// case-insensitive, while Linux and other platforms are case-sensitive. Compare
// with samePath/normalizeForCompare; store the original casing. Volume-level
// case-sensitivity detection is deliberately out of scope.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ToolName } from '../types/index.js';
import {
    DEFAULT_ELEPHA_SERVICE_LABEL,
    REFUSED_ABSOLUTE_PROJECT_ROOTS,
    REFUSED_HOME_PROJECT_ROOTS,
    TEMPORARY_PROJECT_ROOTS,
} from './constants.js';

export { DEFAULT_ELEPHA_SERVICE_LABEL } from './constants.js';

export function expandUserPath(p: string): string {
    if (p === '~') {
        return homedir();
    }
    return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
}

// Claude Code's config root. Honors CLAUDE_CONFIG_DIR, else ~/.claude.
export function claudeConfigDir(): string {
    const override = process.env.CLAUDE_CONFIG_DIR?.trim();
    return override ? path.resolve(override) : path.join(homedir(), '.claude');
}

// Codex's home. Honors CODEX_HOME, else ~/.codex.
export function codexHome(): string {
    const override = process.env.CODEX_HOME?.trim();
    return override ? path.resolve(override) : path.join(homedir(), '.codex');
}

export function claudeProjectsRoot(): string {
    return path.join(claudeConfigDir(), 'projects');
}

export function codexSessionsRoot(): string {
    return path.join(codexHome(), 'sessions');
}

export function providerStoreRoot(tool: ToolName): string {
    if (tool === 'claude-code') {
        return claudeProjectsRoot();
    }
    if (tool === 'codex') {
        return codexSessionsRoot();
    }
    throw new Error(`Unsupported transcript provider: ${String(tool)}`);
}

// elepha's own user configuration; hooks only read it and never create it.
export function elephaConfigPath(): string {
    return elephaPaths().config;
}

export function hookLogPath(): string {
    const override = process.env.ELEPHA_HOOK_LOG_PATH?.trim();
    if (override) {
        return path.resolve(override);
    }
    return path.join(elephaLogDir(), 'hook.log');
}

export function claudeSettingsPath(): string {
    return path.join(claudeConfigDir(), 'settings.json');
}

// Claude Code's user-scoped MCP registry. Project .mcp.json is deliberately never used here.
export function claudeMcpPath(): string {
    const override = process.env.ELEPHA_CLAUDE_MCP_PATH?.trim();
    if (override) {
        return path.resolve(override);
    }
    return path.join(homedir(), '.claude.json');
}

export function codexConfigPath(): string {
    return path.join(codexHome(), 'config.toml');
}

// elepha-owned paths are kept together so persistent integrations never learn a Node-manager path.
export function elephaHome(): string {
    const override = process.env.ELEPHA_HOME?.trim();
    if (override) {
        return path.resolve(override);
    }
    return path.join(homedir(), '.elepha');
}

// Complete elepha-owned layout for one user home.
export function elephaPaths(home = homedir()): {
    home: string;
    root: string;
    config: string;
    launcher: string;
    logDir: string;
    serviceDir: string;
    installState: string;
    installTransaction: string;
    launchFailure: string;
    heartbeat: string;
    updateCheckState: string;
    updateAvailable: string;
    stdout: string;
    stderr: string;
    launchAgent: string;
} {
    // The normal user-home layout honors ELEPHA_HOME; explicit homes are used
    // by isolated install/test runs and retain their literal layout.
    const root = home === homedir() ? elephaHome() : path.join(home, '.elepha');
    const logDir = path.join(root, 'logs');
    const serviceDir = path.join(root, 'service');
    return {
        home,
        root,
        config: path.join(root, 'config.json'),
        launcher: path.join(root, 'bin', 'elepha'),
        logDir,
        serviceDir,
        installState: path.join(serviceDir, 'install-state.json'),
        installTransaction: path.join(serviceDir, 'install-transaction.json'),
        launchFailure: path.join(serviceDir, 'launch-failure.json'),
        heartbeat: path.join(root, 'daemon.heartbeat.json'),
        updateCheckState: path.join(root, 'update-check.json'),
        updateAvailable: path.join(root, 'update-available.json'),
        stdout: path.join(logDir, 'daemon.stdout.log'),
        stderr: path.join(logDir, 'daemon.stderr.log'),
        launchAgent: path.join(home, 'Library', 'LaunchAgents', `${elephaServiceLabel()}.plist`),
    };
}

// A service label is also a LaunchAgents filename component, so keep it path-safe.
export function elephaServiceLabel(): string {
    const override = process.env.ELEPHA_SERVICE_LABEL?.trim();
    if (!override) {
        return DEFAULT_ELEPHA_SERVICE_LABEL;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(override)) {
        throw new Error('ELEPHA_SERVICE_LABEL must contain only letters, numbers, dots, and hyphens');
    }
    return override;
}

export function elephaLauncherPath(): string {
    return elephaPaths().launcher;
}

export function elephaLogDir(): string {
    return elephaPaths().logDir;
}

export function elephaInstallTransactionPath(): string {
    return elephaPaths().installTransaction;
}

export function elephaLaunchFailurePath(): string {
    return elephaPaths().launchFailure;
}

export function daemonHeartbeatPath(): string {
    return elephaPaths().heartbeat;
}

// Daemon-owned cache state for the daily registry check.
export function updateCheckStatePath(): string {
    return elephaPaths().updateCheckState;
}

// Hook-readable marker written only when the daemon found a newer release.
export function updateAvailablePath(): string {
    return elephaPaths().updateAvailable;
}

export function daemonStdoutLogPath(): string {
    return elephaPaths().stdout;
}

export function daemonStderrLogPath(): string {
    return elephaPaths().stderr;
}

export function daemonLaunchAgentPath(label = elephaServiceLabel()): string {
    return label === elephaServiceLabel() ? elephaPaths().launchAgent : path.join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

// Forward-slash form, for substring checks that must behave the same on Windows.
export function toPosix(p: string): string {
    return p.split(path.sep).join('/');
}

// Separator-normalized form for COMPARISON ONLY, case-folded on platforms whose
// filesystems are case-insensitive by default. This platform check deliberately
// does not detect volume-level overrides. Never persist this form: case-folding
// destroys the real casing and can merge distinct files on case-sensitive volumes.
export function normalizeForCompare(p: string): string;
export function normalizeForCompare(p: string, platform: NodeJS.Platform): string;
export function normalizeForCompare(p: string, platform: unknown = process.platform): string {
    const normalized = toPosix(path.normalize(p));
    const comparePlatform = typeof platform === 'string' ? platform : process.platform;
    return comparePlatform === 'darwin' || comparePlatform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
    return normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
}

// Resolves symlinks when possible; non-existent paths retain lexical resolution.
export function canonicalizeExisting(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return path.resolve(p);
    }
}

// True if `child` is inside `parent` (or is `parent`), using platform-default case handling.
export function isWithin(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
    const p = normalizeForCompare(parent, platform).replace(/\/+$/, '');
    const c = normalizeForCompare(child, platform);
    return c === p || c.startsWith(`${p}/`);
}

export function isWithinProviderStore(tool: ToolName, sourcePath: string): boolean {
    try {
        return isWithin(canonicalizeExisting(providerStoreRoot(tool)), canonicalizeExisting(sourcePath));
    } catch {
        return false;
    }
}

export function isReadableProviderSource(tool: ToolName, sourcePath: string): boolean {
    return isWithinProviderStore(tool, sourcePath) && existsSync(sourcePath);
}

const XDG_USER_DIR_NAMES = ['DESKTOP', 'DOCUMENTS', 'DOWNLOAD'] as const;
const WSL_WINDOWS_HOME_PATTERN = /^\/mnt\/[a-z]\/Users\/[^/]+$/;

interface RefusedRootInputs {
    home: string;
    xdgConfigHome: string | undefined;
    claudeConfigRoot: string;
    codexConfigRoot: string;
}

interface RefusedRootSet {
    inputs: RefusedRootInputs;
    exact: readonly string[];
    temporary: readonly string[];
    toolConfig: readonly string[];
}

let cachedLocalizedUserDirRoots: { inputs: RefusedRootInputs; roots: readonly string[] } | undefined;
let cachedRefusedRootSet: RefusedRootSet | undefined;

function parseXdgUserDir(rawValue: string, home: string): string | undefined {
    const quoted = rawValue.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    if (!quoted) {
        return undefined;
    }

    let value = '';
    for (let index = 0; index < quoted[1].length; index++) {
        const character = quoted[1][index];
        if (character !== '\\') {
            value += character;
            continue;
        }
        const escaped = quoted[1][++index];
        if (escaped === undefined) {
            return undefined;
        }
        value += ['$', '`', '"', '\\'].includes(escaped) ? escaped : `\\${escaped}`;
    }

    for (const homeVariable of ['$HOME', `\${HOME}`]) {
        if (value === homeVariable) {
            return home;
        }
        if (value.startsWith(`${homeVariable}/`)) {
            return path.join(home, value.slice(homeVariable.length + 1));
        }
    }
    return path.isAbsolute(value) && !value.includes('\0') ? path.normalize(value) : undefined;
}

function readLocalizedUserDirRoots(inputs: RefusedRootInputs): readonly string[] {
    try {
        const configuredHome = inputs.xdgConfigHome?.trim();
        const configHome = configuredHome || path.join(inputs.home, '.config');
        if (!path.isAbsolute(configHome)) {
            return [];
        }
        const source = readFileSync(path.join(configHome, 'user-dirs.dirs'), 'utf8');
        const roots = new Map<(typeof XDG_USER_DIR_NAMES)[number], string>();
        for (const line of source.split(/\r?\n/)) {
            if (!/^\s*XDG_(?:DESKTOP|DOCUMENTS|DOWNLOAD)_DIR\b/.test(line)) {
                continue;
            }
            const assignment = line.match(/^\s*XDG_(DESKTOP|DOCUMENTS|DOWNLOAD)_DIR\s*=\s*(.*?)\s*$/);
            if (!assignment) {
                return [];
            }
            const root = parseXdgUserDir(assignment[2], inputs.home);
            if (!root) {
                return [];
            }
            roots.set(assignment[1] as (typeof XDG_USER_DIR_NAMES)[number], root);
        }
        if (!XDG_USER_DIR_NAMES.every((name) => roots.has(name))) {
            return [];
        }
        return XDG_USER_DIR_NAMES.map((name) => roots.get(name) as string);
    } catch {
        return [];
    }
}

function sameRefusedRootInputs(left: RefusedRootInputs, right: RefusedRootInputs): boolean {
    return (
        left.home === right.home &&
        left.xdgConfigHome === right.xdgConfigHome &&
        left.claudeConfigRoot === right.claudeConfigRoot &&
        left.codexConfigRoot === right.codexConfigRoot
    );
}

function localizedUserDirRoots(inputs: RefusedRootInputs): readonly string[] {
    if (!cachedLocalizedUserDirRoots || !sameRefusedRootInputs(cachedLocalizedUserDirRoots.inputs, inputs)) {
        cachedLocalizedUserDirRoots = { inputs, roots: readLocalizedUserDirRoots(inputs) };
    }
    return cachedLocalizedUserDirRoots.roots;
}

function withCanonicalForms(roots: readonly string[]): string[] {
    return roots.flatMap((root) => [root, canonicalizeExisting(root)]);
}

function refusedRootSet(inputs: RefusedRootInputs): RefusedRootSet {
    if (cachedRefusedRootSet && sameRefusedRootInputs(cachedRefusedRootSet.inputs, inputs)) {
        return cachedRefusedRootSet;
    }
    cachedRefusedRootSet = {
        inputs,
        exact: withCanonicalForms([
            ...REFUSED_HOME_PROJECT_ROOTS.map((relative) => path.join(inputs.home, relative)),
            ...localizedUserDirRoots(inputs),
            ...REFUSED_ABSOLUTE_PROJECT_ROOTS,
        ]),
        temporary: withCanonicalForms(TEMPORARY_PROJECT_ROOTS),
        toolConfig: withCanonicalForms([inputs.claudeConfigRoot, inputs.codexConfigRoot]),
    };
    return cachedRefusedRootSet;
}

function isRefusedWslWindowsRoot(candidate: string): boolean {
    const normalized = toPosix(path.normalize(candidate)).replace(/\/+$/, '');
    if (WSL_WINDOWS_HOME_PATTERN.test(normalized)) {
        return true;
    }
    return (
        WSL_WINDOWS_HOME_PATTERN.test(path.posix.dirname(normalized)) &&
        REFUSED_HOME_PROJECT_ROOTS.some((relative) => relative !== '' && path.posix.basename(normalized) === relative)
    );
}

// Directories that must never become a project, regardless of what a
// transcript's cwd says.
//
// $HOME itself is the one that actually bit us: a Codex session run from the
// home directory registered `/Users/<me>` as a project and ingested personal
// content (medical imaging files) into memory. Purging the row is not a fix -
// the next session from that cwd recreates it, which is exactly what happened
// within hours of the purge. The refusal has to live at ingestion.
//
// Only the directory ITSELF is refused, not everything beneath it: real
// projects live under $HOME. `~/Documents`, `~/Desktop` and `~/Downloads` are
// refused as project roots for the same reason - they are document dumps, not
// codebases. Tool config homes are refused as whole trees because their
// contents are provider state, not user projects.
export function isRefusedProjectRoot(projectPath: string): boolean {
    if (!projectPath.trim()) {
        return true; // an empty cwd yields an unreachable project row
    }
    const canonicalProjectPath = canonicalizeExisting(projectPath);
    const candidatePaths = [projectPath, canonicalProjectPath];
    const roots = refusedRootSet({
        home: homedir(),
        xdgConfigHome: process.env.XDG_CONFIG_HOME,
        claudeConfigRoot: claudeConfigDir(),
        codexConfigRoot: codexHome(),
    });
    // Temporary trees are never durable project roots. Unlike the user-facing
    // document directories above, refusing only their own root would let a
    // transient checkout such as /private/tmp/.../hooktest become permanent
    // memory merely by being one level deeper.
    return candidatePaths.some(
        (candidate) =>
            roots.exact.some((root) => samePath(root, candidate)) ||
            roots.temporary.some((root) => isWithin(root, candidate)) ||
            roots.toolConfig.some((root) => isWithin(root, candidate)) ||
            isRefusedWslWindowsRoot(candidate),
    );
}

// De-duplicates paths that differ only by case, keeping the first spelling
// seen. Used for files_touched: on macOS the same file reached via different
// casing must not appear twice.
export function dedupePaths(paths: string[]): string[] {
    const seen = new Map<string, string>();
    for (const p of paths) {
        const key = normalizeForCompare(p);
        if (!seen.has(key)) {
            seen.set(key, p);
        }
    }
    return [...seen.values()];
}
