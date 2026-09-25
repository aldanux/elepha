import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MINIMUM_NODE_VERSION } from '../../src/config/constants.js';
import { daemonHealth, managedLauncherHealth } from '../../src/install/health-checks.js';
import { defaultLaunchdServicePaths, LaunchdBackend } from '../../src/install/launchd-backend.js';
import { renderLauncher } from '../../src/install/launcher.js';
import { withTempDir } from '../helpers/tmp.js';

describe('shared installation health checks', () => {
    it('maps missing, gone, stale, and live heartbeats for status and doctor', () => {
        const root = withTempDir('elepha-health-');
        const heartbeat = path.join(root, 'daemon.heartbeat.json');

        expect(daemonHealth(heartbeat, 0)).toEqual({ state: 'NOT RUNNING (no heartbeat file)', healthy: false });

        const gonePid = 2_147_483_647;
        writeFileSync(
            heartbeat,
            JSON.stringify({ pid: gonePid, startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }),
        );
        const gone = daemonHealth(heartbeat, 0);
        expect({ state: gone.state, healthy: gone.healthy }).toEqual({
            state: `NOT RUNNING (pid ${gonePid} from last heartbeat is gone - crashed?)`,
            healthy: false,
        });
        expect(gone.heartbeat).toEqual({
            pid: gonePid,
            startedAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
        });

        writeFileSync(
            heartbeat,
            JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }),
        );
        const stale = daemonHealth(heartbeat, 60_000);
        expect({ state: stale.state, healthy: stale.healthy }).toEqual({
            state: `STUCK (pid ${process.pid} alive, but heartbeat is 1m old - process may be hung)`,
            healthy: false,
        });
        expect(stale.heartbeat).toEqual({
            pid: process.pid,
            startedAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
        });

        writeFileSync(
            heartbeat,
            JSON.stringify({ pid: process.pid, startedAt: new Date(59_000).toISOString(), updatedAt: new Date(59_000).toISOString() }),
        );
        const live = daemonHealth(heartbeat, 60_000);
        expect({ state: live.state, healthy: live.healthy }).toEqual({
            state: `RUNNING (pid ${process.pid}, heartbeat 1s ago)`,
            healthy: true,
        });
        expect(live.heartbeat).toEqual({
            pid: process.pid,
            startedAt: new Date(59_000).toISOString(),
            updatedAt: new Date(59_000).toISOString(),
        });
    });

    it('accepts only an unmodified managed launcher', () => {
        const home = withTempDir('elepha-launcher-health-');
        const paths = defaultLaunchdServicePaths(home);
        const service = new LaunchdBackend(paths, { run: () => ({ stdout: '', stderr: '', status: 0 }) }, 501);
        const backend = {
            kind: 'standalone',
            command: '/usr/local/bin/elepha',
            node: '/usr/local/bin/node',
        } as const;
        service.install(renderLauncher(backend, MINIMUM_NODE_VERSION), backend);

        expect(managedLauncherHealth(service)).toEqual({ healthy: true, detail: 'managed launcher is valid' });
        writeFileSync(paths.launcher, '# modified\n');
        expect(managedLauncherHealth(service)).toEqual({
            healthy: false,
            detail: `${paths.launcher} is not an elepha managed launcher`,
        });
    });

    it('reports when an nvm default upgrade leaves the managed launcher without elepha', () => {
        const home = withTempDir('elepha-nvm-launcher-health-');
        const root = path.join(home, '.nvm');
        const paths = defaultLaunchdServicePaths(home);
        const service = new LaunchdBackend(paths, { run: () => ({ stdout: '', stderr: '', status: 0 }) }, 501);
        const backend = { kind: 'nvm', command: path.join(root, 'nvm-exec'), root } as const;
        const oldVersion = 'v24.19.0';
        const newVersion = 'v24.21.0';
        const oldBin = path.join(root, 'versions', 'node', oldVersion, 'bin');
        const newBin = path.join(root, 'versions', 'node', newVersion, 'bin');
        mkdirSync(path.join(root, 'alias'), { recursive: true });
        mkdirSync(oldBin, { recursive: true });
        mkdirSync(newBin, { recursive: true });
        writeFileSync(path.join(root, 'alias', 'default'), '24\n');
        const installPackage = (bin: string): void => {
            const packageRoot = path.join(path.dirname(bin), 'lib', 'node_modules', 'elepha');
            mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
            writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'elepha', bin: { elepha: './bin/elepha.js' } }));
            const packageBin = path.join(packageRoot, 'bin', 'elepha.js');
            writeFileSync(packageBin, '#!/usr/bin/env node\n');
            chmodSync(packageBin, 0o755);
            symlinkSync(packageBin, path.join(bin, 'elepha'));
        };
        installPackage(oldBin);
        service.install(renderLauncher(backend, MINIMUM_NODE_VERSION), backend);

        const drift = managedLauncherHealth(service);
        expect(drift.healthy).toBe(false);
        expect(drift.detail).toContain(newVersion);
        expect(drift.detail).toContain('elepha');

        installPackage(newBin);
        expect(managedLauncherHealth(service)).toEqual({ healthy: true, detail: 'managed launcher is valid' });
    });
});
