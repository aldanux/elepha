import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearHeartbeat, isPidAlive, readHeartbeat, writeHeartbeat } from '../../src/daemon/heartbeat.js';

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        renameSync: vi.fn(actual.renameSync),
        writeFileSync: vi.fn(actual.writeFileSync),
    };
});

function tmpHeartbeatPath(): string {
    return path.join(mkdtempSync(path.join(tmpdir(), 'elepha-heartbeat-')), 'daemon.heartbeat.json');
}

describe('heartbeat', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('returns undefined when no heartbeat file exists', () => {
        expect(readHeartbeat(tmpHeartbeatPath())).toBeUndefined();
    });

    it('writes and reads back pid/startedAt/updatedAt', () => {
        const file = tmpHeartbeatPath();
        const startedAt = '2026-08-12T00:00:00.000Z';
        writeHeartbeat(file, startedAt);
        const hb = readHeartbeat(file);
        expect(hb).toBeDefined();
        expect(hb!.pid).toBe(process.pid);
        expect(hb!.startedAt).toBe(startedAt);
        expect(new Date(hb!.updatedAt).getTime()).not.toBeNaN();
    });

    it('writes a temporary sibling and atomically renames it onto the heartbeat path', () => {
        const file = tmpHeartbeatPath();
        writeHeartbeat(file, '2026-08-12T00:00:00.000Z');

        const temporaryPath = vi.mocked(writeFileSync).mock.calls[0]?.[0];
        expect(temporaryPath).toContain(`${file}.${process.pid}.`);
        expect(temporaryPath).toMatch(/\.tmp$/);
        expect(temporaryPath).not.toBe(file);
        expect(renameSync).toHaveBeenCalledWith(temporaryPath, file);
        expect(readHeartbeat(file)).toMatchObject({ startedAt: '2026-08-12T00:00:00.000Z' });
    });

    it('clearHeartbeat removes the file, and is a no-op if already gone', () => {
        const file = tmpHeartbeatPath();
        writeHeartbeat(file, '2026-08-12T00:00:00.000Z');
        expect(readHeartbeat(file)).toBeDefined();
        clearHeartbeat(file);
        expect(readHeartbeat(file)).toBeUndefined();
        expect(() => clearHeartbeat(file)).not.toThrow();
    });

    it('isPidAlive is true for this process and false for a pid that cannot exist', () => {
        expect(isPidAlive(process.pid)).toBe(true);
        expect(isPidAlive(999_999)).toBe(false);
    });
});
