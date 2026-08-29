// Liveness signal for `elepha status`. A process existing in the process
// table is not proof it's doing anything - a deadlocked event loop or a
// chokidar watcher stuck on a filesystem error still shows up in `ps aux`.
// The daemon writes this file on start and on an interval while running;
// `elepha status` treats a stale file (pid alive, heartbeat old) as "stuck",
// distinct from "not running" (no file, or pid gone).

import { unlinkSync } from 'node:fs';
import { PRIVATE_FILE_MODE } from '../config/constants.js';
import { daemonHeartbeatPath } from '../config/paths.js';
import { atomicWrite, readJson } from '../util/fs.js';

export { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS } from '../config/constants.js';

export interface Heartbeat {
    pid: number;
    startedAt: string;
    updatedAt: string;
}

export function defaultHeartbeatPath(): string {
    return daemonHeartbeatPath();
}

export function writeHeartbeat(filePath: string, startedAt: string): void {
    const heartbeat: Heartbeat = { pid: process.pid, startedAt, updatedAt: new Date().toISOString() };
    atomicWrite(filePath, JSON.stringify(heartbeat), PRIVATE_FILE_MODE);
}

export function readHeartbeat(filePath: string): Heartbeat | undefined {
    return readJson<Heartbeat>(filePath);
}

export function clearHeartbeat(filePath: string): void {
    try {
        unlinkSync(filePath);
    } catch {
        // already gone, or never existed - fine either way
    }
}

/** True if a process with this pid exists, regardless of who owns it. */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}
