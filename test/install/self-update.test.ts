import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { opencodePluginPath, updateAvailablePath } from '../../src/config/paths.js';
import { type IntegrationPaths, reconcileOwnedIntegrations } from '../../src/install/integrations.js';
import { renderOpencodePlugin } from '../../src/install/opencode-plugin.js';
import { type SelfUpdateRuntime, selfUpdate } from '../../src/install/self-update.js';
import type { ServiceBackend } from '../../src/install/service-backend.js';
import { transformClaudeMcp, transformCodexMcp, transformOpencodeMcp } from '../../src/mcp/installer.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

interface Scenario {
    platform?: NodeJS.Platform;
    latest?: string;
    latestError?: Error;
    installVersionError?: Error;
    approvedRoots?: number;
    reconciliation: Array<'active' | 'awaiting consent' | 'not installed' | Error>;
}

function runtimeFor(scenario: Scenario): { runtime: SelfUpdateRuntime; events: string[] } {
    const events: string[] = [];
    let packageReads = 0;

    return {
        events,
        runtime: {
            platform: scenario.platform ?? 'darwin',
            resolveInstalledBin: () => ({ bin: '/opt/npm/bin/elepha', packageRoot: '/opt/npm/lib/node_modules/elepha' }),
            readPackageVersion: () => (packageReads++ === 0 ? '1.2.3' : (scenario.latest ?? '1.2.3')),
            detectBackend: () => ({
                kind: 'standalone',
                command: '/usr/local/bin/elepha',
                node: '/usr/local/bin/node',
                npmBin: '/usr/local/bin',
            }),
            npm: {
                latestVersion() {
                    events.push('npm view elepha@latest');
                    if (scenario.latestError) {
                        throw scenario.latestError;
                    }
                    return scenario.latest ?? '1.2.4';
                },
                installLatest() {
                    events.push('npm install elepha@latest');
                },
                installVersion(version) {
                    events.push(`npm install elepha@${version}`);
                    if (scenario.installVersionError) {
                        throw scenario.installVersionError;
                    }
                },
            },
            report: () => {},
            refreshIntegrations() {
                events.push('refresh integrations');
                return { refreshed: [], skipped: [], originals: [], installed: [] };
            },
            service: {
                launcherPath: '/managed/elepha',
                stop() {
                    events.push('service stop');
                },
            } as ServiceBackend,
            async readApprovedRoots() {
                events.push('read approved roots');
                return scenario.approvedRoots ?? 1;
            },
            async migrateDatabase() {
                events.push('database migration');
            },
            reconcile() {
                events.push('service reconcile and verify heartbeat');
                const next = scenario.reconciliation.shift();
                if (next instanceof Error) {
                    throw next;
                }
                return next ?? 'active';
            },
        },
    };
}

describe('selfUpdate', () => {
    beforeEach(() => {
        vi.stubEnv('ELEPHA_HOME', withGrantableTestDir('self-update-home-'));
    });
    afterEach(() => vi.unstubAllEnvs());

    function integrationFixture() {
        const root = withGrantableTestDir('self-update-integrations-');
        const paths: IntegrationPaths = {
            claudeMcp: path.join(root, 'claude.json'),
            codexConfig: path.join(root, 'codex.toml'),
            opencodeConfig: path.join(root, 'opencode.json'),
        };
        const plugin = opencodePluginPath(paths.opencodeConfig);
        mkdirSync(path.dirname(plugin), { recursive: true });
        const { runtime, events } = runtimeFor({ latest: '1.2.4', reconciliation: ['active'] });
        runtime.refreshIntegrations = (_installed, launcher) => {
            expect(events).toContain('npm install elepha@latest');
            return reconcileOwnedIntegrations(launcher, paths);
        };
        runtime.report = vi.fn();
        return { paths, plugin, runtime, events };
    }

    it('refreshes stale owned MCP blocks and the plugin, reports paths, and is idempotent', async () => {
        const { paths, plugin, runtime } = integrationFixture();
        const launcher = runtime.service!.launcherPath;
        writeFileSync(paths.claudeMcp, transformClaudeMcp('{"unrelated":true}', '/old/elepha'));
        writeFileSync(paths.codexConfig, transformCodexMcp('model = "custom"', '/old/elepha'));
        writeFileSync(paths.opencodeConfig, transformOpencodeMcp('{"plugin":["user-plugin"]}', '/old/elepha'));
        writeFileSync(plugin, `${renderOpencodePlugin(launcher)}// stale build\n`);

        await expect(selfUpdate(runtime)).resolves.toMatchObject({ status: 'updated' });
        expect(readFileSync(plugin, 'utf8')).toBe(renderOpencodePlugin(launcher));
        expect(readFileSync(paths.claudeMcp, 'utf8')).toBe(transformClaudeMcp('{"unrelated":true}', launcher));
        expect(readFileSync(paths.codexConfig, 'utf8')).toBe(transformCodexMcp('model = "custom"', launcher));
        expect(JSON.parse(readFileSync(paths.opencodeConfig, 'utf8'))).toEqual({
            plugin: ['user-plugin'],
            mcp: { elepha: { type: 'local', command: [launcher, 'mcp', 'serve'], enabled: true } },
        });
        for (const file of [...Object.values(paths), plugin]) {
            expect(runtime.report).toHaveBeenCalledWith(expect.stringContaining(file));
        }
        expect(reconcileOwnedIntegrations(launcher, paths).refreshed).toEqual([]);
    });

    it('leaves user-owned conflicts intact and surfaces their statuses', async () => {
        const { paths, plugin, runtime } = integrationFixture();
        const originals = new Map([
            [paths.claudeMcp, '{"mcpServers":{"elepha":{"command":"custom"}}}'],
            [paths.codexConfig, '[mcp_servers.elepha]\ncommand = "custom"\nargs = ["mcp", "serve"]\n'],
            [paths.opencodeConfig, '{"mcp":{"elepha":{"type":"remote","url":"https://example.test"}}}'],
            [plugin, '// user-owned plugin\n'],
        ]);
        for (const [file, text] of originals) writeFileSync(file, text);
        await expect(selfUpdate(runtime)).resolves.toMatchObject({ status: 'updated' });
        for (const [file, text] of originals) {
            expect(readFileSync(file, 'utf8')).toBe(text);
            expect(runtime.report).toHaveBeenCalledWith(expect.stringContaining(file));
        }
        expect(runtime.report).toHaveBeenCalledWith(expect.stringContaining('conflict'));
    });

    it('does not create absent integrations even when provider configs exist', async () => {
        const { paths, plugin, runtime } = integrationFixture();
        writeFileSync(paths.opencodeConfig, '{"plugin":["user-plugin"]}');
        await expect(selfUpdate(runtime)).resolves.toMatchObject({ status: 'updated' });
        expect(existsSync(paths.claudeMcp)).toBe(false);
        expect(existsSync(paths.codexConfig)).toBe(false);
        expect(existsSync(plugin)).toBe(false);
        expect(readFileSync(paths.opencodeConfig, 'utf8')).toBe('{"plugin":["user-plugin"]}');
        expect(runtime.report).not.toHaveBeenCalled();
    });

    it('rolls back the package when refreshing fails before restarting capture', async () => {
        const { runtime, events } = runtimeFor({ latest: '1.2.4', reconciliation: ['active'] });
        runtime.refreshIntegrations = () => {
            throw new Error('config write failed');
        };
        await expect(selfUpdate(runtime)).resolves.toMatchObject({ status: 'rolled-back', failure: 'config write failed' });
        expect(events.indexOf('npm install elepha@1.2.3')).toBeLessThan(events.indexOf('service stop'));
    });

    it('restores exact integration bytes if subsequent service health fails', async () => {
        const { paths, plugin, runtime } = integrationFixture();
        const original = `${renderOpencodePlugin('/old/elepha')}// previous build\n`;
        writeFileSync(plugin, original);
        runtime.reconcile = vi.fn().mockRejectedValueOnce(new Error('heartbeat failed')).mockResolvedValueOnce('active');
        await expect(selfUpdate(runtime)).resolves.toMatchObject({ status: 'rolled-back', failure: 'heartbeat failed' });
        expect(readFileSync(plugin, 'utf8')).toBe(original);
        expect(existsSync(paths.opencodeConfig)).toBe(false);
    });

    it('refuses rollback over an intervening user edit and directs recovery to doctor', async () => {
        const { plugin, runtime } = integrationFixture();
        writeFileSync(plugin, renderOpencodePlugin('/old/elepha'));
        runtime.reconcile = () => {
            writeFileSync(plugin, '// user edit\n');
            throw new Error('heartbeat failed');
        };
        await expect(selfUpdate(runtime)).rejects.toThrow('integration restore failed: integration changed after refresh:');
        expect(readFileSync(plugin, 'utf8')).toBe('// user edit\n');
    });

    it('updates and restarts the injected service on Linux', async () => {
        const { runtime, events } = runtimeFor({ platform: 'linux', latest: '1.2.4', reconciliation: ['active'] });

        await expect(selfUpdate(runtime)).resolves.toEqual({ status: 'updated', previousVersion: '1.2.3', version: '1.2.4' });
        expect(events).toContain('service stop');
        expect(events).toContain('service reconcile and verify heartbeat');
    });

    it('refuses Windows before resolving or mutating update state', async () => {
        const { runtime, events } = runtimeFor({ platform: 'win32', reconciliation: [] });

        await expect(selfUpdate(runtime)).rejects.toThrow('supported on macOS and Linux');
        expect(events).toEqual([]);
    });

    it('installs the registry version, restarts capture with approved roots, and reports the installed version after a healthy heartbeat', async () => {
        const { runtime, events } = runtimeFor({ latest: '1.2.4', approvedRoots: 1, reconciliation: ['active'] });

        await expect(selfUpdate(runtime)).resolves.toEqual({ status: 'updated', previousVersion: '1.2.3', version: '1.2.4' });
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'refresh integrations',
            'service stop',
            'database migration',
            'read approved roots',
            'service reconcile and verify heartbeat',
        ]);
    });

    it('reports updated without rollback when capture is awaiting consent', async () => {
        const { runtime, events } = runtimeFor({ latest: '1.2.4', approvedRoots: 0, reconciliation: ['awaiting consent'] });

        await expect(selfUpdate(runtime)).resolves.toEqual({ status: 'updated', previousVersion: '1.2.3', version: '1.2.4' });
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'refresh integrations',
            'service stop',
            'database migration',
            'read approved roots',
            'service reconcile and verify heartbeat',
        ]);
    });

    it('reports current without installing or restarting when the registry version matches', async () => {
        const root = withGrantableTestDir('self-update-marker-');
        const previousHome = process.env.ELEPHA_HOME;
        process.env.ELEPHA_HOME = root;
        const markerPath = updateAvailablePath();
        mkdirSync(path.dirname(markerPath), { recursive: true });
        writeFileSync(markerPath, '{"version":"1.2.3","checkedAt":"2026-08-29T00:00:00.000Z"}\n');
        const { runtime, events } = runtimeFor({ latest: '1.2.3', reconciliation: ['active'] });

        try {
            await expect(selfUpdate(runtime)).resolves.toEqual({ status: 'current', version: '1.2.3' });
            expect(events).toEqual(['npm view elepha@latest']);
            expect(existsSync(markerPath)).toBe(false);
        } finally {
            if (previousHome === undefined) {
                delete process.env.ELEPHA_HOME;
            } else {
                process.env.ELEPHA_HOME = previousHome;
            }
        }
    });

    it('aborts before stopping capture when the latest registry version cannot be resolved', async () => {
        const { runtime, events } = runtimeFor({
            latestError: new Error('npm ERR! code E404\nelepha@latest is unpublished'),
            reconciliation: [],
        });

        await expect(selfUpdate(runtime)).rejects.toThrow(
            'self-update preflight failed: could not resolve elepha@latest: npm ERR! code E404',
        );
        expect(events).toEqual(['npm view elepha@latest']);
    });

    it('restores the recorded version when the updated daemon fails its health verification', async () => {
        const { runtime, events } = runtimeFor({
            latest: '1.2.4',
            reconciliation: [new Error('capture service did not produce a healthy heartbeat; daemon stderr: migration failed'), 'active'],
        });

        await expect(selfUpdate(runtime)).resolves.toEqual({
            status: 'rolled-back',
            previousVersion: '1.2.3',
            attemptedVersion: '1.2.4',
            failure: 'capture service did not produce a healthy heartbeat; daemon stderr: migration failed',
        });
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'refresh integrations',
            'service stop',
            'database migration',
            'read approved roots',
            'service reconcile and verify heartbeat',
            'npm install elepha@1.2.3',
            'service stop',
            'database migration',
            'read approved roots',
            'service reconcile and verify heartbeat',
        ]);
    });

    it('reports a failed package rollback and directs recovery to doctor', async () => {
        const { runtime, events } = runtimeFor({
            latest: '1.2.4',
            installVersionError: new Error('npm ERR! network timeout'),
            reconciliation: [new Error('updated launchctl bootstrap failed')],
        });

        await expect(selfUpdate(runtime)).rejects.toThrow(
            'self-update failed after installing 1.2.4: updated launchctl bootstrap failed; rollback to 1.2.3 failed: npm ERR! network timeout; run elepha doctor',
        );
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'refresh integrations',
            'service stop',
            'database migration',
            'read approved roots',
            'service reconcile and verify heartbeat',
            'npm install elepha@1.2.3',
        ]);
    });

    it('distinguishes a reverted package from a service that failed to restart after the revert', async () => {
        const { runtime, events } = runtimeFor({
            latest: '1.2.4',
            reconciliation: [new Error('updated launchctl bootstrap failed'), new Error('rollback launchctl bootstrap failed')],
        });

        let thrown: unknown;
        try {
            await selfUpdate(runtime);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain('self-update failed after installing 1.2.4: updated launchctl bootstrap failed');
        expect(message).toContain('package reverted to 1.2.3');
        expect(message).toContain('rollback launchctl bootstrap failed');
        expect(message).toContain('run elepha doctor');
        expect(message).not.toContain('rollback to 1.2.3 failed');
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'refresh integrations',
            'service stop',
            'database migration',
            'read approved roots',
            'service reconcile and verify heartbeat',
            'npm install elepha@1.2.3',
            'service stop',
            'database migration',
            'read approved roots',
            'service reconcile and verify heartbeat',
        ]);
    });

    it('does not report a rollback failure when the package was reverted and only the service is not installed', async () => {
        const { runtime, events } = runtimeFor({
            latest: '1.2.4',
            reconciliation: ['not installed', 'not installed'],
        });

        let thrown: unknown;
        try {
            await selfUpdate(runtime);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain('package reverted to 1.2.3');
        expect(message).toContain('capture service is not installed');
        expect(message).toContain('run elepha install');
        expect(message).not.toContain('rollback to 1.2.3 failed');
        expect(message).not.toContain('rollback failed');
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'refresh integrations',
            'service stop',
            'database migration',
            'read approved roots',
            'service reconcile and verify heartbeat',
            'npm install elepha@1.2.3',
            'service stop',
            'database migration',
            'read approved roots',
            'service reconcile and verify heartbeat',
        ]);
    });
});
