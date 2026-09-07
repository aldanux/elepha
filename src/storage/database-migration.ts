import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    type BigIntStats,
    chmodSync,
    closeSync,
    copyFileSync,
    existsSync,
    fchmodSync,
    constants as fsConstants,
    fstatSync,
    fsyncSync,
    linkSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    renameSync,
    statfsSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import {
    DATABASE_HEADER_BYTES,
    DATABASE_KEY_BYTES,
    DATABASE_MIGRATION_COPY_SPACE_DENOMINATOR,
    DATABASE_MIGRATION_COPY_SPACE_NUMERATOR,
    DATABASE_MIGRATION_HASH_CHUNK_BYTES,
    DATABASE_MIGRATION_QUIESCE_POLL_MS,
    DATABASE_MIGRATION_QUIESCE_TIMEOUT_MS,
    MINIMUM_NODE_VERSION,
    PRIVATE_DIR_MODE,
    PRIVATE_FILE_MODE,
} from '../config/constants.js';
import { elephaPaths } from '../config/paths.js';
import { errorMessage } from '../util/error.js';
import { atomicCopyPrivateFile } from '../util/fs.js';
import { listManagedBackups } from './backup.js';
import {
    type DatabaseEncryptionRuntime,
    type EncryptionBackend,
    type EncryptionMetadata,
    fsyncDirectory,
    readPrivateFile,
    readStoredDatabaseKey,
    selectBackend,
    storeDatabaseKey,
    writeEncryptionMetadata,
    writePrivateFileAtomic,
} from './database-encryption.js';
import { type ExclusiveDatabaseLifecycleLease, pinSQLitePathForOpen, withExclusiveDatabaseLifecycle } from './database-lifecycle.js';
import {
    assertEncryptedDatabaseFile,
    createPrivateEmptyDatabaseDescriptor,
    inspectPrivateEmptyDatabaseDescriptor,
    writeEncryptedDatabaseSnapshotWithKey,
} from './encrypted-database-export.js';

export const DATABASE_MIGRATION_IN_PROGRESS = 'migration_in_progress';
export const DATABASE_KEY_COMMITMENT_INDETERMINATE =
    'Database key commitment is indeterminate; migration remains blocked with the plaintext canonical.';

const SQLITE_PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const SQLITE_COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'] as const;
const MIGRATION_STAGES = [
    'quiesced',
    'rollback_copied',
    'sidecar_copied',
    'key_prepared',
    'sidecar_encrypted',
    'key_commitment_started',
    'key_committed',
    'backups_encrypted',
    'plaintext_closed',
    'wal_cleaned',
    'rolled_back_key_retained',
    'canonical_swapped',
    'committed_verified',
    'verified',
] as const;

type MigrationStage = (typeof MIGRATION_STAGES)[number];
type ManagedBackupMigrationStage = 'pending' | 'prepared' | 'replaced';

export interface ManagedBackupMigration {
    sourcePath: string;
    originalSha256: string;
    encryptedPath: string;
    encryptedSha256: string | null;
    stage: ManagedBackupMigrationStage;
}

export interface DatabaseMigrationManifest {
    version: 1;
    migrationId: string;
    backend: EncryptionBackend;
    installationId: string;
    sourcePath: string;
    originalSha256: string;
    rollbackPath: string;
    rollbackSha256?: string | null;
    sidecarPath: string;
    backups?: ManagedBackupMigration[];
    keySha256: string | null;
    stage: MigrationStage;
}

interface CompleteDatabaseMigrationManifest extends DatabaseMigrationManifest {
    rollbackSha256: string | null;
    backups: ManagedBackupMigration[];
}

export interface DatabaseMigrationStatePaths {
    lock: string;
    manifest: string;
}

export interface DatabaseMigrationRuntime extends DatabaseEncryptionRuntime {
    arch?: NodeJS.Architecture;
    nodeVersion?: string;
    libc?: 'glibc' | 'musl';
    statePaths?: DatabaseMigrationStatePaths;
    availableBytes?: (directory: string) => bigint;
    swapDatabase?: (sidecar: string, databasePath: string) => void;
    failpoint?: (point: string) => void;
}

export type DatabaseMigrationResult =
    | { status: 'migrated' }
    | { status: 'already-encrypted' }
    | { status: 'no-database' }
    | { status: 'recovered-plaintext' }
    | { status: 'no-active-migration' };

interface SchemaObject {
    type: string;
    name: string;
    table: string;
    sql: string | null;
}

interface DatabaseSnapshot {
    schema: SchemaObject[];
    rowCounts: Array<{ table: string; count: number | bigint }>;
}

interface HeldLock {
    file: string;
    dev: bigint | number;
    ino: bigint | number;
}

function statePaths(runtime: DatabaseMigrationRuntime): DatabaseMigrationStatePaths {
    if (runtime.statePaths) {
        return runtime.statePaths;
    }
    const paths = elephaPaths();
    return { lock: paths.migrationLock, manifest: paths.migrationManifest };
}

export function databaseMigrationIsActive(runtime: Pick<DatabaseMigrationRuntime, 'statePaths'> = {}): boolean {
    const paths = statePaths(runtime);
    return existsSync(paths.lock) || existsSync(paths.manifest);
}

export function assertDatabaseMigrationInactive(runtime: Pick<DatabaseMigrationRuntime, 'statePaths'> = {}): void {
    if (databaseMigrationIsActive(runtime)) {
        throw new Error(DATABASE_MIGRATION_IN_PROGRESS);
    }
}

function hit(runtime: DatabaseMigrationRuntime, point: string): void {
    runtime.failpoint?.(point);
}

function noFollowFlag(): number {
    return fsConstants.O_NOFOLLOW ?? 0;
}

function removeFile(file: string): void {
    try {
        unlinkSync(file);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

function processIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function readLockPid(file: string): number | undefined {
    const contents = readPrivateFile(file);
    if (contents === undefined) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(contents.toString('utf8')) as { pid?: unknown };
        return typeof parsed.pid === 'number' ? parsed.pid : undefined;
    } catch {
        return undefined;
    }
}

function acquireMigrationLock(paths: DatabaseMigrationStatePaths, runtime: DatabaseMigrationRuntime): HeldLock {
    const directory = path.dirname(paths.lock);
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
    chmodSync(directory, PRIVATE_DIR_MODE);
    for (let attempt = 0; attempt < 2; attempt++) {
        const candidate = path.join(directory, `.${path.basename(paths.lock)}.${process.pid}.${randomUUID()}.candidate`);
        let descriptor: number | undefined;
        let acquired: HeldLock | undefined;
        try {
            descriptor = openSync(
                candidate,
                fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
                PRIVATE_FILE_MODE,
            );
            fchmodSync(descriptor, PRIVATE_FILE_MODE);
            writeFileSync(descriptor, `${JSON.stringify({ version: 1, pid: process.pid })}\n`);
            fsyncSync(descriptor);
            const identity = fstatSync(descriptor);
            closeSync(descriptor);
            descriptor = undefined;
            // A hard link publishes the fully written inode without replacing an
            // existing lock, so a crash cannot leave a malformed lock target.
            linkSync(candidate, paths.lock);
            acquired = { file: paths.lock, dev: identity.dev, ino: identity.ino };
            removeFile(candidate);
            fsyncDirectory(directory);
            hit(runtime, 'after_lock_acquired');
            return acquired;
        } catch (error: unknown) {
            if (descriptor !== undefined) {
                closeSync(descriptor);
            }
            removeFile(candidate);
            if (acquired !== undefined) {
                releaseMigrationLock(acquired);
            }
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
            const pid = readLockPid(paths.lock);
            if (pid === undefined || processIsAlive(pid)) {
                throw new Error(DATABASE_MIGRATION_IN_PROGRESS);
            }
            removeFile(paths.lock);
            fsyncDirectory(directory);
        }
    }
    throw new Error(DATABASE_MIGRATION_IN_PROGRESS);
}

function releaseMigrationLock(lock: HeldLock): void {
    try {
        const current = lstatSync(lock.file);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === lock.dev && current.ino === lock.ino) {
            unlinkSync(lock.file);
            fsyncDirectory(path.dirname(lock.file));
        }
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

function migrationArtifactPaths(databasePath: string, migrationId: string): { rollback: string; sidecar: string } {
    const directory = path.dirname(databasePath);
    const basename = path.basename(databasePath);
    return {
        rollback: path.join(directory, `.${basename}.migration-${migrationId}.plaintext`),
        sidecar: path.join(directory, `.${basename}.migration-${migrationId}.encrypted`),
    };
}

function managedBackupArtifactPath(databasePath: string, migrationId: string, index: number): string {
    return path.join(path.dirname(databasePath), `.${path.basename(databasePath)}.migration-${migrationId}.backup-${index}.encrypted`);
}

function malformedManifest(file: string): never {
    throw new Error(`Database migration manifest is unreadable or malformed: ${file}; refusing to guess recovery state.`);
}

function readManifest(file: string, databasePath: string): DatabaseMigrationManifest | undefined {
    const contents = readPrivateFile(file);
    if (contents === undefined) {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents.toString('utf8'));
    } catch {
        return malformedManifest(file);
    }
    if (!parsed || typeof parsed !== 'object') {
        return malformedManifest(file);
    }
    const manifest = parsed as Partial<DatabaseMigrationManifest>;
    if (
        manifest.version !== 1 ||
        typeof manifest.migrationId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(manifest.migrationId) ||
        (manifest.backend !== 'keyring' && manifest.backend !== 'key-file') ||
        typeof manifest.installationId !== 'string' ||
        manifest.installationId.length === 0 ||
        manifest.sourcePath !== path.resolve(databasePath) ||
        typeof manifest.originalSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(manifest.originalSha256) ||
        typeof manifest.rollbackPath !== 'string' ||
        (manifest.rollbackSha256 !== undefined &&
            manifest.rollbackSha256 !== null &&
            (typeof manifest.rollbackSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.rollbackSha256))) ||
        typeof manifest.sidecarPath !== 'string' ||
        (manifest.keySha256 !== null && (typeof manifest.keySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.keySha256))) ||
        typeof manifest.stage !== 'string' ||
        !(MIGRATION_STAGES as readonly string[]).includes(manifest.stage)
    ) {
        return malformedManifest(file);
    }
    const expected = migrationArtifactPaths(manifest.sourcePath, manifest.migrationId);
    if (path.resolve(manifest.rollbackPath) !== expected.rollback || path.resolve(manifest.sidecarPath) !== expected.sidecar) {
        return malformedManifest(file);
    }
    if (manifest.backups === undefined && manifest.rollbackSha256 !== undefined) {
        return malformedManifest(file);
    }
    if (manifest.backups !== undefined && !Array.isArray(manifest.backups)) {
        return malformedManifest(file);
    }
    const backupDirectory = path.dirname(manifest.sourcePath);
    const backupPrefix = `${path.basename(manifest.sourcePath)}.bak-`;
    for (const [index, backup] of (manifest.backups ?? []).entries()) {
        if (
            !backup ||
            typeof backup !== 'object' ||
            typeof backup.sourcePath !== 'string' ||
            path.dirname(backup.sourcePath) !== backupDirectory ||
            !path.basename(backup.sourcePath).startsWith(backupPrefix) ||
            typeof backup.originalSha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(backup.originalSha256) ||
            backup.encryptedPath !== managedBackupArtifactPath(manifest.sourcePath, manifest.migrationId, index) ||
            (backup.encryptedSha256 !== null &&
                (typeof backup.encryptedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(backup.encryptedSha256))) ||
            (backup.stage !== 'pending' && backup.stage !== 'prepared' && backup.stage !== 'replaced') ||
            (backup.stage === 'pending') !== (backup.encryptedSha256 === null)
        ) {
            return malformedManifest(file);
        }
    }
    const backupPaths = (manifest.backups ?? []).map((backup) => backup.sourcePath);
    if (new Set(backupPaths).size !== backupPaths.length || JSON.stringify(backupPaths) !== JSON.stringify([...backupPaths].sort())) {
        return malformedManifest(file);
    }
    const requiresKeyDigest = !['quiesced', 'rollback_copied', 'sidecar_copied'].includes(manifest.stage);
    if (requiresKeyDigest === (manifest.keySha256 === null)) {
        return malformedManifest(file);
    }
    return manifest as DatabaseMigrationManifest;
}

function writeManifest(file: string, databasePath: string, manifest: DatabaseMigrationManifest): void {
    writePrivateFileAtomic(file, Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'), existsSync(file));
    const stored = readManifest(file, databasePath);
    if (JSON.stringify(stored) !== JSON.stringify(manifest)) {
        throw new Error(`Database migration manifest failed read-back verification: ${file}`);
    }
}

function transitionManifest(
    file: string,
    manifest: CompleteDatabaseMigrationManifest,
    stage: MigrationStage,
    runtime: DatabaseMigrationRuntime,
    fields: Partial<Pick<CompleteDatabaseMigrationManifest, 'backend' | 'installationId' | 'keySha256' | 'rollbackSha256'>> = {},
): CompleteDatabaseMigrationManifest {
    const next = { ...manifest, ...fields, stage };
    writeManifest(file, manifest.sourcePath, next);
    hit(runtime, `after_manifest_${stage}`);
    return next;
}

function rebaseUnfrozenManifest(manifestPath: string, manifest: CompleteDatabaseMigrationManifest): CompleteDatabaseMigrationManifest {
    if (manifest.stage !== 'quiesced' || existsSync(manifest.rollbackPath)) {
        return manifest;
    }
    const currentSha256 = hashFile(manifest.sourcePath);
    if (currentSha256 === manifest.originalSha256) {
        return manifest;
    }
    // A quiesced manifest precedes the immutable rollback snapshot. If the
    // original owner stopped in that narrow window, a later acknowledged
    // write becomes the new baseline instead of being overwritten by recovery.
    const rebased = { ...manifest, originalSha256: currentSha256 };
    writeManifest(manifestPath, manifest.sourcePath, rebased);
    return rebased;
}

function assertSupportedRuntime(runtime: DatabaseMigrationRuntime): void {
    const platform = runtime.platform ?? process.platform;
    const arch = runtime.arch ?? process.arch;
    if ((platform !== 'darwin' && platform !== 'linux') || (arch !== 'x64' && arch !== 'arm64')) {
        throw new Error(`Database encryption migration is unsupported on ${platform}/${arch}.`);
    }
    if (platform === 'linux') {
        const report = (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header;
        const libc = runtime.libc ?? (report.glibcVersionRuntime ? 'glibc' : 'musl');
        if (libc !== 'glibc' && libc !== 'musl') {
            throw new Error(`Database encryption migration is unsupported with ${String(libc)} libc.`);
        }
    }
    const current = (runtime.nodeVersion ?? process.versions.node).split('.').map(Number);
    const minimum = MINIMUM_NODE_VERSION.split('.').map(Number);
    if (
        current.length !== 3 ||
        current.some((part) => !Number.isInteger(part)) ||
        current[0] < minimum[0] ||
        (current[0] === minimum[0] && current[1] < minimum[1]) ||
        (current[0] === minimum[0] && current[1] === minimum[1] && current[2] < minimum[2])
    ) {
        throw new Error(
            `Database encryption migration requires Node >=${MINIMUM_NODE_VERSION}; observed ${runtime.nodeVersion ?? process.versions.node}.`,
        );
    }
}

function hasPlaintextHeader(file: string): boolean {
    const descriptor = openSync(file, fsConstants.O_RDONLY | noFollowFlag());
    try {
        const header = Buffer.alloc(DATABASE_HEADER_BYTES);
        const bytesRead = readSync(descriptor, header, 0, header.length, 0);
        return bytesRead === SQLITE_PLAINTEXT_HEADER.length && header.equals(SQLITE_PLAINTEXT_HEADER);
    } finally {
        closeSync(descriptor);
    }
}

function hashFile(file: string): string {
    const descriptor = openSync(file, fsConstants.O_RDONLY | noFollowFlag());
    try {
        if (!fstatSync(descriptor).isFile()) {
            throw new Error(`Database migration requires a regular file: ${file}`);
        }
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(DATABASE_MIGRATION_HASH_CHUNK_BYTES);
        let bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
        while (bytesRead > 0) {
            hash.update(buffer.subarray(0, bytesRead));
            bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
        }
        return hash.digest('hex');
    } finally {
        closeSync(descriptor);
    }
}

function availableBytes(directory: string): bigint {
    const stats = statfsSync(directory, { bigint: true });
    return stats.bavail * stats.bsize;
}

function assertEnoughSpace(databasePath: string, runtime: DatabaseMigrationRuntime): void {
    const walPath = `${databasePath}-wal`;
    const size = BigInt(statSync(databasePath).size) + (existsSync(walPath) ? BigInt(statSync(walPath).size) : 0n);
    const denominator = BigInt(DATABASE_MIGRATION_COPY_SPACE_DENOMINATOR);
    const required = (size * BigInt(DATABASE_MIGRATION_COPY_SPACE_NUMERATOR) + denominator - 1n) / denominator;
    const available = (runtime.availableBytes ?? availableBytes)(path.dirname(databasePath));
    if (available < required) {
        throw new Error(`Database encryption migration requires ${required} free bytes; only ${available} are available.`);
    }
}

function assertIntegrity(db: Database.Database, label: string): void {
    const rows = db.pragma('integrity_check') as Array<Record<string, unknown>>;
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') {
        throw new Error(`${label} failed SQLite integrity_check.`);
    }
    const foreignKeys = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeys.length !== 0) {
        throw new Error(`${label} has ${foreignKeys.length} foreign-key violation(s).`);
    }
}

function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function snapshotDatabase(db: Database.Database): DatabaseSnapshot {
    const schema = db
        .prepare(
            "SELECT type, name, tbl_name AS 'table', sql FROM sqlite_master WHERE type IN ('table','index','view','trigger') ORDER BY type, name",
        )
        .all() as SchemaObject[];
    const tables = schema.filter((object) => object.type === 'table').map((object) => object.name);
    const rowCounts = tables.map((table) => ({
        table,
        count: (db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number | bigint }).count,
    }));
    return { schema, rowCounts };
}

function assertMatchesSnapshot(db: Database.Database, expected: DatabaseSnapshot, label: string): void {
    const actual = snapshotDatabase(db);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label} schema or per-table row counts differ from the plaintext source.`);
    }
}

function plaintextDatabaseVerificationError(databasePath: string, errorPrefix: string, cause: unknown): Error {
    return new Error(`${errorPrefix}: ${databasePath}: ${errorMessage(cause)}`, { cause });
}

function managedBackupOpenCleanupCause(primary: unknown, db?: Database.Database, seal?: ReturnType<typeof pinSQLitePathForOpen>): unknown {
    const failures = [primary];
    if (db !== undefined) {
        try {
            db.close();
        } catch (error) {
            failures.push(error);
        }
    }
    if (seal !== undefined) {
        try {
            seal.release();
        } catch (error) {
            failures.push(error);
        }
    }
    return failures.length === 1
        ? primary
        : new AggregateError(failures, 'Managed backup validation and cleanup both failed.', { cause: primary });
}

function existingSQLiteCompanion(databasePath: string): string | undefined {
    return SQLITE_COMPANION_SUFFIXES.map((suffix) => `${databasePath}${suffix}`).find(
        (companionPath) => lstatSync(companionPath, { throwIfNoEntry: false }) !== undefined,
    );
}

function installSQLiteCompanionCleanup(db: Database.Database, databasePath: string): void {
    const close = db.close.bind(db);
    let nativeClosed = false;
    let cleanupComplete = false;
    db.close = () => {
        if (cleanupComplete) {
            return db;
        }
        if (!nativeClosed) {
            close();
            nativeClosed = true;
        }
        const failures: unknown[] = [];
        for (const suffix of SQLITE_COMPANION_SUFFIXES) {
            const companionPath = `${databasePath}${suffix}`;
            let failure: unknown;
            try {
                const observed = lstatSync(companionPath, { bigint: true, throwIfNoEntry: false });
                const confirmed = observed === undefined ? undefined : lstatSync(companionPath, { bigint: true });
                const same =
                    observed !== undefined &&
                    confirmed !== undefined &&
                    observed.dev === confirmed.dev &&
                    observed.ino === confirmed.ino &&
                    observed.ctimeNs === confirmed.ctimeNs;
                const admitted =
                    same &&
                    confirmed.isFile() &&
                    !confirmed.isSymbolicLink() &&
                    ((suffix === '-wal' && confirmed.size === 0n) || (suffix === '-shm' && confirmed.size === 32_768n));
                if (admitted) {
                    unlinkSync(companionPath);
                } else if (observed !== undefined) {
                    failure = new Error(`Readonly SQLite verification left an unrecognized companion: ${companionPath}`);
                }
                if (admitted && lstatSync(companionPath, { throwIfNoEntry: false }) !== undefined) {
                    failure = new Error(`Readonly SQLite verification companion cleanup failed: ${companionPath}`);
                }
            } catch (error) {
                failure = error;
            }
            if (failure !== undefined) {
                failures.push(failure);
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, `Readonly SQLite verification companion cleanup failed for ${databasePath}.`);
        }
        cleanupComplete = true;
        return db;
    };
}

function openVerifiedPlaintextDatabase(
    databasePath: string,
    expectedSha256?: string,
    integrityLabel = 'Managed backup',
    errorPrefix = 'Managed backup is unrecognized or unverifiable',
    readonly = true,
): Database.Database {
    let stats: BigIntStats;
    let plaintext: boolean;
    try {
        stats = lstatSync(databasePath, { bigint: true });
        plaintext = hasPlaintextHeader(databasePath);
    } catch (error) {
        throw plaintextDatabaseVerificationError(databasePath, errorPrefix, error);
    }
    if (!stats.isFile() || stats.isSymbolicLink() || !plaintext) {
        const cause = new Error('expected a regular plaintext SQLite database');
        throw plaintextDatabaseVerificationError(databasePath, errorPrefix, cause);
    }
    if (expectedSha256 !== undefined) {
        let actualSha256: string;
        try {
            actualSha256 = hashFile(databasePath);
        } catch (error) {
            throw plaintextDatabaseVerificationError(databasePath, errorPrefix, error);
        }
        if (actualSha256 !== expectedSha256) {
            const cause = new Error('contents changed after migration preflight');
            throw plaintextDatabaseVerificationError(databasePath, errorPrefix, cause);
        }
    }
    const existingCompanion = existingSQLiteCompanion(databasePath);
    if (existingCompanion !== undefined) {
        const cause = new Error(`unexpected SQLite companion exists: ${existingCompanion}`);
        throw plaintextDatabaseVerificationError(databasePath, errorPrefix, cause);
    }
    let seal: ReturnType<typeof pinSQLitePathForOpen>;
    try {
        seal = pinSQLitePathForOpen(databasePath, {
            dev: stats.dev,
            ino: stats.ino,
            ctimeNs: stats.ctimeNs,
            nlink: stats.nlink,
        });
    } catch (error) {
        throw plaintextDatabaseVerificationError(databasePath, errorPrefix, error);
    }
    let db: Database.Database;
    try {
        db = new Database(seal.sqlitePath, { readonly, fileMustExist: true, timeout: 0 });
        installSQLiteCompanionCleanup(db, databasePath);
    } catch (error) {
        throw plaintextDatabaseVerificationError(databasePath, errorPrefix, managedBackupOpenCleanupCause(error, undefined, seal));
    }
    try {
        seal.confirmOpen(db);
        assertIntegrity(db, integrityLabel);
    } catch (error) {
        throw plaintextDatabaseVerificationError(databasePath, errorPrefix, managedBackupOpenCleanupCause(error, db, seal));
    }
    try {
        seal.release();
    } catch (error) {
        throw plaintextDatabaseVerificationError(databasePath, errorPrefix, managedBackupOpenCleanupCause(error, db));
    }
    return db;
}

function preflightManagedBackups(databasePath: string): Array<Pick<ManagedBackupMigration, 'sourcePath' | 'originalSha256'>> {
    return listManagedBackups(databasePath).map((backupPath) => {
        const backup = openVerifiedPlaintextDatabase(backupPath);
        backup.close();
        return { sourcePath: backupPath, originalSha256: hashFile(backupPath) };
    });
}

function normalizeLegacyManifest(
    manifestPath: string,
    manifest: DatabaseMigrationManifest,
    runtime: DatabaseMigrationRuntime,
): CompleteDatabaseMigrationManifest {
    if (manifest.backups !== undefined && manifest.rollbackSha256 !== undefined) {
        return manifest as CompleteDatabaseMigrationManifest;
    }
    let backups: ManagedBackupMigration[];
    if (manifest.backups !== undefined) {
        backups = manifest.backups;
    } else {
        backups = preflightManagedBackups(manifest.sourcePath).map((backup, index) => ({
            ...backup,
            encryptedPath: managedBackupArtifactPath(manifest.sourcePath, manifest.migrationId, index),
            encryptedSha256: null,
            stage: 'pending',
        }));
    }
    const normalized: CompleteDatabaseMigrationManifest = {
        ...manifest,
        rollbackSha256: manifest.rollbackSha256 ?? null,
        backups,
    };
    writeManifest(manifestPath, manifest.sourcePath, normalized);
    hit(runtime, 'after_manifest_legacy_normalized');
    return normalized;
}

function preflightPlaintextDatabase(databasePath: string, runtime: DatabaseMigrationRuntime): void {
    assertEnoughSpace(databasePath, runtime);
    const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
        assertIntegrity(db, 'Plaintext database preflight');
    } finally {
        db.close();
    }
}

function checkpointResult(db: Database.Database): { busy: number } {
    const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: unknown }>;
    if (rows.length !== 1 || typeof rows[0].busy !== 'number') {
        throw new Error('SQLite returned an invalid wal_checkpoint result during database migration.');
    }
    return rows[0] as { busy: number };
}

function assertNoHotJournal(databasePath: string): void {
    const journal = `${databasePath}-journal`;
    if (existsSync(journal) && statSync(journal).size !== 0) {
        throw new Error(`Refusing database migration while a hot rollback journal exists: ${journal}`);
    }
}

function assertPlaintextCheckpointReady(result: { busy: number }): void {
    if (result.busy !== 0) {
        throw new Error('Refusing database migration because the WAL checkpoint is busy.');
    }
}

function assertPlaintextDeleteJournalMode(journalMode: unknown): void {
    if (journalMode !== 'delete') {
        throw new Error(`Database migration could not switch SQLite to DELETE journal mode (observed ${String(journalMode)}).`);
    }
}

function switchPlaintextToDeleteJournalMode(db: Database.Database): unknown {
    // A pre-lifecycle daemon can retain its WAL reader briefly after the
    // service manager reports it stopped. Persistent readers still fail closed.
    const deadline = Date.now() + DATABASE_MIGRATION_QUIESCE_TIMEOUT_MS;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
        try {
            return db.pragma('journal_mode = DELETE', { simple: true });
        } catch (error) {
            if (!(error instanceof Database.SqliteError) || error.code !== 'SQLITE_BUSY') {
                throw error;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw error;
            }
            Atomics.wait(wait, 0, 0, Math.min(DATABASE_MIGRATION_QUIESCE_POLL_MS, remaining));
        }
    }
}

function quiescePlaintextDatabase(databasePath: string, runtime: DatabaseMigrationRuntime): Database.Database {
    const db = new Database(databasePath, { fileMustExist: true, timeout: 0 });
    try {
        db.exec('BEGIN EXCLUSIVE');
        db.exec('ROLLBACK');
        assertPlaintextCheckpointReady(checkpointResult(db));
        const journalMode = switchPlaintextToDeleteJournalMode(db);
        assertPlaintextDeleteJournalMode(journalMode);
        assertNoHotJournal(databasePath);
        db.exec('BEGIN EXCLUSIVE');
        assertIntegrity(db, 'Quiesced plaintext database');
        hit(runtime, 'after_plaintext_quiesced');
        return db;
    } catch (error) {
        if (db.inTransaction) {
            db.exec('ROLLBACK');
        }
        db.close();
        throw error;
    }
}

function closePlaintextDatabase(db: Database.Database, runtime: DatabaseMigrationRuntime): void {
    if (db.inTransaction) {
        db.exec('ROLLBACK');
    }
    db.close();
    hit(runtime, 'after_plaintext_closed');
}

function rawKeyBuffer(key: Buffer): Buffer {
    return Buffer.from(`raw:${key.toString('hex')}`, 'ascii');
}

function openKeyedDatabase(databasePath: string, key: Buffer, readonly = false): Database.Database {
    const db = new Database(databasePath, { readonly, fileMustExist: true, timeout: 0 });
    const rawKey = rawKeyBuffer(key);
    try {
        db.pragma("cipher='chacha20'");
        db.key(rawKey);
        db.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
        return db;
    } catch (error) {
        db.close();
        throw error;
    } finally {
        rawKey.fill(0);
    }
}

function syncFile(file: string): void {
    const descriptor = openSync(file, fsConstants.O_RDONLY | noFollowFlag());
    try {
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function transitionManagedBackup(
    manifestPath: string,
    manifest: CompleteDatabaseMigrationManifest,
    index: number,
    backup: ManagedBackupMigration,
    runtime: DatabaseMigrationRuntime,
): CompleteDatabaseMigrationManifest {
    const backups = manifest.backups.map((current, currentIndex) => (currentIndex === index ? backup : current));
    const next = { ...manifest, backups };
    writeManifest(manifestPath, manifest.sourcePath, next);
    hit(runtime, `after_manifest_backup_${backup.stage}`);
    return next;
}

function assertManagedBackupSet(manifest: CompleteDatabaseMigrationManifest): void {
    const expected = manifest.backups.map((backup) => backup.sourcePath);
    if (JSON.stringify(listManagedBackups(manifest.sourcePath)) !== JSON.stringify(expected)) {
        throw new Error('Managed backup set changed after migration preflight; refusing to continue.');
    }
}

function verifyEncryptedManagedBackup(databasePath: string, encryptedSha256: string, key: Buffer, label: string): void {
    if (hashFile(databasePath) !== encryptedSha256) {
        throw new Error(`${label} changed after encryption verification.`);
    }
    assertEncryptedDatabaseFile(databasePath, key, label);
    const db = openKeyedDatabase(databasePath, key, true);
    try {
        assertIntegrity(db, label);
    } finally {
        db.close();
    }
}

function buildEncryptedManagedBackup(backup: ManagedBackupMigration, key: Buffer): string {
    removeFile(backup.encryptedPath);
    const plaintextCopy = `${backup.encryptedPath}.plaintext`;
    removeFile(plaintextCopy);
    let source: Database.Database;
    let copyPrepared = false;
    try {
        copyFileSync(backup.sourcePath, plaintextCopy, fsConstants.COPYFILE_EXCL);
        chmodSync(plaintextCopy, PRIVATE_FILE_MODE);
        if (hashFile(plaintextCopy) !== backup.originalSha256) {
            throw new Error('Managed backup changed while creating its private migration copy.');
        }
        source = openVerifiedPlaintextDatabase(
            plaintextCopy,
            backup.originalSha256,
            'Managed backup migration copy',
            'Managed backup migration copy is unrecognized or unverifiable',
            false,
        );
        copyPrepared = true;
    } finally {
        if (!copyPrepared) {
            removeFile(plaintextCopy);
        }
    }
    let descriptor: number | undefined;
    try {
        descriptor = createPrivateEmptyDatabaseDescriptor(backup.encryptedPath);
        const identity = inspectPrivateEmptyDatabaseDescriptor(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        writeEncryptedDatabaseSnapshotWithKey(source, backup.encryptedPath, identity, key);
    } catch (error) {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
        removeFile(backup.encryptedPath);
        throw error;
    } finally {
        try {
            source.close();
        } finally {
            removeFile(plaintextCopy);
        }
    }
    syncFile(backup.encryptedPath);
    fsyncDirectory(path.dirname(backup.encryptedPath));
    const encryptedSha256 = hashFile(backup.encryptedPath);
    verifyEncryptedManagedBackup(backup.encryptedPath, encryptedSha256, key, 'Encrypted managed backup replacement');
    const unchanged = openVerifiedPlaintextDatabase(backup.sourcePath, backup.originalSha256);
    unchanged.close();
    return encryptedSha256;
}

function convertManagedBackups(
    manifestPath: string,
    initialManifest: CompleteDatabaseMigrationManifest,
    key: Buffer,
    runtime: DatabaseMigrationRuntime,
): CompleteDatabaseMigrationManifest {
    let manifest = initialManifest;
    assertManagedBackupSet(manifest);
    for (let index = 0; index < manifest.backups.length; index++) {
        let backup = manifest.backups[index];
        if (backup === undefined) {
            throw new Error('Database migration manifest lost a managed backup entry.');
        }
        if (backup.stage === 'replaced') {
            verifyEncryptedManagedBackup(backup.sourcePath, backup.encryptedSha256 ?? '', key, 'Encrypted managed backup');
            continue;
        }
        if (backup.stage === 'prepared' && !existsSync(backup.encryptedPath) && !hasPlaintextHeader(backup.sourcePath)) {
            verifyEncryptedManagedBackup(backup.sourcePath, backup.encryptedSha256 ?? '', key, 'Encrypted managed backup');
            manifest = transitionManagedBackup(manifestPath, manifest, index, { ...backup, stage: 'replaced' }, runtime);
            continue;
        }
        if (backup.stage === 'pending' || !existsSync(backup.encryptedPath)) {
            const encryptedSha256 = buildEncryptedManagedBackup(backup, key);
            backup = { ...backup, encryptedSha256, stage: 'prepared' };
            manifest = transitionManagedBackup(manifestPath, manifest, index, backup, runtime);
        } else {
            verifyEncryptedManagedBackup(backup.encryptedPath, backup.encryptedSha256 ?? '', key, 'Encrypted managed backup replacement');
        }
        const original = openVerifiedPlaintextDatabase(backup.sourcePath, backup.originalSha256);
        original.close();
        renameSync(backup.encryptedPath, backup.sourcePath);
        fsyncDirectory(path.dirname(backup.sourcePath));
        hit(runtime, 'after_managed_backup_replaced');
        verifyEncryptedManagedBackup(backup.sourcePath, backup.encryptedSha256 ?? '', key, 'Encrypted managed backup');
        manifest = transitionManagedBackup(manifestPath, manifest, index, { ...backup, stage: 'replaced' }, runtime);
    }
    assertManagedBackupSet(manifest);
    return manifest;
}

function assertManagedBackupsEncrypted(manifest: CompleteDatabaseMigrationManifest, key: Buffer): void {
    assertManagedBackupSet(manifest);
    for (const backup of manifest.backups) {
        if (backup.stage !== 'replaced' || backup.encryptedSha256 === null) {
            throw new Error('Database migration reached canonical replacement before every managed backup was encrypted.');
        }
        verifyEncryptedManagedBackup(backup.sourcePath, backup.encryptedSha256, key, 'Encrypted managed backup');
    }
}

function verifyEncryptedMigrationArtifact(
    databasePath: string,
    key: Buffer,
    expected: DatabaseSnapshot,
    label: string,
    expectedSha256?: string,
): string {
    const sha256 = hashFile(databasePath);
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
        throw new Error(`${label} changed after encryption verification.`);
    }
    assertEncryptedDatabaseFile(databasePath, key, label);
    const verified = openKeyedDatabase(databasePath, key, true);
    try {
        assertIntegrity(verified, label);
        assertMatchesSnapshot(verified, expected, label);
    } finally {
        verified.close();
    }
    return sha256;
}

function buildEncryptedMigrationArtifact(
    source: Database.Database,
    destinationPath: string,
    key: Buffer,
    expected: DatabaseSnapshot,
    label: string,
): string {
    removeFile(destinationPath);
    let descriptor: number | undefined;
    try {
        descriptor = createPrivateEmptyDatabaseDescriptor(destinationPath);
        const identity = inspectPrivateEmptyDatabaseDescriptor(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        writeEncryptedDatabaseSnapshotWithKey(source, destinationPath, identity, key);
        syncFile(destinationPath);
        fsyncDirectory(path.dirname(destinationPath));
        return verifyEncryptedMigrationArtifact(destinationPath, key, expected, label);
    } catch (error) {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
        removeFile(destinationPath);
        throw error;
    }
}

function encryptionMetadata(manifest: DatabaseMigrationManifest): EncryptionMetadata {
    return { backend: manifest.backend, installationId: manifest.installationId, mode: 'default' };
}

function keyMatchesManifest(key: Buffer, manifest: DatabaseMigrationManifest): boolean {
    return manifest.keySha256 !== null && createHash('sha256').update(key).digest('hex') === manifest.keySha256;
}

async function storedMigrationKey(
    databasePath: string,
    manifest: DatabaseMigrationManifest,
    runtime: DatabaseMigrationRuntime,
): Promise<Buffer | undefined> {
    const key = await readStoredDatabaseKey(databasePath, encryptionMetadata(manifest), runtime);
    if (key !== undefined && !keyMatchesManifest(key, manifest)) {
        key.fill(0);
        throw new Error('The stored database key does not match the active migration manifest.');
    }
    return key;
}

function recordEncryptedRollback(
    manifestPath: string,
    manifest: CompleteDatabaseMigrationManifest,
    rollbackSha256: string,
    runtime: DatabaseMigrationRuntime,
): CompleteDatabaseMigrationManifest {
    const next = { ...manifest, rollbackSha256 };
    writeManifest(manifestPath, manifest.sourcePath, next);
    hit(runtime, 'after_manifest_rollback_encrypted');
    return next;
}

function assertLegacyPlaintextRollback(manifest: CompleteDatabaseMigrationManifest, expected: DatabaseSnapshot): void {
    const rollback = openVerifiedPlaintextDatabase(
        manifest.rollbackPath,
        manifest.originalSha256,
        'Legacy plaintext rollback database',
        'Legacy plaintext rollback is unrecognized or unverifiable',
    );
    try {
        assertMatchesSnapshot(rollback, expected, 'Legacy plaintext rollback database');
    } finally {
        rollback.close();
    }
}

function ensureEncryptedCandidatesFromPlaintext(
    manifestPath: string,
    initialManifest: CompleteDatabaseMigrationManifest,
    source: Database.Database,
    key: Buffer,
    expected: DatabaseSnapshot,
    runtime: DatabaseMigrationRuntime,
): CompleteDatabaseMigrationManifest {
    let manifest = initialManifest;
    if (!existsSync(manifest.sidecarPath) || hasPlaintextHeader(manifest.sidecarPath)) {
        buildEncryptedMigrationArtifact(source, manifest.sidecarPath, key, expected, 'Encrypted database sidecar');
        hit(runtime, 'after_sidecar_encrypted');
        hit(runtime, 'after_sidecar_verified');
    } else {
        verifyEncryptedMigrationArtifact(manifest.sidecarPath, key, expected, 'Encrypted database sidecar');
    }
    if (manifest.rollbackSha256 === null) {
        if (existsSync(manifest.rollbackPath) && hasPlaintextHeader(manifest.rollbackPath)) {
            assertLegacyPlaintextRollback(manifest, expected);
        }
        const rollbackSha256 = buildEncryptedMigrationArtifact(source, manifest.rollbackPath, key, expected, 'Encrypted rollback database');
        hit(runtime, 'after_rollback_encrypted');
        hit(runtime, 'after_rollback_verified');
        manifest = recordEncryptedRollback(manifestPath, manifest, rollbackSha256, runtime);
    } else {
        verifyEncryptedMigrationArtifact(manifest.rollbackPath, key, expected, 'Encrypted rollback database', manifest.rollbackSha256);
    }
    return manifest;
}

function cleanupUncommittedMigration(
    manifestPath: string,
    manifest: CompleteDatabaseMigrationManifest,
    runtime: DatabaseMigrationRuntime,
    completeReplacement: () => void,
): void {
    for (const backup of manifest.backups) {
        removeFile(backup.encryptedPath);
    }
    removeFile(manifest.sidecarPath);
    removeFile(manifest.rollbackPath);
    removeFile(`${manifest.rollbackPath}.encrypted`);
    fsyncDirectory(path.dirname(manifest.sourcePath));
    hit(runtime, 'after_uncommitted_artifacts_removed');
    completeReplacement();
    removeFile(manifestPath);
    fsyncDirectory(path.dirname(manifestPath));
    hit(runtime, 'after_manifest_removed');
}

async function commitKey(
    manifestPath: string,
    manifest: CompleteDatabaseMigrationManifest,
    key: Buffer,
    runtime: DatabaseMigrationRuntime,
): Promise<CompleteDatabaseMigrationManifest> {
    const committing = transitionManifest(manifestPath, manifest, 'key_commitment_started', runtime);
    const metadata = encryptionMetadata(manifest);
    let writeError: unknown;
    try {
        await storeDatabaseKey(manifest.sourcePath, metadata, key, runtime);
    } catch (error) {
        writeError = error;
    }
    let readBack: Buffer | undefined;
    try {
        readBack = await readStoredDatabaseKey(manifest.sourcePath, metadata, runtime);
    } catch (readError) {
        if (writeError !== undefined) {
            throw new AggregateError([writeError, readError], DATABASE_KEY_COMMITMENT_INDETERMINATE);
        }
        throw new Error(DATABASE_KEY_COMMITMENT_INDETERMINATE, { cause: readError });
    }
    if (readBack === undefined) {
        throw new Error(DATABASE_KEY_COMMITMENT_INDETERMINATE, writeError === undefined ? undefined : { cause: writeError });
    }
    const matches = readBack.equals(key) && keyMatchesManifest(readBack, committing);
    readBack.fill(0);
    if (!matches) {
        throw new Error('Database key failed byte-for-byte read-back verification.');
    }
    hit(runtime, 'after_key_stored');
    hit(runtime, 'after_key_read_back');
    writeEncryptionMetadata(manifest.sourcePath, metadata);
    hit(runtime, 'after_encryption_metadata_written');
    return transitionManifest(manifestPath, committing, 'key_committed', runtime);
}

function removeInactiveWalFiles(databasePath: string, runtime: DatabaseMigrationRuntime): void {
    const wal = `${databasePath}-wal`;
    if (existsSync(wal) && statSync(wal).size !== 0) {
        throw new Error(`Refusing to remove a nonempty WAL during database migration: ${wal}`);
    }
    removeFile(wal);
    removeFile(`${databasePath}-shm`);
    fsyncDirectory(path.dirname(databasePath));
    hit(runtime, 'after_inactive_wal_removed');
}

function restoreLegacyPlaintextCanonical(manifest: CompleteDatabaseMigrationManifest, runtime: DatabaseMigrationRuntime): void {
    if (!existsSync(manifest.rollbackPath) || hashFile(manifest.rollbackPath) !== manifest.originalSha256) {
        throw new Error('Cannot restore the plaintext database because its byte-exact rollback copy is unavailable.');
    }
    atomicCopyPrivateFile(manifest.rollbackPath, manifest.sourcePath, PRIVATE_FILE_MODE);
    syncFile(manifest.sourcePath);
    fsyncDirectory(path.dirname(manifest.sourcePath));
    if (hashFile(manifest.sourcePath) !== manifest.originalSha256) {
        throw new Error('Restored plaintext database failed SHA-256 verification.');
    }
    const db = new Database(manifest.sourcePath, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
        assertIntegrity(db, 'Restored plaintext database');
    } finally {
        db.close();
    }
    hit(runtime, 'after_plaintext_rollback_restored');
}

function verifyEncryptedRollback(manifest: CompleteDatabaseMigrationManifest, key: Buffer, expected: DatabaseSnapshot): void {
    if (manifest.rollbackSha256 === null) {
        throw new Error('Encrypted rollback database has no verified SHA-256 digest in the migration manifest.');
    }
    verifyEncryptedMigrationArtifact(manifest.rollbackPath, key, expected, 'Encrypted rollback database', manifest.rollbackSha256);
}

function restoreEncryptedCanonical(
    manifest: CompleteDatabaseMigrationManifest,
    key: Buffer,
    expected: DatabaseSnapshot,
    runtime: DatabaseMigrationRuntime,
): void {
    verifyEncryptedRollback(manifest, key, expected);
    atomicCopyPrivateFile(manifest.rollbackPath, manifest.sourcePath, PRIVATE_FILE_MODE);
    syncFile(manifest.sourcePath);
    fsyncDirectory(path.dirname(manifest.sourcePath));
    verifyEncryptedMigrationArtifact(
        manifest.sourcePath,
        key,
        expected,
        'Restored encrypted database',
        manifest.rollbackSha256 ?? undefined,
    );
    hit(runtime, 'after_encrypted_rollback_restored');
}

function swapCanonical(
    manifestPath: string,
    manifest: CompleteDatabaseMigrationManifest,
    key: Buffer,
    expected: DatabaseSnapshot,
    runtime: DatabaseMigrationRuntime,
    completeReplacement: () => void,
): CompleteDatabaseMigrationManifest {
    try {
        (runtime.swapDatabase ?? renameSync)(manifest.sidecarPath, manifest.sourcePath);
        fsyncDirectory(path.dirname(manifest.sourcePath));
    } catch (error) {
        restoreEncryptedCanonical(manifest, key, expected, runtime);
        transitionManifest(manifestPath, manifest, 'rolled_back_key_retained', runtime);
        completeReplacement();
        throw new Error(
            `Encrypted database swap failed; restored the encrypted database and retained its committed key: ${errorMessage(error)}`,
            { cause: error },
        );
    }
    hit(runtime, 'after_canonical_swap');
    return transitionManifest(manifestPath, manifest, 'canonical_swapped', runtime);
}

function finalVerify(
    manifestPath: string,
    manifest: CompleteDatabaseMigrationManifest,
    key: Buffer,
    runtime: DatabaseMigrationRuntime,
): CompleteDatabaseMigrationManifest {
    if (manifest.rollbackSha256 === null) {
        throw new Error('Encrypted rollback database has no verified SHA-256 digest in the migration manifest.');
    }
    if (hashFile(manifest.rollbackPath) !== manifest.rollbackSha256) {
        throw new Error('Encrypted rollback database changed after encryption verification.');
    }
    assertEncryptedDatabaseFile(manifest.rollbackPath, key, 'Encrypted rollback database');
    const baseline = openKeyedDatabase(manifest.rollbackPath, key, true);
    let expected: DatabaseSnapshot;
    try {
        assertIntegrity(baseline, 'Encrypted rollback database');
        expected = snapshotDatabase(baseline);
    } finally {
        baseline.close();
    }
    if (hasPlaintextHeader(manifest.sourcePath)) {
        throw new Error('Canonical database is still plaintext after the encrypted swap.');
    }
    const committed = openKeyedDatabase(manifest.sourcePath, key);
    try {
        assertIntegrity(committed, 'Committed encrypted database');
        assertMatchesSnapshot(committed, expected, 'Committed encrypted database');
        const journalMode = committed.pragma('journal_mode = WAL', { simple: true });
        if (journalMode !== 'wal') {
            throw new Error(`Committed encrypted database could not restore WAL mode (observed ${String(journalMode)}).`);
        }
    } finally {
        committed.close();
    }
    assertManagedBackupsEncrypted(manifest, key);
    const writable = openKeyedDatabase(manifest.sourcePath, key);
    writable.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
    writable.close();
    const readonly = openKeyedDatabase(manifest.sourcePath, key, true);
    readonly.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
    readonly.close();
    chmodSync(manifest.sourcePath, PRIVATE_FILE_MODE);
    for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${manifest.sourcePath}${suffix}`)) {
            chmodSync(`${manifest.sourcePath}${suffix}`, PRIVATE_FILE_MODE);
        }
    }
    fsyncDirectory(path.dirname(manifest.sourcePath));
    hit(runtime, 'after_committed_database_verified');
    return transitionManifest(manifestPath, manifest, 'committed_verified', runtime);
}

function finalizeMigration(manifestPath: string, manifest: CompleteDatabaseMigrationManifest, runtime: DatabaseMigrationRuntime): void {
    for (const backup of manifest.backups) {
        removeFile(backup.encryptedPath);
    }
    removeFile(manifest.rollbackPath);
    removeFile(`${manifest.rollbackPath}.encrypted`);
    removeFile(manifest.sidecarPath);
    fsyncDirectory(path.dirname(manifest.sourcePath));
    hit(runtime, 'after_plaintext_rollback_removed');
    removeFile(manifestPath);
    fsyncDirectory(path.dirname(manifestPath));
    hit(runtime, 'after_manifest_removed');
}

async function resumeFromPlaintext(
    manifestPath: string,
    initialManifest: CompleteDatabaseMigrationManifest,
    db: Database.Database,
    runtime: DatabaseMigrationRuntime,
    completeReplacement: () => void,
): Promise<DatabaseMigrationResult> {
    let manifest = initialManifest;
    let key: Buffer | undefined;
    try {
        const expected = snapshotDatabase(db);
        let adoptCommittedKey = false;
        let commitGeneratedKey = false;

        if (manifest.stage === 'sidecar_encrypted') {
            key = await storedMigrationKey(manifest.sourcePath, manifest, runtime);
            if (key === undefined) {
                closePlaintextDatabase(db, runtime);
                cleanupUncommittedMigration(manifestPath, manifest, runtime, completeReplacement);
                return { status: 'recovered-plaintext' };
            }
            adoptCommittedKey = true;
        } else if (manifest.stage === 'key_commitment_started') {
            key = await storedMigrationKey(manifest.sourcePath, manifest, runtime);
            if (key === undefined) {
                throw new Error(DATABASE_KEY_COMMITMENT_INDETERMINATE);
            }
            adoptCommittedKey = true;
        } else if (
            manifest.stage === 'key_committed' ||
            manifest.stage === 'backups_encrypted' ||
            manifest.stage === 'plaintext_closed' ||
            manifest.stage === 'wal_cleaned' ||
            manifest.stage === 'rolled_back_key_retained' ||
            manifest.stage === 'canonical_swapped' ||
            manifest.stage === 'committed_verified'
        ) {
            key = await storedMigrationKey(manifest.sourcePath, manifest, runtime);
            if (key === undefined) {
                throw new Error('The database migration manifest records a committed key, but the key is absent.');
            }
        } else {
            removeFile(manifest.sidecarPath);
            removeFile(manifest.rollbackPath);
            key = (runtime.randomBytes ?? randomBytes)(DATABASE_KEY_BYTES);
            if (key.length !== DATABASE_KEY_BYTES) {
                key.fill(0);
                throw new Error(`OS CSPRNG returned ${key.length} database-key bytes; expected ${DATABASE_KEY_BYTES}.`);
            }
            const keySha256 = createHash('sha256').update(key).digest('hex');
            hit(runtime, 'after_key_generated');
            manifest = transitionManifest(manifestPath, manifest, 'key_prepared', runtime, {
                keySha256,
                rollbackSha256: null,
            });
            commitGeneratedKey = true;
        }

        if (key === undefined) {
            throw new Error('Database migration reached the swap without a committed key.');
        }
        if (db.inTransaction) {
            db.exec('ROLLBACK');
        }
        manifest = ensureEncryptedCandidatesFromPlaintext(manifestPath, manifest, db, key, expected, runtime);
        db.exec('BEGIN EXCLUSIVE');
        if (hashFile(manifest.sourcePath) !== manifest.originalSha256) {
            throw new Error('Plaintext canonical changed while encrypted migration artifacts were being built; recovery remains blocked.');
        }
        assertNoHotJournal(manifest.sourcePath);
        assertIntegrity(db, 'Revalidated plaintext database');
        assertMatchesSnapshot(db, expected, 'Revalidated plaintext database');
        if (commitGeneratedKey) {
            manifest = transitionManifest(manifestPath, manifest, 'sidecar_encrypted', runtime);
            manifest = await commitKey(manifestPath, manifest, key, runtime);
        } else if (adoptCommittedKey) {
            writeEncryptionMetadata(manifest.sourcePath, encryptionMetadata(manifest));
            hit(runtime, 'after_encryption_metadata_written');
            manifest = transitionManifest(manifestPath, manifest, 'key_committed', runtime);
        }
        manifest = convertManagedBackups(manifestPath, manifest, key, runtime);
        if (manifest.stage === 'key_committed') {
            manifest = transitionManifest(manifestPath, manifest, 'backups_encrypted', runtime);
        }
        assertManagedBackupsEncrypted(manifest, key);
        closePlaintextDatabase(db, runtime);
        manifest = transitionManifest(manifestPath, manifest, 'plaintext_closed', runtime);
        removeInactiveWalFiles(manifest.sourcePath, runtime);
        manifest = transitionManifest(manifestPath, manifest, 'wal_cleaned', runtime);
        manifest = swapCanonical(manifestPath, manifest, key, expected, runtime, completeReplacement);
        manifest = finalVerify(manifestPath, manifest, key, runtime);
        manifest = transitionManifest(manifestPath, manifest, 'verified', runtime);
        completeReplacement();
        finalizeMigration(manifestPath, manifest, runtime);
        return { status: 'migrated' };
    } finally {
        if (db.open) {
            if (db.inTransaction) {
                db.exec('ROLLBACK');
            }
            db.close();
        }
        key?.fill(0);
    }
}

function ensureEncryptedRollbackAfterCanonicalSwap(
    manifestPath: string,
    initialManifest: CompleteDatabaseMigrationManifest,
    source: Database.Database,
    key: Buffer,
    expected: DatabaseSnapshot,
    runtime: DatabaseMigrationRuntime,
): CompleteDatabaseMigrationManifest {
    if (initialManifest.rollbackSha256 !== null) {
        verifyEncryptedRollback(initialManifest, key, expected);
        return initialManifest;
    }
    if (existsSync(initialManifest.rollbackPath) && !hasPlaintextHeader(initialManifest.rollbackPath)) {
        const rollbackSha256 = verifyEncryptedMigrationArtifact(initialManifest.rollbackPath, key, expected, 'Encrypted rollback database');
        return recordEncryptedRollback(manifestPath, initialManifest, rollbackSha256, runtime);
    }
    if (existsSync(initialManifest.rollbackPath)) {
        assertLegacyPlaintextRollback(initialManifest, expected);
    }
    const replacementPath = `${initialManifest.rollbackPath}.encrypted`;
    removeFile(replacementPath);
    const rollbackSha256 = buildEncryptedMigrationArtifact(source, replacementPath, key, expected, 'Encrypted rollback replacement');
    hit(runtime, 'after_rollback_encrypted');
    hit(runtime, 'after_rollback_verified');
    renameSync(replacementPath, initialManifest.rollbackPath);
    fsyncDirectory(path.dirname(initialManifest.rollbackPath));
    hit(runtime, 'after_encrypted_rollback_replaced');
    verifyEncryptedMigrationArtifact(initialManifest.rollbackPath, key, expected, 'Encrypted rollback database', rollbackSha256);
    return recordEncryptedRollback(manifestPath, initialManifest, rollbackSha256, runtime);
}

async function resumeManifest(
    manifestPath: string,
    initialManifest: DatabaseMigrationManifest,
    runtime: DatabaseMigrationRuntime,
    completeReplacement: () => void,
): Promise<DatabaseMigrationResult> {
    let manifest = normalizeLegacyManifest(manifestPath, initialManifest, runtime);
    if (!existsSync(manifest.sourcePath)) {
        if (manifest.rollbackSha256 === null) {
            restoreLegacyPlaintextCanonical(manifest, runtime);
            if (manifest.keySha256 !== null) {
                manifest = transitionManifest(manifestPath, manifest, 'rolled_back_key_retained', runtime);
            }
        } else {
            const key = await storedMigrationKey(manifest.sourcePath, manifest, runtime);
            if (key === undefined) {
                throw new Error('The database migration manifest records an encrypted rollback, but the key is absent.');
            }
            try {
                const rollback = openKeyedDatabase(manifest.rollbackPath, key, true);
                let expected: DatabaseSnapshot;
                try {
                    assertIntegrity(rollback, 'Encrypted rollback database');
                    expected = snapshotDatabase(rollback);
                } finally {
                    rollback.close();
                }
                restoreEncryptedCanonical(manifest, key, expected, runtime);
                manifest = transitionManifest(manifestPath, manifest, 'rolled_back_key_retained', runtime);
            } finally {
                key.fill(0);
            }
        }
    }
    if (hasPlaintextHeader(manifest.sourcePath)) {
        manifest = rebaseUnfrozenManifest(manifestPath, manifest);
        if (hashFile(manifest.sourcePath) !== manifest.originalSha256) {
            throw new Error('Plaintext canonical changed after the migration baseline was frozen; recovery remains blocked.');
        }
        const plaintext = quiescePlaintextDatabase(manifest.sourcePath, runtime);
        return resumeFromPlaintext(manifestPath, manifest, plaintext, runtime, completeReplacement);
    }
    const key = await storedMigrationKey(manifest.sourcePath, manifest, runtime);
    if (key === undefined) {
        throw new Error('Canonical database appears encrypted, but the migration key is absent.');
    }
    try {
        const committed = openKeyedDatabase(manifest.sourcePath, key);
        try {
            assertIntegrity(committed, 'Crash-recovered encrypted database');
            const expected = snapshotDatabase(committed);
            if (existsSync(manifest.rollbackPath) || manifest.stage !== 'verified') {
                manifest = ensureEncryptedRollbackAfterCanonicalSwap(manifestPath, manifest, committed, key, expected, runtime);
            }
        } finally {
            committed.close();
        }
        manifest = convertManagedBackups(manifestPath, manifest, key, runtime);
        assertManagedBackupsEncrypted(manifest, key);
        if (manifest.stage === 'verified' || manifest.stage === 'committed_verified') {
            if (manifest.stage === 'committed_verified') {
                manifest = transitionManifest(manifestPath, manifest, 'verified', runtime);
            }
            completeReplacement();
            finalizeMigration(manifestPath, manifest, runtime);
            return { status: 'migrated' };
        }
        if (manifest.stage !== 'canonical_swapped') {
            manifest = transitionManifest(manifestPath, manifest, 'canonical_swapped', runtime);
        }
        manifest = finalVerify(manifestPath, manifest, key, runtime);
        manifest = transitionManifest(manifestPath, manifest, 'verified', runtime);
        completeReplacement();
        finalizeMigration(manifestPath, manifest, runtime);
        return { status: 'migrated' };
    } finally {
        key.fill(0);
    }
}

async function withMigrationLock(
    runtime: DatabaseMigrationRuntime,
    operation: (manifestPath: string) => Promise<DatabaseMigrationResult>,
): Promise<DatabaseMigrationResult> {
    const paths = statePaths(runtime);
    const lock = acquireMigrationLock(paths, runtime);
    try {
        return await operation(paths.manifest);
    } finally {
        releaseMigrationLock(lock);
    }
}

function activeMigrationRecoveryId(databasePath: string, runtime: DatabaseMigrationRuntime): string | undefined {
    return readManifest(statePaths(runtime).manifest, databasePath)?.migrationId;
}

export async function recoverPrimaryDatabaseMigration(
    databasePath: string,
    runtime: DatabaseMigrationRuntime = {},
): Promise<DatabaseMigrationResult> {
    const pinnedDatabasePath = path.resolve(databasePath);
    assertSupportedRuntime(runtime);
    if (!databaseMigrationIsActive(runtime)) {
        return { status: 'no-active-migration' };
    }
    const recoveryId = activeMigrationRecoveryId(pinnedDatabasePath, runtime);
    return withExclusiveDatabaseLifecycle(
        pinnedDatabasePath,
        (lifecycle) => recoverPrimaryDatabaseMigrationUnderLifecycle(pinnedDatabasePath, runtime, lifecycle),
        recoveryId,
    );
}

async function recoverPrimaryDatabaseMigrationUnderLifecycle(
    databasePath: string,
    runtime: DatabaseMigrationRuntime,
    lifecycle: ExclusiveDatabaseLifecycleLease,
): Promise<DatabaseMigrationResult> {
    return withMigrationLock(runtime, async (manifestPath) => {
        const manifest = readManifest(manifestPath, databasePath);
        if (manifest === undefined) {
            return { status: 'no-active-migration' };
        }
        lifecycle.beginReplacement(manifest.migrationId);
        return resumeManifest(manifestPath, manifest, runtime, () => lifecycle.completeReplacement());
    });
}

export async function migratePrimaryDatabaseToEncrypted(
    databasePath: string,
    runtime: DatabaseMigrationRuntime = {},
): Promise<DatabaseMigrationResult> {
    const pinnedDatabasePath = path.resolve(databasePath);
    assertSupportedRuntime(runtime);
    const recoveryId = activeMigrationRecoveryId(pinnedDatabasePath, runtime);
    return withExclusiveDatabaseLifecycle(
        pinnedDatabasePath,
        async (lifecycle) => {
            if (databaseMigrationIsActive(runtime)) {
                const recovered = await recoverPrimaryDatabaseMigrationUnderLifecycle(pinnedDatabasePath, runtime, lifecycle);
                if (recovered.status !== 'no-active-migration') {
                    return recovered;
                }
            }
            if (!existsSync(pinnedDatabasePath)) {
                return { status: 'no-database' };
            }
            if (!hasPlaintextHeader(pinnedDatabasePath)) {
                return { status: 'already-encrypted' };
            }
            preflightPlaintextDatabase(pinnedDatabasePath, runtime);
            const managedBackups = preflightManagedBackups(pinnedDatabasePath);
            return withMigrationLock(runtime, async (manifestPath) => {
                const interrupted = readManifest(manifestPath, pinnedDatabasePath);
                if (interrupted !== undefined) {
                    lifecycle.beginReplacement(interrupted.migrationId);
                    return resumeManifest(manifestPath, interrupted, runtime, () => lifecycle.completeReplacement());
                }
                if (!hasPlaintextHeader(pinnedDatabasePath)) {
                    return { status: 'already-encrypted' };
                }
                const plaintext = quiescePlaintextDatabase(pinnedDatabasePath, runtime);
                try {
                    const migrationId = (runtime.randomUUID ?? randomUUID)();
                    const artifacts = migrationArtifactPaths(pinnedDatabasePath, migrationId);
                    const backend = await selectBackend(runtime);
                    const installationId = (runtime.randomUUID ?? randomUUID)();
                    const manifest: CompleteDatabaseMigrationManifest = {
                        version: 1,
                        migrationId,
                        backend,
                        installationId,
                        sourcePath: pinnedDatabasePath,
                        originalSha256: hashFile(pinnedDatabasePath),
                        rollbackPath: artifacts.rollback,
                        rollbackSha256: null,
                        sidecarPath: artifacts.sidecar,
                        backups: managedBackups.map((backup, index) => ({
                            ...backup,
                            encryptedPath: managedBackupArtifactPath(pinnedDatabasePath, migrationId, index),
                            encryptedSha256: null,
                            stage: 'pending',
                        })),
                        keySha256: null,
                        stage: 'quiesced',
                    };
                    writeManifest(manifestPath, pinnedDatabasePath, manifest);
                    hit(runtime, 'after_manifest_quiesced');
                    lifecycle.beginReplacement(manifest.migrationId);
                    return await resumeFromPlaintext(manifestPath, manifest, plaintext, runtime, () => lifecycle.completeReplacement());
                } catch (error) {
                    if (plaintext.open) {
                        if (plaintext.inTransaction) {
                            plaintext.exec('ROLLBACK');
                        }
                        plaintext.close();
                    }
                    throw error;
                }
            });
        },
        recoveryId,
    );
}
