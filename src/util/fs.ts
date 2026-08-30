import { randomUUID } from 'node:crypto';
import {
    chmodSync,
    copyFileSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PRIVATE_DIR_MODE } from '../config/constants.js';

/** Creates a directory and ensures it is private even when it already existed. */
export function ensurePrivateDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, PRIVATE_DIR_MODE);
}

/** Creates missing directories and hardens only the directories created by this call. */
export function ensureCreatedDirsPrivate(dir: string): void {
    const firstCreated = mkdirSync(dir, { recursive: true });
    if (firstCreated === undefined) {
        return;
    }
    const firstCreatedPath = path.resolve(firstCreated);
    let current = path.resolve(dir);
    while (true) {
        chmodSync(current, PRIVATE_DIR_MODE);
        if (current === firstCreatedPath) {
            return;
        }
        current = path.dirname(current);
    }
}

/** Applies a restrictive mode to an already-written private file. */
export function setPrivateFileMode(file: string, mode: number): void {
    chmodSync(file, mode);
}

/** Atomically replace a file without replacing a symlink that points at it. */
export function atomicWrite(file: string, text: string, mode: number): void {
    const target = (() => {
        try {
            return lstatSync(file).isSymbolicLink() ? realpathSync(file) : file;
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return file;
            }
            throw error;
        }
    })();
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { mode });
    renameSync(temporary, target);
    chmodSync(target, mode);
}

/** Atomically replaces a file with a byte-for-byte private copy without treating binary data as text. */
export function atomicCopyPrivateFile(source: string, destination: string, mode: number): void {
    const target = (() => {
        try {
            return lstatSync(destination).isSymbolicLink() ? realpathSync(destination) : destination;
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return destination;
            }
            throw error;
        }
    })();
    ensurePrivateDir(path.dirname(target));
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    copyFileSync(source, temporary);
    chmodSync(temporary, mode);
    renameSync(temporary, target);
    chmodSync(target, mode);
}

/** Read JSON only when the complete file can be read and parsed. */
export function readJson<T>(file: string): T | undefined {
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

/** Create the parent directory and write a newline-terminated JSON file. */
export function writeJson(file: string, value: unknown, mode: number): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value)}\n`, { mode });
}

/** Remove an optional file without a separate existence-check race. */
export function removeFileIfExists(file: string): void {
    try {
        unlinkSync(file);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

/** Lists regular files without turning a missing optional directory into an error. */
export function listRegularFiles(directory: string): string[] {
    try {
        return readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(directory, entry.name));
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}
