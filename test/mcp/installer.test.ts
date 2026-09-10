import { describe, expect, it } from 'vitest';
import {
    ELEPHA_MCP_ARGS,
    ELEPHA_MCP_SERVER_NAME,
    hasClaudeMcp,
    hasCodexMcp,
    hasKimiMcp,
    hasOpencodeMcp,
    transformClaudeMcp,
    transformCodexMcp,
    transformKimiMcp,
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
                [ELEPHA_MCP_SERVER_NAME]: {
                    type: 'local',
                    command: [bin, ...ELEPHA_MCP_ARGS],
                    enabled: true,
                },
            },
        });
        expect(transformOpencodeMcp(installed, bin)).toBe(installed);
        const reordered = JSON.stringify({
            mcp: {
                [ELEPHA_MCP_SERVER_NAME]: {
                    enabled: true,
                    command: [bin, ...ELEPHA_MCP_ARGS],
                    type: 'local',
                },
            },
        });
        expect(transformOpencodeMcp(reordered, bin)).toBe(reordered);
    });

    it('preserves OpenCode schema, unrelated keys, and other MCP servers', () => {
        const config = {
            $schema: 'https://opencode.ai/config.json',
            theme: 'system',
            mcp: { docs: { type: 'remote', url: 'https://example.test/mcp' } },
        };

        const installed = JSON.parse(transformOpencodeMcp(JSON.stringify(config), bin)) as typeof config & {
            mcp: Record<string, unknown>;
        };
        const { [ELEPHA_MCP_SERVER_NAME]: _elepha, ...otherServers } = installed.mcp;

        expect({ ...installed, mcp: otherServers }).toEqual(config);
    });

    it('refreshes a stale OpenCode binary and leaves the canonical command enabled', () => {
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
        expect(JSON.parse(installed).mcp[ELEPHA_MCP_SERVER_NAME]).toEqual({
            type: 'local',
            command: [bin, ...ELEPHA_MCP_ARGS],
            enabled: true,
        });
    });

    it('refuses user-owned OpenCode conflicts during install and uninstall', () => {
        const userOwned = JSON.stringify({
            mcp: { [ELEPHA_MCP_SERVER_NAME]: { type: 'local', command: ['other', 'serve'] } },
        });

        expect(() => transformOpencodeMcp(userOwned, bin)).toThrow('conflicting user-owned OpenCode MCP server named elepha');
        expect(() => transformOpencodeMcp(userOwned, bin, true)).toThrow('conflicting user-owned OpenCode MCP server named elepha');
    });

    it('uninstalls only the OpenCode elepha entry and leaves absent configs unchanged', () => {
        const original = {
            $schema: 'https://opencode.ai/config.json',
            mcp: { docs: { type: 'remote', url: 'https://example.test/mcp' } },
        };
        const installed = transformOpencodeMcp(JSON.stringify(original), bin);

        expect(JSON.parse(transformOpencodeMcp(installed, bin, true))).toEqual(original);
        expect(transformOpencodeMcp(JSON.stringify(original), bin, true)).toBe(JSON.stringify(original));
    });

    it('refuses malformed OpenCode JSON', () => {
        expect(() => transformOpencodeMcp('{', bin)).toThrow('OpenCode opencode.json is malformed');
    });

    it('reports every OpenCode MCP status', () => {
        const entry = (command = [bin, ...ELEPHA_MCP_ARGS], enabled: boolean | undefined = true) =>
            JSON.stringify({ mcp: { [ELEPHA_MCP_SERVER_NAME]: { type: 'local', command, enabled } } });

        expect(hasOpencodeMcp('{}', bin)).toBe('not installed');
        expect(hasOpencodeMcp(entry(), bin)).toBe('registered');
        expect(hasOpencodeMcp(entry([bin, ...ELEPHA_MCP_ARGS], false), bin)).toBe('disabled');
        expect(hasOpencodeMcp(entry(['/old/bin/elepha', ...ELEPHA_MCP_ARGS]), bin)).toBe('stale binary');
        expect(hasOpencodeMcp(entry([bin, 'other']), bin)).toBe('invalid');
    });
});

describe('Kimi Code user MCP transform', () => {
    it('renders the documented stdio shape and preserves equivalent reordered bytes', () => {
        const expected = { mcpServers: { [ELEPHA_MCP_SERVER_NAME]: { command: bin, args: [...ELEPHA_MCP_ARGS] } } };
        const installed = transformKimiMcp('', bin);
        expect(installed).toBe(`${JSON.stringify(expected, null, 2)}\n`);
        expect(JSON.parse(installed)).toEqual(expected);
        expect(transformKimiMcp(installed, bin)).toBe(installed);
        const reordered = `  ${JSON.stringify({ mcpServers: { [ELEPHA_MCP_SERVER_NAME]: { args: [...ELEPHA_MCP_ARGS], command: bin } } })}\n`;
        expect(transformKimiMcp(reordered, bin)).toBe(reordered);
    });

    it('preserves other servers and settings through install and uninstall', () => {
        const original = { custom: true, mcpServers: { docs: { url: 'https://example.test/mcp' } } };
        const installed = transformKimiMcp(JSON.stringify(original), bin);
        expect(JSON.parse(installed)).toEqual({
            ...original,
            mcpServers: { ...original.mcpServers, [ELEPHA_MCP_SERVER_NAME]: { command: bin, args: [...ELEPHA_MCP_ARGS] } },
        });
        const removed = transformKimiMcp(installed, bin, true);
        expect(JSON.parse(removed)).toEqual(original);
        expect(hasKimiMcp(removed, bin)).toBe('not installed');
        for (const absent of ['', '  ', JSON.stringify(original)]) {
            expect(transformKimiMcp(absent, bin, true)).toBe(absent);
        }
    });

    it('refreshes a stale owned launcher to the canonical enabled entry', () => {
        const stale = JSON.stringify({ mcpServers: { elepha: { command: '/old/elepha', args: [...ELEPHA_MCP_ARGS], enabled: false } } });
        const installed = transformKimiMcp(stale, bin);
        expect(hasKimiMcp(installed, bin)).toBe('registered');
        expect(installed).toBe(transformKimiMcp('', bin));
    });

    it.each([null, { command: 'other' }, { command: 'other', args: ['serve'] }, { url: 'https://example.test' }])(
        'refuses a user-owned entry on install and uninstall: %j',
        (entry) => {
            const source = JSON.stringify({ mcpServers: { elepha: entry } });
            expect(hasKimiMcp(source, bin)).toBe('conflict');
            expect(() => transformKimiMcp(source, bin)).toThrow('conflicting user-owned Kimi Code MCP');
            expect(() => transformKimiMcp(source, bin, true)).toThrow('conflicting user-owned Kimi Code MCP');
        },
    );

    it.each(['{', 'null', '[]', 'true', '{"mcpServers":[]}', '{"mcpServers":null}', '{"mcpServers":"user data"}'])(
        'refuses malformed config without replacing it: %s',
        (source) => {
            expect(() => transformKimiMcp(source, bin)).toThrow('Kimi Code mcp.json is malformed');
            expect(() => transformKimiMcp(source, bin, true)).toThrow('Kimi Code mcp.json is malformed');
            expect(hasKimiMcp(source, bin)).toBe('invalid');
        },
    );

    it('reports absent, registered, disabled, and stale registrations', () => {
        expect(hasKimiMcp('', bin)).toBe('not installed');
        expect(hasKimiMcp('{}', bin)).toBe('not installed');
        expect(hasKimiMcp(transformKimiMcp('', bin), bin)).toBe('registered');
        expect(hasKimiMcp(transformKimiMcp('', '/old/elepha'), bin)).toBe('stale binary');
        expect(
            hasKimiMcp(JSON.stringify({ mcpServers: { elepha: { command: bin, args: [...ELEPHA_MCP_ARGS], enabled: false } } }), bin),
        ).toBe('disabled');
    });
});
