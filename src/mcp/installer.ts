import { lstatSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { parseDocument } from 'yaml';
import { CODEX_MCP_END, CODEX_MCP_START, DEEPSEEK_MCP_END, DEEPSEEK_MCP_START } from '../install/markers.js';

export const ELEPHA_MCP_SERVER_NAME = 'elepha';
export const ELEPHA_MCP_ARGS = ['mcp', 'serve'] as const;
const DEEPSEEK_MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

type DeepSeekPatchEntry = Record<string, unknown>;

const inertJsTag = {
    tag: 'tag:yaml.org,2002:js',
    resolve(value: string): string {
        return value;
    },
};

export function deepSeekPatch(text: string): unknown[] {
    const document = parseDocument(text.trim() ? text : '[]\n', { customTags: [inertJsTag] });
    if (document.errors.length > 0) {
        throw new Error('DeepSeek Harness cordis.patch.yml is malformed');
    }
    if (document.contents === null) {
        return [];
    }
    const value: unknown = document.toJS();
    if (!Array.isArray(value)) {
        throw new Error('DeepSeek Harness cordis.patch.yml is malformed');
    }
    return value;
}

export function deepSeekPatchRecord(value: unknown): DeepSeekPatchEntry | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as DeepSeekPatchEntry) : undefined;
}

export function deepSeekInsertedEntries(patch: unknown[]): DeepSeekPatchEntry[] {
    const entries: DeepSeekPatchEntry[] = [];
    for (const operation of patch) {
        const insert = deepSeekPatchRecord(operation)?.insert;
        if (!Array.isArray(insert)) {
            continue;
        }
        for (const value of insert) {
            const entry = deepSeekPatchRecord(value);
            if (entry) {
                entries.push(entry);
            }
        }
    }
    return entries;
}

function hasDeepSeekUserConflict(patch: unknown[]): boolean {
    return (
        patch.some((operation) => {
            const entry = deepSeekPatchRecord(operation);
            return entry?.id === ELEPHA_MCP_SERVER_NAME || deepSeekPatchRecord(entry?.config)?.serverName === ELEPHA_MCP_SERVER_NAME;
        }) ||
        deepSeekInsertedEntries(patch).some((entry) => {
            const config = deepSeekPatchRecord(entry.config);
            return entry.id === ELEPHA_MCP_SERVER_NAME || config?.serverName === ELEPHA_MCP_SERVER_NAME;
        })
    );
}

function markerRange(text: string): { start: number; end: number } | undefined {
    const startToken = `${DEEPSEEK_MCP_START}\n`;
    const endToken = `${DEEPSEEK_MCP_END}\n`;
    const starts = text.split(DEEPSEEK_MCP_START).length - 1;
    const ends = text.split(DEEPSEEK_MCP_END).length - 1;
    if (starts === 0 && ends === 0) {
        return undefined;
    }
    if (starts !== 1 || ends !== 1) {
        throw new Error('DeepSeek Harness MCP ownership markers are malformed');
    }
    const start = text.indexOf(startToken);
    const markerEnd = text.indexOf(DEEPSEEK_MCP_END);
    if (start < 0 || markerEnd < start) {
        throw new Error('DeepSeek Harness MCP ownership markers are malformed');
    }
    const end = text.startsWith(endToken, markerEnd) ? markerEnd + endToken.length : markerEnd + DEEPSEEK_MCP_END.length;
    return { start, end };
}

function deepSeekOwnedBlock(launcher: string): string {
    return `${DEEPSEEK_MCP_START}\n- insert:\n    - id: ${ELEPHA_MCP_SERVER_NAME}\n      name: '${DEEPSEEK_MCP_CLIENT}'\n      config:\n        serverName: ${ELEPHA_MCP_SERVER_NAME}\n        transport: stdio\n        command: ${JSON.stringify(launcher)}\n        args: ['mcp', 'serve']\n        env: {}\n${DEEPSEEK_MCP_END}\n`;
}

function validateDeepSeekLauncher(launcher: string): void {
    if (!path.isAbsolute(launcher)) {
        throw new Error('DeepSeek Harness MCP launcher must be an absolute path');
    }
    if (lstatSync(launcher, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error('DeepSeek Harness MCP launcher must not be a symbolic link');
    }
}

function deepSeekOwnedEntry(text: string, range: { start: number; end: number }): DeepSeekPatchEntry | undefined {
    const entries = deepSeekInsertedEntries(deepSeekPatch(text.slice(range.start, range.end)));
    return entries.length === 1 ? entries[0] : undefined;
}

export function isElephaDeepSeekMcp(value: unknown): boolean {
    const entry = deepSeekPatchRecord(value);
    const config = deepSeekPatchRecord(entry?.config);
    return (
        entry?.id === ELEPHA_MCP_SERVER_NAME &&
        entry.name === DEEPSEEK_MCP_CLIENT &&
        config?.serverName === ELEPHA_MCP_SERVER_NAME &&
        config.transport === 'stdio' &&
        typeof config.command === 'string' &&
        isDeepStrictEqual(config.args, [...ELEPHA_MCP_ARGS]) &&
        isDeepStrictEqual(config.env, {})
    );
}

export function transformDeepSeekMcp(text: string, launcher: string, uninstall = false): string {
    validateDeepSeekLauncher(launcher);
    deepSeekPatch(text);
    const range = markerRange(text);
    const withoutOwned = range ? `${text.slice(0, range.start)}${text.slice(range.end)}` : text;
    const unmanagedPatch = deepSeekPatch(withoutOwned);
    if (hasDeepSeekUserConflict(unmanagedPatch)) {
        throw new Error('conflicting user-owned DeepSeek Harness MCP server named elepha; adopt it manually');
    }
    if (uninstall) {
        if (!range) {
            return text;
        }
        const rendered = unmanagedPatch.length === 0 ? `${withoutOwned.trim() ? `${withoutOwned.trimEnd()}\n` : ''}[]\n` : withoutOwned;
        deepSeekPatch(rendered);
        return rendered;
    }
    const block = deepSeekOwnedBlock(launcher);
    let rendered: string;
    if (range) {
        rendered = `${text.slice(0, range.start)}${block}${text.slice(range.end)}`;
    } else if (deepSeekPatch(text).length === 0 && /^\s*\[\]\s*$/.test(text)) {
        rendered = block;
    } else {
        rendered = `${text}${text.length > 0 && !text.endsWith('\n') ? '\n' : ''}${block}`;
    }
    deepSeekPatch(rendered);
    return rendered === text ? text : rendered;
}

export function hasDeepSeekMcp(
    text: string,
    launcher: string,
): 'registered' | 'disabled' | 'conflict' | 'invalid' | 'not installed' | 'stale binary' {
    try {
        const range = markerRange(text);
        const patch = deepSeekPatch(range ? `${text.slice(0, range.start)}${text.slice(range.end)}` : text);
        if (hasDeepSeekUserConflict(patch)) {
            return 'conflict';
        }
        if (!range) {
            return 'not installed';
        }
        const entry = deepSeekOwnedEntry(text, range);
        if (!isElephaDeepSeekMcp(entry)) {
            return 'invalid';
        }
        if (entry?.disabled === true) {
            return 'disabled';
        }
        return deepSeekPatchRecord(entry?.config)?.command === launcher ? 'registered' : 'stale binary';
    } catch {
        return 'invalid';
    }
}

function kimiMcpConfig(text: string): Record<string, unknown> {
    try {
        const config: unknown = text.trim() ? JSON.parse(text) : {};
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            throw new Error();
        }
        const servers = (config as Record<string, unknown>).mcpServers;
        if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
            throw new Error();
        }
        return config as Record<string, unknown>;
    } catch {
        throw new Error('Kimi Code mcp.json is malformed');
    }
}

export function isElephaKimiMcp(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const server = value as Record<string, unknown>;
    return typeof server.command === 'string' && isDeepStrictEqual(server.args, [...ELEPHA_MCP_ARGS]);
}

export function transformKimiMcp(text: string, launcher: string, uninstall = false): string {
    const config = kimiMcpConfig(text);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    const current = servers[ELEPHA_MCP_SERVER_NAME];
    const expected = { command: launcher, args: [...ELEPHA_MCP_ARGS] };
    let changed = false;
    if (current !== undefined && !isElephaKimiMcp(current)) {
        throw new Error('conflicting user-owned Kimi Code MCP server named elepha');
    }
    if (uninstall) {
        if (current !== undefined) {
            const next = { ...servers };
            delete next[ELEPHA_MCP_SERVER_NAME];
            config.mcpServers = next;
            changed = true;
        }
    } else if (!isDeepStrictEqual(current, expected)) {
        config.mcpServers = { ...servers, [ELEPHA_MCP_SERVER_NAME]: expected };
        changed = true;
    }
    return changed ? `${JSON.stringify(config, null, 2)}\n` : text;
}

export function hasKimiMcp(
    text: string,
    launcher: string,
): 'registered' | 'disabled' | 'conflict' | 'invalid' | 'not installed' | 'stale binary' {
    try {
        const config = kimiMcpConfig(text);
        const entry = (config.mcpServers as Record<string, unknown> | undefined)?.[ELEPHA_MCP_SERVER_NAME];
        if (entry === undefined) {
            return 'not installed';
        }
        if (!isElephaKimiMcp(entry)) {
            return 'conflict';
        }
        const server = entry as Record<string, unknown>;
        if (server.enabled === false) {
            return 'disabled';
        }
        return server.command === launcher ? 'registered' : 'stale binary';
    } catch {
        return 'invalid';
    }
}

export function transformClaudeMcp(text: string, bin: string, uninstall = false): string {
    let config: Record<string, unknown> = {};
    if (text.trim()) {
        try {
            config = JSON.parse(text) as Record<string, unknown>;
        } catch {
            throw new Error('Claude ~/.claude.json is malformed');
        }
    }
    const servers = (
        config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers) ? config.mcpServers : {}
    ) as Record<string, unknown>;
    const current = servers[ELEPHA_MCP_SERVER_NAME];
    const expected = { type: 'stdio', command: bin, args: [...ELEPHA_MCP_ARGS] };
    if (uninstall) {
        if (current === undefined) {
            return text;
        }
        if (!isElephaMcp(current)) {
            throw new Error('conflicting user-owned Claude MCP server named elepha');
        }
        const next = { ...servers };
        delete next[ELEPHA_MCP_SERVER_NAME];
        config.mcpServers = next;
    } else if (current === undefined) {
        config.mcpServers = { ...servers, [ELEPHA_MCP_SERVER_NAME]: expected };
    } else if (sameMcp(current, expected)) {
        return text;
    } else if (isElephaMcp(current)) {
        config.mcpServers = { ...servers, [ELEPHA_MCP_SERVER_NAME]: expected };
    } else {
        throw new Error('conflicting user-owned Claude MCP server named elepha');
    }
    return `${JSON.stringify(config, null, 2)}\n`;
}

function sameMcp(value: unknown, expected: unknown): boolean {
    return JSON.stringify(value) === JSON.stringify(expected);
}

function isElephaMcp(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const server = value as Record<string, unknown>;
    return (
        server.type === 'stdio' &&
        Array.isArray(server.args) &&
        server.args.join('\0') === ELEPHA_MCP_ARGS.join('\0') &&
        typeof server.command === 'string'
    );
}

function isCodexElephaMcp(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const server = value as Record<string, unknown>;
    return Array.isArray(server.args) && server.args.join('\0') === ELEPHA_MCP_ARGS.join('\0') && typeof server.command === 'string';
}

export function isElephaOpencodeMcp(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const server = value as Record<string, unknown>;
    return (
        server.type === 'local' &&
        Array.isArray(server.command) &&
        server.command.slice(1).join('\0') === ELEPHA_MCP_ARGS.join('\0') &&
        typeof server.command[0] === 'string'
    );
}

// Registers/removes elepha's MCP server and (when pluginPath is given) the elepha
// plugin in opencode.json. OpenCode only loads plugins listed in the `plugin`
// array, so dropping the plugin file on disk is not enough — its absolute path
// must be registered here too.
export function transformOpencodeMcp(text: string, bin: string, uninstall = false, pluginPath?: string): string {
    let config: Record<string, unknown> = {};
    if (text.trim()) {
        try {
            config = JSON.parse(text) as Record<string, unknown>;
        } catch {
            throw new Error('OpenCode opencode.json is malformed');
        }
    }
    const servers = (config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp) ? config.mcp : {}) as Record<
        string,
        unknown
    >;
    const current = servers[ELEPHA_MCP_SERVER_NAME];
    const expected = { type: 'local', command: [bin, ...ELEPHA_MCP_ARGS], enabled: true };
    let changed = false;
    if (uninstall) {
        if (current !== undefined) {
            if (!isElephaOpencodeMcp(current)) {
                throw new Error('conflicting user-owned OpenCode MCP server named elepha');
            }
            const next = { ...servers };
            delete next[ELEPHA_MCP_SERVER_NAME];
            config.mcp = next;
            changed = true;
        }
    } else if (current === undefined) {
        config.mcp = { ...servers, [ELEPHA_MCP_SERVER_NAME]: expected };
        changed = true;
    } else if (isElephaOpencodeMcp(current)) {
        if (!isDeepStrictEqual(current, expected)) {
            config.mcp = { ...servers, [ELEPHA_MCP_SERVER_NAME]: expected };
            changed = true;
        }
    } else {
        throw new Error('conflicting user-owned OpenCode MCP server named elepha');
    }
    if (pluginPath !== undefined) {
        changed = applyOpencodePluginRegistration(config, pluginPath, uninstall) || changed;
    }
    return changed ? `${JSON.stringify(config, null, 2)}\n` : text;
}

// Only elepha's own plugin path is added or removed; any user-listed plugins are
// left intact. Returns whether the config's plugin array changed.
function applyOpencodePluginRegistration(config: Record<string, unknown>, pluginPath: string, uninstall: boolean): boolean {
    const existing = Array.isArray(config.plugin) ? (config.plugin as unknown[]).filter((entry) => typeof entry === 'string') : [];
    const others = existing.filter((entry) => entry !== pluginPath);
    const alreadyPresent = existing.includes(pluginPath);
    if (uninstall) {
        if (!alreadyPresent) {
            return false;
        }
        if (others.length > 0) {
            config.plugin = others;
        } else {
            delete config.plugin;
        }
        return true;
    }
    if (alreadyPresent && existing.length === others.length + 1 && existing[existing.length - 1] === pluginPath) {
        return false;
    }
    config.plugin = [...others, pluginPath];
    return true;
}

function blockPattern(start: string, end: string): RegExp {
    return new RegExp(`${start}[\\s\\S]*?${end}\\n?`, 'g');
}

export function ownsCodexMcp(text: string): boolean {
    return text.replace(blockPattern(CODEX_MCP_START, CODEX_MCP_END), '') !== text;
}

export function transformCodexMcp(text: string, bin: string, uninstall = false): string {
    try {
        parse(text);
    } catch {
        throw new Error('Codex config.toml is malformed');
    }
    const block = `${CODEX_MCP_START}\n[mcp_servers.${ELEPHA_MCP_SERVER_NAME}]\ncommand = ${JSON.stringify(bin)}\nargs = [${ELEPHA_MCP_ARGS.map((arg) => JSON.stringify(arg)).join(', ')}]\nenabled = true\n${CODEX_MCP_END}\n`;
    const owned = text.replace(blockPattern(CODEX_MCP_START, CODEX_MCP_END), '');
    const hasUserTable = /^\s*\[mcp_servers\.elepha\]/m.test(owned);
    if (hasUserTable) {
        const parsed = parse(owned) as { mcp_servers?: Record<string, unknown> };
        const entry = parsed.mcp_servers?.[ELEPHA_MCP_SERVER_NAME];
        if (!isCodexElephaMcp(entry)) {
            throw new Error('conflicting user-owned Codex MCP server named elepha');
        }
        if (uninstall) {
            throw new Error('conflicting user-owned Codex MCP server named elepha');
        }
        throw new Error('unmanaged Codex MCP server named elepha must be adopted manually');
    }
    if (uninstall) {
        return owned;
    }
    const next = `${owned.replace(/\s*$/, '\n\n')}${block}`;
    parse(next);
    return next;
}

export function hasCodexMcp(text: string, bin: string): 'registered' | 'disabled' | 'invalid' | 'not installed' | 'stale binary' {
    try {
        const config = parse(text) as { mcp_servers?: Record<string, unknown> };
        const entry = config.mcp_servers?.[ELEPHA_MCP_SERVER_NAME];
        if (!entry) {
            return 'not installed';
        }
        if (!isCodexElephaMcp(entry)) {
            return 'invalid';
        }
        const server = entry as Record<string, unknown>;
        if (server.enabled === false) {
            return 'disabled';
        }
        return server.command === bin ? 'registered' : 'stale binary';
    } catch {
        return 'invalid';
    }
}

export function hasClaudeMcp(text: string, bin: string): 'registered' | 'invalid' | 'not installed' | 'stale binary' {
    if (!text.trim()) {
        return 'not installed';
    }
    try {
        const config = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
        const entry = config.mcpServers?.[ELEPHA_MCP_SERVER_NAME];
        if (!entry) {
            return 'not installed';
        }
        if (!isElephaMcp(entry)) {
            return 'invalid';
        }
        return (entry as Record<string, unknown>).command === bin ? 'registered' : 'stale binary';
    } catch {
        return 'invalid';
    }
}

export function hasOpencodeMcp(text: string, bin: string): 'registered' | 'disabled' | 'invalid' | 'not installed' | 'stale binary' {
    if (!text.trim()) {
        return 'not installed';
    }
    try {
        const config = JSON.parse(text) as { mcp?: Record<string, unknown> };
        const entry = config.mcp?.[ELEPHA_MCP_SERVER_NAME];
        if (!entry) {
            return 'not installed';
        }
        if (!isElephaOpencodeMcp(entry)) {
            return 'invalid';
        }
        const server = entry as Record<string, unknown>;
        if (server.enabled === false) {
            return 'disabled';
        }
        return (server.command as unknown[])[0] === bin ? 'registered' : 'stale binary';
    } catch {
        return 'invalid';
    }
}
