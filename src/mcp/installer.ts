import { parse } from 'smol-toml';
import { CODEX_MCP_END, CODEX_MCP_START } from '../install/markers.js';

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
    const current = servers.elepha;
    const expected = { type: 'stdio', command: bin, args: ['mcp', 'serve'] };
    if (uninstall) {
        if (current === undefined) {
            return text;
        }
        if (!isElephaMcp(current)) {
            throw new Error('conflicting user-owned Claude MCP server named elepha');
        }
        const next = { ...servers };
        delete next.elepha;
        config.mcpServers = next;
    } else if (current === undefined) {
        config.mcpServers = { ...servers, elepha: expected };
    } else if (sameMcp(current, expected)) {
        return text;
    } else if (isElephaMcp(current)) {
        config.mcpServers = { ...servers, elepha: expected };
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
        server.args.join('\0') === 'mcp\0serve' &&
        typeof server.command === 'string'
    );
}

function isCodexElephaMcp(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const server = value as Record<string, unknown>;
    return Array.isArray(server.args) && server.args.join('\0') === 'mcp\0serve' && typeof server.command === 'string';
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
    const block = `${CODEX_MCP_START}\n[mcp_servers.elepha]\ncommand = ${JSON.stringify(bin)}\nargs = ["mcp", "serve"]\nenabled = true\n${CODEX_MCP_END}\n`;
    const owned = text.replace(blockPattern(CODEX_MCP_START, CODEX_MCP_END), '');
    const hasUserTable = /^\s*\[mcp_servers\.elepha\]/m.test(owned);
    if (hasUserTable) {
        const parsed = parse(owned) as { mcp_servers?: Record<string, unknown> };
        const entry = parsed.mcp_servers?.elepha;
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
        const entry = config.mcp_servers?.elepha;
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
        const entry = config.mcpServers?.elepha;
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
