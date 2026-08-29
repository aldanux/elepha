// Loads the API key (and a small set of other settings) from a .env file.
//
// Deliberately NOT a general dotenv implementation, for three reasons that are
// specific to what elepha is:
//
//  1. NEVER FROM THE CURRENT DIRECTORY. elepha runs as a background daemon
//     while the user works in other repositories, and `elepha` is invoked from
//     whatever directory the user happens to be standing in. A cwd-relative
//     .env lookup would mean any project's secrets get read into this
//     process - a memory tool that quietly slurps other repos' credentials is
//     precisely the trust failure the consent model exists to prevent. Paths
//     are resolved from $HOME and from this package's own location, never from
//     process.cwd().
//  2. ALLOWLISTED KEYS ONLY. A .env can set anything, including PATH,
//     NODE_OPTIONS or ANTHROPIC_BASE_URL. Applying an arbitrary file wholesale
//     to process.env turns a config file into an execution-environment
//     override. Only the variables below are read; everything else in the file
//     is ignored.
//  3. NO INTERPOLATION. Popular dotenv variants expand `${VAR}` and some
//     expand `$(cmd)`. elepha's whole security posture is that stored text is
//     never executable syntax (Rule 3); it would be absurd to hand that
//     property away in the config loader. Values are taken literally.
//
// Explicit environment always wins: a variable already set in process.env is
// never overwritten, so `ANTHROPIC_API_KEY=... elepha rollup` behaves as
// expected and CI never picks up a developer's file.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage } from '../util/error.js';
import { PRIVATE_UMASK_MASK } from './constants.js';
import { elephaHome } from './paths.js';

/**
 * The only variables read from a .env file. Adding one here is a deliberate
 * act: it widens what a config file can change about this process.
 */
const ALLOWED_KEYS = new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'ELEPHA_CLAUDE_MCP_PATH',
    'ELEPHA_DB_PATH',
    'ELEPHA_HOME',
]);

/** Package root, resolved from this module's own location - not from cwd. */
function packageRoot(): string {
    // dist/config/env.js -> dist/config -> dist -> <package root>
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Candidate files, most specific first. `ELEPHA_ENV_FILE` exists so the
 * launchd plist and the CLI can be pointed at one file while the key lives in
 * two places.
 *
 * An explicit ELEPHA_ENV_FILE is the ONLY candidate when set. Falling back to
 * a different file because the named one is missing would mean the process
 * silently ran against config the operator did not choose - the same
 * "reads as working and isn't" shape as every other bug in this codebase's
 * reference cases.
 */
export function envFileCandidates(): string[] {
    const explicit = process.env.ELEPHA_ENV_FILE;
    if (explicit) {
        return [path.resolve(explicit)];
    }
    return [path.join(elephaHome(), '.env'), path.join(packageRoot(), '.env')];
}

export interface EnvLoadResult {
    /** File actually read, or undefined when none of the candidates exist. */
    file?: string;
    /** Names (never values) of the variables applied to process.env. */
    applied: string[];
    /** Names present in the file but not on the allowlist. */
    ignored: string[];
    /** True when the file is readable by group or other. */
    tooPermissive: boolean;
    /**
     * Set when a candidate exists but could not be read (permissions, a
     * directory in the way). Reported rather than thrown: a memory tool must
     * never be the reason a command fails to run. Distinguishable from "no
     * file" so it cannot be mistaken for a clean no-op.
     */
    error?: string;
}

/**
 * Parses .env text. Supports `KEY=value`, `#` comments, blank lines, and
 * single/double quoted values. No interpolation, no command substitution, no
 * multi-line values - anything fancier is a config file trying to be a
 * program.
 */
export function parseEnv(text: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) {
            continue;
        }
        const eq = line.indexOf('=');
        if (eq <= 0) {
            continue;
        }
        const key = line
            .slice(0, eq)
            .trim()
            .replace(/^export\s+/, '');
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
            (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        ) {
            value = value.slice(1, -1);
        }
        if (key !== '') {
            out.set(key, value);
        }
    }
    return out;
}

/**
 * Applies the first existing candidate file to process.env.
 *
 * Returns names only, never values. Callers may log the result; nothing in it
 * can leak a secret. (`SummarizerCallLog.sanitizeErrorMessage` is the matching
 * guard on the other end, for keys echoed back inside API error text.)
 */
export function loadEnvFile(): EnvLoadResult {
    for (const file of envFileCandidates()) {
        if (!existsSync(file)) {
            continue;
        }

        let mode: number;
        let parsed: Map<string, string>;
        try {
            mode = statSync(file).mode & 0o777;
            parsed = parseEnv(readFileSync(file, 'utf8'));
        } catch (err) {
            // The file is there but unreadable. Report it and carry on
            // unconfigured rather than crashing the CLI: `elepha status`
            // should still work when the key file is misowned.
            return {
                file,
                applied: [],
                ignored: [],
                tooPermissive: false,
                error: errorMessage(err),
            };
        }

        const applied: string[] = [];
        const ignored: string[] = [];
        for (const [key, value] of parsed) {
            if (!ALLOWED_KEYS.has(key)) {
                ignored.push(key);
                continue;
            }
            // Explicit environment wins. Never overwrite.
            if (process.env[key] === undefined || process.env[key] === '') {
                process.env[key] = value;
                applied.push(key);
            }
        }

        return { file, applied, ignored, tooPermissive: (mode & PRIVATE_UMASK_MASK) !== 0 };
    }
    return { applied: [], ignored: [], tooPermissive: false };
}

/**
 * Loads and warns, for CLI entrypoints. Warnings go to stderr so they never
 * pollute a hook's stdout (a SessionStart hook's stdout is parsed as JSON -
 * see the Phase 2 hook design).
 */
export function loadEnvFileWithWarnings(warn: (msg: string) => void = console.error): EnvLoadResult {
    const result = loadEnvFile();
    if (result.error && result.file) {
        warn(`[elepha] WARNING: could not read ${result.file}: ${result.error}. Continuing without it.`);
    }
    if (result.tooPermissive && result.file) {
        warn(`[elepha] WARNING: ${result.file} is readable by other users (chmod 600 it). It holds an API key.`);
    }
    if (result.ignored.length > 0 && result.file) {
        // Not silent: a key that looks set but is being ignored is exactly the
        // "reads as working and isn't" failure this codebase keeps hitting.
        warn(`[elepha] ignored non-allowlisted variable(s) in ${result.file}: ${result.ignored.join(', ')}`);
    }
    return result;
}
