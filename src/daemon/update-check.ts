import { PRIVATE_FILE_MODE, UPDATE_CHECK_INTERVAL_MS } from '../config/constants.js';
import { getSetting } from '../config/settings.js';
import { errorMessage } from '../util/error.js';
import { readJson, removeFileIfExists, writeJson } from '../util/fs.js';

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface UpdateAvailable {
    version: string;
    checkedAt: string;
}

interface UpdateCheckState {
    checkedAt: string;
}

export interface UpdateCheckOptions {
    statePath: string;
    markerPath: string;
    now?: () => number;
    enabled?: boolean;
    queryVersions: () => Promise<{ installedVersion: string; latestVersion: string }>;
    warn?: (message: string) => void;
}

export type UpdateCheckResult =
    | { status: 'update_available'; version: string }
    | { status: 'current' }
    | { status: 'rate_limited' }
    | { status: 'disabled' }
    | { status: 'unreachable' }
    | { status: 'failed' };

// Resolves the persistent preference after the explicit per-invocation opt-out.
export function updateCheckEnabled(environment: NodeJS.ProcessEnv = process.env, configPath?: string): boolean {
    return getSetting('update-check', environment, configPath).value;
}

function validVersion(version: string): RegExpMatchArray | undefined {
    return version.match(VERSION) ?? undefined;
}

export function isNewerVersion(candidate: string, installed: string): boolean {
    const candidateMatch = validVersion(candidate);
    const installedMatch = validVersion(installed);
    if (!candidateMatch || !installedMatch) {
        throw new Error('update check received an invalid package version');
    }
    for (let index = 1; index <= 3; index++) {
        const difference = Number(candidateMatch[index]) - Number(installedMatch[index]);
        if (difference !== 0) {
            return difference > 0;
        }
    }
    const candidatePrerelease = candidateMatch[4];
    const installedPrerelease = installedMatch[4];
    return installedPrerelease !== undefined && candidatePrerelease === undefined;
}

function readState(filePath: string): UpdateCheckState | undefined {
    const state = readJson<Partial<UpdateCheckState>>(filePath);
    return state && typeof state.checkedAt === 'string' && Number.isFinite(Date.parse(state.checkedAt))
        ? { checkedAt: state.checkedAt }
        : undefined;
}

export function readUpdateAvailable(markerPath: string): UpdateAvailable | undefined {
    const marker = readJson<Partial<UpdateAvailable>>(markerPath);
    if (!marker || typeof marker.version !== 'string' || !validVersion(marker.version) || typeof marker.checkedAt !== 'string') {
        return undefined;
    }
    return Number.isFinite(Date.parse(marker.checkedAt)) ? { version: marker.version, checkedAt: marker.checkedAt } : undefined;
}

function isRegistryUnavailable(error: unknown): boolean {
    const message = errorMessage(error);
    return (
        /\b(?:E?404|not found)\b/i.test(message) ||
        /\b(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/i.test(message) ||
        /\b(?:timed?\s*out|timeout|killed|SIGKILL|SIGTERM)\b/i.test(message)
    );
}

export async function runUpdateCheck(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
    if (options.enabled === false) {
        return { status: 'disabled' };
    }
    const now = (options.now ?? Date.now)();
    const state = readState(options.statePath);
    if (state && now - Date.parse(state.checkedAt) < UPDATE_CHECK_INTERVAL_MS) {
        return { status: 'rate_limited' };
    }
    try {
        const { installedVersion, latestVersion } = await options.queryVersions();
        const checkedAt = new Date(now).toISOString();
        if (isNewerVersion(latestVersion, installedVersion)) {
            writeJson(options.markerPath, { version: latestVersion, checkedAt }, PRIVATE_FILE_MODE);
            writeJson(options.statePath, { checkedAt }, PRIVATE_FILE_MODE);
            return { status: 'update_available', version: latestVersion };
        }
        removeFileIfExists(options.markerPath);
        writeJson(options.statePath, { checkedAt }, PRIVATE_FILE_MODE);
        return { status: 'current' };
    } catch (error) {
        if (isRegistryUnavailable(error)) {
            const checkedAt = new Date(now).toISOString();
            removeFileIfExists(options.markerPath);
            writeJson(options.statePath, { checkedAt }, PRIVATE_FILE_MODE);
            return { status: 'unreachable' };
        }
        options.warn?.(`[elepha] update check failed: ${errorMessage(error)}`);
        writeJson(options.statePath, { checkedAt: new Date(now).toISOString() }, PRIVATE_FILE_MODE);
        return { status: 'failed' };
    }
}
