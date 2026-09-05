import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    type BigIntStats,
    chmodSync,
    closeSync,
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
    writeSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import {
    DATABASE_HEADER_BYTES,
    DATABASE_KEY_BYTES,
    DATABASE_MIGRATION_COPY_SPACE_DENOMINATOR,
    DATABASE_MIGRATION_COPY_SPACE_NUMERATOR,
    DATABASE_MIGRATION_HASH_CHUNK_BYTES,
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
    sidecarPath: string;
    backups: ManagedBackupMigration[];
    keySha256: string | null;
    stage: MigrationStage;
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
    if (!Array.isArray(manifest.backups)) {
        return malformedManifest(file);
    }
    const backupDirectory = path.dirname(manifest.sourcePath);
    const backupPrefix = `${path.basename(manifest.sourcePath)}.bak-`;
    for (const [index, backup] of manifest.backups.entries()) {
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
    const backupPaths = manifest.backups.map((backup) => backup.sourcePath);
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
    manifest: DatabaseMigrationManifest,
    stage: MigrationStage,
    runtime: DatabaseMigrationRuntime,
    fields: Partial<Pick<DatabaseMigrationManifest, 'backend' | 'installationId' | 'keySha256'>> = {},
): DatabaseMigrationManifest {
    const next = { ...manifest, ...fields, stage };
    writeManifest(file, manifest.sourcePath, next);
    hit(runtime, `after_manifest_${stage}`);
    return next;
}

function rebaseUnfrozenManifest(manifestPath: string, manifest: DatabaseMigrationManifest): DatabaseMigrationManifest {
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

function managedBackupVerificationError(backupPath: string, cause: unknown): Error {
    return new Error(`Managed backup is unrecognized or unverifiable: ${backupPath}: ${errorMessage(cause)}`, { cause });
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

function openVerifiedPlaintextManagedBackup(backupPath: string, expectedSha256?: string): Database.Database {
    let stats: BigIntStats;
    let plaintext: boolean;
    try {
        stats = lstatSync(backupPath, { bigint: true });
        plaintext = hasPlaintextHeader(backupPath);
    } catch (error) {
        throw managedBackupVerificationError(backupPath, error);
    }
    if (!stats.isFile() || stats.isSymbolicLink() || !plaintext) {
        const cause = new Error('expected a regular plaintext SQLite database');
        throw managedBackupVerificationError(backupPath, cause);
    }
    if (expectedSha256 !== undefined) {
        let actualSha256: string;
        try {
            actualSha256 = hashFile(backupPath);
        } catch (error) {
            throw managedBackupVerificationError(backupPath, error);
        }
        if (actualSha256 !== expectedSha256) {
            const cause = new Error('contents changed after migration preflight');
            throw managedBackupVerificationError(backupPath, cause);
        }
    }
    let seal: ReturnType<typeof pinSQLitePathForOpen>;
    try {
        seal = pinSQLitePathForOpen(backupPath, {
            dev: stats.dev,
            ino: stats.ino,
            ctimeNs: stats.ctimeNs,
            nlink: stats.nlink,
        });
    } catch (error) {
        throw managedBackupVerificationError(backupPath, error);
    }
    let db: Database.Database;
    try {
        db = new Database(seal.sqlitePath, { fileMustExist: true, timeout: 0 });
    } catch (error) {
        throw managedBackupVerificationError(backupPath, managedBackupOpenCleanupCause(error, undefined, seal));
    }
    try {
        seal.confirmOpen(db);
        assertIntegrity(db, 'Managed backup');
    } catch (error) {
        throw managedBackupVerificationError(backupPath, managedBackupOpenCleanupCause(error, db, seal));
    }
    try {
        seal.release();
    } catch (error) {
        throw managedBackupVerificationError(backupPath, managedBackupOpenCleanupCause(error, db));
    }
    return db;
}

function preflightManagedBackups(databasePath: string): Array<Pick<ManagedBackupMigration, 'sourcePath' | 'originalSha256'>> {
    return listManagedBackups(databasePath).map((backupPath) => {
        const backup = openVerifiedPlaintextManagedBackup(backupPath);
        backup.close();
        return { sourcePath: backupPath, originalSha256: hashFile(backupPath) };
    });
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

function quiescePlaintextDatabase(databasePath: string, runtime: DatabaseMigrationRuntime): Database.Database {
    const db = new Database(databasePath, { fileMustExist: true, timeout: 0 });
    try {
        db.pragma('busy_timeout = 0');
        db.exec('BEGIN EXCLUSIVE');
        db.exec('ROLLBACK');
        assertPlaintextCheckpointReady(checkpointResult(db));
        const journalMode = db.pragma('journal_mode = DELETE', { simple: true });
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

function assertRegularMigrationCopySource(descriptor: number, source: string): void {
    if (!fstatSync(descriptor).isFile()) {
        throw new Error(`Database migration copy source is not a regular file: ${source}`);
    }
}

function copyFileDurably(source: string, destination: string): void {
    removeFile(destination);
    const sourceDescriptor = openSync(source, fsConstants.O_RDONLY | noFollowFlag());
    let destinationDescriptor: number | undefined;
    try {
        assertRegularMigrationCopySource(sourceDescriptor, source);
        destinationDescriptor = openSync(
            destination,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
            PRIVATE_FILE_MODE,
        );
        fchmodSync(destinationDescriptor, PRIVATE_FILE_MODE);
        const buffer = Buffer.alloc(DATABASE_MIGRATION_HASH_CHUNK_BYTES);
        let bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
        while (bytesRead > 0) {
            let offset = 0;
            while (offset < bytesRead) {
                offset += writeSync(destinationDescriptor, buffer, offset, bytesRead - offset);
            }
            bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
        }
        fsyncSync(destinationDescriptor);
        closeSync(destinationDescriptor);
        destinationDescriptor = undefined;
        fsyncDirectory(path.dirname(destination));
    } catch (error) {
        if (destinationDescriptor !== undefined) {
            closeSync(destinationDescriptor);
        }
        removeFile(destination);
        throw error;
    } finally {
        closeSync(sourceDescriptor);
    }
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
    manifest: DatabaseMigrationManifest,
    index: number,
    backup: ManagedBackupMigration,
    runtime: DatabaseMigrationRuntime,
): DatabaseMigrationManifest {
    const backups = manifest.backups.map((current, currentIndex) => (currentIndex === index ? backup : current));
    const next = { ...manifest, backups };
    writeManifest(manifestPath, manifest.sourcePath, next);
    hit(runtime, `after_manifest_backup_${backup.stage}`);
    return next;
}

function assertManagedBackupSet(manifest: DatabaseMigrationManifest): void {
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
    const source = openVerifiedPlaintextManagedBackup(backup.sourcePath, backup.originalSha256);
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
        source.close();
    }
    syncFile(backup.encryptedPath);
    fsyncDirectory(path.dirname(backup.encryptedPath));
    const encryptedSha256 = hashFile(backup.encryptedPath);
    verifyEncryptedManagedBackup(backup.encryptedPath, encryptedSha256, key, 'Encrypted managed backup replacement');
    const unchanged = openVerifiedPlaintextManagedBackup(backup.sourcePath, backup.originalSha256);
    unchanged.close();
    return encryptedSha256;
}

function convertManagedBackups(
    manifestPath: string,
    initialManifest: DatabaseMigrationManifest,
    key: Buffer,
    runtime: DatabaseMigrationRuntime,
): DatabaseMigrationManifest {
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
        const original = openVerifiedPlaintextManagedBackup(backup.sourcePath, backup.originalSha256);
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

function assertManagedBackupsEncrypted(manifest: DatabaseMigrationManifest, key: Buffer): void {
    assertManagedBackupSet(manifest);
    for (const backup of manifest.backups) {
        if (backup.stage !== 'replaced' || backup.encryptedSha256 === null) {
            throw new Error('Database migration reached canonical replacement before every managed backup was encrypted.');
        }
        verifyEncryptedManagedBackup(backup.sourcePath, backup.encryptedSha256, key, 'Encrypted managed backup');
    }
}

function encryptAndVerifySidecar(
    manifest: DatabaseMigrationManifest,
    key: Buffer,
    expected: DatabaseSnapshot,
    runtime: DatabaseMigrationRuntime,
): void {
    const sidecar = new Database(manifest.sidecarPath, { fileMustExist: true, timeout: 0 });
    const rawKey = rawKeyBuffer(key);
    try {
        const journalMode = sidecar.pragma('journal_mode = DELETE', { simple: true });
        if (journalMode !== 'delete') {
            throw new Error(`Encrypted sidecar could not enter DELETE journal mode (observed ${String(journalMode)}).`);
        }
        sidecar.pragma("cipher='chacha20'");
        sidecar.rekey(rawKey);
    } finally {
        rawKey.fill(0);
        sidecar.close();
    }
    syncFile(manifest.sidecarPath);
    fsyncDirectory(path.dirname(manifest.sidecarPath));
    hit(runtime, 'after_sidecar_encrypted');
    if (hasPlaintextHeader(manifest.sidecarPath)) {
        throw new Error('Encrypted database sidecar retained a plaintext SQLite header.');
    }
    const verified = openKeyedDatabase(manifest.sidecarPath, key, true);
    try {
        assertIntegrity(verified, 'Encrypted database sidecar');
        assertMatchesSnapshot(verified, expected, 'Encrypted database sidecar');
    } finally {
        verified.close();
    }
    hit(runtime, 'after_sidecar_verified');
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

function cleanupUncommittedMigration(
    manifestPath: string,
    manifest: DatabaseMigrationManifest,
    runtime: DatabaseMigrationRuntime,
    completeReplacement: () => void,
): void {
    for (const backup of manifest.backups) {
        removeFile(backup.encryptedPath);
    }
    removeFile(manifest.sidecarPath);
    removeFile(manifest.rollbackPath);
    fsyncDirectory(path.dirname(manifest.sourcePath));
    hit(runtime, 'after_uncommitted_artifacts_removed');
    completeReplacement();
    removeFile(manifestPath);
    fsyncDirectory(path.dirname(manifestPath));
    hit(runtime, 'after_manifest_removed');
}

async function commitKey(
    manifestPath: string,
    manifest: DatabaseMigrationManifest,
    key: Buffer,
    runtime: DatabaseMigrationRuntime,
): Promise<DatabaseMigrationManifest> {
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

function restorePlaintextCanonical(manifest: DatabaseMigrationManifest, runtime: DatabaseMigrationRuntime): void {
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

function swapCanonical(
    manifestPath: string,
    manifest: DatabaseMigrationManifest,
    runtime: DatabaseMigrationRuntime,
    completeReplacement: () => void,
): DatabaseMigrationManifest {
    try {
        (runtime.swapDatabase ?? renameSync)(manifest.sidecarPath, manifest.sourcePath);
        fsyncDirectory(path.dirname(manifest.sourcePath));
    } catch (error) {
        restorePlaintextCanonical(manifest, runtime);
        const rolledBack = transitionManifest(manifestPath, manifest, 'rolled_back_key_retained', runtime);
        completeReplacement();
        throw new Error(
            `Encrypted database swap failed; restored the plaintext database and retained its committed key: ${errorMessage(error)}`,
            {
                cause: rolledBack,
            },
        );
    }
    hit(runtime, 'after_canonical_swap');
    return transitionManifest(manifestPath, manifest, 'canonical_swapped', runtime);
}

function finalVerify(
    manifestPath: string,
    manifest: DatabaseMigrationManifest,
    key: Buffer,
    runtime: DatabaseMigrationRuntime,
): DatabaseMigrationManifest {
    const baseline = new Database(manifest.rollbackPath, { readonly: true, fileMustExist: true, timeout: 0 });
    let expected: DatabaseSnapshot;
    try {
        assertIntegrity(baseline, 'Plaintext rollback database');
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

function finalizeMigration(manifestPath: string, manifest: DatabaseMigrationManifest, runtime: DatabaseMigrationRuntime): void {
    for (const backup of manifest.backups) {
        removeFile(backup.encryptedPath);
    }
    removeFile(manifest.rollbackPath);
    removeFile(manifest.sidecarPath);
    fsyncDirectory(path.dirname(manifest.sourcePath));
    hit(runtime, 'after_plaintext_rollback_removed');
    removeFile(manifestPath);
    fsyncDirectory(path.dirname(manifestPath));
    hit(runtime, 'after_manifest_removed');
}

function assertRollback(manifest: DatabaseMigrationManifest): void {
    if (!existsSync(manifest.rollbackPath) || hashFile(manifest.rollbackPath) !== manifest.originalSha256) {
        throw new Error('Database migration plaintext rollback copy failed SHA-256 verification.');
    }
}

async function resumeFromPlaintext(
    manifestPath: string,
    initialManifest: DatabaseMigrationManifest,
    db: Database.Database,
    runtime: DatabaseMigrationRuntime,
    completeReplacement: () => void,
): Promise<DatabaseMigrationResult> {
    let manifest = initialManifest;
    let key: Buffer | undefined;
    try {
        if (!existsSync(manifest.rollbackPath) || hashFile(manifest.rollbackPath) !== manifest.originalSha256) {
            copyFileDurably(manifest.sourcePath, manifest.rollbackPath);
            hit(runtime, 'after_plaintext_rollback_copied');
        }
        assertRollback(manifest);
        if (manifest.stage === 'quiesced') {
            manifest = transitionManifest(manifestPath, manifest, 'rollback_copied', runtime);
        }
        const expected = snapshotDatabase(db);

        if (manifest.stage === 'sidecar_encrypted') {
            key = await storedMigrationKey(manifest.sourcePath, manifest, runtime);
            if (key === undefined) {
                closePlaintextDatabase(db, runtime);
                cleanupUncommittedMigration(manifestPath, manifest, runtime, completeReplacement);
                return { status: 'recovered-plaintext' };
            }
            writeEncryptionMetadata(manifest.sourcePath, encryptionMetadata(manifest));
            hit(runtime, 'after_encryption_metadata_written');
            manifest = transitionManifest(manifestPath, manifest, 'key_committed', runtime);
        } else if (manifest.stage === 'key_commitment_started') {
            key = await storedMigrationKey(manifest.sourcePath, manifest, runtime);
            if (key === undefined) {
                throw new Error(DATABASE_KEY_COMMITMENT_INDETERMINATE);
            }
            writeEncryptionMetadata(manifest.sourcePath, encryptionMetadata(manifest));
            hit(runtime, 'after_encryption_metadata_written');
            manifest = transitionManifest(manifestPath, manifest, 'key_committed', runtime);
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
            copyFileDurably(manifest.rollbackPath, manifest.sidecarPath);
            hit(runtime, 'after_working_sidecar_copied');
            if (manifest.stage === 'rollback_copied') {
                manifest = transitionManifest(manifestPath, manifest, 'sidecar_copied', runtime);
            }
            key = (runtime.randomBytes ?? randomBytes)(DATABASE_KEY_BYTES);
            if (key.length !== DATABASE_KEY_BYTES) {
                key.fill(0);
                throw new Error(`OS CSPRNG returned ${key.length} database-key bytes; expected ${DATABASE_KEY_BYTES}.`);
            }
            const keySha256 = createHash('sha256').update(key).digest('hex');
            hit(runtime, 'after_key_generated');
            manifest = transitionManifest(manifestPath, manifest, 'key_prepared', runtime, {
                keySha256,
            });
            encryptAndVerifySidecar(manifest, key, expected, runtime);
            manifest = transitionManifest(manifestPath, manifest, 'sidecar_encrypted', runtime);
            manifest = await commitKey(manifestPath, manifest, key, runtime);
        }

        if (key === undefined) {
            throw new Error('Database migration reached the swap without a committed key.');
        }
        if (!existsSync(manifest.sidecarPath) || hasPlaintextHeader(manifest.sidecarPath)) {
            copyFileDurably(manifest.rollbackPath, manifest.sidecarPath);
            hit(runtime, 'after_working_sidecar_copied');
            encryptAndVerifySidecar(manifest, key, expected, runtime);
        } else {
            const sidecar = openKeyedDatabase(manifest.sidecarPath, key, true);
            try {
                assertIntegrity(sidecar, 'Encrypted database sidecar');
                assertMatchesSnapshot(sidecar, expected, 'Encrypted database sidecar');
            } finally {
                sidecar.close();
            }
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
        manifest = swapCanonical(manifestPath, manifest, runtime, completeReplacement);
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

async function resumeManifest(
    manifestPath: string,
    manifest: DatabaseMigrationManifest,
    runtime: DatabaseMigrationRuntime,
    completeReplacement: () => void,
): Promise<DatabaseMigrationResult> {
    if (manifest.stage === 'verified' || manifest.stage === 'committed_verified') {
        const key = await storedMigrationKey(manifest.sourcePath, manifest, runtime);
        if (key === undefined) {
            throw new Error('The database migration manifest records a committed key, but the key is absent.');
        }
        try {
            assertManagedBackupsEncrypted(manifest, key);
        } finally {
            key.fill(0);
        }
        if (manifest.stage === 'committed_verified') {
            manifest = transitionManifest(manifestPath, manifest, 'verified', runtime);
        }
        completeReplacement();
        finalizeMigration(manifestPath, manifest, runtime);
        return { status: 'migrated' };
    }
    if (!existsSync(manifest.sourcePath)) {
        restorePlaintextCanonical(manifest, runtime);
        manifest = transitionManifest(manifestPath, manifest, 'rolled_back_key_retained', runtime);
    }
    if (hasPlaintextHeader(manifest.sourcePath)) {
        manifest = rebaseUnfrozenManifest(manifestPath, manifest);
        if (hashFile(manifest.sourcePath) !== manifest.originalSha256) {
            restorePlaintextCanonical(manifest, runtime);
            manifest = transitionManifest(manifestPath, manifest, 'rolled_back_key_retained', runtime);
        }
        const plaintext = quiescePlaintextDatabase(manifest.sourcePath, runtime);
        return resumeFromPlaintext(manifestPath, manifest, plaintext, runtime, completeReplacement);
    }
    const key = await storedMigrationKey(manifest.sourcePath, manifest, runtime);
    if (key === undefined) {
        throw new Error('Canonical database appears encrypted, but the migration key is absent.');
    }
    try {
        if (manifest.stage !== 'canonical_swapped') {
            const committed = openKeyedDatabase(manifest.sourcePath, key, true);
            try {
                assertIntegrity(committed, 'Crash-recovered encrypted database');
                assertRollback(manifest);
                const baseline = new Database(manifest.rollbackPath, { readonly: true, fileMustExist: true, timeout: 0 });
                try {
                    assertMatchesSnapshot(committed, snapshotDatabase(baseline), 'Crash-recovered encrypted database');
                } finally {
                    baseline.close();
                }
            } finally {
                committed.close();
            }
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
                    const manifest: DatabaseMigrationManifest = {
                        version: 1,
                        migrationId,
                        backend,
                        installationId,
                        sourcePath: pinnedDatabasePath,
                        originalSha256: hashFile(pinnedDatabasePath),
                        rollbackPath: artifacts.rollback,
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
