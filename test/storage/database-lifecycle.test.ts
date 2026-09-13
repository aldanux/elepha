import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
    existsSync,
    constants as fsConstants,
    linkSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    symlinkSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DATABASE_LIFECYCLE_ACQUIRE_TIMEOUT_MS } from '../../src/config/constants.js';
import type { DatabaseEncryptionRuntime } from '../../src/storage/database-encryption.js';
import {
    acquireExclusiveDatabaseLifecycle,
    acquireSharedDatabaseLifecycle,
    DATABASE_LIFECYCLE_AMBIGUOUS,
    DATABASE_LIFECYCLE_BUSY,
    databaseLifecyclePaths,
    withExclusiveDatabaseLifecycle,
} from '../../src/storage/database-lifecycle.js';
import { openDb, openKeyedDatabase, openManagedDatabase, openUnmanagedDb } from '../../src/storage/db.js';
import { createTestDb } from '../helpers/db.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const dbModule = pathToFileURL(path.join(repositoryRoot, 'src', 'storage', 'db.ts')).href;
const lifecycleModule = pathToFileURL(path.join(repositoryRoot, 'src', 'storage', 'database-lifecycle.ts')).href;
const malformedLeaseName = 'lease-00000000-0000-4000-8000-000000000000';

function lifecycleIntentFiles(databasePath: string): string[] {
    const directory = databaseLifecyclePaths(databasePath).exclusive;
    if (!existsSync(directory)) {
        return [];
    }
    return readdirSync(directory).map((entry) => path.join(directory, entry));
}

function hasLifecycleIntent(databasePath: string): boolean {
    return lifecycleIntentFiles(databasePath).length > 0;
}

function removeLifecycleIntents(databasePath: string): void {
    for (const file of lifecycleIntentFiles(databasePath)) {
        unlinkSync(file);
    }
}

function writeLifecycleIntent(databasePath: string, owner: { ownerId: string }): string {
    const directory = databaseLifecyclePaths(databasePath).exclusive;
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `intent-${owner.ownerId}`);
    writeFileSync(file, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    return file;
}

beforeAll(() => {
    const malformedLease = path.join(
        databaseLifecyclePaths(path.join(repositoryRoot, '.test-scratch', 'unused.db')).leases,
        malformedLeaseName,
    );
    if (existsSync(malformedLease)) {
        unlinkSync(malformedLease);
    }
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for database lifecycle state.');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function spawnOwner(databasePath: string, kind: 'shared' | 'exclusive'): Promise<ChildProcess> {
    const source =
        kind === 'shared'
            ? `const { openManagedDatabase } = await import(${JSON.stringify(dbModule)});
const resource = await openManagedDatabase(${JSON.stringify(databasePath)}, { fileMustExist: true });
process.send?.('held');
setInterval(() => resource.prepare('SELECT 1').get(), 1000);`
            : `const { acquireExclusiveDatabaseLifecycle } = await import(${JSON.stringify(lifecycleModule)});
const resource = await acquireExclusiveDatabaseLifecycle(${JSON.stringify(databasePath)});
process.send?.('held');
setInterval(() => void resource, 1000);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: repositoryRoot,
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for lifecycle child: ${stderr}`)), 5_000);
        child.once('message', (message) => {
            if (message === 'held') {
                clearTimeout(timeout);
                resolve();
            }
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            reject(new Error(`Lifecycle child exited before acquiring (${String(code)}/${String(signal)}): ${stderr}`));
        });
        child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
    return child;
}

async function spawnRecoverableOwner(databasePath: string, recoveryId: string, recovering: boolean): Promise<ChildProcess> {
    const source = `const { acquireExclusiveDatabaseLifecycle } = await import(${JSON.stringify(lifecycleModule)});
const resource = await acquireExclusiveDatabaseLifecycle(${JSON.stringify(databasePath)}${recovering ? `, ${JSON.stringify(recoveryId)}` : ''});
${recovering ? '' : `resource.beginReplacement(${JSON.stringify(recoveryId)});`}
process.send?.('held');
setInterval(() => void resource, 1000);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: repositoryRoot,
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for recoverable lifecycle child: ${stderr}`)), 5_000);
        child.once('message', (message) => {
            if (message === 'held') {
                clearTimeout(timeout);
                resolve();
            }
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            reject(new Error(`Recoverable lifecycle child exited before acquiring (${String(code)}/${String(signal)}): ${stderr}`));
        });
        child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
    return child;
}

async function killOwner(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    child.kill('SIGKILL');
    await once(child, 'exit');
}

interface ObservedChild {
    child: ChildProcess;
    stderr: () => string;
}

interface UnsupportedPlatformLifecycleProbe {
    kind: 'shared' | 'exclusive';
    platform: NodeJS.Platform;
    platformError: string | null;
    error: string | null;
    filesystemEvents: string[];
    databaseExists: boolean;
}

function spawnWithoutLifecycleTestPreload(source: string, home: string): ObservedChild {
    // The test setup injects a repository-owned lifecycle root only when the
    // exact process.execPath spelling is used. This equivalent spelling starts
    // a real production-selection child without adding a public override.
    const executable = `${path.dirname(process.execPath)}${path.sep}.${path.sep}${path.basename(process.execPath)}`;
    const child = spawn(executable, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
    });
    return { child, stderr: () => stderr };
}

async function receiveChildMessage<T>(observed: ObservedChild): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;
        const cleanup = () => {
            clearTimeout(timeout);
            observed.child.off('message', onMessage);
            observed.child.off('exit', onExit);
            observed.child.off('error', onError);
        };
        const onMessage = (message: unknown) => {
            cleanup();
            resolve(message as T);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup();
            reject(new Error(`Lifecycle child exited before responding (${String(code)}/${String(signal)}): ${observed.stderr()}`));
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        observed.child.once('message', onMessage);
        observed.child.once('exit', onExit);
        observed.child.once('error', onError);
        timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for lifecycle child: ${observed.stderr()}`));
        }, 10_000);
    });
}

function sendChildMessage(observed: ObservedChild, message: string): void {
    if (observed.child.send === undefined) {
        throw new Error(`Lifecycle child has no IPC channel: ${observed.stderr()}`);
    }
    observed.child.send(message);
}

async function probeUnsupportedPlatformLifecycle(
    kind: UnsupportedPlatformLifecycleProbe['kind'],
    databasePath: string,
): Promise<UnsupportedPlatformLifecycleProbe> {
    const scratchRoot = path.join(repositoryRoot, '.test-scratch');
    const source = `import { createRequire, syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'win32' });
const mutableFs = createRequire(import.meta.url)('node:fs');
const { acquireExclusiveDatabaseLifecycle, pinSQLitePathForOpen } = await import(${JSON.stringify(lifecycleModule)});
const { openDb } = await import(${JSON.stringify(dbModule)});
const databasePath = ${JSON.stringify(databasePath)};
const scratchRoot = ${JSON.stringify(scratchRoot)};
const filesystemEvents = [];
const originals = new Map();
const pathOperations = [
    'accessSync', 'appendFileSync', 'chmodSync', 'copyFileSync', 'existsSync', 'linkSync', 'lstatSync',
    'mkdirSync', 'mkdtempSync', 'openSync', 'opendirSync', 'readFileSync', 'readdirSync', 'readlinkSync',
    'realpathSync', 'renameSync', 'rmSync', 'rmdirSync', 'statSync', 'symlinkSync', 'truncateSync',
    'unlinkSync', 'writeFileSync',
];
const isScratchPath = (value) => typeof value === 'string' && (value === scratchRoot || value.startsWith(scratchRoot + '/'));
for (const operation of pathOperations) {
    const original = mutableFs[operation];
    if (typeof original !== 'function') continue;
    originals.set(operation, original);
    mutableFs[operation] = (...args) => {
        const touched = args.find(isScratchPath);
        if (touched !== undefined) {
            filesystemEvents.push(operation + ':' + touched);
            throw new Error('REVIEW_LIFECYCLE_MUTATION_BEFORE_PLATFORM_REJECTION');
        }
        return Reflect.apply(original, mutableFs, args);
    };
}
syncBuiltinESMExports();
let platformError = null;
try {
    pinSQLitePathForOpen(databasePath, { dev: 0n, ino: 0n, ctimeNs: 0n, nlink: 0n });
} catch (error) {
    platformError = error instanceof Error ? error.message : String(error);
}
let error = null;
let resource;
try {
    resource = ${kind === 'shared' ? 'await openDb(databasePath)' : 'await acquireExclusiveDatabaseLifecycle(databasePath)'};
} catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
}
for (const [operation, original] of originals) mutableFs[operation] = original;
syncBuiltinESMExports();
if (resource !== undefined) {
    ${kind === 'shared' ? 'resource.close();' : 'resource.release();'}
}
const result = {
    kind: ${JSON.stringify(kind)},
    platform: process.platform,
    platformError,
    error,
    filesystemEvents,
    databaseExists: mutableFs.existsSync(databasePath),
};
await new Promise((resolve, reject) => process.send?.(result, (sendError) => sendError ? reject(sendError) : resolve()));
process.disconnect();`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: repositoryRoot,
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
    });
    const observed = { child, stderr: () => stderr };
    try {
        return await receiveChildMessage<UnsupportedPlatformLifecycleProbe>(observed);
    } finally {
        await killOwner(child);
    }
}

describe('managed database lifecycle', () => {
    it('reads and validates the current injected lifecycle namespace without a module reimport', () => {
        const root = withGrantableTestDir('elepha-database-lifecycle-namespace-');
        const symbol = Symbol.for('dev.elepha.internal.database-lifecycle-test-directory');
        const globals = globalThis as Record<symbol, unknown>;
        const previous = globals[symbol];
        try {
            for (const directory of [path.join(root, 'first'), path.join(root, 'second')]) {
                globals[symbol] = directory;
                expect(databaseLifecyclePaths(path.join(root, 'elepha.db')).directory).toBe(directory);
            }
            globals[symbol] = 'relative-lifecycle-directory';
            expect(() => databaseLifecyclePaths(path.join(root, 'elepha.db'))).toThrow(
                `${DATABASE_LIFECYCLE_AMBIGUOUS}: injected lifecycle test directory is invalid`,
            );
        } finally {
            globals[symbol] = previous;
        }
    });

    it('passes the current injected lifecycle namespace to exact-execPath children and grandchildren', () => {
        const root = withGrantableTestDir('elepha-database-lifecycle-child-namespace-');
        const symbol = Symbol.for('dev.elepha.internal.database-lifecycle-test-directory');
        const globals = globalThis as Record<symbol, unknown>;
        const previous = globals[symbol];
        const directory = path.join(root, 'lifecycle');
        const grandchildSource = `const { databaseLifecyclePaths } = await import(${JSON.stringify(lifecycleModule)});
process.stdout.write(JSON.stringify(databaseLifecyclePaths('unused.db').directory));`;
        const childSource = `import { spawnSync } from 'node:child_process';
const { databaseLifecyclePaths } = await import(${JSON.stringify(lifecycleModule)});
const grandchild = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', ${JSON.stringify(grandchildSource)}], {
    encoding: 'utf8', timeout: 5000, env: process.env,
});
if (grandchild.status !== 0) throw new Error(grandchild.stderr);
process.stdout.write(JSON.stringify({ child: databaseLifecyclePaths('unused.db').directory, grandchild: JSON.parse(grandchild.stdout) }));`;
        try {
            globals[symbol] = directory;
            const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childSource], {
                cwd: repositoryRoot,
                encoding: 'utf8',
                timeout: 10_000,
                env: process.env,
            });
            expect(result.status, result.stderr).toBe(0);
            expect(JSON.parse(result.stdout)).toEqual({ child: directory, grandchild: directory });
        } finally {
            globals[symbol] = previous;
        }
    });

    it.each([{ kind: 'shared' as const }, { kind: 'exclusive' as const }])(
        'rejects native Win32 before $kind lifecycle filesystem access',
        async ({ kind }) => {
            const directory = withGrantableTestDir(`elepha-database-lifecycle-unsupported-${kind}-`);
            const result = await probeUnsupportedPlatformLifecycle(kind, path.join(directory, 'elepha.db'));

            expect(result.platform).toBe('win32');
            expect(result.platformError).toMatch(new RegExp(`^${DATABASE_LIFECYCLE_AMBIGUOUS}: `));
            expect(result.filesystemEvents).toEqual([]);
            expect(result.error).toBe(result.platformError);
            expect(result.databaseExists).toBe(false);
        },
    );

    it('does not let a stale dead-owner reclaimer delete a newly published exclusive owner', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-owner-release-race-');
        const replacement = createTestDb('elepha-database-lifecycle-owner-release-race-replacement-');
        fixture.close();
        replacement.close();
        const aliasPath = path.join(fixture.directory, 'retired.db');
        linkSync(fixture.dbPath, aliasPath);
        const originalIdentity = statSync(aliasPath);
        const paths = databaseLifecyclePaths(fixture.dbPath);
        const deadPid = 2_147_483_647;
        const deadOwner = {
            version: 1,
            kind: 'exclusive',
            pid: deadPid,
            ownerId: '11111111-1111-4111-8111-111111111111',
            databasePath: path.resolve(fixture.dbPath),
            databaseFilename: null,
            phase: 'acquiring',
            databaseIdentity: null,
        } as const;
        const liveOwner = {
            ...deadOwner,
            pid: process.pid,
            ownerId: '22222222-2222-4222-8222-222222222222',
        } as const;
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalLstatSync = mutableFs.lstatSync;
        const originalKill = process.kill;
        let exclusiveLstatCalls = 0;
        let replacementPublished = false;
        let changes = 0;

        const seeded = acquireSharedDatabaseLifecycle(fixture.dbPath);
        seeded.release();
        const deadOwnerFile = writeLifecycleIntent(fixture.dbPath, deadOwner);
        const liveOwnerFile = path.join(paths.exclusive, `intent-${liveOwner.ownerId}`);
        process.kill = ((pid, signal) => {
            if (pid === deadPid && signal === 0) {
                const error = new Error('seeded owner is dead') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return originalKill(pid, signal);
        }) as typeof process.kill;
        mutableFs.lstatSync = ((file, options) => {
            const current = originalLstatSync(file, options as never);
            if (file === deadOwnerFile && ++exclusiveLstatCalls === 3) {
                unlinkSync(deadOwnerFile);
                writeFileSync(liveOwnerFile, `${JSON.stringify(liveOwner)}\n`, { mode: 0o600 });
                renameSync(replacement.dbPath, fixture.dbPath);
                replacementPublished = true;
            }
            return current;
        }) as typeof import('node:fs').lstatSync;
        syncBuiltinESMExports();

        try {
            const opener = await openManagedDatabase(aliasPath, { fileMustExist: true });
            try {
                changes = opener
                    .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                    .run('codex', 'ack-after-owner-deletion', '2026-09-04T00:00:00.000Z').changes;
            } finally {
                opener.close();
            }
        } catch {
            // The safe outcome is a blocked opener before any detached write.
        } finally {
            mutableFs.lstatSync = originalLstatSync;
            syncBuiltinESMExports();
            process.kill = originalKill;
        }

        const currentIdentity = statSync(fixture.dbPath);
        expect({
            replacementPublished,
            changes,
            exclusiveOwnerStillPresent: existsSync(liveOwnerFile),
            detachedAtWrite: currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino,
        }).toEqual({
            replacementPublished: true,
            changes: 0,
            exclusiveOwnerStillPresent: true,
            detachedAtWrite: true,
        });

        removeLifecycleIntents(fixture.dbPath);
    });

    it('releases a managed connection when a short-lived process exits without an explicit close', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-process-exit-');
        fixture.close();
        const source = `const { openManagedDatabase } = await import(${JSON.stringify(dbModule)});
await openManagedDatabase(${JSON.stringify(fixture.dbPath)}, { fileMustExist: true });
await new Promise((resolve, reject) => process.send?.('opened', (error) => error ? reject(error) : resolve()));`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
            cwd: repositoryRoot,
            env: process.env,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });
        const observed = { child, stderr: () => stderr };
        try {
            await receiveChildMessage(observed);
            if (child.exitCode === null && child.signalCode === null) {
                await once(child, 'exit');
            }

            const lifecycle = databaseLifecyclePaths(fixture.dbPath);
            const leaked = readdirSync(lifecycle.leases)
                .map((entry) => path.join(lifecycle.leases, entry))
                .filter((file) => {
                    const record = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; databasePath?: string };
                    return record.pid === child.pid && record.databasePath === path.resolve(fixture.dbPath);
                });
            expect(leaked, stderr).toEqual([]);
        } finally {
            await killOwner(child);
        }
    });

    it('drains a managed hard-link alias before replacing the canonical database inode', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-hard-link-');
        fixture.close();
        const aliasPath = path.join(fixture.directory, 'alias.db');
        linkSync(fixture.dbPath, aliasPath);
        const alias = await openManagedDatabase(aliasPath, { fileMustExist: true });
        const originalIdentity = statSync(aliasPath);
        let exclusiveSettled = false;
        const exclusivePromise = acquireExclusiveDatabaseLifecycle(fixture.dbPath).then((lease) => {
            exclusiveSettled = true;
            return lease;
        });
        await waitFor(() => hasLifecycleIntent(fixture.dbPath));
        await new Promise((resolve) => setImmediate(resolve));
        let detachedWriteAcknowledged = false;

        try {
            if (exclusiveSettled) {
                const replacement = createTestDb('elepha-database-lifecycle-hard-link-replacement-');
                replacement.close();
                renameSync(replacement.dbPath, fixture.dbPath);
                alias.exec('CREATE TABLE detached_write_acknowledged (id INTEGER PRIMARY KEY)');
                const currentIdentity = statSync(fixture.dbPath);
                detachedWriteAcknowledged = currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino;
            }
            expect(exclusiveSettled).toBe(false);
            expect(detachedWriteAcknowledged).toBe(false);
        } finally {
            alias.close();
            const exclusive = await exclusivePromise;
            exclusive.release();
        }
    });

    it('blocks replacement when a killed hard-link opener leaves an alias WAL', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-killed-alias-wal-');
        const replacement = createTestDb('elepha-database-lifecycle-killed-alias-wal-replacement-');
        fixture.close();
        replacement.close();
        const aliasPath = path.join(fixture.directory, 'killed-alias.db');
        linkSync(fixture.dbPath, aliasPath);
        const originalIdentity = statSync(aliasPath);
        const lifecycle = databaseLifecyclePaths(fixture.dbPath);
        const source = `import { statSync } from 'node:fs';
const { openManagedDatabase } = await import(${JSON.stringify(dbModule)});
const database = await openManagedDatabase(${JSON.stringify(aliasPath)}, { fileMustExist: true });
database.pragma('wal_autocheckpoint = 0');
const changes = database.prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
    .run('codex', 'ack-in-killed-alias-wal', '2026-09-04T00:00:00.000Z').changes;
process.send?.({ type: 'held', changes, walBytes: statSync(${JSON.stringify(`${aliasPath}-wal`)}).size });
setInterval(() => void database, 1000);`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
            cwd: repositoryRoot,
            env: process.env,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });
        const observed = { child, stderr: () => stderr };
        let ownerFile: string | undefined;

        try {
            const write = await receiveChildMessage<{ type: 'held'; changes: number; walBytes: number }>(observed);
            ownerFile = readdirSync(lifecycle.leases)
                .map((entry) => path.join(lifecycle.leases, entry))
                .find((file) => {
                    const record = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; databasePath?: string };
                    return record.pid === child.pid && record.databasePath === path.resolve(aliasPath);
                });
            expect(ownerFile).toBeDefined();
            await killOwner(child);

            let error: string | null = null;
            let canonicalAck: number | null = null;
            let aliasAck: number | null = null;
            let detached = false;
            try {
                const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
                renameSync(replacement.dbPath, fixture.dbPath);
                exclusive.release();
                const currentIdentity = statSync(fixture.dbPath);
                detached = currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino;
                const countAck = (databasePath: string): number => {
                    const database = openUnmanagedDb(databasePath);
                    try {
                        return (
                            database
                                .prepare("SELECT COUNT(*) AS count FROM purged_transcripts WHERE native_id = 'ack-in-killed-alias-wal'")
                                .get() as { count: number }
                        ).count;
                    } finally {
                        database.close();
                    }
                };
                canonicalAck = countAck(fixture.dbPath);
                aliasAck = countAck(aliasPath);
            } catch (caught) {
                error = caught instanceof Error ? caught.message : String(caught);
            }

            expect({ ...write, error, canonicalAck, aliasAck, detached }).toEqual({
                type: 'held',
                changes: 1,
                walBytes: 8_272,
                error: `${DATABASE_LIFECYCLE_AMBIGUOUS}: killed shared database owner left ambiguous companion state for ${aliasPath}`,
                canonicalAck: null,
                aliasAck: null,
                detached: false,
            });
        } finally {
            await killOwner(child);
            if (ownerFile !== undefined && existsSync(ownerFile)) {
                unlinkSync(ownerFile);
            }
        }
    });

    it('recovers committed encrypted WAL data before reclaiming a killed shared owner', async () => {
        const directory = withGrantableTestDir('elepha-database-lifecycle-killed-shared-wal-recovery-');
        const databasePath = path.join(directory, 'elepha.db');
        const keyPath = path.join(directory, 'database.key');
        const key = Buffer.alloc(32, 7);
        const runtime: DatabaseEncryptionRuntime = {
            platform: 'linux',
            env: { CI: '1' },
            keyFilePath: () => keyPath,
            randomBytes: () => Buffer.from(key),
            randomUUID: () => '55555555-5555-4555-8555-555555555555',
        };
        const seeded = await openDb(databasePath, { encryption: runtime });
        seeded.close();
        const source = `import { statSync } from 'node:fs';
const { openManagedDatabase } = await import(${JSON.stringify(dbModule)});
const database = await openManagedDatabase(${JSON.stringify(databasePath)}, {
    fileMustExist: true,
    encryption: { platform: 'linux', env: { CI: '1' }, keyFilePath: () => ${JSON.stringify(keyPath)} },
});
database.pragma('wal_autocheckpoint = 0');
const changes = database.prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
    .run('codex', 'committed-before-sigkill', '2026-09-12T00:00:00.000Z').changes;
process.send?.({ type: 'held', changes, walBytes: statSync(${JSON.stringify(`${databasePath}-wal`)}).size });
setInterval(() => void database, 1000);`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
            cwd: repositoryRoot,
            env: process.env,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });
        const observed = { child, stderr: () => stderr };

        try {
            const write = await receiveChildMessage<{ type: 'held'; changes: number; walBytes: number }>(observed);
            expect(write.changes).toBe(1);
            expect(write.walBytes).toBeGreaterThan(0);
            await killOwner(child);

            const recovered = await openManagedDatabase(databasePath, { fileMustExist: true, encryption: runtime });
            expect(
                recovered.prepare("SELECT native_id FROM purged_transcripts WHERE native_id = 'committed-before-sigkill'").get(),
            ).toEqual({ native_id: 'committed-before-sigkill' });
            expect(readdirSync(databaseLifecyclePaths(databasePath).leases)).toHaveLength(1);
            expect(statSync(`${databasePath}-wal`).size).toBe(0);
            recovered.close();
            expect(readdirSync(databaseLifecyclePaths(databasePath).leases)).toEqual([]);

            const verified = openKeyedDatabase(databasePath, key, { readonly: true, fileMustExist: true });
            try {
                expect(
                    verified.prepare("SELECT native_id FROM purged_transcripts WHERE native_id = 'committed-before-sigkill'").get(),
                ).toEqual({ native_id: 'committed-before-sigkill' });
            } finally {
                verified.close();
            }
        } finally {
            await killOwner(child);
        }
    });

    it.each(['symlink', 'inode-change'] as const)('rejects a %s WAL companion from a killed shared owner', async (change) => {
        const fixture = createTestDb(`elepha-database-lifecycle-killed-shared-${change}-`);
        fixture.close();
        const walPath = `${fixture.dbPath}-wal`;
        const substitute = path.join(fixture.directory, 'substitute-wal');
        const child = await spawnOwner(fixture.dbPath, 'shared');
        const paths = databaseLifecyclePaths(fixture.dbPath);
        await killOwner(child);
        writeFileSync(substitute, 'not a SQLite WAL');

        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalLstatSync = mutableFs.lstatSync;
        let substituted = false;
        if (change === 'symlink') {
            if (existsSync(walPath)) {
                unlinkSync(walPath);
            }
            symlinkSync(substitute, walPath);
        } else {
            mutableFs.lstatSync = ((file, options) => {
                if (!substituted && file === walPath) {
                    renameSync(substitute, walPath);
                    substituted = true;
                }
                return originalLstatSync(file, options as never);
            }) as typeof import('node:fs').lstatSync;
            syncBuiltinESMExports();
        }

        try {
            await expect(openManagedDatabase(fixture.dbPath, { fileMustExist: true })).rejects.toThrow(
                `${DATABASE_LIFECYCLE_AMBIGUOUS}: killed shared database companion`,
            );
            expect(readdirSync(paths.leases)).toHaveLength(1);
        } finally {
            mutableFs.lstatSync = originalLstatSync;
            syncBuiltinESMExports();
            await killOwner(child);
            for (const owner of readdirSync(paths.leases)) {
                unlinkSync(path.join(paths.leases, owner));
            }
        }
    });

    it.each(['shared', 'exclusive'] as const)('inspects the physical WAL after a killed %s symlink opener', async (kind) => {
        const fixture = createTestDb('elepha-database-lifecycle-killed-symlink-wal-');
        const replacement = createTestDb('elepha-database-lifecycle-killed-symlink-wal-replacement-');
        fixture.close();
        replacement.close();
        const aliasPath = path.join(fixture.directory, 'writer-alias.db');
        const replacementTarget = path.join(fixture.directory, 'replacement-target.db');
        symlinkSync(fixture.dbPath, aliasPath);
        linkSync(fixture.dbPath, replacementTarget);
        const originalIdentity = statSync(replacementTarget);
        const lifecycle = databaseLifecyclePaths(fixture.dbPath);
        const exclusiveSource =
            kind === 'exclusive'
                ? `const { acquireExclusiveDatabaseLifecycle } = await import(${JSON.stringify(lifecycleModule)});
const lifecycle = await acquireExclusiveDatabaseLifecycle(${JSON.stringify(aliasPath)});`
                : '';
        const openOptions = kind === 'exclusive' ? '{ fileMustExist: true, lifecycle }' : '{ fileMustExist: true }';
        const source = `import { statSync } from 'node:fs';
const { openManagedDatabase } = await import(${JSON.stringify(dbModule)});
${exclusiveSource}
const database = await openManagedDatabase(${JSON.stringify(aliasPath)}, ${openOptions});
database.pragma('wal_autocheckpoint = 0');
const changes = database.prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
    .run('codex', ${JSON.stringify(`ack-in-killed-${kind}-symlink-wal`)}, '2026-09-04T00:00:00.000Z').changes;
process.send?.({ type: 'held', changes, walBytes: statSync(${JSON.stringify(`${fixture.dbPath}-wal`)}).size });
setInterval(() => void database, 1000);`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
            cwd: repositoryRoot,
            env: process.env,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });
        const observed = { child, stderr: () => stderr };
        let ownerFile: string | undefined;

        try {
            const write = await receiveChildMessage<{ type: 'held'; changes: number; walBytes: number }>(observed);
            const ownerDirectory = kind === 'shared' ? lifecycle.leases : lifecycle.exclusive;
            const owned = readdirSync(ownerDirectory)
                .map((entry) => path.join(ownerDirectory, entry))
                .map((file) => ({
                    file,
                    record: JSON.parse(readFileSync(file, 'utf8')) as {
                        pid?: number;
                        databasePath?: string;
                        databaseFilename?: string;
                    },
                }))
                .find(({ record }) => record.pid === child.pid && record.databasePath === path.resolve(aliasPath));
            ownerFile = owned?.file;
            expect(ownerFile).toBeDefined();
            expect(owned?.record.databaseFilename).toBe(realpathSync(aliasPath));
            await killOwner(child);

            let error: string | null = null;
            let installedAck: number | null = null;
            let physicalAck: number | null = null;
            let detached = false;
            try {
                const exclusive = await acquireExclusiveDatabaseLifecycle(replacementTarget);
                renameSync(replacement.dbPath, replacementTarget);
                exclusive.release();
                const currentIdentity = statSync(replacementTarget);
                detached = currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino;
                const countAck = (databasePath: string): number => {
                    const database = openUnmanagedDb(databasePath);
                    try {
                        return (
                            database
                                .prepare('SELECT COUNT(*) AS count FROM purged_transcripts WHERE native_id = ?')
                                .get(`ack-in-killed-${kind}-symlink-wal`) as { count: number }
                        ).count;
                    } finally {
                        database.close();
                    }
                };
                installedAck = countAck(replacementTarget);
                physicalAck = countAck(fixture.dbPath);
            } catch (caught) {
                error = caught instanceof Error ? caught.message : String(caught);
            }

            expect({ ...write, error, installedAck, physicalAck, detached }).toEqual({
                type: 'held',
                changes: 1,
                walBytes: 8_272,
                error: `${DATABASE_LIFECYCLE_AMBIGUOUS}: killed ${kind} database owner left ambiguous companion state for ${fixture.dbPath}`,
                installedAck: null,
                physicalAck: null,
                detached: false,
            });
        } finally {
            await killOwner(child);
            if (ownerFile !== undefined && existsSync(ownerFile)) {
                unlinkSync(ownerFile);
            }
        }
    });

    it('blocks replacement when a killed exclusive hard-link opener leaves an alias WAL', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-killed-exclusive-alias-wal-');
        const replacement = createTestDb('elepha-database-lifecycle-killed-exclusive-alias-wal-replacement-');
        fixture.close();
        replacement.close();
        const aliasPath = path.join(fixture.directory, 'killed-exclusive-alias.db');
        linkSync(fixture.dbPath, aliasPath);
        const originalIdentity = statSync(aliasPath);
        const lifecycle = databaseLifecyclePaths(fixture.dbPath);
        const source = `import { statSync } from 'node:fs';
const { acquireExclusiveDatabaseLifecycle } = await import(${JSON.stringify(lifecycleModule)});
const { openManagedDatabase } = await import(${JSON.stringify(dbModule)});
const lifecycle = await acquireExclusiveDatabaseLifecycle(${JSON.stringify(aliasPath)});
const database = await openManagedDatabase(${JSON.stringify(aliasPath)}, { fileMustExist: true, lifecycle });
database.pragma('wal_autocheckpoint = 0');
const changes = database.prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
    .run('codex', 'ack-in-killed-exclusive-alias-wal', '2026-09-04T00:00:00.000Z').changes;
process.send?.({ type: 'held', changes, walBytes: statSync(${JSON.stringify(`${aliasPath}-wal`)}).size });
setInterval(() => void database, 1000);`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
            cwd: repositoryRoot,
            env: process.env,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });
        const observed = { child, stderr: () => stderr };
        let ownerFile: string | undefined;

        try {
            const write = await receiveChildMessage<{ type: 'held'; changes: number; walBytes: number }>(observed);
            ownerFile = readdirSync(lifecycle.exclusive)
                .map((entry) => path.join(lifecycle.exclusive, entry))
                .find((file) => {
                    const record = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; databasePath?: string };
                    return record.pid === child.pid && record.databasePath === path.resolve(aliasPath);
                });
            expect(ownerFile).toBeDefined();
            await killOwner(child);

            let error: string | null = null;
            let canonicalAck: number | null = null;
            let aliasAck: number | null = null;
            let detached = false;
            try {
                const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
                renameSync(replacement.dbPath, fixture.dbPath);
                exclusive.release();
                const currentIdentity = statSync(fixture.dbPath);
                detached = currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino;
                const countAck = (databasePath: string): number => {
                    const database = openUnmanagedDb(databasePath);
                    try {
                        return (
                            database
                                .prepare(
                                    "SELECT COUNT(*) AS count FROM purged_transcripts WHERE native_id = 'ack-in-killed-exclusive-alias-wal'",
                                )
                                .get() as { count: number }
                        ).count;
                    } finally {
                        database.close();
                    }
                };
                canonicalAck = countAck(fixture.dbPath);
                aliasAck = countAck(aliasPath);
            } catch (caught) {
                error = caught instanceof Error ? caught.message : String(caught);
            }

            expect({ ...write, error, canonicalAck, aliasAck, detached }).toEqual({
                type: 'held',
                changes: 1,
                walBytes: 8_272,
                error: `${DATABASE_LIFECYCLE_AMBIGUOUS}: killed exclusive database owner left ambiguous companion state for ${aliasPath}`,
                canonicalAck: null,
                aliasAck: null,
                detached: false,
            });
        } finally {
            await killOwner(child);
            if (ownerFile !== undefined && existsSync(ownerFile)) {
                unlinkSync(ownerFile);
            }
        }
    });

    it('rejects a retired hard-link alias after successful canonical replacement', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-retired-hard-link-');
        const replacement = createTestDb('elepha-database-lifecycle-retired-hard-link-replacement-');
        fixture.close();
        replacement.close();
        const aliasPath = path.join(fixture.directory, 'daemon.db');
        linkSync(fixture.dbPath, aliasPath);
        const originalIdentity = statSync(aliasPath);
        const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
        renameSync(replacement.dbPath, fixture.dbPath);
        exclusive.release();

        await expect(
            openDb(aliasPath, { fileMustExist: true }).then((db) => {
                try {
                    return db
                        .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                        .run('codex', 'ack-on-retired-hard-link', '2026-09-04T00:00:00.000Z').changes;
                } finally {
                    db.close();
                }
            }),
        ).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
        const currentIdentity = statSync(fixture.dbPath);
        expect(currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino).toBe(true);
    });

    it('rejects a genuine retired alias when clock rollback made its recorded ctime older than its unchanged birthtime', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-retired-clock-rollback-');
        const replacement = createTestDb('elepha-database-lifecycle-retired-clock-rollback-replacement-');
        fixture.close();
        replacement.close();
        const aliasPath = path.join(fixture.directory, 'retired.db');
        linkSync(fixture.dbPath, aliasPath);
        const original = statSync(aliasPath, { bigint: true });
        const birthtime = 2_000_000_001n;
        let ctime = 1_000_000_001n;
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalFstatSync = mutableFs.fstatSync;
        mutableFs.fstatSync = ((descriptor, options) => {
            const state = originalFstatSync(descriptor, options as never);
            if (String(state.dev) !== String(original.dev) || String(state.ino) !== String(original.ino)) {
                return state;
            }
            return new Proxy(state, {
                get(target, property, receiver) {
                    if (property === 'birthtimeNs') {
                        return birthtime;
                    }
                    if (property === 'ctimeNs') {
                        return ctime;
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
        }) as typeof import('node:fs').fstatSync;
        syncBuiltinESMExports();

        try {
            const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
            renameSync(replacement.dbPath, fixture.dbPath);
            exclusive.release();
            const repointedPath = path.join(fixture.directory, 'repointed.db');
            linkSync(aliasPath, repointedPath);
            ctime = 3_000_000_001n;
            await expect(
                openManagedDatabase(repointedPath, { fileMustExist: true }).then((database) => {
                    try {
                        return database.prepare('SELECT 42 AS count').get();
                    } finally {
                        database.close();
                    }
                }),
            ).rejects.toThrow(`${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${repointedPath}`);
            const platform = Object.getOwnPropertyDescriptor(process, 'platform');
            if (platform === undefined) {
                throw new Error('process.platform descriptor is unavailable');
            }
            try {
                Object.defineProperty(process, 'platform', { value: 'linux' });
                expect(() => acquireSharedDatabaseLifecycle(repointedPath)).toThrow(
                    `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${repointedPath}`,
                );
            } finally {
                Object.defineProperty(process, 'platform', platform);
            }
        } finally {
            mutableFs.fstatSync = originalFstatSync;
            syncBuiltinESMExports();
        }
    });

    it.skipIf(process.platform !== 'darwin')('rejects a genuine retired alias after Darwin utimes changes its birthtime', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-retired-birthtime-change-');
        const replacement = createTestDb('elepha-database-lifecycle-retired-birthtime-change-replacement-');
        fixture.close();
        replacement.close();
        const aliasPath = path.join(fixture.directory, 'retired.db');
        linkSync(fixture.dbPath, aliasPath);
        const original = statSync(aliasPath, { bigint: true });
        const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
        renameSync(replacement.dbPath, fixture.dbPath);
        exclusive.release();
        const earlierTime = new Date('2000-01-01T00:00:00.000Z');
        utimesSync(aliasPath, earlierTime, earlierTime);
        const changed = statSync(aliasPath, { bigint: true });
        expect({ dev: changed.dev, ino: changed.ino }).toEqual({ dev: original.dev, ino: original.ino });
        expect(changed.birthtimeNs).toBeLessThan(original.birthtimeNs);
        await expect(openManagedDatabase(aliasPath, { fileMustExist: true })).rejects.toThrow(
            `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${aliasPath}`,
        );
    });

    it.each(['open', 'stat', 'close'] as const)(
        'treats ancestor probe %s failure as unproven birthtime, not a database failure',
        (failure) => {
            const fixture = createTestDb('elepha-database-lifecycle-birthtime-probe-failure-');
            fixture.close();
            const identity = statSync(fixture.dbPath, { bigint: true });
            const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
            const originalOpenSync = mutableFs.openSync;
            const originalFstatSync = mutableFs.fstatSync;
            const originalCloseSync = mutableFs.closeSync;
            const platform = Object.getOwnPropertyDescriptor(process, 'platform');
            if (platform === undefined) {
                throw new Error('process.platform descriptor is unavailable');
            }
            const retiredFile = path.join(
                databaseLifecyclePaths(fixture.dbPath).retired,
                `identity-${createHash('sha256').update(`${identity.dev}:${identity.ino}`).digest('hex')}`,
            );
            const previousRetired = existsSync(retiredFile) ? readFileSync(retiredFile) : undefined;
            const probeDescriptors = new Set<number>();
            let probeFailures = 0;
            let failDatabaseInspection = false;
            const probeError = Object.assign(new Error('forced ancestor probe failure'), { code: 'EACCES' });
            const databaseError = Object.assign(new Error('forced database inspection failure'), { code: 'EACCES' });
            mutableFs.openSync = ((filename, flags, mode) => {
                const isProbe =
                    filename === fixture.directory && typeof flags === 'number' && (flags & (fsConstants.O_DIRECTORY ?? 0)) !== 0;
                if (isProbe && failure === 'open') {
                    probeFailures++;
                    throw probeError;
                }
                const descriptor = originalOpenSync(filename, flags, mode);
                if (isProbe) probeDescriptors.add(descriptor);
                return descriptor;
            }) as typeof import('node:fs').openSync;
            mutableFs.fstatSync = ((descriptor, options) => {
                if (probeDescriptors.has(descriptor) && failure === 'stat') {
                    probeFailures++;
                    throw probeError;
                }
                const state = originalFstatSync(descriptor, options as never);
                if (String(state.dev) !== String(identity.dev) || String(state.ino) !== String(identity.ino)) {
                    return state;
                }
                if (failDatabaseInspection) throw databaseError;
                return new Proxy(state, {
                    get(target, property, receiver) {
                        return property === 'birthtimeNs'
                            ? Reflect.get(target, 'ctimeNs', receiver)
                            : Reflect.get(target, property, receiver);
                    },
                });
            }) as typeof import('node:fs').fstatSync;
            mutableFs.closeSync = ((descriptor) => {
                const isProbe = probeDescriptors.delete(descriptor);
                originalCloseSync(descriptor);
                if (isProbe && failure === 'close') {
                    probeFailures++;
                    throw probeError;
                }
            }) as typeof import('node:fs').closeSync;
            syncBuiltinESMExports();
            try {
                Object.defineProperty(process, 'platform', { value: 'linux' });
                if (previousRetired !== undefined) unlinkSync(retiredFile);
                const ordinary = acquireSharedDatabaseLifecycle(fixture.dbPath);
                ordinary.release();
                expect(probeFailures).toBeGreaterThan(0);
                expect([...probeDescriptors]).toEqual([]);
                writeFileSync(
                    retiredFile,
                    JSON.stringify({
                        version: 1,
                        databaseIdentity: {
                            exists: true,
                            dev: String(identity.dev),
                            ino: String(identity.ino),
                            birthtimeNs: String(identity.ctimeNs - 1n),
                            birthtimeProven: true,
                        },
                    }),
                );
                expect(() => acquireSharedDatabaseLifecycle(fixture.dbPath)).toThrow(
                    `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${fixture.dbPath}`,
                );
                expect([...probeDescriptors]).toEqual([]);
                failDatabaseInspection = true;
                expect(() => acquireSharedDatabaseLifecycle(fixture.dbPath)).toThrow(databaseError);
            } finally {
                Object.defineProperty(process, 'platform', platform);
                mutableFs.openSync = originalOpenSync;
                mutableFs.fstatSync = originalFstatSync;
                mutableFs.closeSync = originalCloseSync;
                syncBuiltinESMExports();
                for (const descriptor of probeDescriptors) originalCloseSync(descriptor);
                if (previousRetired !== undefined) {
                    writeFileSync(retiredFile, previousRetired);
                } else if (existsSync(retiredFile)) {
                    unlinkSync(retiredFile);
                }
            }
        },
    );

    it.each(['same-device', 'fallback', 'other-device'] as const)(
        'proves equal birthtime and ctime snapshots from Linux ancestors (%s)',
        async (proof) => {
            const supported = proof === 'same-device';
            const fixture = createTestDb('elepha-database-lifecycle-equal-birthtime-');
            const replacement = createTestDb('elepha-database-lifecycle-equal-birthtime-replacement-');
            const fresh = createTestDb('elepha-database-lifecycle-equal-birthtime-fresh-');
            fixture.close();
            replacement.close();
            fresh.close();
            const aliasPath = path.join(fixture.directory, 'retired.db');
            linkSync(fixture.dbPath, aliasPath);
            const retiredIdentity = statSync(aliasPath, { bigint: true });
            const freshIdentity = statSync(fresh.dbPath, { bigint: true });
            let retiredCtime = 2_000_000_001n;
            let ancestorSupport = proof !== 'fallback';
            let matchingDevice = proof !== 'other-device';
            const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
            const originalFstatSync = mutableFs.fstatSync;
            const originalLstatSync = mutableFs.lstatSync;
            const platform = Object.getOwnPropertyDescriptor(process, 'platform');
            if (platform === undefined) {
                throw new Error('process.platform descriptor is unavailable');
            }
            const presentSnapshot = <T extends ReturnType<typeof statSync>>(state: T): T => {
                if (state === undefined) {
                    return state;
                }
                const isFresh = String(state.dev) === String(freshIdentity.dev) && String(state.ino) === String(freshIdentity.ino);
                const isRetired = String(state.dev) === String(retiredIdentity.dev) && String(state.ino) === String(retiredIdentity.ino);
                return new Proxy(state, {
                    get(target, property, receiver) {
                        if (state.isDirectory() && property === 'dev' && !matchingDevice) {
                            return typeof state.dev === 'bigint' ? -1n : -1;
                        }
                        if (isFresh && (property === 'dev' || property === 'ino')) {
                            return typeof target[property] === 'bigint' ? retiredIdentity[property] : Number(retiredIdentity[property]);
                        }
                        if (property === 'birthtimeNs') {
                            if (isFresh) return 3_000_000_001n;
                            if (isRetired) return 2_000_000_001n;
                            if (state.isDirectory()) return ancestorSupport ? 1n : Reflect.get(target, 'ctimeNs', receiver);
                        }
                        if (property === 'ctimeNs') {
                            if (isFresh) return 3_000_000_001n;
                            if (isRetired) return retiredCtime;
                        }
                        return Reflect.get(target, property, receiver);
                    },
                });
            };
            mutableFs.fstatSync = ((descriptor, options) =>
                presentSnapshot(originalFstatSync(descriptor, options as never))) as typeof import('node:fs').fstatSync;
            mutableFs.lstatSync = ((filename, options) =>
                presentSnapshot(originalLstatSync(filename, options as never))) as typeof import('node:fs').lstatSync;
            syncBuiltinESMExports();
            try {
                Object.defineProperty(process, 'platform', { value: 'linux' });
                const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
                renameSync(replacement.dbPath, fixture.dbPath);
                exclusive.release();
                const retiredFile = path.join(
                    databaseLifecyclePaths(fixture.dbPath).retired,
                    `identity-${createHash('sha256').update(`${retiredIdentity.dev}:${retiredIdentity.ino}`).digest('hex')}`,
                );
                const retiredBytes = readFileSync(retiredFile);
                const retiredRecord = JSON.parse(retiredBytes.toString('utf8')) as {
                    databaseIdentity: { birthtimeProven?: boolean };
                };
                expect(retiredRecord.databaseIdentity.birthtimeProven).toBe(supported);
                retiredCtime = 4_000_000_001n;
                expect(() => acquireSharedDatabaseLifecycle(aliasPath)).toThrow(
                    `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${aliasPath}`,
                );
                if (supported) {
                    try {
                        writeFileSync(
                            retiredFile,
                            JSON.stringify({
                                ...retiredRecord,
                                databaseIdentity: { ...retiredRecord.databaseIdentity, birthtimeProven: 'true' },
                            }),
                        );
                        expect(() => acquireSharedDatabaseLifecycle(fresh.dbPath)).toThrow(
                            `${DATABASE_LIFECYCLE_AMBIGUOUS}: retired database identity is malformed: ${retiredFile}`,
                        );
                    } finally {
                        writeFileSync(retiredFile, retiredBytes);
                    }
                    const lease = acquireSharedDatabaseLifecycle(fresh.dbPath);
                    lease.release();
                    if (platform.value === 'linux') {
                        const opened = await openManagedDatabase(fresh.dbPath, { fileMustExist: true });
                        try {
                            expect(opened.prepare('SELECT 42 AS count').get()).toEqual({ count: 42 });
                        } finally {
                            opened.close();
                        }
                    }
                } else {
                    expect(() => acquireSharedDatabaseLifecycle(fresh.dbPath)).toThrow(
                        `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${fresh.dbPath}`,
                    );
                    ancestorSupport = true;
                    matchingDevice = true;
                    expect(() => acquireSharedDatabaseLifecycle(fresh.dbPath)).toThrow(
                        `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${fresh.dbPath}`,
                    );
                }
            } finally {
                Object.defineProperty(process, 'platform', platform);
                mutableFs.fstatSync = originalFstatSync;
                mutableFs.lstatSync = originalLstatSync;
                syncBuiltinESMExports();
            }
        },
    );

    it.each(['forward', 'backward'] as const)(
        'admits a new file generation reusing a retired device and inode on Linux with a %s clock, but rejects a repointed retired alias',
        async (clock) => {
            const fixture = createTestDb('elepha-database-lifecycle-inode-generation-');
            const replacement = createTestDb('elepha-database-lifecycle-inode-generation-replacement-');
            const fresh = createTestDb('elepha-database-lifecycle-inode-generation-fresh-');
            fixture.close();
            replacement.close();
            fresh.close();
            const aliasPath = path.join(fixture.directory, 'retired.db');
            linkSync(fixture.dbPath, aliasPath);
            const retiredIdentity = statSync(aliasPath, { bigint: true });
            const freshIdentity = statSync(fresh.dbPath, { bigint: true });
            const retirementPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
            if (retirementPlatform === undefined) {
                throw new Error('process.platform descriptor is unavailable');
            }
            try {
                Object.defineProperty(process, 'platform', { value: 'linux' });
                const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
                renameSync(replacement.dbPath, fixture.dbPath);
                exclusive.release();
            } finally {
                Object.defineProperty(process, 'platform', retirementPlatform);
            }
            const repointedPath = path.join(fresh.directory, 'repointed.db');
            linkSync(aliasPath, repointedPath);

            const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
            const originalFstatSync = mutableFs.fstatSync;
            const originalLstatSync = mutableFs.lstatSync;
            const laterBirthtime =
                clock === 'forward' ? retiredIdentity.ctimeNs + 1_000_000_000n : retiredIdentity.birthtimeNs - 1_000_000_000n;
            const laterCtime = laterBirthtime + 1_000_000n;
            let birthtimeEvidence: 'supported' | 'zero' | 'ctime' = 'supported';
            const presentGeneration = <T extends ReturnType<typeof statSync>>(state: T): T => {
                if (state === undefined) {
                    return state;
                }
                const isFresh = String(state.dev) === String(freshIdentity.dev) && String(state.ino) === String(freshIdentity.ino);
                const isRetired = String(state.dev) === String(retiredIdentity.dev) && String(state.ino) === String(retiredIdentity.ino);
                const isAncestor = state.isDirectory();
                if (!isFresh && !isRetired && !isAncestor) {
                    return state;
                }
                return new Proxy(state, {
                    get(target, property, receiver) {
                        if (isFresh && (property === 'dev' || property === 'ino')) {
                            return typeof target[property] === 'bigint' ? retiredIdentity[property] : Number(retiredIdentity[property]);
                        }
                        if (isFresh && property === 'birthtimeNs') {
                            return birthtimeEvidence === 'zero' ? 0n : birthtimeEvidence === 'ctime' ? laterCtime : laterBirthtime;
                        }
                        if (isAncestor && property === 'birthtimeNs' && birthtimeEvidence !== 'supported') {
                            return birthtimeEvidence === 'zero' ? 0n : Reflect.get(target, 'ctimeNs', receiver);
                        }
                        if (!isAncestor && property === 'ctimeNs') {
                            return laterCtime;
                        }
                        return Reflect.get(target, property, receiver);
                    },
                });
            };
            mutableFs.fstatSync = ((descriptor, options) =>
                presentGeneration(originalFstatSync(descriptor, options as never))) as typeof import('node:fs').fstatSync;
            mutableFs.lstatSync = ((filename, options) =>
                presentGeneration(originalLstatSync(filename, options as never))) as typeof import('node:fs').lstatSync;
            syncBuiltinESMExports();

            const platform = Object.getOwnPropertyDescriptor(process, 'platform');
            if (platform === undefined) {
                throw new Error('process.platform descriptor is unavailable');
            }
            try {
                Object.defineProperty(process, 'platform', { value: 'linux' });
                const retiredFile = path.join(
                    databaseLifecyclePaths(fixture.dbPath).retired,
                    `identity-${createHash('sha256').update(`${retiredIdentity.dev}:${retiredIdentity.ino}`).digest('hex')}`,
                );
                const retiredRecord = readFileSync(retiredFile);
                const legacyIdentity = { exists: true, dev: String(retiredIdentity.dev), ino: String(retiredIdentity.ino) };
                try {
                    for (const databaseIdentity of [
                        legacyIdentity,
                        { ...legacyIdentity, ctimeNs: String(retiredIdentity.ctimeNs), birthtimeNs: '0' },
                        { ...legacyIdentity, ctimeNs: String(retiredIdentity.ctimeNs), birthtimeNs: String(retiredIdentity.ctimeNs) },
                    ]) {
                        birthtimeEvidence = !('birthtimeNs' in databaseIdentity)
                            ? 'supported'
                            : databaseIdentity.birthtimeNs === '0'
                              ? 'zero'
                              : 'ctime';
                        writeFileSync(retiredFile, `${JSON.stringify({ version: 1, databaseIdentity })}\n`);
                        expect(() => acquireSharedDatabaseLifecycle(fresh.dbPath)).toThrow(
                            `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${fresh.dbPath}`,
                        );
                    }
                } finally {
                    writeFileSync(retiredFile, retiredRecord);
                    birthtimeEvidence = 'supported';
                }
                for (const evidence of ['zero', 'ctime'] as const) {
                    birthtimeEvidence = evidence;
                    expect(() => acquireSharedDatabaseLifecycle(fresh.dbPath)).toThrow(
                        `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${fresh.dbPath}`,
                    );
                }
                birthtimeEvidence = 'supported';
                const freshLease = acquireSharedDatabaseLifecycle(fresh.dbPath);
                freshLease.release();
                if (platform.value === 'linux') {
                    const reopened = await openManagedDatabase(fresh.dbPath, { fileMustExist: true });
                    try {
                        expect(reopened.prepare('SELECT count(*) AS count FROM sqlite_master').get()).toEqual({
                            count: expect.any(Number),
                        });
                    } finally {
                        reopened.close();
                    }
                } else {
                    Object.defineProperty(process, 'platform', platform);
                    await expect(openManagedDatabase(fresh.dbPath, { fileMustExist: true })).rejects.toThrow(
                        `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${fresh.dbPath}`,
                    );
                    Object.defineProperty(process, 'platform', { value: 'linux' });
                }
                expect(() => acquireSharedDatabaseLifecycle(repointedPath)).toThrow(
                    `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${repointedPath}`,
                );
                const reusedAliasPath = path.join(fresh.directory, 'reused.db');
                linkSync(fresh.dbPath, reusedAliasPath);
                const reusedExclusive = await acquireExclusiveDatabaseLifecycle(fresh.dbPath);
                renameSync(fixture.dbPath, fresh.dbPath);
                reusedExclusive.release();
                expect(() => acquireSharedDatabaseLifecycle(reusedAliasPath)).toThrow(
                    `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path names a retired inode: ${reusedAliasPath}`,
                );
            } finally {
                Object.defineProperty(process, 'platform', platform);
                mutableFs.fstatSync = originalFstatSync;
                mutableFs.lstatSync = originalLstatSync;
                syncBuiltinESMExports();
            }
        },
    );

    it('rejects a retired hard-link alias from a different physical directory', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-cross-directory-');
        const replacement = createTestDb('elepha-database-lifecycle-cross-directory-replacement-');
        const aliasDirectory = withGrantableTestDir('elepha-database-lifecycle-cross-directory-alias-');
        fixture.close();
        replacement.close();
        const aliasPath = path.join(aliasDirectory, 'daemon.db');
        linkSync(fixture.dbPath, aliasPath);
        const originalIdentity = statSync(aliasPath);
        const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
        renameSync(replacement.dbPath, fixture.dbPath);
        exclusive.release();

        await expect(
            openManagedDatabase(aliasPath, { fileMustExist: true }).then((db) => {
                try {
                    return db
                        .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                        .run('codex', 'ack-on-cross-directory-hard-link', '2026-09-04T00:00:00.000Z').changes;
                } finally {
                    db.close();
                }
            }),
        ).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
        const currentIdentity = statSync(fixture.dbPath);
        expect(currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino).toBe(true);
    });

    it('coordinates one database across independent ELEPHA_HOME values', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-cross-home-');
        const replacement = createTestDb('elepha-database-lifecycle-cross-home-replacement-');
        const homeA = withGrantableTestDir('elepha-database-lifecycle-home-a-');
        const homeB = withGrantableTestDir('elepha-database-lifecycle-home-b-');
        fixture.close();
        replacement.close();
        const originalIdentity = statSync(fixture.dbPath);
        const originalHome = process.env.ELEPHA_HOME;
        let opener: Awaited<ReturnType<typeof openManagedDatabase>> | undefined;
        let exclusivePromise: ReturnType<typeof acquireExclusiveDatabaseLifecycle> | undefined;
        let exclusiveSettled = false;
        let detachedWriteAcknowledged = false;

        try {
            process.env.ELEPHA_HOME = homeB;
            opener = await openManagedDatabase(fixture.dbPath, { fileMustExist: true });
            process.env.ELEPHA_HOME = homeA;
            exclusivePromise = acquireExclusiveDatabaseLifecycle(fixture.dbPath).then((lease) => {
                exclusiveSettled = true;
                return lease;
            });
            await waitFor(() => hasLifecycleIntent(fixture.dbPath));
            await new Promise((resolve) => setImmediate(resolve));

            if (exclusiveSettled) {
                renameSync(replacement.dbPath, fixture.dbPath);
                const result = opener
                    .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                    .run('codex', 'ack-from-other-home', '2026-09-04T00:00:00.000Z');
                const currentIdentity = statSync(fixture.dbPath);
                detachedWriteAcknowledged =
                    result.changes === 1 && (currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino);
            }
            expect(exclusiveSettled).toBe(false);
            expect(detachedWriteAcknowledged).toBe(false);
        } finally {
            opener?.close();
            if (exclusivePromise !== undefined) {
                const exclusive = await exclusivePromise;
                exclusive.release();
            }
            if (originalHome === undefined) {
                delete process.env.ELEPHA_HOME;
            } else {
                process.env.ELEPHA_HOME = originalHome;
            }
        }
    });

    it('coordinates one OS user across child processes with different HOME values', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-process-home-');
        const replacement = createTestDb('elepha-database-lifecycle-process-home-replacement-');
        const openerHome = withGrantableTestDir('elepha-database-lifecycle-process-home-a-');
        const replacerHome = withGrantableTestDir('elepha-database-lifecycle-process-home-b-');
        const stableOsHome = withGrantableTestDir('elepha-database-lifecycle-os-user-home-');
        fixture.db
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', 'old-row', '2026-09-04T00:00:00.000Z');
        replacement.db
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', 'replacement-row', '2026-09-04T00:00:00.000Z');
        fixture.close();
        replacement.close();

        const osUserInfoPrelude = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const mutableOs = createRequire(import.meta.url)('node:os');
const actualUser = mutableOs.userInfo();
mutableOs.userInfo = () => ({ ...actualUser, homedir: ${JSON.stringify(stableOsHome)} });
syncBuiltinESMExports();`;
        const openerSource = `${osUserInfoPrelude}
import { readdirSync, statSync } from 'node:fs';
const { openManagedDatabase } = await import(${JSON.stringify(dbModule)});
const { databaseLifecyclePaths } = await import(${JSON.stringify(lifecycleModule)});
const databasePath = ${JSON.stringify(fixture.dbPath)};
const database = await openManagedDatabase(databasePath, { fileMustExist: true });
const original = statSync(databasePath);
process.send?.({ type: 'held' });
if ((await new Promise((resolve) => process.once('message', resolve))) !== 'probe') throw new Error('Expected probe command.');
process.send?.({ type: 'probe', seesExclusive: readdirSync(databaseLifecyclePaths(databasePath).exclusive).length > 0 });
const action = await new Promise((resolve) => process.once('message', resolve));
let result = { type: 'closed', changes: 0, detachedAtWrite: false };
if (action === 'write') {
    const current = statSync(databasePath);
    const changes = database.prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
        .run('codex', 'ack-after-home-split', '2026-09-04T00:00:00.000Z').changes;
    result = { type: 'closed', changes, detachedAtWrite: current.dev !== original.dev || current.ino !== original.ino };
} else if (action !== 'close') {
    throw new Error('Expected write or close command.');
}
database.close();
await new Promise((resolve, reject) => process.send?.(result, (error) => error ? reject(error) : resolve()));
process.disconnect();`;
        const replacerSource = `${osUserInfoPrelude}
import { renameSync, unlinkSync } from 'node:fs';
const { acquireExclusiveDatabaseLifecycle } = await import(${JSON.stringify(lifecycleModule)});
const databasePath = ${JSON.stringify(fixture.dbPath)};
const acquisition = acquireExclusiveDatabaseLifecycle(databasePath);
process.send?.({ type: 'intent-published' });
if ((await new Promise((resolve) => process.once('message', resolve))) !== 'continue') throw new Error('Expected continue command.');
const lifecycle = await acquisition;
renameSync(${JSON.stringify(replacement.dbPath)}, databasePath);
for (const suffix of ['-wal', '-shm', '-journal']) {
    try { unlinkSync(databasePath + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
lifecycle.release();
await new Promise((resolve, reject) => process.send?.({ type: 'installed' }, (error) => error ? reject(error) : resolve()));
process.disconnect();`;

        let opener: ObservedChild | undefined;
        let replacer: ObservedChild | undefined;
        try {
            opener = spawnWithoutLifecycleTestPreload(openerSource, openerHome);
            expect(await receiveChildMessage(opener)).toEqual({ type: 'held' });
            replacer = spawnWithoutLifecycleTestPreload(replacerSource, replacerHome);
            expect(await receiveChildMessage(replacer)).toEqual({ type: 'intent-published' });

            const probePromise = receiveChildMessage<{ type: 'probe'; seesExclusive: boolean }>(opener);
            sendChildMessage(opener, 'probe');
            const probe = await probePromise;
            let writeResult: { type: 'closed'; changes: number; detachedAtWrite: boolean } | undefined;
            const drainBeforeInstall = probe.seesExclusive;
            if (drainBeforeInstall) {
                const closePromise = receiveChildMessage<typeof writeResult>(opener);
                sendChildMessage(opener, 'close');
                writeResult = await closePromise;
            }

            const installedPromise = receiveChildMessage<{ type: 'installed' }>(replacer);
            sendChildMessage(replacer, 'continue');
            await installedPromise;

            if (!drainBeforeInstall) {
                const writePromise = receiveChildMessage<typeof writeResult>(opener);
                sendChildMessage(opener, 'write');
                writeResult = await writePromise;
            }
            if (writeResult === undefined) {
                throw new Error('Lifecycle opener did not report its close result.');
            }

            const installed = openUnmanagedDb(fixture.dbPath);
            try {
                const installedAckRows = (
                    installed
                        .prepare("SELECT COUNT(*) AS count FROM purged_transcripts WHERE native_id = 'ack-after-home-split'")
                        .get() as {
                        count: number;
                    }
                ).count;
                const installedReplacementRows = (
                    installed.prepare("SELECT COUNT(*) AS count FROM purged_transcripts WHERE native_id = 'replacement-row'").get() as {
                        count: number;
                    }
                ).count;
                expect({
                    openerSawExclusiveIntent: probe.seesExclusive,
                    acknowledgedChanges: writeResult.changes,
                    detachedAtWrite: writeResult.detachedAtWrite,
                    installedAckRows,
                    installedReplacementRows,
                }).toEqual({
                    openerSawExclusiveIntent: true,
                    acknowledgedChanges: 0,
                    detachedAtWrite: false,
                    installedAckRows: 0,
                    installedReplacementRows: 1,
                });
            } finally {
                installed.close();
            }
        } finally {
            if (opener !== undefined) await killOwner(opener.child);
            if (replacer !== undefined) await killOwner(replacer.child);
        }
    });

    it('fails closed before database access when the OS user home lookup fails', async () => {
        const directory = withGrantableTestDir('elepha-database-lifecycle-user-lookup-failure-');
        const childHome = withGrantableTestDir('elepha-database-lifecycle-user-lookup-child-home-');
        const databasePath = path.join(directory, 'must-not-exist.db');
        const source = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const mutableOs = createRequire(import.meta.url)('node:os');
mutableOs.userInfo = () => { throw new Error('simulated OS account lookup failure'); };
syncBuiltinESMExports();
let message;
try {
    const { openManagedDatabase } = await import(${JSON.stringify(dbModule)});
    const database = await openManagedDatabase(${JSON.stringify(databasePath)});
    database.close();
    message = 'unexpected success';
} catch (error) {
    message = error instanceof Error ? error.message : String(error);
}
await new Promise((resolve, reject) => process.send?.({ type: 'result', message }, (error) => error ? reject(error) : resolve()));
process.disconnect();`;
        const child = spawnWithoutLifecycleTestPreload(source, childHome);
        try {
            await expect(receiveChildMessage(child)).resolves.toEqual({
                type: 'result',
                message: `${DATABASE_LIFECYCLE_AMBIGUOUS}: operating-system user home cannot be resolved`,
            });
            expect(existsSync(databasePath)).toBe(false);
        } finally {
            await killOwner(child.child);
        }
    });

    it.each(['openManagedDatabase', 'openDb'] as const)('pins a relative path through awaited key retrieval in %s', async (openKind) => {
        const safeDirectory = withGrantableTestDir(`elepha-database-lifecycle-relative-safe-${openKind}-`);
        const retiredDirectory = withGrantableTestDir(`elepha-database-lifecycle-relative-retired-${openKind}-`);
        const safePath = path.join(safeDirectory, 'relative.db');
        const canonicalPath = path.join(retiredDirectory, 'canonical.db');
        const retiredAliasPath = path.join(retiredDirectory, 'relative.db');
        const replacementPath = path.join(retiredDirectory, 'replacement.db');
        const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
        const runtime: DatabaseEncryptionRuntime = {
            platform: 'darwin',
            randomBytes: () => Buffer.from(key),
            randomUUID: () => '22222222-2222-4222-8222-222222222222',
            createKeyringEntry: async () => ({
                getSecret: async () => Buffer.from(key),
                setSecret: async () => undefined,
                deleteCredential: async () => true,
            }),
        };
        const seed = async (databasePath: string, nativeId: string) => {
            const database = await openDb(databasePath, { encryption: runtime });
            database
                .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                .run('codex', nativeId, '2026-09-04T00:00:00.000Z');
            database.close();
        };
        const nativeIds = (databasePath: string): string[] => {
            const database = openKeyedDatabase(databasePath, Buffer.from(key), { fileMustExist: true });
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

        await seed(safePath, 'safe');
        await seed(canonicalPath, 'old');
        await seed(replacementPath, 'new');
        linkSync(canonicalPath, retiredAliasPath);
        const exclusive = await acquireExclusiveDatabaseLifecycle(canonicalPath);
        renameSync(replacementPath, canonicalPath);
        exclusive.release();

        const originalCwd = process.cwd();
        let changes: number;
        try {
            process.chdir(safeDirectory);
            const changingRuntime: DatabaseEncryptionRuntime = {
                ...runtime,
                createKeyringEntry: async () => ({
                    getSecret: async () => {
                        process.chdir(retiredDirectory);
                        return Buffer.from(key);
                    },
                    setSecret: async () => undefined,
                    deleteCredential: async () => true,
                }),
            };
            const database =
                openKind === 'openManagedDatabase'
                    ? await openManagedDatabase('relative.db', { fileMustExist: true, encryption: changingRuntime })
                    : await openDb('relative.db', { fileMustExist: true, encryption: changingRuntime });
            try {
                changes = database
                    .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                    .run('codex', 'acknowledged', '2026-09-04T00:00:00.000Z').changes;
            } finally {
                database.close();
            }
        } finally {
            process.chdir(originalCwd);
        }

        expect({
            changes,
            safe: nativeIds(safePath),
            canonical: nativeIds(canonicalPath),
            retired: nativeIds(retiredAliasPath),
        }).toEqual({
            changes: 1,
            safe: ['acknowledged', 'safe'],
            canonical: ['new'],
            retired: ['old'],
        });
    });

    it('rejects a pathname retargeted to a retired inode while database key retrieval is pending', async () => {
        const safeDirectory = withGrantableTestDir('elepha-database-lifecycle-open-identity-safe-');
        const retiredDirectory = withGrantableTestDir('elepha-database-lifecycle-open-identity-retired-');
        const databasePath = path.join(safeDirectory, 'mutable.db');
        const safeAliasPath = path.join(safeDirectory, 'safe.db');
        const canonicalPath = path.join(retiredDirectory, 'canonical.db');
        const retiredAliasPath = path.join(retiredDirectory, 'retired.db');
        const replacementPath = path.join(retiredDirectory, 'replacement.db');
        const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
        const runtime: DatabaseEncryptionRuntime = {
            platform: 'darwin',
            randomBytes: () => Buffer.from(key),
            randomUUID: () => '33333333-3333-4333-8333-333333333333',
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
        let swapped = false;
        let changes = 0;
        let error: string | null = null;
        const swappingRuntime: DatabaseEncryptionRuntime = {
            ...runtime,
            createKeyringEntry: async () => ({
                getSecret: async () => {
                    unlinkSync(databasePath);
                    linkSync(retiredAliasPath, databasePath);
                    swapped = true;
                    return Buffer.from(key);
                },
                setSecret: async () => undefined,
                deleteCredential: async () => true,
            }),
        };

        try {
            const database = await openManagedDatabase(databasePath, {
                fileMustExist: true,
                encryption: swappingRuntime,
            });
            try {
                changes = database
                    .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                    .run('codex', 'ack-retired', '2026-09-04T00:00:00.000Z').changes;
            } finally {
                database.close();
            }
        } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
        }

        const currentIdentity = statSync(databasePath);
        expect({
            swapped,
            changes,
            error,
            retired: nativeIds(retiredAliasPath),
            safe: nativeIds(safeAliasPath),
            detached:
                currentIdentity.dev === retiredIdentity.dev &&
                currentIdentity.ino === retiredIdentity.ino &&
                (currentIdentity.dev !== safeIdentity.dev || currentIdentity.ino !== safeIdentity.ino),
        }).toEqual({
            swapped: true,
            changes: 0,
            error: `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database identity changed while opening ${databasePath}`,
            retired: ['old'],
            safe: ['safe'],
            detached: true,
        });
    });

    it('revalidates an acquiring owner after liveness before reclaiming it', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-stale-acquiring-');
        const replacement = createTestDb('elepha-database-lifecycle-stale-acquiring-replacement-');
        fixture.close();
        replacement.close();
        const aliasPath = path.join(fixture.directory, 'stale-opener.db');
        linkSync(fixture.dbPath, aliasPath);
        const originalIdentity = statSync(fixture.dbPath);
        const seeded = acquireSharedDatabaseLifecycle(fixture.dbPath);
        seeded.release();
        const pid = 2_147_483_647;
        const acquiringOwner = {
            version: 1,
            kind: 'exclusive',
            pid,
            ownerId: '11111111-1111-4111-8111-111111111111',
            databasePath: path.resolve(fixture.dbPath),
            databaseFilename: null,
            phase: 'acquiring',
            databaseIdentity: null,
        } as const;
        const acquiringOwnerFile = writeLifecycleIntent(fixture.dbPath, acquiringOwner);
        const originalKill = process.kill;
        let interleavingReached = false;
        process.kill = ((ownerPid, signal) => {
            if (ownerPid !== pid || signal !== 0) {
                return originalKill(ownerPid, signal);
            }
            if (interleavingReached) {
                const error = new Error('exclusive owner remains exited') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            writeFileSync(
                acquiringOwnerFile,
                `${JSON.stringify({
                    ...acquiringOwner,
                    phase: 'held',
                    databaseFilename: path.resolve(fixture.dbPath),
                    databaseIdentity: { exists: true, dev: String(originalIdentity.dev), ino: String(originalIdentity.ino) },
                })}\n`,
            );
            renameSync(replacement.dbPath, fixture.dbPath);
            interleavingReached = true;
            const error = new Error('exclusive owner exited') as NodeJS.ErrnoException;
            error.code = 'ESRCH';
            throw error;
        }) as typeof process.kill;

        try {
            await expect(
                openManagedDatabase(aliasPath, { fileMustExist: true }).then((db) => {
                    try {
                        return db
                            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                            .run('codex', 'ack-after-stale-acquiring-read', '2026-09-04T00:00:00.000Z').changes;
                    } finally {
                        db.close();
                    }
                }),
            ).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
            expect(interleavingReached).toBe(true);
            expect(existsSync(acquiringOwnerFile)).toBe(true);
        } finally {
            process.kill = originalKill;
            removeLifecycleIntents(fixture.dbPath);
        }
    });

    it('publishes exclusive intent before draining existing leases and blocks later openers', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-order-');
        fixture.close();
        const first = await openManagedDatabase(fixture.dbPath, { fileMustExist: true });
        const paths = databaseLifecyclePaths(fixture.dbPath);
        const exclusivePromise = acquireExclusiveDatabaseLifecycle(fixture.dbPath);
        await waitFor(() => hasLifecycleIntent(fixture.dbPath));

        await expect(openManagedDatabase(fixture.dbPath, { fileMustExist: true })).rejects.toThrow(DATABASE_LIFECYCLE_BUSY);
        expect(readdirSync(paths.leases)).toHaveLength(1);
        first.close();
        const exclusive = await exclusivePromise;
        await expect(openManagedDatabase(fixture.dbPath, { readonly: true, fileMustExist: true })).rejects.toThrow(DATABASE_LIFECYCLE_BUSY);

        exclusive.release();
        const reopened = await openManagedDatabase(fixture.dbPath, { fileMustExist: true });
        reopened.close();
    });

    it('releases exclusive intent when live shared owners exceed the acquisition timeout', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-timeout-cleanup-');
        fixture.close();
        const shared = await openManagedDatabase(fixture.dbPath, { fileMustExist: true });
        const paths = databaseLifecyclePaths(fixture.dbPath);
        vi.useFakeTimers();
        try {
            const exclusivePromise = acquireExclusiveDatabaseLifecycle(fixture.dbPath);
            const rejection = expect(exclusivePromise).rejects.toThrow(
                `${DATABASE_LIFECYCLE_BUSY}: managed database connections did not close for ${path.resolve(fixture.dbPath)}`,
            );
            expect(hasLifecycleIntent(fixture.dbPath)).toBe(true);

            await vi.advanceTimersByTimeAsync(DATABASE_LIFECYCLE_ACQUIRE_TIMEOUT_MS);

            await rejection;
            expect(hasLifecycleIntent(fixture.dbPath)).toBe(false);
            expect(readdirSync(paths.leases)).toHaveLength(1);
        } finally {
            vi.useRealTimers();
            shared.close();
        }
    });

    it('blocks a later opener before it can create or inspect database bytes', async () => {
        const directory = withGrantableTestDir('elepha-database-lifecycle-before-open-');
        const databasePath = path.join(directory, 'not-created.db');
        const exclusive = await acquireExclusiveDatabaseLifecycle(databasePath);
        try {
            await expect(openManagedDatabase(databasePath)).rejects.toThrow(DATABASE_LIFECYCLE_BUSY);
            expect(existsSync(databasePath)).toBe(false);
        } finally {
            exclusive.release();
        }
    });

    it('creates a first-run managed database below a missing nested parent', async () => {
        const directory = withGrantableTestDir('elepha-database-lifecycle-first-run-parent-');
        const databasePath = path.join(directory, 'missing', 'nested', 'elepha.db');
        const key = Buffer.alloc(32, 7);
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

        expect(existsSync(path.dirname(databasePath))).toBe(false);
        const database = await openManagedDatabase(databasePath, { encryption: runtime });
        database.close();

        expect(existsSync(databasePath)).toBe(true);
    });

    it('releases a shared lease when database initialization fails', async () => {
        const directory = withGrantableTestDir('elepha-database-lifecycle-init-failure-');
        const databasePath = path.join(directory, 'invalid.db');
        writeFileSync(databasePath, Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(128)]));

        await expect(openManagedDatabase(databasePath, { fileMustExist: true })).rejects.toThrow();
        const exclusive = await acquireExclusiveDatabaseLifecycle(databasePath);
        exclusive.release();
    });

    it('retains exclusive ownership when a managed SQLite close fails', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-exclusive-close-failure-');
        fixture.close();
        let database: Awaited<ReturnType<typeof openManagedDatabase>> | undefined;
        let iterator: IterableIterator<unknown> | undefined;
        try {
            await expect(
                withExclusiveDatabaseLifecycle(fixture.dbPath, async (lease) => {
                    const opened = await openManagedDatabase(fixture.dbPath, { fileMustExist: true, lifecycle: lease });
                    const rows = opened.prepare('SELECT 1 AS value UNION ALL SELECT 2').iterate();
                    database = opened;
                    iterator = rows;
                    rows.next();
                    opened.close();
                }),
            ).rejects.toThrow(`Exclusive database lifecycle operation and release both failed for ${fixture.dbPath}`);

            expect(hasLifecycleIntent(fixture.dbPath)).toBe(true);
            expect(() => acquireSharedDatabaseLifecycle(fixture.dbPath)).toThrow(DATABASE_LIFECYCLE_BUSY);
            await expect(acquireExclusiveDatabaseLifecycle(fixture.dbPath)).rejects.toThrow(DATABASE_LIFECYCLE_BUSY);

            if (iterator === undefined || database === undefined) {
                throw new Error('managed database close failure was not reached');
            }
            iterator.return?.();
            database.close();
            expect(hasLifecycleIntent(fixture.dbPath)).toBe(true);
        } finally {
            iterator?.return?.();
            if (database?.open) {
                database.close();
            }
            removeLifecycleIntents(fixture.dbPath);
        }
    });

    it('retains the live writer and lease when its close checkpoint is blocked by a reader', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-closed-reader-');
        fixture.close();
        const writer = await openManagedDatabase(fixture.dbPath, { fileMustExist: true });
        const reader = await openManagedDatabase(fixture.dbPath, { readonly: true, fileMustExist: true });
        try {
            writer.pragma('wal_autocheckpoint = 0');
            reader.exec('BEGIN');
            reader.prepare('SELECT COUNT(*) FROM purged_transcripts').get();
            writer.prepare('INSERT INTO purged_transcripts VALUES (?, ?, ?)').run('codex', 'closed-reader-tombstone', 'now');
            expect(() => writer.close()).toThrow(DATABASE_LIFECYCLE_BUSY);
            expect(writer.open).toBe(true);
            const paths = databaseLifecyclePaths(fixture.dbPath);
            const held = readdirSync(paths.leases)
                .map((entry) => JSON.parse(readFileSync(path.join(paths.leases, entry), 'utf8')))
                .filter((record) => record.databasePath === fixture.dbPath);
            expect(held).toHaveLength(2);
            expect(held[0]).toMatchObject({ pid: process.pid, phase: 'shared', databaseFilename: realpathSync(fixture.dbPath) });
            reader.close();
            writer.close();
            const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
            exclusive.release();
            expect(readdirSync(paths.leases)).toEqual([]);
            const reopened = await openManagedDatabase(fixture.dbPath, { fileMustExist: true });
            expect(reopened.prepare('SELECT native_id FROM purged_transcripts').all()).toEqual([{ native_id: 'closed-reader-tombstone' }]);
            reopened.close();
        } finally {
            reader.close();
            writer.close();
        }
    });

    it('retains exclusive alias ownership until the native close checkpoint can complete', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-exclusive-closed-wal-');
        fixture.close();
        const aliasPath = path.join(fixture.directory, 'alias.db');
        linkSync(fixture.dbPath, aliasPath);
        const reader = openUnmanagedDb(fixture.dbPath);
        const exclusive = await acquireExclusiveDatabaseLifecycle(aliasPath);
        const writer = await openManagedDatabase(aliasPath, { fileMustExist: true, lifecycle: exclusive });
        try {
            reader.exec('BEGIN');
            reader.prepare('SELECT COUNT(*) FROM purged_transcripts').get();
            writer.pragma('wal_autocheckpoint = 0');
            writer.prepare('INSERT INTO purged_transcripts VALUES (?, ?, ?)').run('codex', 'exclusive-closed-tombstone', 'now');
            expect(() => writer.close()).toThrow(DATABASE_LIFECYCLE_BUSY);
            expect(writer.open).toBe(true);
            expect(statSync(`${aliasPath}-wal`).size).toBeGreaterThan(0);
            expect(() => exclusive.beginReplacement()).toThrow(DATABASE_LIFECYCLE_BUSY);
            expect(() => exclusive.release()).toThrow(DATABASE_LIFECYCLE_BUSY);
            reader.close();
            writer.close();
            const recovery = openUnmanagedDb(fixture.dbPath);
            expect(recovery.prepare('SELECT native_id FROM purged_transcripts').all()).toEqual([
                { native_id: 'exclusive-closed-tombstone' },
            ]);
            recovery.close();
            exclusive.beginReplacement();
            exclusive.assertReplacementReady();
            exclusive.completeReplacement();
            exclusive.release();
            expect(hasLifecycleIntent(aliasPath)).toBe(false);
        } finally {
            reader.close();
            writer.close();
            removeLifecycleIntents(aliasPath);
        }
    });

    it.each(['shared', 'exclusive'] as const)('retains %s ownership across checkpoint errors and invalid results', async (kind) => {
        const fixture = createTestDb(`elepha-database-lifecycle-checkpoint-failure-${kind}-`);
        fixture.close();
        const exclusive = kind === 'exclusive' ? await acquireExclusiveDatabaseLifecycle(fixture.dbPath) : undefined;
        const database = await openManagedDatabase(fixture.dbPath, { fileMustExist: true, lifecycle: exclusive });
        database.prepare('INSERT INTO purged_transcripts VALUES (?, ?, ?)').run('codex', 'checkpoint-retry', 'now');
        try {
            const pragma = vi.spyOn(database, 'pragma');
            try {
                for (const result of [[], [{ busy: 1, log: 1, checkpointed: 0 }], [{ busy: 0, log: 2, checkpointed: 1 }]]) {
                    pragma.mockReturnValueOnce(result);
                    expect(() => database.close()).toThrow(DATABASE_LIFECYCLE_BUSY);
                    expect(database.open).toBe(true);
                }
                pragma.mockImplementationOnce(() => {
                    throw new Error('checkpoint I/O failure');
                });
                expect(() => database.close()).toThrow('checkpoint I/O failure');
                expect(database.open).toBe(true);
                if (exclusive !== undefined) {
                    expect(() => exclusive.beginReplacement()).toThrow(DATABASE_LIFECYCLE_BUSY);
                    expect(() => exclusive.release()).toThrow(DATABASE_LIFECYCLE_BUSY);
                } else {
                    expect(readdirSync(databaseLifecyclePaths(fixture.dbPath).leases)).toHaveLength(1);
                }
            } finally {
                pragma.mockRestore();
            }
        } finally {
            database.close();
            exclusive?.release();
        }
        const verified = await openManagedDatabase(fixture.dbPath, { readonly: true, fileMustExist: true });
        expect(verified.prepare('SELECT native_id FROM purged_transcripts').all()).toEqual([{ native_id: 'checkpoint-retry' }]);
        verified.close();
    });

    it('reports a close rollback failure without releasing the handle or its lease', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-close-rollback-');
        fixture.close();
        const database = await openManagedDatabase(fixture.dbPath, { fileMustExist: true });
        database.prepare('INSERT INTO purged_transcripts VALUES (?, ?, ?)').run('codex', 'committed', 'now');
        database.exec('BEGIN');
        database.prepare('INSERT INTO purged_transcripts VALUES (?, ?, ?)').run('codex', 'uncommitted', 'now');
        const exec = vi.spyOn(database, 'exec').mockImplementationOnce(() => {
            throw new Error('rollback I/O failure');
        });
        try {
            expect(() => database.close()).toThrow('rollback I/O failure');
            expect(database.open).toBe(true);
            expect(database.inTransaction).toBe(true);
            expect(readdirSync(databaseLifecyclePaths(fixture.dbPath).leases)).toHaveLength(1);
        } finally {
            exec.mockRestore();
            database.close();
        }
        const verified = await openManagedDatabase(fixture.dbPath, { readonly: true, fileMustExist: true });
        expect(verified.prepare('SELECT native_id FROM purged_transcripts').all()).toEqual([{ native_id: 'committed' }]);
        verified.close();
    });

    it('releases exclusive ownership after every managed connection closes successfully', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-exclusive-close-success-');
        fixture.close();
        const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
        const database = await openManagedDatabase(fixture.dbPath, { fileMustExist: true, lifecycle: exclusive });

        expect(() => exclusive.beginReplacement()).toThrow(DATABASE_LIFECYCLE_BUSY);
        expect(() => exclusive.completeReplacement()).toThrow(DATABASE_LIFECYCLE_BUSY);
        expect(() => exclusive.release()).toThrow(DATABASE_LIFECYCLE_BUSY);
        database.close();
        exclusive.beginReplacement();
        const verification = await openManagedDatabase(fixture.dbPath, { fileMustExist: true, lifecycle: exclusive });
        expect(() => exclusive.assertReplacementReady()).toThrow(DATABASE_LIFECYCLE_BUSY);
        expect(() => exclusive.completeReplacement()).toThrow(DATABASE_LIFECYCLE_BUSY);
        verification.close();
        exclusive.assertReplacementReady();
        exclusive.completeReplacement();
        exclusive.release();
        expect(hasLifecycleIntent(fixture.dbPath)).toBe(false);

        const reopened = await openManagedDatabase(fixture.dbPath, { fileMustExist: true });
        reopened.close();
    });

    it('rejects a second concurrent managed connection under one exclusive lease', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-exclusive-single-connection-');
        fixture.close();
        const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
        const first = await openManagedDatabase(fixture.dbPath, { fileMustExist: true, lifecycle: exclusive });
        try {
            await expect(
                openManagedDatabase(fixture.dbPath, { fileMustExist: true, lifecycle: exclusive }).then((second) => {
                    second.close();
                }),
            ).rejects.toThrow(DATABASE_LIFECYCLE_BUSY);
        } finally {
            first.close();
            exclusive.release();
        }
    });

    it.each(['shared', 'exclusive'] as const)('reclaims a %s owner only after its process is provably dead', async (kind) => {
        const fixture = createTestDb(`elepha-database-lifecycle-killed-${kind}-`);
        fixture.close();
        const paths = databaseLifecyclePaths(fixture.dbPath);
        const child = await spawnOwner(fixture.dbPath, kind);
        try {
            if (kind === 'shared') {
                expect(readdirSync(paths.leases)).toHaveLength(1);
            } else {
                expect(hasLifecycleIntent(fixture.dbPath)).toBe(true);
            }
            await killOwner(child);

            if (kind === 'shared') {
                const exclusive = await acquireExclusiveDatabaseLifecycle(fixture.dbPath);
                exclusive.release();
                expect(readdirSync(paths.leases)).toEqual([]);
            } else {
                const shared = acquireSharedDatabaseLifecycle(fixture.dbPath);
                shared.release();
                expect(hasLifecycleIntent(fixture.dbPath)).toBe(false);
            }
        } finally {
            await killOwner(child);
        }
    });

    it('claims recoverable ownership only after death and serializes matching claimants', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-recoverable-claim-');
        fixture.close();
        const recoveryId = '11111111-1111-4111-8111-111111111111';
        const wrongRecoveryId = '22222222-2222-4222-8222-222222222222';
        const original = await spawnRecoverableOwner(fixture.dbPath, recoveryId, false);
        let claimant: ChildProcess | undefined;
        try {
            await expect(acquireExclusiveDatabaseLifecycle(fixture.dbPath, recoveryId)).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
            await killOwner(original);

            await expect(acquireExclusiveDatabaseLifecycle(fixture.dbPath, wrongRecoveryId)).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
            claimant = await spawnRecoverableOwner(fixture.dbPath, recoveryId, true);
            await expect(acquireExclusiveDatabaseLifecycle(fixture.dbPath, recoveryId)).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
            await killOwner(claimant);

            const recovered = await acquireExclusiveDatabaseLifecycle(fixture.dbPath, recoveryId);
            recovered.completeReplacement();
            recovered.release();
            expect(hasLifecycleIntent(fixture.dbPath)).toBe(false);
        } finally {
            await killOwner(original);
            if (claimant !== undefined) {
                await killOwner(claimant);
            }
            removeLifecycleIntents(fixture.dbPath);
        }
    });

    it.each(['finalize', 'owner-release'] as const)('retains an in-process recoverable lease until %s succeeds', async (failurePoint) => {
        const fixture = createTestDb(`elepha-database-lifecycle-recoverable-${failurePoint}-`);
        fixture.close();
        const recoveryId = '33333333-3333-4333-8333-333333333333';
        await expect(
            withExclusiveDatabaseLifecycle(
                fixture.dbPath,
                (lease) => {
                    lease.beginReplacement(recoveryId);
                    throw new Error('retain recoverable lifecycle lease');
                },
                recoveryId,
            ),
        ).rejects.toThrow('retain recoverable lifecycle lease');

        const paths = databaseLifecyclePaths(fixture.dbPath);
        const ownerFile = lifecycleIntentFiles(fixture.dbPath)[0];
        if (ownerFile === undefined) {
            throw new Error('recoverable lifecycle owner was not retained');
        }
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalRenameSync = mutableFs.renameSync;
        const originalUnlinkSync = mutableFs.unlinkSync;
        let injected = false;
        if (failurePoint === 'finalize') {
            mutableFs.renameSync = ((oldPath, newPath) => {
                if (!injected && typeof newPath === 'string' && path.dirname(newPath) === paths.authorities) {
                    injected = true;
                    throw new Error('injected lifecycle finalization failure');
                }
                return originalRenameSync(oldPath, newPath);
            }) as typeof import('node:fs').renameSync;
        } else {
            mutableFs.unlinkSync = ((file) => {
                if (!injected && file === ownerFile) {
                    injected = true;
                    throw new Error('injected lifecycle owner release failure');
                }
                return originalUnlinkSync(file);
            }) as typeof import('node:fs').unlinkSync;
        }
        syncBuiltinESMExports();

        try {
            await expect(
                withExclusiveDatabaseLifecycle(
                    fixture.dbPath,
                    (lease) => {
                        lease.completeReplacement();
                        return 'verified';
                    },
                    recoveryId,
                ),
            ).rejects.toThrow(`injected lifecycle ${failurePoint === 'finalize' ? 'finalization' : 'owner release'} failure`);
            expect(injected).toBe(true);
            expect(hasLifecycleIntent(fixture.dbPath)).toBe(true);
            expect(() => acquireSharedDatabaseLifecycle(fixture.dbPath)).toThrow(DATABASE_LIFECYCLE_BUSY);
        } finally {
            mutableFs.renameSync = originalRenameSync;
            mutableFs.unlinkSync = originalUnlinkSync;
            syncBuiltinESMExports();
        }

        await expect(withExclusiveDatabaseLifecycle(fixture.dbPath, () => 'released', recoveryId)).resolves.toBe('released');
        expect(hasLifecycleIntent(fixture.dbPath)).toBe(false);
    });

    it('blocks a dead exclusive owner when the canonical inode changed before verification', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-dead-install-');
        const replacement = createTestDb('elepha-database-lifecycle-dead-install-replacement-');
        fixture.close();
        replacement.close();
        const originalIdentity = statSync(fixture.dbPath);
        const child = await spawnOwner(fixture.dbPath, 'exclusive');
        try {
            renameSync(replacement.dbPath, fixture.dbPath);
            const installedIdentity = statSync(fixture.dbPath);
            expect(installedIdentity.dev !== originalIdentity.dev || installedIdentity.ino !== originalIdentity.ino).toBe(true);
            await killOwner(child);

            await expect(
                openManagedDatabase(fixture.dbPath, { fileMustExist: true }).then((db) => {
                    db.close();
                }),
            ).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
            await expect(acquireExclusiveDatabaseLifecycle(fixture.dbPath)).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
        } finally {
            await killOwner(child);
            removeLifecycleIntents(fixture.dbPath);
        }
    });

    it('fails closed on malformed owner state instead of reclaiming it', async () => {
        const fixture = createTestDb('elepha-database-lifecycle-ambiguous-');
        fixture.close();
        const paths = databaseLifecyclePaths(fixture.dbPath);
        const malformedLease = path.join(paths.leases, malformedLeaseName);
        const malformedIntent = path.join(paths.exclusive, 'intent-00000000-0000-4000-8000-000000000000');
        const seeded = acquireSharedDatabaseLifecycle(fixture.dbPath);
        seeded.release();
        try {
            mkdirSync(paths.exclusive, { recursive: true });
            writeFileSync(malformedIntent, '{}\n', { mode: 0o600 });

            expect(() => acquireSharedDatabaseLifecycle(fixture.dbPath)).toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
            unlinkSync(malformedIntent);
            writeFileSync(malformedLease, '{}\n', { mode: 0o600 });

            expect(() => acquireSharedDatabaseLifecycle(fixture.dbPath)).toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
            await expect(acquireExclusiveDatabaseLifecycle(fixture.dbPath)).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
            expect(hasLifecycleIntent(fixture.dbPath)).toBe(false);
        } finally {
            if (existsSync(malformedIntent)) {
                unlinkSync(malformedIntent);
            }
            removeLifecycleIntents(fixture.dbPath);
            if (existsSync(malformedLease)) {
                unlinkSync(malformedLease);
            }
        }
    });
});
