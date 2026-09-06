import type Database from 'better-sqlite3-multiple-ciphers';
import {
    type AuthenticatedReadGeneration,
    LOCKED_MEMORY_MESSAGE,
    withMemoryReadGeneration,
    withMemoryReadGenerationAsync,
} from '../storage/paranoid-gate.js';

export interface GuardedCliOutput {
    error(message: string): void;
    log(message: string): void;
    warn(message: string): void;
}

export function refuseLockedCliRead(db: Database.Database, output: (message: string) => void = console.log): boolean {
    return withMemoryReadGeneration(
        db,
        () => {
            output(LOCKED_MEMORY_MESSAGE);
            return true;
        },
        () => false,
    );
}

export async function withCliReadGeneration(
    db: Database.Database,
    read: (output: GuardedCliOutput, token: AuthenticatedReadGeneration) => Promise<void> | void,
): Promise<void> {
    let lockedEmitted = false;
    const locked = (): void => {
        if (!lockedEmitted) {
            console.log(LOCKED_MEMORY_MESSAGE);
            lockedEmitted = true;
        }
    };
    await withMemoryReadGenerationAsync(db, locked, async (token) => {
        const emit = (output: (message: string) => void, message: string): void => {
            if (!lockedEmitted) {
                withMemoryReadGeneration(db, locked, () => output(message), token);
            }
        };
        await read(
            {
                error: (message) => emit(console.error, message),
                log: (message) => emit(console.log, message),
                warn: (message) => emit(console.warn, message),
            },
            token,
        );
    });
}
