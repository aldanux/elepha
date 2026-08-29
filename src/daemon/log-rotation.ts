// launchd owns the daemon log file descriptors, so rotating while the process
// runs would leave its writes attached to the renamed inode. Rotate only at
// process startup; KeepAlive re-enters this boundary after every crash.

import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DAEMON_LOG_ROTATE_MAX_BYTES } from '../config/constants.js';

export { DAEMON_LOG_ROTATE_MAX_BYTES } from '../config/constants.js';

export interface DaemonLogPaths {
    stdout: string;
    stderr: string;
}

/**
 * Keeps one previous generation per launchd-managed log. The process's
 * inherited descriptor may still point at the archive for this invocation;
 * the next KeepAlive launch opens the fresh primary path.
 */
export function rotateDaemonLogs(paths: DaemonLogPaths, maxBytes = DAEMON_LOG_ROTATE_MAX_BYTES): string[] {
    const rotated: string[] = [];
    for (const logPath of [paths.stdout, paths.stderr]) {
        const stat = statSync(logPath, { throwIfNoEntry: false });
        if (!stat || stat.size <= maxBytes) {
            continue;
        }

        const archivePath = `${logPath}.1`;
        rmSync(archivePath, { force: true });
        renameSync(logPath, archivePath);
        writeFileSync(logPath, '');
        rotated.push(logPath);
    }
    return rotated;
}
