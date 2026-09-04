import type Database from 'better-sqlite3-multiple-ciphers';
import { isMemoryLocked, LOCKED_MEMORY_MESSAGE } from '../storage/paranoid-gate.js';

export function refuseLockedCliRead(db: Database.Database, output: (message: string) => void = console.log): boolean {
    if (!isMemoryLocked(db)) {
        return false;
    }
    output(LOCKED_MEMORY_MESSAGE);
    return true;
}
