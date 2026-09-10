import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kimiConfigTomlPath, opencodePluginPath } from '../../src/config/paths.js';
import { refreshInstalledIntegrations } from '../../src/install/integration-refresh.js';
import { reconcileOwnedIntegrations, restoreRefreshedIntegrations } from '../../src/install/integrations.js';
import { kimiHookStatus, transformKimiHook } from '../../src/install/kimi-hook.js';
import { renderOpencodePlugin } from '../../src/install/opencode-plugin.js';
import { ELEPHA_MCP_ARGS, transformKimiMcp } from '../../src/mcp/installer.js';
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
            kimiMcp: path.join(root, '.kimi-code', 'mcp.json'),
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
            kimiMcp: path.join(root, '.kimi-code', 'mcp.json'),
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

describe('Kimi Code owned integration refresh', () => {
    afterEach(() => vi.unstubAllEnvs());

    function fixture() {
        const root = withGrantableTestDir('kimi-refresh-');
        const paths = {
            claudeMcp: path.join(root, 'claude.json'),
            codexConfig: path.join(root, 'codex.toml'),
            opencodeConfig: path.join(root, 'opencode.json'),
            kimiMcp: path.join(root, '.kimi-code', 'mcp.json'),
        };
        mkdirSync(path.dirname(paths.kimiMcp), { recursive: true });
        return { root, paths };
    }

    it('refreshes an owned entry, is byte-idempotent, and restores original bytes on later failure', () => {
        const { paths } = fixture();
        const original = transformKimiMcp('{"mcpServers":{"docs":{"command":"docs"}}}', '/old/elepha');
        writeFileSync(paths.kimiMcp, original);
        const result = reconcileOwnedIntegrations('/managed/elepha', paths);
        expect(result.refreshed).toEqual([paths.kimiMcp]);
        expect(readFileSync(paths.kimiMcp, 'utf8')).toBe(transformKimiMcp(original, '/managed/elepha'));
        expect(reconcileOwnedIntegrations('/managed/elepha', paths).refreshed).toEqual([]);
        restoreRefreshedIntegrations(result);
        expect(readFileSync(paths.kimiMcp, 'utf8')).toBe(original);
    });

    it('refuses to restore over an intervening user edit', () => {
        const { paths } = fixture();
        writeFileSync(paths.kimiMcp, transformKimiMcp('', '/old/elepha'));
        const result = reconcileOwnedIntegrations('/managed/elepha', paths);
        writeFileSync(paths.kimiMcp, '{"user":"edit"}');
        expect(() => restoreRefreshedIntegrations(result)).toThrow('integration changed after refresh');
        expect(readFileSync(paths.kimiMcp, 'utf8')).toBe('{"user":"edit"}');
    });

    it.each([undefined, '{"mcpServers":{"docs":{"command":"docs"}}}'])('does not install an absent elepha entry: %s', (source) => {
        const { paths } = fixture();
        if (source !== undefined) writeFileSync(paths.kimiMcp, source);
        const result = reconcileOwnedIntegrations('/managed/elepha', paths);
        expect(result.refreshed).toEqual([]);
        expect(result.skipped).toEqual([]);
        if (source === undefined) expect(existsSync(paths.kimiMcp)).toBe(false);
        else expect(readFileSync(paths.kimiMcp, 'utf8')).toBe(source);
    });

    it.each([
        ['{', 'invalid'],
        ['{"mcpServers":{"elepha":{"command":"user-owned"}}}', 'conflict'],
    ])('preserves and reports an unowned or malformed registry: %s', (source, status) => {
        const { paths } = fixture();
        writeFileSync(paths.kimiMcp, source);
        const result = reconcileOwnedIntegrations('/managed/elepha', paths);
        expect(result.refreshed).toEqual([]);
        expect(result.skipped).toEqual([{ integration: 'Kimi Code MCP', file: paths.kimiMcp, status }]);
        expect(readFileSync(paths.kimiMcp, 'utf8')).toBe(source);
    });

    it('skips a symlink without changing its target', () => {
        const { root, paths } = fixture();
        const target = path.join(root, 'user.json');
        const source = transformKimiMcp('', '/old/elepha');
        writeFileSync(target, source);
        symlinkSync(target, paths.kimiMcp);
        const result = reconcileOwnedIntegrations('/managed/elepha', paths);
        expect(result.skipped).toEqual([{ integration: 'Kimi Code MCP', file: paths.kimiMcp, status: 'conflict' }]);
        expect(readFileSync(target, 'utf8')).toBe(source);
    });

    it('rolls back other integrations when writing Kimi fails', () => {
        const { paths } = fixture();
        const claude = JSON.stringify({ mcpServers: { elepha: { type: 'stdio', command: '/old/elepha', args: [...ELEPHA_MCP_ARGS] } } });
        const kimi = transformKimiMcp('', '/old/elepha');
        writeFileSync(paths.claudeMcp, claude);
        writeFileSync(paths.kimiMcp, kimi);
        const write = fileIO.atomicWrite;
        const spy = vi
            .spyOn(fileIO, 'atomicWrite')
            .mockImplementationOnce(write)
            .mockImplementationOnce(() => {
                throw new Error('Kimi write failed');
            });
        try {
            expect(() => reconcileOwnedIntegrations('/managed/elepha', paths)).toThrow('Kimi write failed');
            expect(readFileSync(paths.claudeMcp, 'utf8')).toBe(claude);
            expect(readFileSync(paths.kimiMcp, 'utf8')).toBe(kimi);
        } finally {
            spy.mockRestore();
        }
    });

    it('refreshes owned Kimi hooks, skips absent hooks, and restores exact original bytes', () => {
        const { paths } = fixture();
        const file = kimiConfigTomlPath(paths.kimiMcp);
        writeFileSync(paths.kimiMcp, transformKimiMcp('', '/managed/elepha'));
        expect(reconcileOwnedIntegrations('/managed/elepha', paths).refreshed).toEqual([]);
        expect(existsSync(file)).toBe(false);
        const source = transformKimiHook('[[hooks]]\nevent="Stop"\ncommand="user"\n', '/old/elepha');
        writeFileSync(file, source);
        const refresh = reconcileOwnedIntegrations('/managed/elepha', paths);
        expect(refresh.refreshed).toEqual([file]);
        expect(kimiHookStatus(readFileSync(file, 'utf8'), '/managed/elepha')).toBe('active');
        expect(reconcileOwnedIntegrations('/managed/elepha', paths).refreshed).toEqual([]);
        restoreRefreshedIntegrations(refresh);
        expect(readFileSync(file, 'utf8')).toBe(source);
    });

    it.each([
        ['[', 'invalid'],
        ['[[hooks]]\nevent="UserPromptSubmit"\nmatcher="^elepha:"\ncommand="user"', 'conflict'],
    ])('preserves and reports invalid or conflicting Kimi hooks: %s', (source, status) => {
        const { paths } = fixture();
        const file = kimiConfigTomlPath(paths.kimiMcp);
        writeFileSync(file, source);
        const refresh = reconcileOwnedIntegrations('/managed/elepha', paths);
        expect(refresh.refreshed).toEqual([]);
        expect(refresh.skipped).toEqual([{ integration: 'Kimi Code hook', file, status }]);
        expect(readFileSync(file, 'utf8')).toBe(source);
    });

    it('does not follow a Kimi config symlink during refresh', () => {
        const { root, paths } = fixture();
        const file = kimiConfigTomlPath(paths.kimiMcp);
        const target = path.join(root, 'user.toml');
        const source = transformKimiHook('', '/old/elepha');
        writeFileSync(target, source);
        symlinkSync(target, file);
        expect(reconcileOwnedIntegrations('/managed/elepha', paths).skipped).toEqual([
            { integration: 'Kimi Code hook', file, status: 'conflict' },
        ]);
        expect(readFileSync(target, 'utf8')).toBe(source);
    });

    it('refreshes Kimi through the built installed-package worker using KIMI_CODE_HOME', async () => {
        const { root, paths } = fixture();
        vi.stubEnv('KIMI_CODE_HOME', path.dirname(paths.kimiMcp));
        vi.stubEnv('ELEPHA_CLAUDE_MCP_PATH', paths.claudeMcp);
        vi.stubEnv('CODEX_HOME', path.join(root, 'codex-home'));
        vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'xdg-config'));
        const source = transformKimiMcp('', '/old/elepha');
        writeFileSync(paths.kimiMcp, source);
        const hookFile = kimiConfigTomlPath(paths.kimiMcp);
        writeFileSync(hookFile, transformKimiHook('', '/old/elepha'));
        const result = await refreshInstalledIntegrations(
            { packageRoot: process.cwd(), bin: path.resolve('bin/elepha.js') },
            '/managed/elepha',
        );
        expect(result.refreshed).toEqual([paths.kimiMcp, hookFile]);
        expect(kimiHookStatus(readFileSync(hookFile, 'utf8'), '/managed/elepha')).toBe('active');
        expect(result.skipped).toEqual([]);
        expect(readFileSync(paths.kimiMcp, 'utf8')).toBe(transformKimiMcp(source, '/managed/elepha'));
    });
});
