import { describe, expect, it } from 'vitest';
import { hasClaudeMcp, hasCodexMcp, transformClaudeMcp, transformCodexMcp } from '../../src/mcp/installer.js';

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
});
