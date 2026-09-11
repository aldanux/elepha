import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { INSTALLED_HOOK_TIMEOUT_SECONDS } from '../config/constants.js';
import { deepSeekInsertedEntries, deepSeekPatch, deepSeekPatchRecord } from '../mcp/installer.js';
import { renderDeepSeekHookCommand } from '../security/subprocess-allowlist.js';
import { DEEPSEEK_HOOKS_END, DEEPSEEK_HOOKS_FILE_MARKER, DEEPSEEK_HOOKS_START } from './markers.js';

export const DEEPSEEK_HOOKS_ID = 'elepha-commands';
export const DEEPSEEK_HOOKS_BRIDGE = '@deepseek-ai/dsh-hooks-claude-code';

type PatchStatus = 'active' | 'disabled' | 'conflict' | 'invalid' | 'not installed' | 'stale bridge';
export type DeepSeekCommandsStatus = PatchStatus | 'stale hooks';

interface MarkerRange {
    start: number;
    end: number;
}

function markerRange(text: string, startMarker: string, endMarker: string): MarkerRange | undefined {
    const startToken = `${startMarker}\n`;
    const endToken = `${endMarker}\n`;
    const starts = text.split(startMarker).length - 1;
    const ends = text.split(endMarker).length - 1;
    if (starts === 0 && ends === 0) {
        return undefined;
    }
    if (starts !== 1 || ends !== 1) {
        throw new Error('DeepSeek Harness hook ownership markers are malformed');
    }
    const start = text.indexOf(startToken);
    const markerEnd = text.indexOf(endMarker);
    if (start < 0 || markerEnd < start) {
        throw new Error('DeepSeek Harness hook ownership markers are malformed');
    }
    const end = text.startsWith(endToken, markerEnd) ? markerEnd + endToken.length : markerEnd + endMarker.length;
    return { start, end };
}

function withoutRange(text: string, range: MarkerRange | undefined): string {
    return range ? `${text.slice(0, range.start)}${text.slice(range.end)}` : text;
}

function unmanagedPatch(text: string): { text: string; owned?: MarkerRange } {
    const owned = markerRange(text, DEEPSEEK_HOOKS_START, DEEPSEEK_HOOKS_END);
    return { text: withoutRange(text, owned), owned };
}

function hasUserConflict(patch: unknown[]): boolean {
    return (
        patch.some((operation) => deepSeekPatchRecord(operation)?.id === DEEPSEEK_HOOKS_ID) ||
        deepSeekInsertedEntries(patch).some((entry) => entry.id === DEEPSEEK_HOOKS_ID)
    );
}

export function deepSeekHooksPath(patchPath: string): string {
    return path.join(path.dirname(patchPath), 'elepha', 'hooks.json');
}

function expectedConfig(configPath: string): Record<string, unknown> {
    return { configPath };
}

function ownedBlock(configPath: string): string {
    return `${DEEPSEEK_HOOKS_START}\n- insert:\n    - id: ${DEEPSEEK_HOOKS_ID}\n      name: '${DEEPSEEK_HOOKS_BRIDGE}'\n      config:\n        configPath: ${JSON.stringify(configPath)}\n${DEEPSEEK_HOOKS_END}\n`;
}

function ownedEntry(text: string, range: MarkerRange): Record<string, unknown> | undefined {
    const entries = deepSeekInsertedEntries(deepSeekPatch(text.slice(range.start, range.end)));
    return entries.length === 1 ? entries[0] : undefined;
}

export function deepSeekHooksPatchStatus(text: string, configPath: string): PatchStatus {
    try {
        const stripped = unmanagedPatch(text);
        const unmanaged = deepSeekPatch(stripped.text);
        if (hasUserConflict(unmanaged)) {
            return 'conflict';
        }
        if (!stripped.owned) {
            return 'not installed';
        }
        const entry = ownedEntry(text, stripped.owned);
        const config = deepSeekPatchRecord(entry?.config);
        if (!entry || entry.id !== DEEPSEEK_HOOKS_ID || !config || typeof config.configPath !== 'string') {
            return 'invalid';
        }
        if (entry.disabled === true) {
            return 'disabled';
        }
        return entry.name === DEEPSEEK_HOOKS_BRIDGE && isDeepStrictEqual(config, expectedConfig(configPath)) ? 'active' : 'stale bridge';
    } catch {
        return 'invalid';
    }
}

export function transformDeepSeekHooksPatch(text: string, configPath: string, uninstall = false): string {
    if (!path.isAbsolute(configPath)) {
        throw new Error('DeepSeek Harness hooks config path must be absolute');
    }
    deepSeekPatch(text);
    const stripped = unmanagedPatch(text);
    const unmanaged = deepSeekPatch(stripped.text);
    if (hasUserConflict(unmanaged)) {
        throw new Error('conflicting user-owned DeepSeek Harness plugin named elepha-commands');
    }
    if (uninstall) {
        if (!stripped.owned) {
            return text;
        }
        const rendered = unmanaged.length === 0 ? `${stripped.text.trim() ? `${stripped.text.trimEnd()}\n` : ''}[]\n` : stripped.text;
        deepSeekPatch(rendered);
        return rendered;
    }
    const block = ownedBlock(configPath);
    const rendered =
        deepSeekPatch(stripped.text).length === 0 && /^\s*\[\]\s*$/.test(stripped.text)
            ? block
            : `${stripped.text}${stripped.text.length > 0 && !stripped.text.endsWith('\n') ? '\n' : ''}${block}`;
    deepSeekPatch(rendered);
    return rendered === text ? text : rendered;
}

export function renderDeepSeekHooks(launcher: string): string {
    return `${JSON.stringify(
        {
            elephaManaged: DEEPSEEK_HOOKS_FILE_MARKER,
            hooks: {
                SessionStart: [
                    {
                        matcher: 'startup|clear|resume|compact',
                        hooks: [
                            {
                                type: 'command',
                                command: renderDeepSeekHookCommand(launcher, 'session-start'),
                                timeout: INSTALLED_HOOK_TIMEOUT_SECONDS,
                            },
                        ],
                    },
                ],
                UserPromptSubmit: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: renderDeepSeekHookCommand(launcher, 'user-prompt-submit'),
                                timeout: INSTALLED_HOOK_TIMEOUT_SECONDS,
                            },
                        ],
                    },
                ],
            },
        },
        null,
        2,
    )}\n`;
}

export function ownsDeepSeekHooks(source: string | undefined): boolean {
    if (source === undefined) {
        return false;
    }
    try {
        const parsed = JSON.parse(source) as Record<string, unknown>;
        return parsed.elephaManaged === DEEPSEEK_HOOKS_FILE_MARKER;
    } catch {
        return false;
    }
}

export function deepSeekCommandsStatus(
    patchSource: string,
    patchPath: string,
    launcher: string,
    hooksSource: string | undefined,
): DeepSeekCommandsStatus {
    const configPath = deepSeekHooksPath(patchPath);
    const patch = deepSeekHooksPatchStatus(patchSource, configPath);
    if (hooksSource !== undefined && !ownsDeepSeekHooks(hooksSource)) {
        return 'conflict';
    }
    if (patch === 'conflict' || patch === 'invalid' || patch === 'disabled' || patch === 'stale bridge') {
        return patch;
    }
    if (patch === 'not installed' && hooksSource === undefined) {
        return 'not installed';
    }
    if (hooksSource !== renderDeepSeekHooks(launcher)) {
        return 'stale hooks';
    }
    return patch === 'active' ? 'active' : 'stale bridge';
}

// Missing and non-files are distinct. Never follow a hook-config symlink.
export function readDeepSeekHooks(patchPath: string): string | undefined {
    const file = deepSeekHooksPath(patchPath);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
        return undefined;
    }
    return stat.isFile() ? readFileSync(file, 'utf8') : '';
}
