import { describe, expect, it } from 'vitest';
import {
    ELEPHA_MCP_ARGS,
    ELEPHA_MCP_SERVER_NAME,
    hasClaudeMcp,
    hasCodexMcp,
    hasOpencodeMcp,
    transformClaudeMcp,
    transformCodexMcp,
    transformOpencodeMcp,
} from '../../src/mcp/installer.js';

const bin = '/opt/npm/bin/elepha';

describe('global MCP transforms', () => {
    it('installs and removes only the user-scoped Claude elepha server', () => {
        const unrelated = {
            projects: { '/Users/test/Sites/example': { hasTrustDialogAccepted: true } },
            mcpServers: { phpstorm: { type: 'stdio', command: '/Applications/PhpStorm.app/Contents/bin/phpstorm' } },
            top: true,
        };
        const installed = transformClaudeMcp(JSON.stringify(unrelated), bin);
        expect(hasClaudeMcp(installed, bin)).toBe('registered');
        const installedConfig = JSON.parse(installed) as Record<string, unknown>;
        const { elepha: _elepha, ...unrelatedServers } = installedConfig.mcpServers as Record<string, unknown>;
        expect({ ...installedConfig, mcpServers: unrelatedServers }).toEqual(unrelated);
        const removed = transformClaudeMcp(installed, bin, true);
        expect(JSON.parse(removed)).toEqual(unrelated);
        expect(hasClaudeMcp(removed, bin)).toBe('not installed');
    });

    it('refuses malformed user config and an unrelated Claude server under the elepha name', () => {
        expect(() => transformClaudeMcp('{', bin)).toThrow('~/.claude.json is malformed');
        expect(() => transformClaudeMcp(JSON.stringify({ mcpServers: { elepha: { command: 'other' } } }), bin)).toThrow('conflicting');
    });

    it('keeps Codex comments and installs a canonical enabled server', () => {
        const installed = transformCodexMcp('# keep\n[other]\nx = 1\n', bin);
        expect(installed).toContain('# keep');
        expect(hasCodexMcp(installed, bin)).toBe('registered');
        expect(transformCodexMcp(installed, bin, true)).not.toContain('mcp_servers.elepha');
    });

    it('installs OpenCode MCP from an empty config and is byte-idempotent', () => {
        const installed = transformOpencodeMcp('   ', bin);

        expect(JSON.parse(installed)).toEqual({
            mcp: {
                servers: {
                    [ELEPHA_MCP_SERVER_NAME]: {
                        type: 'local',
                        command: [bin, ...ELEPHA_MCP_ARGS],
                        codemode: false,
                    },
                },
            },
        });
        expect(transformOpencodeMcp(installed, bin)).toBe(installed);
        const reordered = JSON.stringify({
            mcp: {
                servers: {
                    [ELEPHA_MCP_SERVER_NAME]: {
                        codemode: false,
                        command: [bin, ...ELEPHA_MCP_ARGS],
                        type: 'local',
                    },
                },
            },
        });
        expect(transformOpencodeMcp(reordered, bin)).toBe(reordered);
    });

    it('preserves OpenCode schema, unrelated keys, and other MCP servers', () => {
        const config = {
            $schema: 'https://opencode.ai/config.json',
            theme: 'system',
            mcp: { servers: { docs: { type: 'remote', url: 'https://example.test/mcp' } }, codemode: true },
            plugin: ['user-plugin'],
        };

        const installed = JSON.parse(transformOpencodeMcp(JSON.stringify(config), bin)) as typeof config & {
            mcp: { servers: Record<string, unknown>; codemode: boolean };
        };
        const { [ELEPHA_MCP_SERVER_NAME]: _elepha, ...otherServers } = installed.mcp.servers;

        expect({ ...installed, mcp: { ...installed.mcp, servers: otherServers } }).toEqual(config);
    });

    it('refreshes a stale OpenCode binary and enables direct tool calls', () => {
        const stale = JSON.stringify({
            mcp: {
                [ELEPHA_MCP_SERVER_NAME]: {
                    type: 'local',
                    command: ['/old/bin/elepha', ...ELEPHA_MCP_ARGS],
                    enabled: false,
                },
            },
        });

        const installed = transformOpencodeMcp(stale, bin);

        expect(hasOpencodeMcp(installed, bin)).toBe('registered');
        expect(JSON.parse(installed).mcp.servers[ELEPHA_MCP_SERVER_NAME]).toEqual({
            type: 'local',
            command: [bin, ...ELEPHA_MCP_ARGS],
            codemode: false,
        });
        expect(JSON.parse(installed).mcp[ELEPHA_MCP_SERVER_NAME]).toBeUndefined();
    });

    it('migrates owned flat and nested entries without changing other MCP settings', () => {
        const original = {
            mcp: {
                [ELEPHA_MCP_SERVER_NAME]: { type: 'local', command: ['/old/bin/elepha', ...ELEPHA_MCP_ARGS] },
                servers: {
                    docs: { type: 'remote', url: 'https://example.test/mcp' },
                    [ELEPHA_MCP_SERVER_NAME]: { type: 'local', command: ['/old/bin/elepha', ...ELEPHA_MCP_ARGS] },
                },
                timeout: 5000,
            },
            plugin: ['user-plugin'],
        };
        const installed = transformOpencodeMcp(JSON.stringify(original), bin);
        const parsed = JSON.parse(installed);

        expect(parsed.mcp.elepha).toBeUndefined();
        expect(parsed.mcp.servers.elepha).toEqual({
            type: 'local',
            command: [bin, ...ELEPHA_MCP_ARGS],
            codemode: false,
        });
        expect(parsed.mcp.servers.docs).toEqual(original.mcp.servers.docs);
        expect(parsed.mcp.timeout).toBe(5000);
        expect(parsed.plugin).toEqual(['user-plugin']);
        expect(transformOpencodeMcp(installed, bin)).toBe(installed);
        const removed = JSON.parse(transformOpencodeMcp(JSON.stringify(original), bin, true));
        expect(removed.mcp.elepha).toBeUndefined();
        expect(removed.mcp.servers.elepha).toBeUndefined();
        expect(removed.mcp.servers.docs).toEqual(original.mcp.servers.docs);
        expect(removed.plugin).toEqual(['user-plugin']);
    });

    it('refuses user-owned OpenCode conflicts during install and uninstall', () => {
        for (const mcp of [
            { [ELEPHA_MCP_SERVER_NAME]: { type: 'local', command: ['other', 'serve'] } },
            { servers: { [ELEPHA_MCP_SERVER_NAME]: { type: 'local', command: ['other', 'serve'] } } },
            {
                [ELEPHA_MCP_SERVER_NAME]: { type: 'local', command: [bin, ...ELEPHA_MCP_ARGS] },
                servers: { [ELEPHA_MCP_SERVER_NAME]: { type: 'local', command: ['other', 'serve'] } },
            },
        ]) {
            const userOwned = JSON.stringify({ mcp });
            expect(() => transformOpencodeMcp(userOwned, bin)).toThrow('conflicting user-owned OpenCode MCP server named elepha');
            expect(() => transformOpencodeMcp(userOwned, bin, true)).toThrow('conflicting user-owned OpenCode MCP server named elepha');
        }
    });

    it('uninstalls only the OpenCode elepha entry and leaves absent configs unchanged', () => {
        const original = {
            $schema: 'https://opencode.ai/config.json',
            mcp: { servers: { docs: { type: 'remote', url: 'https://example.test/mcp' } } },
        };
        const installed = transformOpencodeMcp(JSON.stringify(original), bin);

        expect(JSON.parse(transformOpencodeMcp(installed, bin, true))).toEqual(original);
        expect(transformOpencodeMcp(JSON.stringify(original), bin, true)).toBe(JSON.stringify(original));
        const emptyServers = JSON.stringify({ mcp: { servers: {}, elepha: { type: 'local', command: [bin, ...ELEPHA_MCP_ARGS] } } });
        expect(JSON.parse(transformOpencodeMcp(emptyServers, bin, true))).toEqual({ mcp: { servers: {} } });
    });

    it('refuses malformed OpenCode JSON', () => {
        expect(() => transformOpencodeMcp('{', bin)).toThrow('OpenCode opencode.json is malformed');
        expect(() => transformOpencodeMcp('{"mcp":{"servers":false}}', bin)).toThrow('invalid MCP servers');
        expect(hasOpencodeMcp('{"mcp":{"servers":false}}', bin)).toBe('invalid');
    });

    it('reports every OpenCode MCP status', () => {
        const entry = (command = [bin, ...ELEPHA_MCP_ARGS], disabled = false, codemode = false) =>
            JSON.stringify({ mcp: { servers: { [ELEPHA_MCP_SERVER_NAME]: { type: 'local', command, disabled, codemode } } } });

        expect(hasOpencodeMcp('{}', bin)).toBe('not installed');
        expect(hasOpencodeMcp(entry(), bin)).toBe('registered');
        expect(hasOpencodeMcp(entry([bin, ...ELEPHA_MCP_ARGS], true), bin)).toBe('disabled');
        expect(hasOpencodeMcp(entry(['/old/bin/elepha', ...ELEPHA_MCP_ARGS]), bin)).toBe('stale binary');
        expect(hasOpencodeMcp(entry([bin, 'other']), bin)).toBe('invalid');
        expect(hasOpencodeMcp(entry([bin, ...ELEPHA_MCP_ARGS], false, true), bin)).toBe('stale config');
        expect(hasOpencodeMcp(JSON.stringify({ mcp: { elepha: { type: 'local', command: [bin, ...ELEPHA_MCP_ARGS] } } }), bin)).toBe(
            'stale config',
        );
        expect(hasOpencodeMcp(JSON.stringify({ mcp: { servers: { elepha: { type: 'local', command: ['other', 'serve'] } } } }), bin)).toBe(
            'invalid',
        );
        expect(hasOpencodeMcp('{"mcp":{"servers":{"elepha":null}}}', bin)).toBe('invalid');
    });
});
