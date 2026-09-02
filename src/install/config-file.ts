import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { PRIVATE_FILE_MODE } from '../config/constants.js';
import { elephaHome } from '../config/paths.js';
import { atomicWrite } from '../util/fs.js';

export type ConfigChange =
    | { kind: 'write'; file: string; text: string; validate: (text: string) => void }
    | { kind: 'delete'; file: string };

export interface ConfigOriginal {
    file: string;
    exists: boolean;
    text: string;
    mode?: number;
}

export interface ConfigTransactionResult {
    originals: ConfigOriginal[];
}

interface InstallSnapshot {
    original: ConfigOriginal;
    installed: string;
}

export type InstallSnapshotRestore = { kind: 'text'; text: string } | { kind: 'delete' };

function snapshotDirectory(): string {
    return path.join(elephaHome(), 'install-snapshots');
}

function snapshotPath(file: string, directory = snapshotDirectory()): string {
    const key = createHash('sha256').update(file).digest('hex');
    return path.join(directory, `${key}.json`);
}

export function hasInstallSnapshot(file: string, directory?: string): boolean {
    return existsSync(snapshotPath(file, directory));
}

// Retain the pre-install bytes so a clean install/uninstall cycle is exactly reversible.
export function rememberInstallSnapshots(changes: ConfigChange[], originals: ConfigOriginal[], directory?: string): void {
    for (const change of changes) {
        if (change.kind !== 'write') {
            continue;
        }
        const original = originals.find((item) => item.file === change.file);
        if (!original) {
            continue;
        }
        const file = snapshotPath(change.file, directory);
        atomicWrite(file, `${JSON.stringify({ original, installed: change.text })}\n`, PRIVATE_FILE_MODE);
    }
}

export function deleteInstallSnapshots(files: string[], directory?: string): void {
    for (const file of files) {
        const snapshot = snapshotPath(file, directory);
        if (existsSync(snapshot)) {
            unlinkSync(snapshot);
        }
    }
}

// Prefer the exact original only if no one changed the managed document since install.
export function restoreInstallSnapshot(file: string, current: string, directory?: string): InstallSnapshotRestore | undefined {
    const snapshotFile = snapshotPath(file, directory);
    if (!existsSync(snapshotFile)) {
        return undefined;
    }
    try {
        const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as InstallSnapshot;
        if (snapshot.original.file !== file || snapshot.installed !== current) {
            return undefined;
        }
        return snapshot.original.exists ? { kind: 'text', text: snapshot.original.text } : { kind: 'delete' };
    } catch {
        throw new Error(`elepha install snapshot is malformed: ${snapshotFile}`);
    }
}

// Apply a logical multi-file config change or restore every original on failure.
export function applyConfigTransaction(changes: ConfigChange[]): ConfigTransactionResult | false {
    const changed = changes.filter((change) =>
        change.kind === 'delete'
            ? existsSync(change.file)
            : existsSync(change.file)
              ? readFileSync(change.file, 'utf8') !== change.text
              : change.text.length > 0,
    );
    if (changed.length === 0) {
        return false;
    }
    const originals: ConfigOriginal[] = changed.map((change) => {
        const exists = existsSync(change.file);
        return {
            file: change.file,
            exists,
            text: exists ? readFileSync(change.file, 'utf8') : '',
            mode: exists ? statSync(change.file).mode & 0o777 : undefined,
        };
    });
    try {
        for (const change of changed) {
            const original = originals.find((item) => item.file === change.file);
            if (!original) {
                // noinspection ExceptionCaughtLocallyJS
                throw new Error(`missing transaction original for ${change.file}`);
            }
            if (change.kind === 'write') {
                atomicWrite(change.file, change.text, original.mode ?? PRIVATE_FILE_MODE);
            } else {
                unlinkSync(change.file);
            }
        }
        for (const change of changed) {
            if (change.kind !== 'write') {
                continue;
            }
            const reread = readFileSync(change.file, 'utf8');
            change.validate(reread);
            if (reread !== change.text) {
                // noinspection ExceptionCaughtLocallyJS
                throw new Error(`read-back verification failed for ${change.file}`);
            }
        }
        return { originals };
    } catch (error) {
        try {
            for (const original of originals) {
                if (original.exists) {
                    atomicWrite(original.file, original.text, original.mode ?? PRIVATE_FILE_MODE);
                } else if (existsSync(original.file)) {
                    unlinkSync(original.file);
                }
            }
        } catch (rollbackError) {
            throw new Error(`configuration write failed and rollback failed: ${String(rollbackError)}`, { cause: error });
        }
        throw error;
    }
}
