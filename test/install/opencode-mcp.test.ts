import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderOpencodePlugin } from '../../src/install/opencode-plugin.js';
import { detectPresentTools } from '../../src/install/present-tools.js';
import { installationStatus } from '../../src/install/status.js';
import { ELEPHA_MCP_ARGS, ELEPHA_MCP_SERVER_NAME } from '../../src/mcp/installer.js';

const bin = '/opt/npm/bin/elepha';

function toolPaths(root: string) {
    return {
        claudeSettings: path.join(root, '.claude', 'settings.json'),
        claudeMcp: path.join(root, '.claude.json'),
        codexConfig: path.join(root, '.codex', 'config.toml'),
        deepseekMcp: path.join(root, '.dsh', 'cordis.patch.yml'),
        opencodeConfig: path.join(root, '.config', 'opencode', 'opencode.json'),
        kimiMcp: path.join(root, '.kimi-code', 'mcp.json'),
        opencodeStore: path.join(root, '.local', 'share', 'opencode'),
    };
}

describe('OpenCode installation status', () => {
    it('detects OpenCode from its data store without materializing a config directory', () => {
        const scratch = path.resolve(import.meta.dirname, '..', '..', '.test-scratch');
        mkdirSync(scratch, { recursive: true });
        const root = mkdtempSync(path.join(scratch, 'opencode-present-tools-'));
        const paths = toolPaths(root);

        try {
            expect(detectPresentTools(paths).opencode).toBe(false);
            mkdirSync(paths.opencodeStore, { recursive: true });
            expect(detectPresentTools(paths).opencode).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('requires a registered MCP alongside the plugin only for a detected OpenCode installation', () => {
        const present = { claude: false, codex: false, deepseek: false, opencode: true, kimi: false };
        const registeredConfig = JSON.stringify({
            mcp: {
                [ELEPHA_MCP_SERVER_NAME]: { type: 'local', command: [bin, ...ELEPHA_MCP_ARGS], enabled: true },
            },
        });

        const registered = installationStatus('', '', '', '/config.toml', registeredConfig, bin, present, renderOpencodePlugin(bin));
        const missing = installationStatus('', '', '', '/config.toml', '{}', bin, present);

        expect(registered.opencodeMcp).toBe('registered');
        expect(registered.ready).toBe(true);
        expect(missing.opencodeMcp).toBe('not installed');
        expect(missing.ready).toBe(false);
    });
});
