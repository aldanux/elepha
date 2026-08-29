// ~/.elepha holds memory synthesized from session transcripts - DB, WAL,
// backups, logs. Created at the process umask (typically 0755/0644), it's
// world-readable by default on a shared machine. Pure fs, no subprocess -
// this module has nothing to do with Security Rule 2's allowlist.

import { chmodSync, existsSync } from 'node:fs';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../config/constants.js';

export function hardenDir(dir: string): void {
    chmodSync(dir, PRIVATE_DIR_MODE);
}

export function hardenFile(file: string): void {
    if (existsSync(file)) {
        chmodSync(file, PRIVATE_FILE_MODE);
    }
}
