import { createHash, randomUUID } from 'node:crypto';
import {
    accessSync,
    chmodSync,
    closeSync,
    fchmodSync,
    constants as fsConstants,
    fstatSync,
    fsyncSync,
    ftruncateSync,
    linkSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readSync,
    realpathSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import {
    DATABASE_LIFECYCLE_ACQUIRE_TIMEOUT_MS,
    DATABASE_LIFECYCLE_COARSE_TIMESTAMP_QUANTUM_NS,
    DATABASE_LIFECYCLE_EXCLUSIVE_OWNER_PUBLICATION_ATTEMPTS,
    DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS,
    DATABASE_LIFECYCLE_POLL_MS,
    DATABASE_LIFECYCLE_RECORD_MAX_BYTES,
    PRIVATE_DIR_MODE,
    PRIVATE_FILE_MODE,
} from '../config/constants.js';
import { fsyncDirectory, writePrivateFileAtomic } from './database-encryption.js';

export const DATABASE_LIFECYCLE_BUSY = 'database_lifecycle_busy';
export const DATABASE_LIFECYCLE_AMBIGUOUS = 'database_lifecycle_ambiguous';

const OWNER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exclusiveLeaseOwners = new WeakMap<object, HeldOwner>();
const exclusiveLeaseOpenDatabases = new WeakMap<object, Set<Database.Database>>();
const retainedRecoverableExclusiveLeases = new Map<string, { lease: ExclusiveDatabaseLifecycleLease; recoveryInProgress: boolean }>();
const sharedDatabasesHeldUntilClose = new Set<Database.Database>();
const unprovenDatabaseProofs = new Set<Database.Database>();
const checkpointOnCloseDatabases = new WeakSet<Database.Database>();
const DATABASE_LIFECYCLE_TEST_DIRECTORY = Symbol.for('dev.elepha.internal.database-lifecycle-test-directory');
let databaseExitCleanupInstalled = false;

function databaseLifecycleDirectory(): string {
    const injected = (globalThis as Record<symbol, unknown>)[DATABASE_LIFECYCLE_TEST_DIRECTORY];
    if (injected !== undefined) {
        if (typeof injected !== 'string' || !path.isAbsolute(injected) || path.resolve(injected) !== injected) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, 'injected lifecycle test directory is invalid');
        }
        return injected;
    }
    let userHome: string;
    try {
        userHome = userInfo().homedir;
    } catch {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, 'operating-system user home cannot be resolved');
    }
    if (!path.isAbsolute(userHome) || path.resolve(userHome) !== userHome) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, 'operating-system user home is invalid');
    }
    return path.join(userHome, '.elepha', 'database-lifecycle');
}

const DATABASE_LIFECYCLE_DIRECTORY = databaseLifecycleDirectory();

type OwnerKind = 'shared' | 'exclusive';
type FileIdentity = { dev: bigint | number; ino: bigint | number };
type DatabaseFileIdentity =
    | { exists: false }
    | {
          exists: true;
          dev: string;
          ino: string;
      };

interface OwnerRecord {
    version: 1;
    kind: OwnerKind;
    pid: number;
    ownerId: string;
    databasePath: string;
    databaseFilename: string | null;
    phase: 'shared' | 'acquiring' | 'held' | 'mutating';
    databaseIdentity: DatabaseFileIdentity | null;
    recoveryHash: string | null;
}

interface AuthorityRecord {
    version: 1;
    databasePath: string;
    databaseIdentity: Extract<DatabaseFileIdentity, { exists: true }>;
}

interface RetiredIdentityRecord {
    version: 1;
    databaseIdentity: Extract<DatabaseFileIdentity, { exists: true }>;
}

interface HeldOwner extends FileIdentity {
    file: string;
    record: OwnerRecord;
}

export interface DatabaseLifecyclePaths {
    directory: string;
    exclusive: string;
    leases: string;
    authorities: string;
    retired: string;
}

export interface SharedDatabaseLifecycleLease {
    readonly kind: 'shared';
    readonly databasePath: string;
    captureDatabaseIdentity(): DatabaseLifecycleIdentity;
    release(): void;
}

export interface ExclusiveDatabaseLifecycleLease {
    readonly kind: 'exclusive';
    readonly databasePath: string;
    captureDatabaseIdentity(): DatabaseLifecycleIdentity;
    beginReplacement(recoveryId?: string): void;
    assertReplacementReady(): void;
    resolvePhysicalDatabaseFilename(): string;
    completeReplacement(): void;
    release(): void;
}

export interface DatabaseLifecycleIdentity {
    readonly exists: boolean;
    assertCurrent(): void;
    openDatabase(open: (databasePath: string) => Database.Database): {
        database: Database.Database;
        identity: DatabaseLifecycleIdentity;
    };
}

export interface SQLiteFileIdentitySeal {
    dev: bigint;
    ino: bigint;
    ctimeNs: bigint;
    nlink: bigint;
}

export interface SQLitePathOpenSeal {
    readonly descriptor: number;
    readonly sqlitePath: string;
    confirmOpen(database: Database.Database, schemaName?: string): void;
    captureMutationState(): DatabasePathMutationState;
    assertCurrent(expectedMutationState: DatabasePathMutationState): void;
    release(): void;
}

function noFollowFlag(): number {
    return fsConstants.O_NOFOLLOW ?? 0;
}

function lifecycleError(code: string, detail: string): Error {
    return new Error(`${code}: ${detail}`);
}

function assertLifecycle(condition: boolean, code: string, detail: string): asserts condition {
    if (!condition) {
        throw lifecycleError(code, detail);
    }
}

function assertNoCleanupFailures(failures: readonly unknown[], message: string): void {
    if (failures.length > 0) {
        throw new AggregateError(failures, message);
    }
}

class DatabasePathMutationError extends Error {}

function databasePathMutationError(databasePath: string): DatabasePathMutationError {
    return new DatabasePathMutationError(
        `${DATABASE_LIFECYCLE_AMBIGUOUS}: managed database path changed while SQLite opened ${databasePath}`,
    );
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function databaseLifecyclePaths(_databasePath: string): DatabaseLifecyclePaths {
    // This user-scoped root is independent of both configurable Elepha homes
    // and database spellings, so every managed hard-link alias converges before
    // any database identity or bytes are inspected.
    const directory = DATABASE_LIFECYCLE_DIRECTORY;
    return {
        directory,
        exclusive: path.join(directory, 'exclusive'),
        leases: path.join(directory, 'leases'),
        authorities: path.join(directory, 'authorities'),
        retired: path.join(directory, 'retired'),
    };
}

function inspectDatabaseIdentity(databasePath: string): DatabaseFileIdentity {
    let physicalPath: string;
    try {
        physicalPath = realpathSync(databasePath);
    } catch (error: unknown) {
        if (isMissing(error)) {
            return { exists: false };
        }
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database identity cannot be resolved: ${databasePath}`);
    }
    let descriptor: number;
    try {
        descriptor = openSync(physicalPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollowFlag());
    } catch {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database cannot be opened for identity inspection: ${databasePath}`);
    }
    try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile()) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database is not a physical file: ${databasePath}`);
        }
        let currentPhysicalPath: string;
        let current: ReturnType<typeof lstatSync>;
        try {
            currentPhysicalPath = realpathSync(databasePath);
            current = lstatSync(currentPhysicalPath);
        } catch {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database identity changed while inspected: ${databasePath}`);
        }
        if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(opened, current)) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database identity changed while inspected: ${databasePath}`);
        }
        return { exists: true, dev: String(opened.dev), ino: String(opened.ino) };
    } finally {
        closeSync(descriptor);
    }
}

function inspectDatabaseLocation(databasePath: string): {
    identity: DatabaseFileIdentity;
    databaseFilename: string;
} {
    const identity = inspectDatabaseIdentity(databasePath);
    let databaseFilename: string;
    try {
        databaseFilename = identity.exists
            ? realpathSync(databasePath)
            : path.join(realpathSync(path.dirname(databasePath)), path.basename(databasePath));
    } catch (error: unknown) {
        if (!identity.exists && isMissing(error)) {
            // Acquisition precedes first-run directory creation. No database
            // bytes exist yet, so retain the absolute lexical filename until
            // descriptor-backed creation records the physical filename.
            databaseFilename = databasePath;
        } else {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database physical filename cannot be resolved: ${databasePath}`);
        }
    }
    const current = inspectDatabaseIdentity(databasePath);
    if (!sameDatabaseIdentity(identity, current)) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database identity changed while locating ${databasePath}`);
    }
    if (identity.exists) {
        let physical: ReturnType<typeof lstatSync>;
        try {
            physical = lstatSync(databaseFilename);
        } catch {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database physical filename changed: ${databasePath}`);
        }
        if (
            !physical.isFile() ||
            physical.isSymbolicLink() ||
            String(physical.dev) !== identity.dev ||
            String(physical.ino) !== identity.ino
        ) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database physical filename changed: ${databasePath}`);
        }
    }
    return { identity, databaseFilename };
}

function sameDatabaseIdentity(left: DatabaseFileIdentity, right: DatabaseFileIdentity): boolean {
    if (!left.exists || !right.exists) {
        return left.exists === right.exists;
    }
    return left.dev === right.dev && left.ino === right.ino;
}

function closeProofDatabases(databases: readonly Database.Database[]): unknown[] {
    const failures: unknown[] = [];
    for (const database of [...databases].reverse()) {
        if (!database.open) {
            continue;
        }
        try {
            database.close();
        } catch (error) {
            failures.push(error);
        }
    }
    return failures;
}

export interface DatabasePathMutationState {
    fileCtimeNs: bigint;
    fileNlink: bigint;
}

interface DirectoryPathMutationState {
    descriptor: number;
    physicalPath: string;
    identity: FileIdentity;
    ctimeNs: bigint;
    mtimeNs: bigint;
}

// SQLite does not expose the file descriptor owned by a returned connection.
// A pinned parent binds traversal on Linux; file ctime/link count seals leaf
// unlink/link and rename ABA on every supported Unix filesystem.
function databasePathMutationState(descriptor: number): DatabasePathMutationState {
    const file = fstatSync(descriptor, { bigint: true });
    return {
        fileCtimeNs: file.ctimeNs,
        fileNlink: file.nlink,
    };
}

function sameDatabasePathMutationState(left: DatabasePathMutationState, right: DatabasePathMutationState): boolean {
    return left.fileCtimeNs === right.fileCtimeNs && left.fileNlink === right.fileNlink;
}

function assertPreciseDatabasePathMutationState(state: DatabasePathMutationState, databasePath: string): void {
    // Parent timestamps cannot distinguish a leaf substitution from unrelated
    // sidecar or sibling churn. Require precision on the pinned file itself.
    assertPreciseMutationTimestamp(state.fileCtimeNs, databasePath);
}

function assertPreciseMutationTimestamp(timestamp: bigint, databasePath: string): void {
    if (timestamp % DATABASE_LIFECYCLE_COARSE_TIMESTAMP_QUANTUM_NS === 0n) {
        throw lifecycleError(
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `managed database filesystem metadata is too coarse to seal SQLite open: ${databasePath}`,
        );
    }
}

function physicalAncestorPaths(databaseFilename: string): string[] {
    const ancestors: string[] = [];
    let current = path.dirname(databaseFilename);
    while (true) {
        ancestors.push(current);
        const parent = path.dirname(current);
        if (parent === current) {
            return ancestors;
        }
        current = parent;
    }
}

function directoryPathMutationState(descriptor: number, directory: string): DirectoryPathMutationState {
    const opened = fstatSync(descriptor, { bigint: true });
    assertLifecycle(opened.isDirectory(), DATABASE_LIFECYCLE_AMBIGUOUS, 'managed database ancestor is not a physical directory');
    return {
        descriptor,
        physicalPath: directory,
        identity: { dev: opened.dev, ino: opened.ino },
        ctimeNs: opened.ctimeNs,
        mtimeNs: opened.mtimeNs,
    };
}

function currentUserMayReplaceDirectoryEntry(parent: DirectoryPathMutationState): boolean {
    const effectiveUserId = process.geteuid?.();
    if (path.dirname(parent.physicalPath) !== parent.physicalPath || effectiveUserId === undefined || effectiveUserId === 0) {
        return true;
    }
    try {
        accessSync(parent.physicalPath, fsConstants.W_OK | fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function assertPreciseDarwinAncestorMutationState(directories: readonly DirectoryPathMutationState[], databasePath: string): void {
    for (let index = 0; index + 1 < directories.length; index++) {
        const directory = directories[index];
        const parent = directories[index + 1];
        if (directory !== undefined && parent !== undefined && currentUserMayReplaceDirectoryEntry(parent)) {
            assertPreciseMutationTimestamp(directory.ctimeNs, databasePath);
            assertPreciseMutationTimestamp(parent.ctimeNs, databasePath);
        }
    }
}

interface AuthorizedDescriptor {
    descriptor: number | undefined;
    directories: DirectoryPathMutationState[];
    physicalPath: string;
    sqlitePath: string;
    identity: Extract<DatabaseFileIdentity, { exists: true }>;
    mutationState?: DatabasePathMutationState;
    closed: boolean;
}

function openAuthorizedDescriptor(
    databasePath: string,
    expected: DatabaseFileIdentity,
    assertAcceptable: (identity: DatabaseFileIdentity) => void,
    recordCreated: (identity: Extract<DatabaseFileIdentity, { exists: true }>, databaseFilename: string) => void,
): AuthorizedDescriptor {
    let physicalPath: string;
    const directories: DirectoryPathMutationState[] = [];
    const directoryDescriptors: number[] = [];
    try {
        physicalPath = expected.exists
            ? realpathSync(databasePath)
            : path.join(realpathSync(path.dirname(databasePath)), path.basename(databasePath));
    } catch {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database physical path cannot be resolved: ${databasePath}`);
    }
    let descriptor: number;
    try {
        descriptor = expected.exists
            ? openSync(physicalPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollowFlag())
            : openSync(physicalPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), PRIVATE_FILE_MODE);
    } catch {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database cannot be pinned for SQLite identity proof: ${databasePath}`);
    }
    try {
        if (!expected.exists) {
            fchmodSync(descriptor, PRIVATE_FILE_MODE);
            fsyncSync(descriptor);
        }
        const opened = fstatSync(descriptor);
        assertLifecycle(opened.isFile(), DATABASE_LIFECYCLE_AMBIGUOUS, `managed database is not a physical file: ${databasePath}`);
        const identity: Extract<DatabaseFileIdentity, { exists: true }> = {
            exists: true,
            dev: String(opened.dev),
            ino: String(opened.ino),
        };
        const current = inspectDatabaseIdentity(databasePath);
        assertLifecycle(
            current.exists && sameDatabaseIdentity(identity, current) && (!expected.exists || sameDatabaseIdentity(expected, current)),
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `managed database identity changed while opening ${databasePath}`,
        );
        const physical = lstatSync(physicalPath);
        assertLifecycle(
            physical.isFile() && !physical.isSymbolicLink() && sameIdentity(opened, physical),
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `managed database physical identity changed while opening ${databasePath}`,
        );
        assertAcceptable(identity);
        if (!expected.exists) {
            recordCreated(identity, physicalPath);
        }
        if (process.platform === 'win32') {
            return {
                descriptor,
                directories,
                physicalPath,
                sqlitePath: physicalPath,
                identity,
                closed: false,
            };
        }
        assertLifecycle(
            process.platform === 'darwin' || process.platform === 'linux',
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `SQLite open mutation seal is unsupported on ${process.platform}`,
        );
        for (const ancestor of process.platform === 'darwin' ? physicalAncestorPaths(physicalPath) : [path.dirname(physicalPath)]) {
            const ancestorDescriptor = openSync(ancestor, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollowFlag());
            directoryDescriptors.push(ancestorDescriptor);
            directories.push(directoryPathMutationState(ancestorDescriptor, ancestor));
        }
        if (process.platform === 'darwin') {
            // Every non-root component has a pinned parent boundary. Root
            // itself cannot be renamed; its direct children are mutable only
            // when this OS user can write and traverse root (normally root).
            assertPreciseDarwinAncestorMutationState(directories, databasePath);
        }
        const parent = directories[0];
        assertLifecycle(parent !== undefined, DATABASE_LIFECYCLE_AMBIGUOUS, 'managed database physical parent was not pinned');
        const mutationState = databasePathMutationState(descriptor);
        assertPreciseDatabasePathMutationState(mutationState, databasePath);
        return {
            descriptor,
            directories,
            physicalPath,
            // Linux resolves the SQLite filename relative to the pinned
            // parent descriptor, so swapping any ancestor cannot redirect
            // the main file or its canonical sibling sidecars.
            sqlitePath:
                process.platform === 'linux' ? `/proc/self/fd/${String(parent.descriptor)}/${path.basename(physicalPath)}` : physicalPath,
            identity,
            mutationState,
            closed: false,
        };
    } catch (error) {
        const cleanupFailures: unknown[] = [];
        for (const directoryDescriptor of [...directoryDescriptors].reverse()) {
            try {
                closeSync(directoryDescriptor);
            } catch (closeError) {
                cleanupFailures.push(closeError);
            }
        }
        try {
            closeSync(descriptor);
        } catch (closeError) {
            cleanupFailures.push(closeError);
        }
        if (cleanupFailures.length > 0) {
            throw new AggregateError(
                [error, ...cleanupFailures],
                `SQLite identity descriptor acquisition and cleanup both failed for ${databasePath}`,
            );
        }
        throw error;
    }
}

function closeAuthorizedDescriptor(pinned: AuthorizedDescriptor): unknown[] {
    if (pinned.closed) {
        return [];
    }
    pinned.closed = true;
    const failures: unknown[] = [];
    for (const descriptor of [pinned.descriptor, ...pinned.directories.map((directory) => directory.descriptor)]) {
        if (descriptor === undefined) {
            continue;
        }
        try {
            closeSync(descriptor);
        } catch (error) {
            failures.push(error);
        }
    }
    pinned.descriptor = undefined;
    pinned.directories = [];
    return failures;
}

function installDatabaseExitCleanup(): void {
    if (databaseExitCleanupInstalled) {
        return;
    }
    process.once('exit', () => {
        for (const database of new Set([...sharedDatabasesHeldUntilClose, ...unprovenDatabaseProofs])) {
            try {
                database.close();
            } catch {
                // Durable owner state remains when close cannot be proved;
                // process exit will release the operating-system handles.
            }
        }
    });
    databaseExitCleanupInstalled = true;
}

function retainUnprovenDatabaseProof(database: Database.Database, pinned: AuthorizedDescriptor, onRecovered: () => void): void {
    const close = database.close.bind(database);
    let cleanupComplete = false;
    let cleanupFailure: unknown;
    unprovenDatabaseProofs.add(database);
    installDatabaseExitCleanup();
    database.close = () => {
        if (cleanupComplete) {
            return database;
        }
        if (cleanupFailure !== undefined) {
            throw cleanupFailure;
        }
        close();
        const descriptorFailures = closeAuthorizedDescriptor(pinned);
        if (descriptorFailures.length > 0) {
            cleanupFailure = new AggregateError(descriptorFailures, 'Pinned SQLite proof cleanup failed.');
            throw cleanupFailure;
        }
        cleanupComplete = true;
        unprovenDatabaseProofs.delete(database);
        onRecovered();
        return database;
    };
}

function assertSQLiteOpenSealed(pinned: AuthorizedDescriptor, databasePath: string, checkAncestorMutationState = true): void {
    const current = inspectDatabaseIdentity(databasePath);
    if (!sameDatabaseIdentity(pinned.identity, current)) {
        throw databasePathMutationError(databasePath);
    }
    const physical = lstatSync(pinned.physicalPath);
    if (
        !physical.isFile() ||
        physical.isSymbolicLink() ||
        String(physical.dev) !== pinned.identity.dev ||
        String(physical.ino) !== pinned.identity.ino
    ) {
        throw databasePathMutationError(databasePath);
    }
    if (process.platform !== 'win32') {
        if (pinned.descriptor === undefined || pinned.directories.length === 0 || pinned.mutationState === undefined) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `SQLite open mutation seal is incomplete for ${databasePath}`);
        }
        const after = databasePathMutationState(pinned.descriptor);
        if (!sameDatabasePathMutationState(pinned.mutationState, after)) {
            throw databasePathMutationError(databasePath);
        }
        const directoryAfter = pinned.directories.map((directory) => {
            const opened = fstatSync(directory.descriptor, { bigint: true });
            const current = lstatSync(directory.physicalPath, { bigint: true });
            if (
                !opened.isDirectory() ||
                !current.isDirectory() ||
                current.isSymbolicLink() ||
                !sameIdentity(opened, directory.identity) ||
                !sameIdentity(current, directory.identity)
            ) {
                throw databasePathMutationError(databasePath);
            }
            return { ctimeNs: opened.ctimeNs, mtimeNs: opened.mtimeNs };
        });
        if (process.platform === 'darwin' && checkAncestorMutationState) {
            for (let index = 0; index + 1 < pinned.directories.length; index++) {
                const before = pinned.directories[index];
                const after = directoryAfter[index];
                const parentBefore = pinned.directories[index + 1];
                const parentAfter = directoryAfter[index + 1];
                if (
                    before !== undefined &&
                    after !== undefined &&
                    parentBefore !== undefined &&
                    parentAfter !== undefined &&
                    currentUserMayReplaceDirectoryEntry(parentBefore) &&
                    before.ctimeNs !== after.ctimeNs &&
                    (parentBefore.ctimeNs !== parentAfter.ctimeNs || parentBefore.mtimeNs !== parentAfter.mtimeNs)
                ) {
                    throw databasePathMutationError(databasePath);
                }
            }
        }
    }
}

function assertSQLiteCanonicalFilename(
    database: Database.Database,
    pinned: AuthorizedDescriptor,
    databasePath: string,
    schemaName = 'main',
): void {
    const databases = database.pragma('database_list') as Array<{ seq?: unknown; name?: unknown; file?: unknown }>;
    const opened = databases.find((entry) => entry.name === schemaName && (schemaName !== 'main' || entry.seq === 0));
    if (opened === undefined || typeof opened.file !== 'string' || path.resolve(opened.file) !== pinned.physicalPath) {
        throw databasePathMutationError(databasePath);
    }
}

function expectedSQLiteFileError(pinned: AuthorizedDescriptor, expected: SQLiteFileIdentitySeal, databasePath: string): unknown {
    try {
        if (pinned.descriptor === undefined) {
            return lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `SQLite open mutation seal is incomplete for ${databasePath}`);
        }
        const opened = fstatSync(pinned.descriptor, { bigint: true });
        if (
            !opened.isFile() ||
            opened.dev !== expected.dev ||
            opened.ino !== expected.ino ||
            opened.ctimeNs !== expected.ctimeNs ||
            opened.nlink !== expected.nlink
        ) {
            return databasePathMutationError(databasePath);
        }
        return undefined;
    } catch (error) {
        return error;
    }
}

// Backup/export code precreates an empty private inode, then asks SQLite to
// open that exact object. Keep C01's file and ancestor descriptors pinned so
// the caller can validate database_list before admitting any key, read, or
// write through the SQLite handle.
export function pinSQLitePathForOpen(databasePath: string, expected: SQLiteFileIdentitySeal): SQLitePathOpenSeal {
    const lifecycleIdentity: DatabaseFileIdentity = {
        exists: true,
        dev: String(expected.dev),
        ino: String(expected.ino),
    };
    const pinned = openAuthorizedDescriptor(
        databasePath,
        lifecycleIdentity,
        () => undefined,
        () => undefined,
    );
    const expectedError = expectedSQLiteFileError(pinned, expected, databasePath);
    if (expectedError !== undefined) {
        const cleanupFailures = closeAuthorizedDescriptor(pinned);
        if (cleanupFailures.length > 0) {
            throw new AggregateError(
                [expectedError, ...cleanupFailures],
                `SQLite identity descriptor validation and cleanup both failed for ${databasePath}`,
                { cause: expectedError },
            );
        }
        throw expectedError;
    }
    const descriptor = pinned.descriptor;
    assertLifecycle(descriptor !== undefined, DATABASE_LIFECYCLE_AMBIGUOUS, `SQLite open mutation seal is incomplete for ${databasePath}`);
    return {
        descriptor,
        sqlitePath: pinned.sqlitePath,
        confirmOpen: (database, schemaName = 'main') => {
            assertSQLiteOpenSealed(pinned, databasePath);
            assertSQLiteCanonicalFilename(database, pinned, databasePath, schemaName);
        },
        captureMutationState: () => databasePathMutationState(descriptor),
        assertCurrent: (expectedMutationState) => {
            pinned.mutationState = expectedMutationState;
            // Once confirmOpen has bound SQLite to the intended object, its
            // own page writes legitimately change the leaf and unrelated
            // sibling activity may change adjacent ancestor timestamps. The
            // post-write check still seals descriptor/path identities and the
            // caller-supplied leaf mutation state without treating those
            // unrelated directory changes as a new SQLite open.
            assertSQLiteOpenSealed(pinned, databasePath, false);
        },
        release: () => {
            const failures = closeAuthorizedDescriptor(pinned);
            assertNoCleanupFailures(failures, `SQLite identity seal cleanup failed for ${databasePath}`);
        },
    };
}

function databaseIdentityGuard(
    databasePath: string,
    expected: DatabaseFileIdentity,
    assertHeld: () => void,
    onUnprovenClose: (database: Database.Database) => () => void,
    assertAcceptable: (identity: DatabaseFileIdentity) => void = () => undefined,
    recordCreated: (identity: Extract<DatabaseFileIdentity, { exists: true }>, databaseFilename: string) => void = () => undefined,
    assertOpenAllowed: () => void = () => undefined,
    recordOpened: (
        database: Database.Database,
        databaseFilename: string,
        identity: Extract<DatabaseFileIdentity, { exists: true }>,
    ) => void = () => undefined,
): DatabaseLifecycleIdentity {
    const assertCurrent = () => {
        assertHeld();
        const current = inspectDatabaseIdentity(databasePath);
        if (!sameDatabaseIdentity(expected, current)) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database identity changed while opening ${databasePath}`);
        }
        assertAcceptable(current);
    };
    return {
        exists: expected.exists,
        assertCurrent,
        openDatabase: (open) => {
            for (let attempt = 0; attempt < DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS; attempt++) {
                assertHeld();
                assertOpenAllowed();
                const beforeIdentity = inspectDatabaseIdentity(databasePath);
                if (!sameDatabaseIdentity(expected, beforeIdentity)) {
                    throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database identity changed while opening ${databasePath}`);
                }
                assertAcceptable(beforeIdentity);
                const pinned = openAuthorizedDescriptor(databasePath, expected, assertAcceptable, recordCreated);
                let database: Database.Database | undefined;
                try {
                    database = open(pinned.sqlitePath);
                    assertSQLiteOpenSealed(pinned, databasePath);
                    if (process.platform === 'linux' || process.platform === 'darwin') {
                        // database_list does not read database content or need
                        // a key. After the platform-specific traversal seal,
                        // it proves that later journal/WAL companion suffixes
                        // use the authorized physical filename.
                        assertSQLiteCanonicalFilename(database, pinned, databasePath);
                        assertHeld();
                        assertAcceptable(pinned.identity);
                    }
                    recordOpened(database, pinned.physicalPath, pinned.identity);
                    const closeFailures = closeAuthorizedDescriptor(pinned);
                    assertNoCleanupFailures(closeFailures, `SQLite identity seal cleanup failed for ${databasePath}`);
                    return {
                        database,
                        identity: databaseIdentityGuard(
                            databasePath,
                            pinned.identity,
                            assertHeld,
                            onUnprovenClose,
                            assertAcceptable,
                            recordCreated,
                            assertOpenAllowed,
                            recordOpened,
                        ),
                    };
                } catch (error) {
                    const databaseCloseFailures = closeProofDatabases(database === undefined ? [] : [database]);
                    if (databaseCloseFailures.length > 0 && database !== undefined) {
                        const onRecovered = onUnprovenClose(database);
                        retainUnprovenDatabaseProof(database, pinned, onRecovered);
                        throw new AggregateError(
                            [error, ...databaseCloseFailures],
                            `SQLite identity proof and cleanup both failed for ${databasePath}`,
                        );
                    }
                    const descriptorFailures = closeAuthorizedDescriptor(pinned);
                    if (descriptorFailures.length > 0) {
                        throw new AggregateError(
                            [error, ...descriptorFailures],
                            `SQLite identity proof and cleanup both failed for ${databasePath}`,
                        );
                    }
                    if (
                        error instanceof DatabasePathMutationError &&
                        expected.exists &&
                        attempt + 1 < DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS
                    ) {
                        // No key, read, or write has reached this closed handle.
                        continue;
                    }
                    throw error;
                }
            }
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `SQLite identity proof exhausted for ${databasePath}`);
        },
    };
}

function ensurePrivateDirectory(directory: string): void {
    try {
        mkdirSync(directory, { mode: PRIVATE_DIR_MODE });
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }
    const opened = lstatSync(directory);
    if (!opened.isDirectory() || opened.isSymbolicLink()) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle state is not a physical directory: ${directory}`);
    }
    chmodSync(directory, PRIVATE_DIR_MODE);
}

function prepareState(paths: DatabaseLifecyclePaths): void {
    mkdirSync(path.dirname(paths.directory), { recursive: true, mode: PRIVATE_DIR_MODE });
    ensurePrivateDirectory(paths.directory);
    ensurePrivateDirectory(paths.leases);
    ensurePrivateDirectory(paths.authorities);
    ensurePrivateDirectory(paths.retired);
}

function removeCandidate(file: string): void {
    try {
        unlinkSync(file);
    } catch (error: unknown) {
        if (!isMissing(error)) {
            throw error;
        }
    }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function recoveryHash(recoveryId: string): string {
    if (!OWNER_ID_PATTERN.test(recoveryId)) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, 'database lifecycle recovery identifier is invalid');
    }
    // Only the owning migration home retains the random manifest identifier;
    // global lifecycle state carries its one-way commitment for adoption.
    return createHash('sha256').update(recoveryId, 'utf8').digest('hex');
}

function recoverableLeaseKey(databasePath: string, recoveryId: string): string {
    return `${databasePath}\0${recoveryHash(recoveryId)}`;
}

function recoveryClaimOwnerId(seed: string): string {
    const digest = createHash('sha256').update(seed, 'utf8').digest('hex');
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function assertRecoveryOwnerStillClaimable(
    owner: HeldOwner | undefined,
    databasePath: string,
    expectedRecoveryHash: string,
): asserts owner is HeldOwner {
    if (owner === undefined) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `database lifecycle recovery ownership changed for ${databasePath}`);
    }
    assertRecoveryOwnersMatch([owner], databasePath, expectedRecoveryHash);
    if (ownerLiveness(owner) !== 'dead') {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `database lifecycle recovery ownership changed for ${databasePath}`);
    }
}

function releaseHeldOwner(owner: HeldOwner): void {
    let current: ReturnType<typeof lstatSync>;
    try {
        current = lstatSync(owner.file);
    } catch (error: unknown) {
        if (isMissing(error)) {
            return;
        }
        throw error;
    }
    if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, owner)) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle owner identity changed before release: ${owner.file}`);
    }
    unlinkSync(owner.file);
    fsyncDirectory(path.dirname(owner.file));
}

function publishOwner(file: string, record: OwnerRecord, candidateDirectory: string): HeldOwner {
    const directory = path.dirname(file);
    const candidate = path.join(candidateDirectory, `.lifecycle-${process.pid}-${record.ownerId}.candidate`);
    let descriptor: number | undefined;
    let identity: FileIdentity | undefined;
    let published: HeldOwner | undefined;
    try {
        descriptor = openSync(
            candidate,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
            PRIVATE_FILE_MODE,
        );
        fchmodSync(descriptor, PRIVATE_FILE_MODE);
        writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
        fsyncSync(descriptor);
        identity = fstatSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        linkSync(candidate, file);
        published = { file, record, ...identity };
        removeCandidate(candidate);
        if (candidateDirectory !== directory) {
            fsyncDirectory(candidateDirectory);
        }
        fsyncDirectory(directory);
        return published;
    } catch (error) {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
        let cleanupError: unknown;
        try {
            removeCandidate(candidate);
            if (published !== undefined) {
                releaseHeldOwner(published);
            }
        } catch (cleanupFailure) {
            cleanupError = cleanupFailure;
        }
        if (cleanupError !== undefined) {
            throw new AggregateError([error, cleanupError], `Database lifecycle owner publication failed: ${file}`);
        }
        throw error;
    }
}

function validDatabaseIdentity(value: unknown): value is DatabaseFileIdentity {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const identity = value as Partial<DatabaseFileIdentity>;
    return identity.exists === false || (identity.exists === true && typeof identity.dev === 'string' && typeof identity.ino === 'string');
}

function validDatabaseFilename(value: unknown): value is string {
    return typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value;
}

function validRecoveryHash(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function parseOwner(contents: Buffer, file: string, expectedKind: OwnerKind): OwnerRecord {
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents.toString('utf8'));
    } catch {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle owner is malformed: ${file}`);
    }
    if (!parsed || typeof parsed !== 'object') {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle owner is malformed: ${file}`);
    }
    const record = parsed as Partial<OwnerRecord>;
    const storedRecoveryHash = record.recoveryHash ?? null;
    if (
        record.version !== 1 ||
        record.kind !== expectedKind ||
        !Number.isInteger(record.pid) ||
        (record.pid ?? 0) <= 0 ||
        typeof record.ownerId !== 'string' ||
        !OWNER_ID_PATTERN.test(record.ownerId) ||
        typeof record.databasePath !== 'string' ||
        !path.isAbsolute(record.databasePath) ||
        path.resolve(record.databasePath) !== record.databasePath ||
        (record.kind === 'shared' &&
            (record.phase !== 'shared' ||
                storedRecoveryHash !== null ||
                (record.databaseIdentity === null && record.databaseFilename !== null) ||
                (record.databaseIdentity !== null &&
                    (!validDatabaseIdentity(record.databaseIdentity) || !validDatabaseFilename(record.databaseFilename))))) ||
        (record.kind === 'exclusive' &&
            !(
                ((record.phase === 'acquiring' || record.phase === 'held') &&
                    storedRecoveryHash === null &&
                    (record.phase !== 'acquiring' || (record.databaseIdentity === null && record.databaseFilename === null)) &&
                    (record.phase !== 'held' ||
                        (validDatabaseIdentity(record.databaseIdentity) && validDatabaseFilename(record.databaseFilename)))) ||
                (record.phase === 'mutating' &&
                    (storedRecoveryHash === null || validRecoveryHash(storedRecoveryHash)) &&
                    validDatabaseIdentity(record.databaseIdentity) &&
                    validDatabaseFilename(record.databaseFilename))
            ))
    ) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle owner is malformed: ${file}`);
    }
    return { ...record, recoveryHash: storedRecoveryHash } as OwnerRecord;
}

function readOwner(file: string, expectedKind: OwnerKind): HeldOwner | undefined {
    let descriptor: number;
    try {
        descriptor = openSync(file, fsConstants.O_RDONLY | noFollowFlag());
    } catch (error: unknown) {
        if (isMissing(error)) {
            return undefined;
        }
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle owner cannot be opened safely: ${file}`);
    }
    try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.size > DATABASE_LIFECYCLE_RECORD_MAX_BYTES) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle owner is not a bounded regular file: ${file}`);
        }
        const contents = Buffer.alloc(opened.size + 1);
        const bytesRead = readSync(descriptor, contents, 0, contents.length, 0);
        if (bytesRead !== opened.size) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle owner changed while it was read: ${file}`);
        }
        let current: ReturnType<typeof lstatSync>;
        try {
            current = lstatSync(file);
        } catch (error: unknown) {
            if (isMissing(error)) {
                return undefined;
            }
            throw error;
        }
        if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(opened, current)) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle owner identity changed while it was read: ${file}`);
        }
        const record = parseOwner(contents.subarray(0, bytesRead), file, expectedKind);
        if (expectedKind === 'shared' && path.basename(file) !== `lease-${record.ownerId}`) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `shared lifecycle owner name does not match its identity: ${file}`);
        }
        if (expectedKind === 'exclusive' && path.basename(file) !== `intent-${record.ownerId}`) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `exclusive lifecycle owner name does not match its identity: ${file}`);
        }
        return { file, record, dev: opened.dev, ino: opened.ino };
    } finally {
        closeSync(descriptor);
    }
}

function readBoundedLifecycleRecord(file: string): Buffer | undefined {
    let descriptor: number;
    try {
        descriptor = openSync(file, fsConstants.O_RDONLY | noFollowFlag());
    } catch (error: unknown) {
        if (isMissing(error)) {
            return undefined;
        }
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle authority cannot be opened safely: ${file}`);
    }
    try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.size > DATABASE_LIFECYCLE_RECORD_MAX_BYTES) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle authority is not a bounded regular file: ${file}`);
        }
        const contents = Buffer.alloc(opened.size + 1);
        const bytesRead = readSync(descriptor, contents, 0, contents.length, 0);
        if (bytesRead !== opened.size) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle authority changed while it was read: ${file}`);
        }
        let current: ReturnType<typeof lstatSync>;
        try {
            current = lstatSync(file);
        } catch (error: unknown) {
            if (isMissing(error)) {
                return undefined;
            }
            throw error;
        }
        if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(opened, current)) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle authority identity changed while it was read: ${file}`);
        }
        return contents.subarray(0, bytesRead);
    } finally {
        closeSync(descriptor);
    }
}

function parseLifecycleRecord(file: string): unknown | undefined {
    const contents = readBoundedLifecycleRecord(file);
    if (contents === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(contents.toString('utf8'));
    } catch {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle authority is malformed: ${file}`);
    }
}

function recordKey(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function authorityPath(paths: DatabaseLifecyclePaths, databasePath: string): string {
    return path.join(paths.authorities, `path-${recordKey(databasePath)}`);
}

function retiredIdentityPath(paths: DatabaseLifecyclePaths, identity: Extract<DatabaseFileIdentity, { exists: true }>): string {
    return path.join(paths.retired, `identity-${recordKey(`${identity.dev}:${identity.ino}`)}`);
}

function readAuthority(paths: DatabaseLifecyclePaths, databasePath: string): AuthorityRecord | undefined {
    const file = authorityPath(paths, databasePath);
    const parsed = parseLifecycleRecord(file);
    if (parsed === undefined) {
        return undefined;
    }
    const record = parsed as Partial<AuthorityRecord>;
    if (
        !parsed ||
        typeof parsed !== 'object' ||
        record.version !== 1 ||
        record.databasePath !== databasePath ||
        !validDatabaseIdentity(record.databaseIdentity) ||
        !record.databaseIdentity.exists
    ) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle path authority is malformed: ${file}`);
    }
    return record as AuthorityRecord;
}

function readRetiredIdentity(
    paths: DatabaseLifecyclePaths,
    identity: Extract<DatabaseFileIdentity, { exists: true }>,
): RetiredIdentityRecord | undefined {
    const file = retiredIdentityPath(paths, identity);
    const parsed = parseLifecycleRecord(file);
    if (parsed === undefined) {
        return undefined;
    }
    const record = parsed as Partial<RetiredIdentityRecord>;
    if (
        !parsed ||
        typeof parsed !== 'object' ||
        record.version !== 1 ||
        !validDatabaseIdentity(record.databaseIdentity) ||
        !record.databaseIdentity.exists ||
        !sameDatabaseIdentity(record.databaseIdentity, identity)
    ) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `retired database identity is malformed: ${file}`);
    }
    return record as RetiredIdentityRecord;
}

function assertDatabaseAuthority(paths: DatabaseLifecyclePaths, databasePath: string, identity: DatabaseFileIdentity): void {
    if (identity.exists && readRetiredIdentity(paths, identity) !== undefined) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database path names a retired inode: ${databasePath}`);
    }
    const authority = readAuthority(paths, databasePath);
    if (authority !== undefined && !sameDatabaseIdentity(authority.databaseIdentity, identity)) {
        throw lifecycleError(
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `managed database path no longer names its authoritative inode: ${databasePath}`,
        );
    }
}

function finalizeExclusiveAuthority(paths: DatabaseLifecyclePaths, owner: HeldOwner): void {
    const baseline = owner.record.databaseIdentity;
    if (owner.record.phase !== 'held' || baseline === null) {
        throw lifecycleError(
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `exclusive lifecycle ownership was not fully acquired: ${owner.record.databasePath}`,
        );
    }
    const current = inspectDatabaseIdentity(owner.record.databasePath);
    if (baseline.exists && !sameDatabaseIdentity(baseline, current)) {
        if (!current.exists) {
            throw lifecycleError(
                DATABASE_LIFECYCLE_AMBIGUOUS,
                `managed database disappeared during exclusive ownership: ${owner.record.databasePath}`,
            );
        }
        const retiredFile = retiredIdentityPath(paths, baseline);
        if (readRetiredIdentity(paths, baseline) === undefined) {
            const retired: RetiredIdentityRecord = { version: 1, databaseIdentity: baseline };
            writePrivateFileAtomic(retiredFile, Buffer.from(`${JSON.stringify(retired)}\n`, 'utf8'));
        }
    }
    if (current.exists) {
        const authority: AuthorityRecord = {
            version: 1,
            databasePath: owner.record.databasePath,
            databaseIdentity: current,
        };
        writePrivateFileAtomic(
            authorityPath(paths, owner.record.databasePath),
            Buffer.from(`${JSON.stringify(authority)}\n`, 'utf8'),
            true,
        );
    }
}

function updateOwnerRecord(owner: HeldOwner, record: OwnerRecord): HeldOwner {
    let descriptor: number;
    try {
        descriptor = openSync(owner.file, fsConstants.O_WRONLY | noFollowFlag());
    } catch {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `database lifecycle owner cannot be updated safely: ${owner.file}`);
    }
    try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || !sameIdentity(opened, owner)) {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `database lifecycle owner identity changed before update: ${owner.file}`);
        }
        ftruncateSync(descriptor, 0);
        writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
        fsyncSync(descriptor);
        return { ...owner, record };
    } finally {
        closeSync(descriptor);
    }
}

function markExclusiveHeld(owner: HeldOwner, databaseIdentity: DatabaseFileIdentity, databaseFilename: string): HeldOwner {
    return updateOwnerRecord(owner, {
        ...owner.record,
        phase: 'held',
        databaseIdentity,
        databaseFilename,
        recoveryHash: null,
    });
}

function markExclusiveMutating(owner: HeldOwner, recoveryId?: string): HeldOwner {
    const expectedRecoveryHash = recoveryId === undefined ? null : recoveryHash(recoveryId);
    if (recoveryId !== undefined && owner.record.phase === 'mutating' && owner.record.recoveryHash === expectedRecoveryHash) {
        return owner;
    }
    if (owner.record.phase !== 'held' || owner.record.databaseIdentity === null) {
        throw lifecycleError(
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `exclusive lifecycle ownership cannot begin replacement for ${owner.record.databasePath}`,
        );
    }
    return updateOwnerRecord(owner, {
        ...owner.record,
        phase: 'mutating',
        recoveryHash: expectedRecoveryHash,
    });
}

function markExclusiveReplacementComplete(owner: HeldOwner): HeldOwner {
    if (owner.record.phase !== 'mutating' || owner.record.databaseIdentity === null) {
        throw lifecycleError(
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `exclusive lifecycle ownership has no replacement to complete for ${owner.record.databasePath}`,
        );
    }
    return updateOwnerRecord(owner, {
        ...owner.record,
        phase: 'held',
        recoveryHash: null,
    });
}

function recordSharedDatabaseIdentity(owner: HeldOwner, databaseIdentity: DatabaseFileIdentity, databaseFilename: string): HeldOwner {
    return updateOwnerRecord(owner, {
        ...owner.record,
        databaseIdentity,
        databaseFilename,
    });
}

function recordOpenedDatabaseFilename(
    owner: HeldOwner,
    databaseFilename: string,
    identity: Extract<DatabaseFileIdentity, { exists: true }>,
): HeldOwner {
    if (!validDatabaseFilename(databaseFilename)) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `opened SQLite physical filename is invalid: ${databaseFilename}`);
    }
    let physical: ReturnType<typeof lstatSync>;
    try {
        physical = lstatSync(databaseFilename);
    } catch {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `opened SQLite physical filename cannot be validated: ${databaseFilename}`);
    }
    if (!physical.isFile() || physical.isSymbolicLink() || String(physical.dev) !== identity.dev || String(physical.ino) !== identity.ino) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `opened SQLite physical filename changed: ${databaseFilename}`);
    }
    return updateOwnerRecord(owner, {
        ...owner.record,
        databaseFilename,
    });
}

function ownerLiveness(owner: HeldOwner): 'live' | 'dead' {
    try {
        process.kill(owner.record.pid, 0);
        return 'live';
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
            return 'dead';
        }
        if (code === 'EPERM') {
            return 'live';
        }
        throw lifecycleError(
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `cannot prove whether lifecycle owner process ${owner.record.pid} is alive: ${owner.file}`,
        );
    }
}

function revalidateDeadOwner(owner: HeldOwner, expectedKind: OwnerKind): HeldOwner | undefined {
    const current = readOwner(owner.file, expectedKind);
    if (current === undefined) {
        return undefined;
    }
    if (
        !sameIdentity(current, owner) ||
        current.record.ownerId !== owner.record.ownerId ||
        current.record.pid !== owner.record.pid ||
        current.record.databasePath !== owner.record.databasePath
    ) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `lifecycle ownership changed during liveness proof: ${owner.file}`);
    }
    return current;
}

function reclaimDeadExclusiveOwner(owner: HeldOwner): void {
    if (owner.record.phase === 'mutating') {
        throw lifecycleError(
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `exclusive owner died before managed database replacement was verified: ${owner.record.databasePath}`,
        );
    }
    if (owner.record.phase === 'held') {
        const recordedIdentity = owner.record.databaseIdentity;
        const databaseFilename = owner.record.databaseFilename;
        if (
            recordedIdentity === null ||
            databaseFilename === null ||
            !sameDatabaseIdentity(recordedIdentity, inspectDatabaseIdentity(owner.record.databasePath))
        ) {
            throw lifecycleError(
                DATABASE_LIFECYCLE_AMBIGUOUS,
                `exclusive owner died after the managed database identity changed before completion: ${owner.record.databasePath}`,
            );
        }
        assertRecordedDatabaseFilename(databaseFilename, recordedIdentity, 'exclusive');
        assertNoAmbiguousDatabaseCompanions(databaseFilename, 'exclusive');
    }
    releaseHeldOwner(owner);
}

function assertRecordedDatabaseFilename(databaseFilename: string, identity: DatabaseFileIdentity, ownerKind: OwnerKind): void {
    let descriptor: number;
    try {
        descriptor = openSync(databaseFilename, fsConstants.O_RDONLY | noFollowFlag());
    } catch (error: unknown) {
        if (isMissing(error) && !identity.exists) {
            return;
        }
        throw lifecycleError(
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `killed ${ownerKind} database physical filename cannot be opened safely: ${databaseFilename}`,
        );
    }
    try {
        const opened = fstatSync(descriptor);
        let current: ReturnType<typeof lstatSync>;
        try {
            current = lstatSync(databaseFilename);
        } catch {
            throw lifecycleError(
                DATABASE_LIFECYCLE_AMBIGUOUS,
                `killed ${ownerKind} database physical filename changed while inspected: ${databaseFilename}`,
            );
        }
        if (
            !identity.exists ||
            !opened.isFile() ||
            !current.isFile() ||
            current.isSymbolicLink() ||
            !sameIdentity(opened, current) ||
            String(opened.dev) !== identity.dev ||
            String(opened.ino) !== identity.ino
        ) {
            throw lifecycleError(
                DATABASE_LIFECYCLE_AMBIGUOUS,
                `killed ${ownerKind} database physical filename is not the recorded inode: ${databaseFilename}`,
            );
        }
    } finally {
        closeSync(descriptor);
    }
}

function inspectDatabaseCompanion(file: string, ownerKind: OwnerKind): number | undefined {
    let descriptor: number;
    try {
        descriptor = openSync(file, fsConstants.O_RDONLY | noFollowFlag());
    } catch (error: unknown) {
        if (isMissing(error)) {
            return undefined;
        }
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `killed ${ownerKind} database companion cannot be opened safely: ${file}`);
    }
    try {
        const opened = fstatSync(descriptor);
        let current: ReturnType<typeof lstatSync>;
        try {
            current = lstatSync(file);
        } catch {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `killed ${ownerKind} database companion changed while inspected: ${file}`);
        }
        if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || !sameIdentity(opened, current)) {
            throw lifecycleError(
                DATABASE_LIFECYCLE_AMBIGUOUS,
                `killed ${ownerKind} database companion is not a stable physical file: ${file}`,
            );
        }
        return opened.size;
    } finally {
        closeSync(descriptor);
    }
}

function assertNoAmbiguousDatabaseCompanions(databasePath: string, ownerKind: OwnerKind): void {
    const walBytes = inspectDatabaseCompanion(`${databasePath}-wal`, ownerKind);
    inspectDatabaseCompanion(`${databasePath}-shm`, ownerKind);
    const journalBytes = inspectDatabaseCompanion(`${databasePath}-journal`, ownerKind);
    if ((walBytes ?? 0) > 0 || (journalBytes ?? 0) > 0) {
        throw lifecycleError(
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `killed ${ownerKind} database owner left ambiguous companion state for ${databasePath}`,
        );
    }
}

function reclaimDeadSharedOwner(owner: HeldOwner): void {
    const recordedIdentity = owner.record.databaseIdentity;
    const databaseFilename = owner.record.databaseFilename;
    if (
        recordedIdentity === null ||
        databaseFilename === null ||
        !sameDatabaseIdentity(recordedIdentity, inspectDatabaseIdentity(owner.record.databasePath))
    ) {
        throw lifecycleError(
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `killed shared database owner has an unprovable database identity for ${owner.record.databasePath}`,
        );
    }
    assertRecordedDatabaseFilename(databaseFilename, recordedIdentity, 'shared');
    assertNoAmbiguousDatabaseCompanions(databaseFilename, 'shared');
    releaseHeldOwner(owner);
}

function exclusiveOwners(paths: DatabaseLifecyclePaths, databasePath: string): HeldOwner[] {
    let entries: import('node:fs').Dirent<string>[];
    try {
        entries = readdirSync(paths.exclusive, { withFileTypes: true, encoding: 'utf8' });
    } catch (error: unknown) {
        if (isMissing(error)) {
            return [];
        }
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `exclusive lifecycle owners cannot be enumerated for ${databasePath}`);
    }
    const owners: HeldOwner[] = [];
    for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith('intent-')) {
            throw lifecycleError(
                DATABASE_LIFECYCLE_AMBIGUOUS,
                `unrecognized exclusive lifecycle state: ${path.join(paths.exclusive, entry.name)}`,
            );
        }
        const owner = readOwner(path.join(paths.exclusive, entry.name), 'exclusive');
        if (owner !== undefined) {
            owners.push(owner);
        }
    }
    return owners;
}

function assertRecoveryOwnersMatch(owners: readonly HeldOwner[], databasePath: string, expectedRecoveryHash: string): void {
    const baseline = owners[0]?.record;
    if (baseline === undefined || baseline.databaseIdentity === null || baseline.databaseFilename === null) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `database lifecycle recovery ownership is inconsistent for ${databasePath}`);
    }
    const baselineIdentity = baseline.databaseIdentity;
    if (
        owners.some(
            (owner) =>
                owner.record.databasePath !== databasePath ||
                owner.record.phase !== 'mutating' ||
                owner.record.recoveryHash !== expectedRecoveryHash ||
                owner.record.databaseIdentity === null ||
                owner.record.databaseFilename !== baseline.databaseFilename ||
                !sameDatabaseIdentity(owner.record.databaseIdentity, baselineIdentity),
        )
    ) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `database lifecycle recovery ownership is inconsistent for ${databasePath}`);
    }
}

function claimDeadRecoverableExclusiveOwner(
    paths: DatabaseLifecyclePaths,
    databasePath: string,
    recoveryId: string,
): HeldOwner | undefined {
    const expectedRecoveryHash = recoveryHash(recoveryId);
    const candidates: HeldOwner[] = [];
    for (const owner of exclusiveOwners(paths, databasePath)) {
        if (
            owner.record.databasePath === databasePath &&
            owner.record.phase === 'mutating' &&
            owner.record.recoveryHash === expectedRecoveryHash
        ) {
            if (ownerLiveness(owner) !== 'dead') {
                throw lifecycleError(
                    DATABASE_LIFECYCLE_AMBIGUOUS,
                    `recoverable database lifecycle ownership is still live for ${databasePath}`,
                );
            }
            const current = revalidateDeadOwner(owner, 'exclusive');
            if (current === undefined) {
                throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `recoverable database lifecycle ownership changed for ${databasePath}`);
            }
            candidates.push(current);
            continue;
        }
        if (ownerLiveness(owner) === 'dead') {
            const current = revalidateDeadOwner(owner, 'exclusive');
            if (current !== undefined) {
                reclaimDeadExclusiveOwner(current);
            }
            continue;
        }
        const code = owner.record.phase === 'mutating' ? DATABASE_LIFECYCLE_AMBIGUOUS : DATABASE_LIFECYCLE_BUSY;
        throw lifecycleError(code, `exclusive database lifecycle intent is active for ${databasePath}`);
    }
    if (candidates.length === 0) {
        return undefined;
    }
    assertRecoveryOwnersMatch(candidates, databasePath, expectedRecoveryHash);
    const baseline = candidates[0]?.record;
    if (baseline?.databaseIdentity === null || baseline?.databaseIdentity === undefined || baseline.databaseFilename === null) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `database lifecycle recovery ownership is incomplete for ${databasePath}`);
    }
    const claimOwnerId = recoveryClaimOwnerId(
        [databasePath, expectedRecoveryHash, ...candidates.map((candidate) => candidate.record.ownerId).sort()].join('\n'),
    );
    const claimRecord: OwnerRecord = {
        ...newOwnerRecord('exclusive', databasePath),
        ownerId: claimOwnerId,
        databaseFilename: baseline.databaseFilename,
        phase: 'mutating',
        databaseIdentity: baseline.databaseIdentity,
        recoveryHash: expectedRecoveryHash,
    };
    const claimed = publishOwner(path.join(paths.exclusive, `intent-${claimOwnerId}`), claimRecord, paths.directory);
    // The newly published mutating owner deliberately remains if a predecessor
    // cannot be removed with proof, so no opener can observe the unresolved
    // migration as an ordinary database.
    for (const candidate of candidates) {
        const current = revalidateDeadOwner(candidate, 'exclusive');
        assertRecoveryOwnerStillClaimable(current, databasePath, expectedRecoveryHash);
        releaseHeldOwner(current);
    }
    return claimed;
}

function assertNoExclusiveOwner(paths: DatabaseLifecyclePaths, databasePath: string, permittedOwnerId?: string): void {
    for (const exclusive of exclusiveOwners(paths, databasePath)) {
        if (exclusive.record.ownerId === permittedOwnerId) {
            continue;
        }
        if (ownerLiveness(exclusive) === 'dead') {
            const current = revalidateDeadOwner(exclusive, 'exclusive');
            if (current !== undefined) {
                reclaimDeadExclusiveOwner(current);
            }
            continue;
        }
        const code = exclusive.record.phase === 'mutating' ? DATABASE_LIFECYCLE_AMBIGUOUS : DATABASE_LIFECYCLE_BUSY;
        throw lifecycleError(code, `exclusive database lifecycle intent is active for ${databasePath}`);
    }
}

function newOwnerRecord(kind: OwnerKind, databasePath: string): OwnerRecord {
    return {
        version: 1,
        kind,
        pid: process.pid,
        ownerId: randomUUID(),
        databasePath,
        databaseFilename: null,
        phase: kind === 'shared' ? 'shared' : 'acquiring',
        databaseIdentity: null,
        recoveryHash: null,
    };
}

export function acquireSharedDatabaseLifecycle(databasePath: string): SharedDatabaseLifecycleLease {
    const canonical = path.resolve(databasePath);
    const paths = databaseLifecyclePaths(canonical);
    prepareState(paths);
    countLiveSharedOwners(paths, canonical);
    assertNoExclusiveOwner(paths, canonical);
    const record = newOwnerRecord('shared', canonical);
    let held = publishOwner(path.join(paths.leases, `lease-${record.ownerId}`), record, paths.directory);
    let databaseIdentity: DatabaseFileIdentity;
    try {
        // An exclusive owner can publish after the first check but before this
        // lease. Rechecking after publication makes either side observe the
        // other before any database byte is touched.
        assertNoExclusiveOwner(paths, canonical);
        const location = inspectDatabaseLocation(canonical);
        databaseIdentity = location.identity;
        assertDatabaseAuthority(paths, canonical, databaseIdentity);
        held = recordSharedDatabaseIdentity(held, databaseIdentity, location.databaseFilename);
    } catch (error) {
        try {
            releaseHeldOwner(held);
        } catch (releaseError) {
            throw new AggregateError([error, releaseError], `Shared database lifecycle acquisition failed for ${canonical}`);
        }
        throw error;
    }
    let released = false;
    let closeUnproven = false;
    let databaseOpened = false;
    const lease: SharedDatabaseLifecycleLease = {
        kind: 'shared',
        databasePath: canonical,
        captureDatabaseIdentity: () => {
            const assertHeld = () => {
                if (released) {
                    throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `shared lifecycle lease is no longer held for ${canonical}`);
                }
            };
            assertHeld();
            if (!sameDatabaseIdentity(databaseIdentity, inspectDatabaseIdentity(canonical))) {
                throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database identity changed while opening ${canonical}`);
            }
            return databaseIdentityGuard(
                canonical,
                databaseIdentity,
                assertHeld,
                () => {
                    closeUnproven = true;
                    databaseOpened = true;
                    return () => {
                        closeUnproven = false;
                        lease.release();
                    };
                },
                (identity) => assertDatabaseAuthority(paths, canonical, identity),
                (created, databaseFilename) => {
                    held = recordSharedDatabaseIdentity(held, created, databaseFilename);
                    databaseIdentity = created;
                },
                () => {
                    if (databaseOpened) {
                        throw lifecycleError(DATABASE_LIFECYCLE_BUSY, `shared lifecycle lease already opened ${canonical}`);
                    }
                },
                (_database, databaseFilename, identity) => {
                    held = recordOpenedDatabaseFilename(held, databaseFilename, identity);
                    databaseOpened = true;
                },
            );
        },
        release: () => {
            if (!released) {
                if (closeUnproven) {
                    throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `managed database close remains unproven for ${canonical}`);
                }
                releaseHeldOwner(held);
                released = true;
            }
        },
    };
    return lease;
}

function publishExclusiveOwner(paths: DatabaseLifecyclePaths, databasePath: string): HeldOwner {
    for (let attempt = 0; attempt < DATABASE_LIFECYCLE_EXCLUSIVE_OWNER_PUBLICATION_ATTEMPTS; attempt++) {
        const record = newOwnerRecord('exclusive', databasePath);
        ensurePrivateDirectory(paths.exclusive);
        try {
            return publishOwner(path.join(paths.exclusive, `intent-${record.ownerId}`), record, paths.directory);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
    }
    throw lifecycleError(DATABASE_LIFECYCLE_BUSY, `could not publish exclusive database lifecycle intent for ${databasePath}`);
}

function countLiveSharedOwners(paths: DatabaseLifecyclePaths, databasePath: string): number {
    const entries = (() => {
        try {
            return readdirSync(paths.leases, { withFileTypes: true, encoding: 'utf8' });
        } catch {
            throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `shared lifecycle owners cannot be enumerated for ${databasePath}`);
        }
    })();
    let live = 0;
    for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith('lease-')) {
            throw lifecycleError(
                DATABASE_LIFECYCLE_AMBIGUOUS,
                `unrecognized shared lifecycle state: ${path.join(paths.leases, entry.name)}`,
            );
        }
        const owner = readOwner(path.join(paths.leases, entry.name), 'shared');
        if (owner === undefined) {
            continue;
        }
        if (ownerLiveness(owner) === 'dead') {
            const current = revalidateDeadOwner(owner, 'shared');
            if (current !== undefined) {
                reclaimDeadSharedOwner(current);
            }
        } else {
            live++;
        }
    }
    return live;
}

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function completeExclusiveAcquisition(paths: DatabaseLifecyclePaths, databasePath: string, owner: HeldOwner): Promise<HeldOwner> {
    const deadline = Date.now() + DATABASE_LIFECYCLE_ACQUIRE_TIMEOUT_MS;
    while (countLiveSharedOwners(paths, databasePath) > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw lifecycleError(DATABASE_LIFECYCLE_BUSY, `managed database connections did not close for ${databasePath}`);
        }
        await wait(Math.min(DATABASE_LIFECYCLE_POLL_MS, remaining));
    }
    assertNoExclusiveOwner(paths, databasePath, owner.record.ownerId);
    const location = inspectDatabaseLocation(databasePath);
    assertDatabaseAuthority(paths, databasePath, location.identity);
    return markExclusiveHeld(owner, location.identity, location.databaseFilename);
}

function assertExclusiveManagedDatabasesClosed(lease: ExclusiveDatabaseLifecycleLease, databasePath: string): void {
    const openDatabases = exclusiveLeaseOpenDatabases.get(lease);
    if (openDatabases === undefined) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `exclusive lifecycle database tracking is unavailable for ${databasePath}`);
    }
    if (openDatabases.size > 0) {
        throw lifecycleError(DATABASE_LIFECYCLE_BUSY, `managed database connections remain open for ${databasePath}`);
    }
}

export async function acquireExclusiveDatabaseLifecycle(
    databasePath: string,
    recoveryId?: string,
): Promise<ExclusiveDatabaseLifecycleLease> {
    const canonical = path.resolve(databasePath);
    const paths = databaseLifecyclePaths(canonical);
    prepareState(paths);
    const recovered = recoveryId === undefined ? undefined : claimDeadRecoverableExclusiveOwner(paths, canonical, recoveryId);
    let held: HeldOwner;
    if (recovered === undefined) {
        held = publishExclusiveOwner(paths, canonical);
        try {
            assertNoExclusiveOwner(paths, canonical, held.record.ownerId);
            held = await completeExclusiveAcquisition(paths, canonical, held);
        } catch (error) {
            try {
                releaseHeldOwner(held);
            } catch (releaseError) {
                throw new AggregateError([error, releaseError], `Exclusive database lifecycle acquisition failed for ${canonical}`);
            }
            throw error;
        }
    } else {
        held = recovered;
    }
    let released = false;
    const lease: ExclusiveDatabaseLifecycleLease = {
        kind: 'exclusive',
        databasePath: canonical,
        captureDatabaseIdentity: () => {
            assertExclusiveDatabaseLifecycle(lease, canonical);
            return databaseIdentityGuard(
                canonical,
                inspectDatabaseIdentity(canonical),
                () => assertExclusiveDatabaseLifecycle(lease, canonical),
                (database) => {
                    const openDatabases = exclusiveLeaseOpenDatabases.get(lease);
                    if (openDatabases === undefined) {
                        throw lifecycleError(
                            DATABASE_LIFECYCLE_AMBIGUOUS,
                            `exclusive lifecycle database tracking is unavailable for ${canonical}`,
                        );
                    }
                    openDatabases.add(database);
                    return () => openDatabases.delete(database);
                },
                undefined,
                undefined,
                () => assertExclusiveManagedDatabasesClosed(lease, canonical),
                (_database, databaseFilename, identity) => {
                    assertExclusiveManagedDatabasesClosed(lease, canonical);
                    held = recordOpenedDatabaseFilename(held, databaseFilename, identity);
                    exclusiveLeaseOwners.set(lease, held);
                },
            );
        },
        beginReplacement: (recoverableId) => {
            assertExclusiveDatabaseLifecycle(lease, canonical);
            assertExclusiveManagedDatabasesClosed(lease, canonical);
            held = markExclusiveMutating(held, recoverableId);
            exclusiveLeaseOwners.set(lease, held);
        },
        assertReplacementReady: () => {
            assertExclusiveDatabaseLifecycle(lease, canonical);
            if (held.record.phase !== 'mutating') {
                throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `exclusive lifecycle ownership is not ready to replace ${canonical}`);
            }
            assertExclusiveManagedDatabasesClosed(lease, canonical);
        },
        resolvePhysicalDatabaseFilename: () => {
            assertExclusiveDatabaseLifecycle(lease, canonical);
            if (held.record.phase !== 'mutating' || held.record.databaseFilename === null) {
                throw lifecycleError(
                    DATABASE_LIFECYCLE_AMBIGUOUS,
                    `exclusive lifecycle ownership cannot resolve the replacement filename for ${canonical}`,
                );
            }
            assertExclusiveManagedDatabasesClosed(lease, canonical);
            const current = inspectDatabaseLocation(canonical);
            if (current.databaseFilename !== held.record.databaseFilename) {
                throw lifecycleError(
                    DATABASE_LIFECYCLE_AMBIGUOUS,
                    `managed database physical filename changed during replacement: ${canonical}`,
                );
            }
            return current.databaseFilename;
        },
        completeReplacement: () => {
            assertExclusiveDatabaseLifecycle(lease, canonical);
            assertExclusiveManagedDatabasesClosed(lease, canonical);
            held = markExclusiveReplacementComplete(held);
            exclusiveLeaseOwners.set(lease, held);
        },
        release: () => {
            if (!released) {
                assertExclusiveManagedDatabasesClosed(lease, canonical);
                finalizeExclusiveAuthority(paths, held);
                releaseHeldOwner(held);
                released = true;
                exclusiveLeaseOwners.delete(lease);
                exclusiveLeaseOpenDatabases.delete(lease);
            }
        },
    };
    exclusiveLeaseOwners.set(lease, held);
    exclusiveLeaseOpenDatabases.set(lease, new Set());
    return lease;
}

export function assertExclusiveDatabaseLifecycle(lease: ExclusiveDatabaseLifecycleLease, databasePath: string): void {
    const canonical = path.resolve(databasePath);
    if (lease.kind !== 'exclusive' || lease.databasePath !== canonical) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `exclusive lifecycle lease does not cover ${canonical}`);
    }
    const held = exclusiveLeaseOwners.get(lease);
    if (held === undefined) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `exclusive lifecycle lease is no longer held for ${canonical}`);
    }
    const current = readOwner(held.file, 'exclusive');
    if (current === undefined || !sameIdentity(current, held) || current.record.ownerId !== held.record.ownerId) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `exclusive lifecycle ownership is no longer authoritative for ${canonical}`);
    }
}

export async function withSharedDatabaseLifecycle<T>(databasePath: string, operation: () => Promise<T> | T): Promise<T> {
    const lease = acquireSharedDatabaseLifecycle(databasePath);
    let result: T;
    try {
        result = await operation();
    } catch (error) {
        try {
            lease.release();
        } catch (releaseError) {
            throw new AggregateError(
                [error, releaseError],
                `Shared database lifecycle operation and release both failed for ${databasePath}`,
            );
        }
        throw error;
    }
    lease.release();
    return result;
}

export async function withExclusiveDatabaseLifecycle<T>(
    databasePath: string,
    operation: (lease: ExclusiveDatabaseLifecycleLease) => Promise<T> | T,
    recoveryId?: string,
): Promise<T> {
    const canonical = path.resolve(databasePath);
    const retainedKey = recoveryId === undefined ? undefined : recoverableLeaseKey(canonical, recoveryId);
    const retained = retainedKey === undefined ? undefined : retainedRecoverableExclusiveLeases.get(retainedKey);
    if (retained?.recoveryInProgress) {
        throw lifecycleError(DATABASE_LIFECYCLE_AMBIGUOUS, `database lifecycle recovery is already active for ${canonical}`);
    }
    const lease = retained?.lease ?? (await acquireExclusiveDatabaseLifecycle(canonical, recoveryId));
    if (retained !== undefined) {
        assertExclusiveDatabaseLifecycle(retained.lease, canonical);
        retained.recoveryInProgress = true;
    }
    let result: T;
    try {
        result = await operation(lease);
    } catch (error) {
        const held = exclusiveLeaseOwners.get(lease);
        if (held?.record.phase === 'mutating') {
            if (held.record.recoveryHash !== null) {
                retainedRecoverableExclusiveLeases.set(`${canonical}\0${held.record.recoveryHash}`, {
                    lease,
                    recoveryInProgress: false,
                });
            }
            throw error;
        }
        try {
            lease.release();
            if (retainedKey !== undefined) {
                retainedRecoverableExclusiveLeases.delete(retainedKey);
            }
        } catch (releaseError) {
            if (retained !== undefined) {
                retained.recoveryInProgress = false;
            }
            throw new AggregateError(
                [error, releaseError],
                `Exclusive database lifecycle operation and release both failed for ${databasePath}`,
            );
        }
        throw error;
    }
    try {
        lease.release();
    } catch (error) {
        if (retained !== undefined) {
            retained.recoveryInProgress = false;
        }
        throw error;
    }
    if (retainedKey !== undefined) {
        retainedRecoverableExclusiveLeases.delete(retainedKey);
    }
    return result;
}

export function requireManagedDatabaseCheckpointOnClose(db: Database.Database): void {
    checkpointOnCloseDatabases.add(db);
}

function checkpointBeforeManagedClose(db: Database.Database, databasePath: string): void {
    if (db.readonly || !checkpointOnCloseDatabases.has(db)) {
        return;
    }
    // Native close discards rollback/checkpoint errors. Finish rollback while
    // the handle can still report errors, then prove its committed WAL frames
    // reached the main file even when another hard-link reader prevents the
    // native close-time checkpoint. A busy checkpoint keeps the handle/key
    // and lifecycle ownership available for a retry after readers finish.
    if (db.inTransaction) {
        db.exec('ROLLBACK');
    }
    const rows = db.pragma('main.wal_checkpoint(PASSIVE)') as Array<{ busy?: unknown; log?: unknown; checkpointed?: unknown }>;
    const result = rows[0];
    if (
        rows.length !== 1 ||
        result?.busy !== 0 ||
        typeof result.log !== 'number' ||
        !Number.isInteger(result.log) ||
        result.log < -1 ||
        result.checkpointed !== result.log
    ) {
        throw lifecycleError(DATABASE_LIFECYCLE_BUSY, `managed database checkpoint did not complete for ${databasePath}`);
    }
}

export function holdSharedDatabaseLifecycleUntilClose(db: Database.Database, lease: SharedDatabaseLifecycleLease): void {
    const close = db.close.bind(db);
    let databaseClosed = false;
    sharedDatabasesHeldUntilClose.add(db);
    installDatabaseExitCleanup();
    db.close = () => {
        if (!databaseClosed) {
            checkpointBeforeManagedClose(db, lease.databasePath);
            close();
            databaseClosed = true;
        }
        lease.release();
        sharedDatabasesHeldUntilClose.delete(db);
        return db;
    };
}

export function holdExclusiveDatabaseLifecycleUntilClose(db: Database.Database, lease: ExclusiveDatabaseLifecycleLease): void {
    assertExclusiveDatabaseLifecycle(lease, lease.databasePath);
    const openDatabases = exclusiveLeaseOpenDatabases.get(lease);
    if (openDatabases === undefined) {
        throw lifecycleError(
            DATABASE_LIFECYCLE_AMBIGUOUS,
            `exclusive lifecycle database tracking is unavailable for ${lease.databasePath}`,
        );
    }
    const close = db.close.bind(db);
    let databaseClosed = false;
    openDatabases.add(db);
    db.close = () => {
        if (!databaseClosed) {
            checkpointBeforeManagedClose(db, lease.databasePath);
            close();
            databaseClosed = true;
            openDatabases.delete(db);
        }
        return db;
    };
}
