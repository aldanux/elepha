import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicCopyPrivateFile, atomicWrite } from '../../src/util/fs.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

function injectedFsError(message: string, code: string): NodeJS.ErrnoException {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

function assertRandomizedTemporary(temporary: string | undefined, destination: string): asserts temporary is string {
    expect(temporary?.startsWith(`${destination}.${process.pid}.`)).toBe(true);
    expect(temporary?.endsWith('.tmp')).toBe(true);
}

function existingTemporaryArtifacts(temporary: string): string[] {
    return ['', '-wal', '-shm', '-journal'].map((suffix) => `${temporary}${suffix}`).filter((file) => existsSync(file));
}

function randomizedTemporaryArtifacts(destination: string): string[] {
    const prefix = `${path.basename(destination)}.${process.pid}.`;
    return readdirSync(path.dirname(destination))
        .filter((entry) => entry.startsWith(prefix) && entry.includes('.tmp'))
        .map((entry) => path.join(path.dirname(destination), entry));
}

describe('atomicWrite', () => {
    it('writes through a symlink without replacing it', () => {
        const root = withTempDir('elepha-util-fs-');
        const target = path.join(root, 'dotfiles', 'settings.json');
        const link = path.join(root, 'config', 'settings.json');
        mkdirSync(path.dirname(target), { recursive: true });
        mkdirSync(path.dirname(link), { recursive: true });
        writeFileSync(target, '{"before":true}\n');
        symlinkSync(target, link);

        atomicWrite(link, '{"after":true}\n', 0o600);

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(target, 'utf8')).toBe('{"after":true}\n');
    });
});

describe('atomicCopyPrivateFile', () => {
    it('removes the exact randomized temporary when destination rename fails', () => {
        const root = withGrantableTestDir('elepha-atomic-copy-rename-failure-');
        const source = path.join(root, 'source.db');
        const destination = path.join(root, 'destination.db');
        const sourceBytes = Buffer.from('SQLite format 3\0plaintext restore fixture');
        const destinationBytes = Buffer.from('existing destination bytes');
        writeFileSync(source, sourceBytes);
        writeFileSync(destination, destinationBytes, { mode: 0o600 });
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalRenameSync = mutableFs.renameSync;
        let exactTemporary: string | undefined;
        mutableFs.renameSync = ((oldPath, newPath) => {
            if (String(newPath) === destination) {
                exactTemporary = String(oldPath);
                for (const suffix of ['-wal', '-shm', '-journal']) {
                    writeFileSync(`${exactTemporary}${suffix}`, `temporary ${suffix}`);
                }
                throw injectedFsError('injected destination rename failure', 'EISDIR');
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof import('node:fs').renameSync;
        syncBuiltinESMExports();

        let caught: unknown;
        try {
            atomicCopyPrivateFile(source, destination, 0o600);
        } catch (error) {
            caught = error;
        } finally {
            mutableFs.renameSync = originalRenameSync;
            syncBuiltinESMExports();
        }

        expect((caught as NodeJS.ErrnoException).code).toBe('EISDIR');
        assertRandomizedTemporary(exactTemporary, destination);
        expect(existingTemporaryArtifacts(exactTemporary)).toEqual([]);
        expect(readFileSync(source)).toEqual(sourceBytes);
        expect(readFileSync(destination)).toEqual(destinationBytes);
        expect(statSync(destination).mode & 0o777).toBe(0o600);
    });

    it('removes a partially written temporary and companions when copy fails', () => {
        const root = withGrantableTestDir('elepha-atomic-copy-copy-failure-');
        const source = path.join(root, 'source.db');
        const destination = path.join(root, 'destination.db');
        const sourceBytes = Buffer.from('SQLite format 3\0partially copied fixture');
        const destinationBytes = Buffer.from('destination before failed copy');
        writeFileSync(source, sourceBytes);
        writeFileSync(destination, destinationBytes);
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalCopyFileSync = mutableFs.copyFileSync;
        const primaryError = injectedFsError('injected copy failure', 'EIO');
        let exactTemporary: string | undefined;
        mutableFs.copyFileSync = ((sourcePath, destinationPath, mode) => {
            if (String(sourcePath) === source) {
                exactTemporary = String(destinationPath);
                writeFileSync(destinationPath, sourceBytes.subarray(0, 16));
                for (const suffix of ['-wal', '-shm', '-journal']) {
                    writeFileSync(`${exactTemporary}${suffix}`, `temporary ${suffix}`);
                }
                throw primaryError;
            }
            return originalCopyFileSync(sourcePath, destinationPath, mode);
        }) as typeof import('node:fs').copyFileSync;
        syncBuiltinESMExports();

        let caught: unknown;
        try {
            atomicCopyPrivateFile(source, destination, 0o600);
        } catch (error) {
            caught = error;
        } finally {
            mutableFs.copyFileSync = originalCopyFileSync;
            syncBuiltinESMExports();
        }

        expect(caught).toBe(primaryError);
        assertRandomizedTemporary(exactTemporary, destination);
        expect(existingTemporaryArtifacts(exactTemporary)).toEqual([]);
        expect(readFileSync(source)).toEqual(sourceBytes);
        expect(readFileSync(destination)).toEqual(destinationBytes);
    });

    it('removes the copied temporary and companions when private chmod fails', () => {
        const root = withGrantableTestDir('elepha-atomic-copy-chmod-failure-');
        const source = path.join(root, 'source.db');
        const destination = path.join(root, 'destination.db');
        const sourceBytes = Buffer.from('SQLite format 3\0chmod failure fixture');
        const destinationBytes = Buffer.from('destination before failed chmod');
        writeFileSync(source, sourceBytes);
        writeFileSync(destination, destinationBytes);
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalChmodSync = mutableFs.chmodSync;
        const primaryError = injectedFsError('injected temporary chmod failure', 'EACCES');
        let exactTemporary: string | undefined;
        mutableFs.chmodSync = ((file, mode) => {
            if (String(file).startsWith(`${destination}.${process.pid}.`) && String(file).endsWith('.tmp')) {
                exactTemporary = String(file);
                for (const suffix of ['-wal', '-shm', '-journal']) {
                    writeFileSync(`${exactTemporary}${suffix}`, `temporary ${suffix}`);
                }
                throw primaryError;
            }
            return originalChmodSync(file, mode);
        }) as typeof import('node:fs').chmodSync;
        syncBuiltinESMExports();

        let caught: unknown;
        try {
            atomicCopyPrivateFile(source, destination, 0o600);
        } catch (error) {
            caught = error;
        } finally {
            mutableFs.chmodSync = originalChmodSync;
            syncBuiltinESMExports();
        }

        expect(caught).toBe(primaryError);
        assertRandomizedTemporary(exactTemporary, destination);
        expect(existingTemporaryArtifacts(exactTemporary)).toEqual([]);
        expect(readFileSync(source)).toEqual(sourceBytes);
        expect(readFileSync(destination)).toEqual(destinationBytes);
    });

    it('keeps the primary failure when the exact temporary is already absent', () => {
        const root = withGrantableTestDir('elepha-atomic-copy-cleanup-enoent-');
        const source = path.join(root, 'source.db');
        const destination = path.join(root, 'destination.db');
        const destinationBytes = Buffer.from('destination before rename failure');
        writeFileSync(source, 'source bytes');
        writeFileSync(destination, destinationBytes);
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalRenameSync = mutableFs.renameSync;
        const originalUnlinkSync = mutableFs.unlinkSync;
        const primaryError = injectedFsError('injected rename after external temp removal', 'EISDIR');
        let exactTemporary: string | undefined;
        mutableFs.renameSync = ((oldPath, newPath) => {
            if (String(newPath) === destination) {
                exactTemporary = String(oldPath);
                originalUnlinkSync(oldPath);
                throw primaryError;
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof import('node:fs').renameSync;
        syncBuiltinESMExports();

        let caught: unknown;
        try {
            atomicCopyPrivateFile(source, destination, 0o600);
        } catch (error) {
            caught = error;
        } finally {
            mutableFs.renameSync = originalRenameSync;
            syncBuiltinESMExports();
        }

        expect(caught).toBe(primaryError);
        assertRandomizedTemporary(exactTemporary, destination);
        expect(existingTemporaryArtifacts(exactTemporary)).toEqual([]);
        expect(readFileSync(destination)).toEqual(destinationBytes);
    });

    it('reports cleanup failures without hiding the primary failure and still removes other artifacts', () => {
        const root = withGrantableTestDir('elepha-atomic-copy-cleanup-failure-');
        const source = path.join(root, 'source.db');
        const destination = path.join(root, 'destination.db');
        const destinationBytes = Buffer.from('destination before cleanup failure');
        writeFileSync(source, 'source bytes');
        writeFileSync(destination, destinationBytes);
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalRenameSync = mutableFs.renameSync;
        const originalUnlinkSync = mutableFs.unlinkSync;
        const primaryError = injectedFsError('injected destination rename failure', 'EISDIR');
        const cleanupError = injectedFsError('injected WAL cleanup failure', 'EACCES');
        let exactTemporary: string | undefined;
        mutableFs.renameSync = ((oldPath, newPath) => {
            if (String(newPath) === destination) {
                exactTemporary = String(oldPath);
                for (const suffix of ['-wal', '-shm', '-journal']) {
                    writeFileSync(`${exactTemporary}${suffix}`, `temporary ${suffix}`);
                }
                throw primaryError;
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof import('node:fs').renameSync;
        mutableFs.unlinkSync = ((file) => {
            if (exactTemporary !== undefined && String(file) === `${exactTemporary}-wal`) {
                throw cleanupError;
            }
            return originalUnlinkSync(file);
        }) as typeof import('node:fs').unlinkSync;
        syncBuiltinESMExports();

        let caught: unknown;
        try {
            atomicCopyPrivateFile(source, destination, 0o600);
        } catch (error) {
            caught = error;
        } finally {
            mutableFs.renameSync = originalRenameSync;
            mutableFs.unlinkSync = originalUnlinkSync;
            syncBuiltinESMExports();
        }

        assertRandomizedTemporary(exactTemporary, destination);
        expect(caught).toBeInstanceOf(AggregateError);
        expect((caught as AggregateError).cause).toBe(primaryError);
        expect((caught as AggregateError).errors).toEqual([primaryError, cleanupError]);
        expect((caught as Error).message).toContain(primaryError.message);
        expect((caught as Error).message).toContain(cleanupError.message);
        expect(existingTemporaryArtifacts(exactTemporary)).toEqual([`${exactTemporary}-wal`]);
        expect(readFileSync(destination)).toEqual(destinationBytes);
    });

    it('replaces the destination with exact source bytes and the requested private mode', () => {
        const root = withGrantableTestDir('elepha-atomic-copy-success-');
        const source = path.join(root, 'source.db');
        const destination = path.join(root, 'destination.db');
        const sourceBytes = Buffer.from([0, 1, 2, 3, 255, 128, 64]);
        writeFileSync(source, sourceBytes, { mode: 0o644 });
        writeFileSync(destination, 'old destination', { mode: 0o644 });
        const sourceMode = statSync(source).mode & 0o777;

        atomicCopyPrivateFile(source, destination, 0o600);

        expect(readFileSync(destination)).toEqual(sourceBytes);
        expect(statSync(destination).mode & 0o777).toBe(0o600);
        expect(readFileSync(source)).toEqual(sourceBytes);
        expect(statSync(source).mode & 0o777).toBe(sourceMode);
        expect(randomizedTemporaryArtifacts(destination)).toEqual([]);
    });
});
