import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { CODEX_MCP_END, CODEX_MCP_START } from '../install/markers.js';

export const ELEPHA_MCP_SERVER_NAME = 'elepha';
export const ELEPHA_MCP_ARGS = ['mcp', 'serve'] as const;

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
