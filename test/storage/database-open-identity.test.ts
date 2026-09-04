import {
    closeSync,
    existsSync,
    constants as fsConstants,
    linkSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import { expect, it, vi } from 'vitest';
import { DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS } from '../../src/config/constants.js';
import type { DatabaseEncryptionRuntime } from '../../src/storage/database-encryption.js';
import {
    acquireExclusiveDatabaseLifecycle,
    DATABASE_LIFECYCLE_AMBIGUOUS,
    DATABASE_LIFECYCLE_BUSY,
    databaseLifecyclePaths,
} from '../../src/storage/database-lifecycle.js';
import { openDb, openKeyedDatabase, openManagedDatabase, openUnmanagedDb } from '../../src/storage/db.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const databaseOpenHook = vi.hoisted(() => ({
    before: undefined as ((filename: unknown) => void) | undefined,
    after: undefined as ((filename: unknown, database: Database.Database) => void) | undefined,
}));

function isManagedDatabaseOpen(filename: unknown, databasePath: string): boolean {
    return (
        filename === databasePath ||
        (process.platform === 'linux' &&
            typeof filename === 'string' &&
            filename.startsWith('/proc/self/fd/') &&
            path.basename(filename) === path.basename(databasePath))
    );
}

function keyringRuntime(key: Buffer): DatabaseEncryptionRuntime {
    return {
        platform: 'darwin',
        randomBytes: () => Buffer.from(key),
        randomUUID: () => '66666666-6666-4666-8666-666666666666',
        createKeyringEntry: async () => ({
            getSecret: async () => Buffer.from(key),
            setSecret: async () => undefined,
            deleteCredential: async () => true,
        }),
    };
}

function hasSharedOwner(databasePath: string): boolean {
    const leases = databaseLifecyclePaths(databasePath).leases;
    return readdirSync(leases).some((entry) => {
        try {
            const record = JSON.parse(readFileSync(path.join(leases, entry), 'utf8')) as { databasePath?: unknown };
            return record.databasePath === path.resolve(databasePath);
        } catch {
            return false;
        }
    });
}

function failFirstDatabaseClose(database: Database.Database): () => number {
    const close = database.close.bind(database);
    let attempts = 0;
    database.close = () => {
        attempts++;
        if (attempts === 1) {
            throw new Error('forced SQLite close failure');
        }
        return close();
    };
    return () => attempts;
}

it('binds the returned connection after SQLite reuses a deferred same-inode descriptor', async () => {
    const directory = withGrantableTestDir('elepha-database-open-identity-deferred-');
    const databasePath = path.join(directory, 'elepha.db');
    const anchor = openUnmanagedDb(databasePath);
    try {
        const first = await openManagedDatabase(databasePath, { fileMustExist: true });
        first.close();

        const reopened = await openManagedDatabase(databasePath, { fileMustExist: true });
        try {
            expect(reopened.prepare('SELECT count(*) AS count FROM sqlite_master').get()).toEqual({ count: expect.any(Number) });
        } finally {
            reopened.close();
        }
    } finally {
        anchor.close();
    }
});

it('fails closed when filesystem timestamps cannot distinguish an open-path mutation', async () => {
    const directory = withGrantableTestDir('elepha-database-open-identity-coarse-');
    const databasePath = path.join(directory, 'elepha.db');
    const seeded = openUnmanagedDb(databasePath);
    seeded.close();
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
    const originalFstatSync = mutableFs.fstatSync;
    mutableFs.fstatSync = ((descriptor, options) => {
        const state = originalFstatSync(descriptor, options as never);
        if ((options as { bigint?: boolean } | undefined)?.bigint !== true) {
            return state;
        }
        return new Proxy(state, {
            get(target, property, receiver) {
                if (property === 'ctimeNs' || property === 'mtimeNs') {
                    return 1_000_000_000n;
                }
                return Reflect.get(target, property, receiver);
            },
        });
    }) as typeof import('node:fs').fstatSync;
    syncBuiltinESMExports();

    try {
        await expect(openManagedDatabase(databasePath, { fileMustExist: true })).rejects.toThrow(
            `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database filesystem metadata is too coarse to seal SQLite open: ${databasePath}`,
        );
    } finally {
        mutableFs.fstatSync = originalFstatSync;
        syncBuiltinESMExports();
    }

    const reopened = await openManagedDatabase(databasePath, { fileMustExist: true });
    reopened.close();
});

it.skipIf(process.platform !== 'darwin')('fails closed when ancestor timestamps cannot distinguish a directory replacement', async () => {
    const directory = withGrantableTestDir('elepha-database-open-identity-coarse-ancestor-');
    const databasePath = path.join(directory, 'elepha.db');
    const seeded = openUnmanagedDb(databasePath);
    seeded.close();
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
    const originalFstatSync = mutableFs.fstatSync;
    mutableFs.fstatSync = ((descriptor, options) => {
        const state = originalFstatSync(descriptor, options as never);
        if ((options as { bigint?: boolean } | undefined)?.bigint !== true || !state.isDirectory()) {
            return state;
        }
        return new Proxy(state, {
            get(target, property, receiver) {
                if (property === 'ctimeNs') {
                    return 1_000_000_000n;
                }
                return Reflect.get(target, property, receiver);
            },
        });
    }) as typeof import('node:fs').fstatSync;
    syncBuiltinESMExports();

    try {
        await expect(openManagedDatabase(databasePath, { fileMustExist: true })).rejects.toThrow(
            `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database filesystem metadata is too coarse to seal SQLite open: ${databasePath}`,
        );
    } finally {
        mutableFs.fstatSync = originalFstatSync;
        syncBuiltinESMExports();
    }

    const reopened = await openManagedDatabase(databasePath, { fileMustExist: true });
    reopened.close();
});

it.skipIf(process.platform !== 'darwin')('preserves the identity failure when an ancestor descriptor also fails to close', async () => {
    const directory = withGrantableTestDir('elepha-database-open-identity-ancestor-cleanup-');
    const databasePath = path.join(directory, 'elepha.db');
    const seeded = openUnmanagedDb(databasePath);
    seeded.close();
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
    const originalCloseSync = mutableFs.closeSync;
    const originalFstatSync = mutableFs.fstatSync;
    let failedDescriptor: number | undefined;
    let cleanupFailureInjected = false;
    mutableFs.fstatSync = ((descriptor, options) => {
        const state = originalFstatSync(descriptor, options as never);
        if ((options as { bigint?: boolean } | undefined)?.bigint !== true || !state.isDirectory()) {
            return state;
        }
        failedDescriptor ??= descriptor;
        return new Proxy(state, {
            get(target, property, receiver) {
                if (property === 'ctimeNs') {
                    return 1_000_000_000n;
                }
                return Reflect.get(target, property, receiver);
            },
        });
    }) as typeof import('node:fs').fstatSync;
    mutableFs.closeSync = ((descriptor) => {
        if (descriptor === failedDescriptor && !cleanupFailureInjected) {
            cleanupFailureInjected = true;
            throw new Error('forced ancestor descriptor close failure');
        }
        return originalCloseSync(descriptor);
    }) as typeof import('node:fs').closeSync;
    syncBuiltinESMExports();

    let caught: unknown;
    try {
        await openManagedDatabase(databasePath, { fileMustExist: true });
    } catch (error) {
        caught = error;
    } finally {
        mutableFs.closeSync = originalCloseSync;
        mutableFs.fstatSync = originalFstatSync;
        syncBuiltinESMExports();
        if (failedDescriptor !== undefined) {
            originalCloseSync(failedDescriptor);
        }
    }

    expect(cleanupFailureInjected).toBe(true);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
        `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database filesystem metadata is too coarse to seal SQLite open: ${databasePath}`,
        'forced ancestor descriptor close failure',
    ]);

    const reopened = await openManagedDatabase(databasePath, { fileMustExist: true });
    reopened.close();
});

it('allows unrelated sibling churn in and above the database parent while SQLite opens', async () => {
    const root = withGrantableTestDir('elepha-database-open-identity-sibling-churn-');
    const databaseDirectory = path.join(root, 'active', 'nested');
    const databasePath = path.join(databaseDirectory, 'elepha.db');
    mkdirSync(databaseDirectory, { recursive: true });
    const seeded = openUnmanagedDb(databasePath);
    seeded.close();
    let churnCount = 0;

    databaseOpenHook.before = (filename) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            mkdirSync(path.join(root, `unrelated-ancestor-${churnCount}`));
            mkdirSync(path.join(databaseDirectory, `unrelated-parent-${churnCount}`));
            churnCount++;
        }
    };
    try {
        const database = await openManagedDatabase(databasePath, { fileMustExist: true });
        try {
            const changes = database
                .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                .run('codex', 'safe-write', '2026-09-04T00:00:00.000Z').changes;
            expect(changes).toBe(1);
            // Churn in two adjacent ancestors is indistinguishable from a
            // restored rename and is retried fail-closed. The successful open
            // must remain within the fixed seal-attempt budget.
            expect(churnCount).toBeGreaterThanOrEqual(1);
            expect(churnCount).toBeLessThanOrEqual(DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS);
        } finally {
            database.close();
        }
    } finally {
        databaseOpenHook.before = undefined;
    }

    const reopened = openUnmanagedDb(databasePath);
    try {
        expect(reopened.prepare('SELECT native_id FROM purged_transcripts ORDER BY native_id').all()).toEqual([
            { native_id: 'safe-write' },
        ]);
    } finally {
        reopened.close();
    }
});

it.skipIf(process.platform !== 'linux')('binds Linux SQLite filenames and WAL companions to the pinned parent', async () => {
    const directory = withGrantableTestDir('elepha-database-open-identity-linux-parent-');
    const databasePath = path.join(directory, 'elepha.db');
    const seeded = openUnmanagedDb(databasePath);
    seeded.close();

    const database = await openDb(databasePath);
    try {
        const main = (database.pragma('database_list') as Array<{ seq: number; name: string; file: string }>).find(
            (entry) => entry.seq === 0 && entry.name === 'main',
        );
        expect(main?.file).toBe(realpathSync(databasePath));
        expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
        expect(
            database
                .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                .run('codex', 'linux-pinned-parent', '2026-09-04T00:00:00.000Z').changes,
        ).toBe(1);
        expect(existsSync(`${databasePath}-wal`)).toBe(true);
        expect(existsSync(`${databasePath}-shm`)).toBe(true);
    } finally {
        database.close();
    }
});

it('retains a shared lease when key validation and SQLite close both fail', async () => {
    const directory = withGrantableTestDir('elepha-database-open-identity-shared-init-close-');
    const databasePath = path.join(directory, 'elepha.db');
    const correctKey = Buffer.alloc(32, 0x31);
    const wrongKey = Buffer.alloc(32, 0x32);
    const seeded = await openDb(databasePath, { encryption: keyringRuntime(correctKey) });
    seeded.close();
    let captured: Database.Database | undefined;
    let closeAttempts: (() => number) | undefined;

    databaseOpenHook.after = (filename, database) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            captured = database;
            closeAttempts = failFirstDatabaseClose(database);
        }
    };
    try {
        await expect(openManagedDatabase(databasePath, { fileMustExist: true, encryption: keyringRuntime(wrongKey) })).rejects.toThrow(
            'Managed database initialization and close both failed.',
        );
        expect(closeAttempts?.()).toBe(1);
        expect(hasSharedOwner(databasePath)).toBe(true);

        if (captured === undefined) {
            throw new Error('managed database constructor was not captured');
        }
        captured.close();
        expect(closeAttempts?.()).toBe(2);
        expect(hasSharedOwner(databasePath)).toBe(false);

        const exclusive = await acquireExclusiveDatabaseLifecycle(databasePath);
        exclusive.release();
    } finally {
        databaseOpenHook.after = undefined;
        if (captured?.open) {
            captured.close();
        }
    }
});

it('retains supplied exclusive ownership when key validation and SQLite close both fail', async () => {
    const directory = withGrantableTestDir('elepha-database-open-identity-exclusive-init-close-');
    const databasePath = path.join(directory, 'elepha.db');
    const correctKey = Buffer.alloc(32, 0x41);
    const wrongKey = Buffer.alloc(32, 0x42);
    const seeded = await openDb(databasePath, { encryption: keyringRuntime(correctKey) });
    seeded.close();
    const exclusive = await acquireExclusiveDatabaseLifecycle(databasePath);
    let captured: Database.Database | undefined;
    let closeAttempts: (() => number) | undefined;

    databaseOpenHook.after = (filename, database) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            captured = database;
            closeAttempts = failFirstDatabaseClose(database);
        }
    };
    try {
        await expect(
            openManagedDatabase(databasePath, {
                fileMustExist: true,
                encryption: keyringRuntime(wrongKey),
                lifecycle: exclusive,
            }),
        ).rejects.toThrow('Managed database initialization and close both failed.');
        expect(closeAttempts?.()).toBe(1);
        expect(() => exclusive.release()).toThrow(
            `${DATABASE_LIFECYCLE_BUSY}: managed database connections remain open for ${databasePath}`,
        );

        if (captured === undefined) {
            throw new Error('managed database constructor was not captured');
        }
        captured.close();
        expect(closeAttempts?.()).toBe(2);
        exclusive.release();
    } finally {
        databaseOpenHook.after = undefined;
        if (captured?.open) {
            captured.close();
        }
        try {
            exclusive.release();
        } catch {
            // Preserve a live owner if the test failed before SQLite close was proven.
        }
    }
});

it('retains the pinned proof and shared lease when an uncertain SQLite handle cannot close', async () => {
    const directory = withGrantableTestDir('elepha-database-open-identity-proof-close-');
    const databasePath = path.join(directory, 'elepha.db');
    const aliasPath = path.join(directory, 'alias.db');
    const seeded = openUnmanagedDb(databasePath);
    seeded.close();
    linkSync(databasePath, aliasPath);
    let captured: Database.Database | undefined;
    let closeAttempts: (() => number) | undefined;

    databaseOpenHook.before = (filename) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            unlinkSync(databasePath);
            linkSync(aliasPath, databasePath);
        }
    };
    databaseOpenHook.after = (filename, database) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            unlinkSync(databasePath);
            linkSync(aliasPath, databasePath);
            captured = database;
            closeAttempts = failFirstDatabaseClose(database);
        }
    };
    try {
        await expect(openManagedDatabase(databasePath, { fileMustExist: true })).rejects.toThrow(
            'Managed database initialization and lifecycle release both failed.',
        );
        expect(closeAttempts?.()).toBe(1);
        expect(hasSharedOwner(databasePath)).toBe(true);

        if (captured === undefined) {
            throw new Error('uncertain SQLite database was not captured');
        }
        captured.close();
        expect(closeAttempts?.()).toBe(2);
        expect(hasSharedOwner(databasePath)).toBe(false);

        const exclusive = await acquireExclusiveDatabaseLifecycle(databasePath);
        exclusive.release();
    } finally {
        databaseOpenHook.before = undefined;
        databaseOpenHook.after = undefined;
        if (captured?.open) {
            captured.close();
        }
    }
});

vi.mock('better-sqlite3-multiple-ciphers', async (importOriginal) => {
    const actual = (await importOriginal()) as { default: typeof import('better-sqlite3-multiple-ciphers') };
    const wrapped = new Proxy(actual.default, {
        construct(target, argumentsList, newTarget) {
            databaseOpenHook.before?.(argumentsList[0]);
            const database = Reflect.construct(target, argumentsList, newTarget);
            databaseOpenHook.after?.(argumentsList[0], database);
            return database;
        },
    });
    return { ...actual, default: wrapped };
});

it('rejects a SQLite handle opened on a retired inode during a pathname ABA', async () => {
    const safeDirectory = withGrantableTestDir('elepha-database-open-identity-aba-safe-');
    const retiredDirectory = withGrantableTestDir('elepha-database-open-identity-aba-retired-');
    const databasePath = path.join(safeDirectory, 'mutable.db');
    const safeAliasPath = path.join(safeDirectory, 'safe.db');
    const canonicalPath = path.join(retiredDirectory, 'canonical.db');
    const retiredAliasPath = path.join(retiredDirectory, 'retired.db');
    const replacementPath = path.join(retiredDirectory, 'replacement.db');
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
    const runtime: DatabaseEncryptionRuntime = {
        platform: 'darwin',
        randomBytes: () => Buffer.from(key),
        randomUUID: () => '44444444-4444-4444-8444-444444444444',
        createKeyringEntry: async () => ({
            getSecret: async () => Buffer.from(key),
            setSecret: async () => undefined,
            deleteCredential: async () => true,
        }),
    };
    const seed = async (targetPath: string, nativeId: string) => {
        const database = await openDb(targetPath, { encryption: runtime });
        database
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', nativeId, '2026-09-04T00:00:00.000Z');
        database.close();
    };
    const nativeIds = (targetPath: string): string[] => {
        const database = openKeyedDatabase(targetPath, Buffer.from(key), { fileMustExist: true });
        try {
            return (
                database.prepare('SELECT native_id FROM purged_transcripts ORDER BY native_id').all() as Array<{
                    native_id: string;
                }>
            ).map((row) => row.native_id);
        } finally {
            database.close();
        }
    };

    await seed(databasePath, 'safe');
    await seed(canonicalPath, 'old');
    await seed(replacementPath, 'new');
    linkSync(databasePath, safeAliasPath);
    linkSync(canonicalPath, retiredAliasPath);
    const exclusive = await acquireExclusiveDatabaseLifecycle(canonicalPath);
    renameSync(replacementPath, canonicalPath);
    exclusive.release();
    const safeIdentity = statSync(safeAliasPath);
    const retiredIdentity = statSync(retiredAliasPath);
    let beforeReached = false;
    let afterReached = false;
    let changes = 0;
    let error: string | null = null;

    databaseOpenHook.before = (filename) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            unlinkSync(databasePath);
            linkSync(retiredAliasPath, databasePath);
            beforeReached = true;
        }
    };
    databaseOpenHook.after = (filename) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            unlinkSync(databasePath);
            linkSync(safeAliasPath, databasePath);
            afterReached = true;
        }
    };
    try {
        const database = await openManagedDatabase(databasePath, { fileMustExist: true, encryption: runtime });
        try {
            unlinkSync(databasePath);
            linkSync(retiredAliasPath, databasePath);
            changes = database
                .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                .run('codex', 'ack-on-retired-handle', '2026-09-04T00:00:00.000Z').changes;
        } finally {
            database.close();
        }
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
    } finally {
        databaseOpenHook.before = undefined;
        databaseOpenHook.after = undefined;
    }

    const currentIdentity = statSync(databasePath);
    expect({
        beforeReached,
        afterReached,
        changes,
        error,
        retired: nativeIds(retiredAliasPath),
        safe: nativeIds(safeAliasPath),
        detached:
            currentIdentity.dev === retiredIdentity.dev &&
            currentIdentity.ino === retiredIdentity.ino &&
            (currentIdentity.dev !== safeIdentity.dev || currentIdentity.ino !== safeIdentity.ino),
    }).toEqual({
        beforeReached: true,
        afterReached: true,
        changes: 0,
        error: `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path changed while SQLite opened ${databasePath}`,
        retired: ['old'],
        safe: ['safe'],
        detached: false,
    });
});

it('rejects a SQLite handle opened during a rename-away and rename-back ABA', async () => {
    const safeDirectory = withGrantableTestDir('elepha-database-open-identity-rename-safe-');
    const retiredDirectory = withGrantableTestDir('elepha-database-open-identity-rename-retired-');
    const databasePath = path.join(safeDirectory, 'mutable.db');
    const parkedSafePath = path.join(safeDirectory, 'parked-safe.db');
    const canonicalPath = path.join(retiredDirectory, 'canonical.db');
    const retiredAliasPath = path.join(retiredDirectory, 'retired.db');
    const replacementPath = path.join(retiredDirectory, 'replacement.db');
    const seed = (targetPath: string, nativeId: string): void => {
        const database = openUnmanagedDb(targetPath);
        database
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', nativeId, '2026-09-04T00:00:00.000Z');
        database.close();
    };
    const nativeIds = (targetPath: string): string[] => {
        const database = openUnmanagedDb(targetPath);
        try {
            return (
                database.prepare('SELECT native_id FROM purged_transcripts ORDER BY native_id').all() as Array<{ native_id: string }>
            ).map((row) => row.native_id);
        } finally {
            database.close();
        }
    };

    seed(databasePath, 'safe');
    seed(canonicalPath, 'old');
    seed(replacementPath, 'new');
    linkSync(canonicalPath, retiredAliasPath);
    const exclusive = await acquireExclusiveDatabaseLifecycle(canonicalPath);
    renameSync(replacementPath, canonicalPath);
    exclusive.release();
    let renamedAway = false;
    let renamedBack = false;
    let changes = 0;
    let error: string | null = null;

    databaseOpenHook.before = (filename) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            renameSync(databasePath, parkedSafePath);
            renameSync(retiredAliasPath, databasePath);
            renamedAway = true;
        }
    };
    databaseOpenHook.after = (filename) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            renameSync(databasePath, retiredAliasPath);
            renameSync(parkedSafePath, databasePath);
            renamedBack = true;
        }
    };
    try {
        const database = await openManagedDatabase(databasePath, { fileMustExist: true });
        try {
            changes = database
                .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                .run('codex', 'ack-on-renamed-retired-handle', '2026-09-04T00:00:00.000Z').changes;
        } finally {
            database.close();
        }
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
    } finally {
        databaseOpenHook.before = undefined;
        databaseOpenHook.after = undefined;
    }

    expect({ renamedAway, renamedBack, changes, error, safe: nativeIds(databasePath), retired: nativeIds(retiredAliasPath) }).toEqual({
        renamedAway: true,
        renamedBack: true,
        changes: 0,
        error: `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path changed while SQLite opened ${databasePath}`,
        safe: ['safe'],
        retired: ['old'],
    });
});

it('rejects a SQLite handle opened while an ancestor is replaced and restored', async () => {
    const root = withGrantableTestDir('elepha-database-open-identity-ancestor-');
    const originalAncestor = path.join(root, 'active');
    const originalParent = path.join(originalAncestor, 'nested');
    const retiredDirectory = path.join(root, 'retired');
    mkdirSync(originalParent, { recursive: true });
    mkdirSync(retiredDirectory);
    const databasePath = path.join(originalParent, 'mutable.db');
    const canonicalPath = path.join(retiredDirectory, 'canonical.db');
    const retiredAliasPath = path.join(retiredDirectory, 'retired.db');
    const replacementPath = path.join(retiredDirectory, 'replacement.db');
    const seed = (targetPath: string, nativeId: string): void => {
        const database = openUnmanagedDb(targetPath);
        database
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', nativeId, '2026-09-04T00:00:00.000Z');
        database.close();
    };
    const nativeIds = (targetPath: string): string[] => {
        const database = openUnmanagedDb(targetPath);
        try {
            return (
                database.prepare('SELECT native_id FROM purged_transcripts ORDER BY native_id').all() as Array<{ native_id: string }>
            ).map((row) => row.native_id);
        } finally {
            database.close();
        }
    };

    seed(databasePath, 'safe');
    seed(canonicalPath, 'old');
    seed(replacementPath, 'new');
    linkSync(canonicalPath, retiredAliasPath);
    const exclusive = await acquireExclusiveDatabaseLifecycle(canonicalPath);
    renameSync(replacementPath, canonicalPath);
    exclusive.release();
    let ancestorReplacementAttempts = 0;
    let ancestorRestorationAttempts = 0;
    let changes = 0;
    let error: string | null = null;

    databaseOpenHook.before = (filename) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            const parkedAncestor = path.join(root, `parked-active-${ancestorReplacementAttempts}`);
            renameSync(originalAncestor, parkedAncestor);
            mkdirSync(originalParent, { recursive: true });
            renameSync(retiredAliasPath, databasePath);
            ancestorReplacementAttempts++;
        }
    };
    databaseOpenHook.after = (filename) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            const attempt = ancestorRestorationAttempts;
            const parkedAncestor = path.join(root, `parked-active-${attempt}`);
            const discardedAncestor = path.join(root, `discarded-active-${attempt}`);
            renameSync(databasePath, retiredAliasPath);
            renameSync(originalAncestor, discardedAncestor);
            renameSync(parkedAncestor, originalAncestor);
            ancestorRestorationAttempts++;
        }
    };
    try {
        const database = await openManagedDatabase(databasePath, { fileMustExist: true });
        try {
            changes = database
                .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                .run('codex', 'ack-on-ancestor-swapped-handle', '2026-09-04T00:00:00.000Z').changes;
        } finally {
            database.close();
        }
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
    } finally {
        databaseOpenHook.before = undefined;
        databaseOpenHook.after = undefined;
    }

    const outcome = {
        ancestorReplacementAttempts,
        ancestorRestorationAttempts,
        changes,
        error,
        safe: nativeIds(databasePath),
        retired: nativeIds(retiredAliasPath),
    };
    if (ancestorReplacementAttempts > 0) {
        expect(outcome).toEqual({
            ancestorReplacementAttempts: DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS,
            ancestorRestorationAttempts: DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS,
            changes: 0,
            error: `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path changed while SQLite opened ${databasePath}`,
            safe: ['safe'],
            retired: ['old'],
        });
    } else {
        // Sandboxed Darwin may refuse the directory rename. Unsandboxed APFS
        // permits it, and the branch above requires the lifecycle seal rather
        // than the operating system to prevent a detached write.
        expect(outcome).toEqual({
            ancestorReplacementAttempts: 0,
            ancestorRestorationAttempts: 0,
            changes: 0,
            error: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM):/),
            safe: ['safe'],
            retired: ['old'],
        });
    }
});

it('binds the returned connection when a retired deferred descriptor is hidden by an unrelated expected-inode descriptor', async () => {
    const safeDirectory = withGrantableTestDir('elepha-database-open-identity-decoy-safe-');
    const retiredDirectory = withGrantableTestDir('elepha-database-open-identity-decoy-retired-');
    const databasePath = path.join(safeDirectory, 'mutable.db');
    const safeAliasPath = path.join(safeDirectory, 'safe.db');
    const canonicalPath = path.join(retiredDirectory, 'canonical.db');
    const retiredAliasPath = path.join(retiredDirectory, 'retired.db');
    const replacementPath = path.join(retiredDirectory, 'replacement.db');
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
    const runtime: DatabaseEncryptionRuntime = {
        platform: 'darwin',
        randomBytes: () => Buffer.from(key),
        randomUUID: () => '55555555-5555-4555-8555-555555555555',
        createKeyringEntry: async () => ({
            getSecret: async () => Buffer.from(key),
            setSecret: async () => undefined,
            deleteCredential: async () => true,
        }),
    };
    const seed = async (targetPath: string, nativeId: string) => {
        const database = await openDb(targetPath, { encryption: runtime });
        database
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', nativeId, '2026-09-04T00:00:00.000Z');
        database.close();
    };
    const nativeIds = (targetPath: string): string[] => {
        const database = openKeyedDatabase(targetPath, Buffer.from(key), { fileMustExist: true });
        try {
            return (
                database.prepare('SELECT native_id FROM purged_transcripts ORDER BY native_id').all() as Array<{
                    native_id: string;
                }>
            ).map((row) => row.native_id);
        } finally {
            database.close();
        }
    };

    await seed(databasePath, 'safe');
    await seed(canonicalPath, 'old');
    await seed(replacementPath, 'new');
    linkSync(databasePath, safeAliasPath);
    linkSync(canonicalPath, retiredAliasPath);
    const exclusive = await acquireExclusiveDatabaseLifecycle(canonicalPath);
    renameSync(replacementPath, canonicalPath);
    exclusive.release();
    const retiredIdentity = statSync(retiredAliasPath);
    const anchor = openKeyedDatabase(retiredAliasPath, Buffer.from(key), { fileMustExist: true });
    anchor.exec('BEGIN');
    anchor.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
    const deferredConnections: Array<ReturnType<typeof openKeyedDatabase>> = [];
    for (let index = 0; index < 4; index++) {
        const deferred = openKeyedDatabase(retiredAliasPath, Buffer.from(key), { fileMustExist: true });
        deferred.exec('BEGIN');
        deferred.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
        deferredConnections.push(deferred);
    }
    for (const deferred of deferredConnections) {
        deferred.close();
    }
    const decoyDescriptors: number[] = [];
    let attackedOpenCount = 0;
    let changes = 0;
    let error: string | null = null;

    databaseOpenHook.before = (filename) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            unlinkSync(databasePath);
            linkSync(retiredAliasPath, databasePath);
        }
    };
    databaseOpenHook.after = (filename) => {
        if (isManagedDatabaseOpen(filename, databasePath)) {
            decoyDescriptors.push(openSync(safeAliasPath, fsConstants.O_RDONLY));
            unlinkSync(databasePath);
            linkSync(safeAliasPath, databasePath);
            attackedOpenCount++;
        }
    };
    try {
        const database = await openManagedDatabase(databasePath, { fileMustExist: true, encryption: runtime });
        anchor.exec('ROLLBACK');
        anchor.close();
        try {
            changes = database
                .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                .run('codex', 'ack-on-retired-deferred-fd', '2026-09-04T00:00:00.000Z').changes;
        } finally {
            database.close();
        }
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
    } finally {
        if (anchor.inTransaction) {
            anchor.exec('ROLLBACK');
        }
        if (anchor.open) {
            anchor.close();
        }
        databaseOpenHook.before = undefined;
        databaseOpenHook.after = undefined;
        for (const descriptor of decoyDescriptors) {
            closeSync(descriptor);
        }
    }

    const currentIdentity = statSync(databasePath);
    expect({
        attackedOpenCount,
        changes,
        error,
        retired: nativeIds(retiredAliasPath),
        safe: nativeIds(safeAliasPath),
        detached: currentIdentity.dev !== retiredIdentity.dev || currentIdentity.ino !== retiredIdentity.ino,
    }).toEqual({
        attackedOpenCount: expect.any(Number),
        changes: 0,
        error: `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path changed while SQLite opened ${databasePath}`,
        retired: ['old'],
        safe: ['safe'],
        detached: true,
    });
    expect(attackedOpenCount).toBeGreaterThan(0);
});
