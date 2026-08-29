import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UPDATE_CHECK_INTERVAL_MS } from '../../src/config/constants.js';
import { setSetting, unsetSetting } from '../../src/config/settings.js';
import { HEARTBEAT_INTERVAL_MS, readHeartbeat } from '../../src/daemon/heartbeat.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { readUpdateAvailable, runUpdateCheck, updateCheckEnabled } from '../../src/daemon/update-check.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

const { queryVersions } = vi.hoisted(() => ({ queryVersions: vi.fn() }));
vi.mock('../../src/install/self-update.js', () => ({ installedAndLatestElephaVersionAsync: queryVersions }));

const NOW = Date.parse('2026-08-19T00:00:00.000Z');

function paths(): { statePath: string; markerPath: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'elepha-update-check-'));
    return { statePath: path.join(root, 'update-check.json'), markerPath: path.join(root, 'update-available.json') };
}

describe('daemon update check', () => {
    it('resolves the persistent setting unless ELEPHA_NO_UPDATE_CHECK is set', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-update-config-'));
        const configPath = path.join(root, 'config.json');
        writeFileSync(configPath, '{"update-check":false}\n');

        expect(updateCheckEnabled({}, configPath)).toBe(false);
        expect(updateCheckEnabled({ ELEPHA_NO_UPDATE_CHECK: '1' }, configPath)).toBe(false);

        writeFileSync(configPath, '{"update-check":true}\n');
        expect(updateCheckEnabled({}, configPath)).toBe(true);
        expect(updateCheckEnabled({ ELEPHA_NO_UPDATE_CHECK: '0' }, configPath)).toBe(false);
    });

    it('writes an update marker for a newer registry version', async () => {
        const { statePath, markerPath } = paths();

        expect(
            await runUpdateCheck({
                statePath,
                markerPath,
                now: () => NOW,
                queryVersions: async () => ({ installedVersion: '1.2.3', latestVersion: '1.2.4' }),
            }),
        ).toEqual({ status: 'update_available', version: '1.2.4' });
        expect(readUpdateAvailable(markerPath)).toEqual({ version: '1.2.4', checkedAt: '2026-08-19T00:00:00.000Z' });
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ checkedAt: '2026-08-19T00:00:00.000Z' });
    });

    it('clears a previous update marker when the installed version is current', async () => {
        const { statePath, markerPath } = paths();
        await runUpdateCheck({
            statePath,
            markerPath,
            now: () => NOW,
            queryVersions: async () => ({ installedVersion: '1.2.3', latestVersion: '1.2.4' }),
        });

        expect(
            await runUpdateCheck({
                statePath,
                markerPath,
                now: () => NOW + 24 * 60 * 60 * 1000,
                queryVersions: async () => ({ installedVersion: '1.2.4', latestVersion: '1.2.4' }),
            }),
        ).toEqual({ status: 'current' });
        expect(existsSync(markerPath)).toBe(false);
    });

    it('does not issue a second query inside the persisted 24-hour window', async () => {
        const { statePath, markerPath } = paths();
        let calls = 0;
        const queryVersions = async () => {
            calls++;
            return { installedVersion: '1.2.3', latestVersion: '1.2.4' };
        };

        await runUpdateCheck({ statePath, markerPath, now: () => NOW, queryVersions });
        expect(await runUpdateCheck({ statePath, markerPath, now: () => NOW + 23 * 60 * 60 * 1000, queryVersions })).toEqual({
            status: 'rate_limited',
        });
        expect(calls).toBe(1);
    });

    it('leaves the cache untouched when update checks are opted out', async () => {
        const { statePath, markerPath } = paths();
        await runUpdateCheck({
            statePath,
            markerPath,
            now: () => NOW,
            queryVersions: async () => ({ installedVersion: '1.2.3', latestVersion: '1.2.4' }),
        });
        const markerBefore = readFileSync(markerPath, 'utf8');
        let calls = 0;

        expect(
            await runUpdateCheck({
                statePath,
                markerPath,
                enabled: false,
                now: () => NOW + 24 * 60 * 60 * 1000,
                queryVersions: async () => {
                    calls++;
                    return { installedVersion: '1.2.4', latestVersion: '1.2.5' };
                },
            }),
        ).toEqual({ status: 'disabled' });
        expect(calls).toBe(0);
        expect(readFileSync(markerPath, 'utf8')).toBe(markerBefore);
    });

    it('routes the daemon update check through the persistent setting', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-update-daemon-config-'));
        const previousHome = process.env.ELEPHA_HOME;
        process.env.ELEPHA_HOME = root;
        queryVersions.mockResolvedValue({ installedVersion: '1.2.3', latestVersion: '1.2.4' });

        try {
            setSetting('update-check', 'false');
            const disabledDaemon = new IngestionDaemon({
                store: new MemoryStore(openDb(path.join(root, 'disabled.db'))),
                watchRoots: [root],
                heartbeatPath: path.join(root, 'disabled.heartbeat.json'),
                watcherUsePolling: true,
            });
            disabledDaemon.start();
            await new Promise((resolve) => setTimeout(resolve, 20));
            await disabledDaemon.stop();

            expect(queryVersions).not.toHaveBeenCalled();
            expect(existsSync(path.join(root, 'update-available.json'))).toBe(false);

            unsetSetting('update-check');
            const enabledDaemon = new IngestionDaemon({
                store: new MemoryStore(openDb(path.join(root, 'enabled.db'))),
                watchRoots: [root],
                heartbeatPath: path.join(root, 'enabled.heartbeat.json'),
                watcherUsePolling: true,
            });
            enabledDaemon.start();
            await new Promise((resolve) => setTimeout(resolve, 20));
            await enabledDaemon.stop();

            expect(queryVersions).toHaveBeenCalledTimes(1);
            expect(readUpdateAvailable(path.join(root, 'update-available.json'))).toEqual({
                version: '1.2.4',
                checkedAt: expect.any(String),
            });
        } finally {
            if (previousHome === undefined) {
                delete process.env.ELEPHA_HOME;
            } else {
                process.env.ELEPHA_HOME = previousHome;
            }
            queryVersions.mockReset();
        }
    });

    it.each([
        ['404 response', 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/elepha'],
        ['network error', 'request to https://registry.npmjs.org/elepha failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org'],
    ])('silences an unavailable registry after a %s and caches the check', async (_kind, message) => {
        const { statePath, markerPath } = paths();
        const warn = vi.fn();
        await runUpdateCheck({
            statePath,
            markerPath,
            now: () => NOW,
            queryVersions: async () => ({ installedVersion: '1.2.3', latestVersion: '1.2.4' }),
        });

        expect(
            await runUpdateCheck({
                statePath,
                markerPath,
                now: () => NOW + 24 * 60 * 60 * 1000,
                queryVersions: async () => {
                    throw new Error(message);
                },
                warn,
            }),
        ).toEqual({
            status: 'unreachable',
        });
        expect(warn).not.toHaveBeenCalled();
        expect(existsSync(markerPath)).toBe(false);
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ checkedAt: '2026-08-20T00:00:00.000Z' });
    });

    it('returns unreachable without warning when the async registry query times out', async () => {
        const { statePath, markerPath } = paths();
        const warn = vi.fn();

        await expect(
            runUpdateCheck({
                statePath,
                markerPath,
                now: () => NOW,
                queryVersions: async () => {
                    throw new Error('timed out after 10000ms');
                },
                warn,
            }),
        ).resolves.toEqual({ status: 'unreachable' });
        expect(warn).not.toHaveBeenCalled();
    });

    it('caches an unexpected failure for the normal interval, then retries', async () => {
        const { statePath, markerPath } = paths();
        const warn = vi.fn();
        const queryVersions = vi.fn(async () => ({ installedVersion: '1.2.3', latestVersion: 'not-a-version' }));
        writeFileSync(markerPath, '{"version":"1.2.4","checkedAt":"2026-08-18T00:00:00.000Z"}\n');
        const markerBefore = readFileSync(markerPath, 'utf8');

        await expect(runUpdateCheck({ statePath, markerPath, now: () => NOW, queryVersions, warn })).resolves.toEqual({
            status: 'failed',
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenLastCalledWith('[elepha] update check failed: update check received an invalid package version');
        expect(queryVersions).toHaveBeenCalledTimes(1);
        expect(readFileSync(markerPath, 'utf8')).toBe(markerBefore);
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ checkedAt: '2026-08-19T00:00:00.000Z' });

        await expect(
            runUpdateCheck({
                statePath,
                markerPath,
                now: () => NOW + UPDATE_CHECK_INTERVAL_MS - 1,
                queryVersions,
                warn,
            }),
        ).resolves.toEqual({ status: 'rate_limited' });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(queryVersions).toHaveBeenCalledTimes(1);

        await expect(
            runUpdateCheck({
                statePath,
                markerPath,
                now: () => NOW + UPDATE_CHECK_INTERVAL_MS,
                queryVersions,
                warn,
            }),
        ).resolves.toEqual({ status: 'failed' });
        expect(warn).toHaveBeenCalledTimes(2);
        expect(queryVersions).toHaveBeenCalledTimes(2);
        expect(readFileSync(markerPath, 'utf8')).toBe(markerBefore);
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ checkedAt: '2026-08-20T00:00:00.000Z' });
    });

    it('writes heartbeats while an async update query remains pending', async () => {
        vi.useFakeTimers();
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-update-heartbeat-'));
        let releaseQuery: (() => void) | undefined;
        const queryPending = new Promise<void>((resolve) => {
            releaseQuery = resolve;
        });
        const daemon = new IngestionDaemon({
            store: new MemoryStore(openDb(path.join(root, 'elepha.db'))),
            watchRoots: [root],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            updateCheck: () => queryPending,
        });

        try {
            daemon.start();
            await vi.advanceTimersByTimeAsync(0);
            const firstHeartbeat = readHeartbeat(path.join(root, 'daemon.heartbeat.json'));

            await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

            expect(firstHeartbeat?.updatedAt).toBeDefined();
            expect(readHeartbeat(path.join(root, 'daemon.heartbeat.json'))?.updatedAt).not.toBe(firstHeartbeat?.updatedAt);
        } finally {
            releaseQuery?.();
            await daemon.stop();
            vi.useRealTimers();
        }
    });

    it('runs the update checker from the daemon periodic loop', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-update-daemon-'));
        let calls = 0;
        const daemon = new IngestionDaemon({
            store: new MemoryStore(openDb(path.join(root, 'elepha.db'))),
            watchRoots: [root],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            updateCheck: () => {
                calls++;
            },
            updateCheckIntervalMs: 10,
        });

        daemon.start();
        await new Promise((resolve) => setTimeout(resolve, 30));
        await daemon.stop();

        expect(calls).toBeGreaterThanOrEqual(2);
    });
});
