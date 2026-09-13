import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { opencodePluginPath } from '../../src/config/paths.js';
import { refreshInstalledIntegrations } from '../../src/install/integration-refresh.js';
import { reconcileOwnedIntegrations } from '../../src/install/integrations.js';
import { renderOpencodePlugin } from '../../src/install/opencode-plugin.js';
import * as fileIO from '../../src/util/fs.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

describe('installed integration refresh runtime', () => {
    it('loads the replaced package and its transitive renderer afresh on each invocation', async () => {
        const packageRoot = withGrantableTestDir('refresh-installed-package-');
        const directory = path.join(packageRoot, 'dist/install');
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(packageRoot, 'package.json'), '{"type":"module"}');
        writeFileSync(
            path.join(directory, 'integration-refresh-worker.js'),
            `
import { parentPort, workerData } from 'node:worker_threads';
import { render } from './renderer.js';
parentPort.postMessage({ refreshed: [render(workerData.launcher)], skipped: [], originals: [], installed: [] });
`,
        );
        const renderer = path.join(directory, 'renderer.js');
        const installed = { packageRoot, bin: path.join(packageRoot, 'bin/elepha.js') };
        writeFileSync(renderer, 'export const render = (launcher) => "old:" + launcher;');
        expect((await refreshInstalledIntegrations(installed, '/managed/elepha')).refreshed).toEqual(['old:/managed/elepha']);
        writeFileSync(renderer, 'export const render = (launcher) => "new:" + launcher;');
        expect((await refreshInstalledIntegrations(installed, '/managed/elepha')).refreshed).toEqual(['new:/managed/elepha']);
    });

    it('propagates an installed worker failure instead of reporting an empty refresh', async () => {
        const packageRoot = withGrantableTestDir('refresh-missing-worker-');
        await expect(refreshInstalledIntegrations({ packageRoot, bin: '/unused' }, '/managed/elepha')).rejects.toThrow();
    });

    it('restores every original when a later file write fails', () => {
        const root = withGrantableTestDir('refresh-write-failure-');
        const paths = {
            claudeMcp: path.join(root, 'claude.json'),
            codexConfig: path.join(root, 'codex.toml'),
            opencodeConfig: path.join(root, 'opencode.json'),
        };
        const plugin = opencodePluginPath(paths.opencodeConfig);
        mkdirSync(path.dirname(plugin), { recursive: true });
        const originalMcp = JSON.stringify({ mcpServers: { elepha: { type: 'stdio', command: '/old/elepha', args: ['mcp', 'serve'] } } });
        const originalPlugin = renderOpencodePlugin('/old/elepha');
        writeFileSync(paths.claudeMcp, originalMcp);
        writeFileSync(plugin, originalPlugin);
        const write = fileIO.atomicWrite;
        const spy = vi
            .spyOn(fileIO, 'atomicWrite')
            .mockImplementationOnce(write)
            .mockImplementationOnce(() => {
                throw new Error('write failed');
            });
        try {
            expect(() => reconcileOwnedIntegrations('/managed/elepha', paths)).toThrow('write failed');
            expect(readFileSync(paths.claudeMcp, 'utf8')).toBe(originalMcp);
            expect(readFileSync(plugin, 'utf8')).toBe(originalPlugin);
        } finally {
            spy.mockRestore();
        }
    });

    it('reports malformed MCP configs and plugin symlinks while refreshing independent owned entries', () => {
        const root = withGrantableTestDir('refresh-conflicts-');
        const paths = {
            claudeMcp: path.join(root, 'claude.json'),
            codexConfig: path.join(root, 'codex.toml'),
            opencodeConfig: path.join(root, 'opencode.json'),
        };
        const target = path.join(root, 'user-plugin.js');
        const plugin = opencodePluginPath(paths.opencodeConfig);
        mkdirSync(path.dirname(plugin), { recursive: true });
        writeFileSync(target, renderOpencodePlugin('/old/elepha'));
        symlinkSync(target, plugin);
        writeFileSync(paths.claudeMcp, 'malformed json');
        writeFileSync(
            paths.opencodeConfig,
            JSON.stringify({ mcp: { elepha: { type: 'local', command: ['/old/elepha', 'mcp', 'serve'] } } }),
        );
        const result = reconcileOwnedIntegrations('/managed/elepha', paths);
        expect(result.refreshed).toEqual([paths.opencodeConfig]);
        expect(result.skipped).toEqual(
            expect.arrayContaining([
                { integration: 'Claude MCP', file: paths.claudeMcp, status: 'invalid' },
                { integration: 'OpenCode plugin', file: plugin, status: 'conflict' },
            ]),
        );
        expect(readFileSync(target, 'utf8')).toBe(renderOpencodePlugin('/old/elepha'));
        expect(readFileSync(paths.claudeMcp, 'utf8')).toBe('malformed json');
    });
});
