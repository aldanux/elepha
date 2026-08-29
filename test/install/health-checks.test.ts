import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { daemonHealth, managedLauncherHealth } from '../../src/install/health-checks.js';
import { defaultLaunchdServicePaths, LaunchdBackend } from '../../src/install/launchd-backend.js';
import { renderLauncher } from '../../src/install/launcher.js';

describe('shared installation health checks', () => {
    it('maps missing, gone, stale, and live heartbeats for status and doctor', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-health-'));
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
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-launcher-health-'));
        const paths = defaultLaunchdServicePaths(home);
        const service = new LaunchdBackend(paths, { run: () => ({ stdout: '', stderr: '', status: 0 }) }, 501);
        const backend = {
            kind: 'standalone',
            command: '/usr/local/bin/elepha',
            node: '/usr/local/bin/node',
        } as const;
        service.install(renderLauncher(backend, 22), backend);

        expect(managedLauncherHealth(service)).toEqual({ healthy: true, detail: 'managed launcher is valid' });
        writeFileSync(paths.launcher, '# modified\n');
        expect(managedLauncherHealth(service)).toEqual({
            healthy: false,
            detail: `${paths.launcher} is not an elepha managed launcher`,
        });
    });
});
