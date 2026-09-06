import { createHash, randomUUID } from 'node:crypto';
import {
    type BigIntStats,
    closeSync,
    existsSync,
    constants as fsConstants,
    fstatSync,
    fsyncSync,
    linkSync,
    lstatSync,
    openSync,
    readlinkSync,
    readSync,
    renameSync,
    statSync,
    symlinkSync,
    unlinkSync,
} from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { Command } from 'commander';
import { DATABASE_EXPORT_VERIFY_CHUNK_BYTES, DATABASE_HEADER_BYTES, USER_BACKUPS_DIR_NAME } from '../../config/constants.js';
import { canonicalizeExisting, elephaHome, normalizeForCompare } from '../../config/paths.js';
import { databaseKey } from '../../storage/database-encryption.js';
import { defaultDbPath, isPlaintextDatabaseHeader, openDb, openKeyedDatabase } from '../../storage/db.js';
import {
    assertDatabaseFileIdentity,
    assertEncryptedDatabaseFile,
    createPrivateEmptyDatabaseDescriptor,
    type DatabaseFileIdentity,
    type DatabaseFileSeal,
    inspectPrivateEmptyDatabaseDescriptor,
    qualifySQLiteCreateSql,
    writeEncryptedAttachedDatabase,
    writeEncryptedDatabaseSnapshot,
} from '../../storage/encrypted-database-export.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { ProjectResolver, type ProjectSet } from '../../storage/project-resolver.js';
import { errorMessage } from '../../util/error.js';
import { ensureCreatedDirsPrivate, listRegularFiles } from '../../util/fs.js';
import { runBackupWizard } from '../backup-wizard.js';

const EXPORTED_TABLES = ['projects', 'sessions', 'memories', 'session_rollups'] as const;

interface BackupCommandOptions {
    all: boolean;
    force: boolean;
    project?: string;
    out?: string;
}

interface SchemaRow {
    type: 'table' | 'index' | 'trigger';
    name: string;
    sql: string;
}

export interface FullBackup {
    path: string;
    mtimeMs: number;
    bytes: number;
}

// Registers user-requested, installation-keyed exports. Safety snapshots remain in storage/backup.ts.
export function registerBackup(program: Command): void {
    program
        .command('backup')
        .description('Back up elepha memory for recovery on this installation')
        .option('--all', 'export the whole elepha database')
        .option('--project <pathOrName>', 'export one consolidated project set')
        .option('--out <path>', 'write to this file or directory instead of ~/.elepha/backups')
        .option('--force', 'overwrite an existing backup destination')
        .action(async (opts: BackupCommandOptions) => {
            const scopes = [opts.all, opts.project !== undefined].filter(Boolean).length;
            if (scopes > 1) {
                console.error('Specify only one of --all or --project <pathOrName>.');
                process.exitCode = 1;
                return;
            }
            if (scopes === 0 && !process.stdin.isTTY) {
                console.error('Specify --all or --project <pathOrName>.');
                process.exitCode = 1;
                return;
            }

            const dbPath = defaultDbPath();
            const db = await openDb(dbPath);
            const store = new MemoryStore(db);
            let encryptionKey: Buffer | undefined;
            const defaultOutput = (project?: ProjectSet) => {
                const generated = defaultBackupPath(project);
                return opts.out === undefined ? generated : resolveOutput(opts.out, generated);
            };
            try {
                const exportKey = await databaseKey(dbPath, false);
                encryptionKey = exportKey;
                if (scopes === 0) {
                    process.exitCode = await runBackupWizard({
                        store,
                        defaultOutput,
                        backupAll: async (output) => exportAll(db, resolveOutput(output, defaultOutput()), exportKey, opts.force),
                        backupProject: async (project, output) =>
                            exportProject(db, project, resolveOutput(output, defaultOutput(project)), exportKey, opts.force),
                    });
                    return;
                }

                if (opts.all) {
                    const written = exportAll(db, resolveOutput(opts.out, defaultOutput()), exportKey, opts.force);
                    console.log(`Backup written to ${written}.`);
                    return;
                }

                const resolution = new ProjectResolver(db).resolve(opts.project ?? '');
                if (!('project' in resolution) || resolution.project === null) {
                    console.error(`No project matching "${opts.project}".`);
                    process.exitCode = 1;
                    return;
                }
                if ('ambiguous' in resolution) {
                    console.error(`Project "${opts.project}" is ambiguous. Use a more specific path or name.`);
                    process.exitCode = 1;
                    return;
                }
                const written = exportProject(
                    db,
                    resolution.project,
                    resolveOutput(opts.out, defaultOutput(resolution.project)),
                    exportKey,
                    opts.force,
                );
                console.log(`Backup written to ${written}.`);
            } finally {
                encryptionKey?.fill(0);
                db.close();
            }
        });
}

function backupDirectory(): string {
    return path.join(elephaHome(), USER_BACKUPS_DIR_NAME);
}

// Lists complete database exports only; project exports are not valid restore candidates.
export function listFullBackups(): FullBackup[] {
    return listRegularFiles(backupDirectory())
        .filter((file) => /^elepha-full-.*\.db$/.test(path.basename(file)))
        .map((file) => {
            const stats = statSync(file);
            return { path: file, mtimeMs: stats.mtimeMs, bytes: stats.size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || path.basename(b.path).localeCompare(path.basename(a.path)));
}

function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function projectSlug(project: ProjectSet): string {
    const source = project.displayName || project.paths[0] || 'project';
    const slug = source
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'project';
}

export function defaultBackupPath(project?: ProjectSet): string {
    const filename = project ? `elepha-${projectSlug(project)}-${timestamp()}.db` : `elepha-full-${timestamp()}.db`;
    return path.join(backupDirectory(), filename);
}

// Existing directories stay directories; a trailing separator also creates a directory. Other values are file paths.
export function resolveOutput(output: string | undefined, defaultPath: string): string {
    if (output === undefined) {
        return defaultPath;
    }
    const resolved = path.resolve(output);
    if ((existsSync(resolved) && statSync(resolved).isDirectory()) || output.endsWith(path.sep)) {
        return path.join(resolved, path.basename(defaultPath));
    }
    return resolved;
}

// Full exports retain every source table in one SQLite snapshot after a WAL checkpoint, unlike pruned safety snapshots.
export function exportAll(db: Database.Database, destination: string, encryptionKey: Buffer, force = false): string {
    if (db.name === ':memory:') {
        throw new Error('A full backup requires an on-disk database.');
    }
    refuseActiveDatabaseDestination(db.name, destination);
    const destinationAuthorization = prepareDestination(destination, force);
    refuseActiveDatabaseDestination(db.name, destination);
    const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: unknown }>;
    if (checkpoint?.busy !== 0) {
        throw new Error("Backup aborted: WAL checkpoint did not complete (the daemon may be writing) — run 'elepha pause' or retry.");
    }
    replaceDestination(
        destination,
        destinationAuthorization,
        (databasePath, identity) => writeEncryptedDatabaseSnapshot(db, databasePath, identity),
        (databasePath, cipherSalt) => verifyEncryptedExport(databasePath, encryptionKey, [], cipherSalt),
    );
    return destination;
}

// Exports exactly one resolved ProjectSet and the four portable tables that reference it.
export function exportProject(
    source: Database.Database,
    project: ProjectSet,
    destination: string,
    encryptionKey: Buffer,
    force = false,
): string {
    refuseActiveDatabaseDestination(source.name, destination);
    const destinationAuthorization = prepareDestination(destination, force);
    refuseActiveDatabaseDestination(source.name, destination);
    replaceDestination(
        destination,
        destinationAuthorization,
        (databasePath, identity) => {
            writeEncryptedAttachedDatabase(source, databasePath, identity, (targetSchema) => {
                cloneProjectDatabase(source, targetSchema, project);
            });
        },
        (databasePath, cipherSalt) => verifyEncryptedExport(databasePath, encryptionKey, EXPORTED_TABLES, cipherSalt),
    );
    return destination;
}

function verifyEncryptedExport(
    databasePath: string,
    encryptionKey: Buffer,
    expectedTables: readonly string[],
    expectedCipherSalt: string,
): void {
    assertEncryptedDatabaseFile(databasePath, encryptionKey, 'Backup encryption verification');
    const db = openKeyedDatabase(databasePath, encryptionKey, { readonly: true, fileMustExist: true });
    try {
        const cipherSalt = db.pragma('cipher_salt', { simple: true });
        if (typeof cipherSalt !== 'string' || cipherSalt.toUpperCase() !== expectedCipherSalt) {
            throw new Error('Backup verification opened a different encrypted database.');
        }
        const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
            throw new Error(`Backup failed integrity_check: ${integrity.map((row) => row.integrity_check).join('; ')}`);
        }
        const tables = new Set(
            (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
        );
        const missing = expectedTables.filter((table) => !tables.has(table));
        if (missing.length > 0) {
            throw new Error(`Backup is incomplete (missing required table(s): ${missing.join(', ')}).`);
        }
    } finally {
        db.close();
    }
}

function refuseActiveDatabaseDestination(activeDatabase: string, destination: string): void {
    if (activeDatabase === ':memory:') {
        return;
    }
    const canonicalDestination = path.join(canonicalizeExisting(path.dirname(destination)), path.basename(destination));
    const canonicalActiveDatabase = canonicalizeExisting(activeDatabase);
    if (
        normalizeForCompare(canonicalDestination) === normalizeForCompare(canonicalActiveDatabase) ||
        sameExistingFileIdentity(canonicalDestination, canonicalActiveDatabase)
    ) {
        throw new Error('Backup destination must not be the active database.');
    }
}

function sameExistingFileIdentity(first: string, second: string): boolean {
    try {
        const firstInfo = lstatSync(first, { bigint: true });
        const secondInfo = lstatSync(second, { bigint: true });
        return firstInfo.isFile() && secondInfo.isFile() && firstInfo.dev === secondInfo.dev && firstInfo.ino === secondInfo.ino;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

type DestinationAuthorization = { state: 'absent' } | { state: 'replace'; identity: DatabaseFileIdentity };

// Rejects unsafe destinations and binds an authorized replacement to the inode observed here.
function prepareDestination(destination: string, force: boolean): DestinationAuthorization {
    let destinationInfo: BigIntStats | undefined;
    try {
        destinationInfo = lstatSync(destination, { bigint: true });
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
    if (destinationInfo?.isSymbolicLink()) {
        throw new Error(`refusing to write a backup through a symlink: ${destination}`);
    }
    if (destinationInfo !== undefined && !force) {
        throw new Error(`Backup destination already exists: ${destination} (pass --force to overwrite)`);
    }
    if (destinationInfo !== undefined && !destinationInfo.isFile()) {
        throw new Error(`refusing to overwrite a non-regular backup destination: ${destination}`);
    }
    ensureCreatedDirsPrivate(path.dirname(destination));
    return destinationInfo === undefined
        ? { state: 'absent' }
        : { state: 'replace', identity: { dev: destinationInfo.dev, ino: destinationInfo.ino } };
}

function assertDescriptorIdentity(descriptor: number, expected: DatabaseFileIdentity): void {
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
        throw new Error('Backup temporary descriptor changed identity.');
    }
}

function verifyThroughHeldDescriptor(databasePath: string, identity: DatabaseFileIdentity, verify: (sqlitePath: string) => void): void {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
        throw new Error('Backup verification is supported on macOS and Linux.');
    }
    const descriptor = openSync(databasePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
    let primaryError: unknown;
    const cleanupFailures: unknown[] = [];
    try {
        assertDescriptorIdentity(descriptor, identity);
        const sqlitePath = process.platform === 'linux' ? `/proc/self/fd/${String(descriptor)}` : `/dev/fd/${String(descriptor)}`;
        verify(sqlitePath);
        assertDescriptorIdentity(descriptor, identity);
    } catch (error: unknown) {
        primaryError = error;
    }
    try {
        closeSync(descriptor);
    } catch (error: unknown) {
        cleanupFailures.push(error);
    }
    if (primaryError !== undefined && cleanupFailures.length === 0) {
        throw primaryError;
    }
    if (primaryError !== undefined || cleanupFailures.length > 0) {
        const failures = primaryError === undefined ? cleanupFailures : [primaryError, ...cleanupFailures];
        throw new AggregateError(failures, `Backup verification descriptor failed for ${databasePath}.`, {
            ...(primaryError === undefined ? {} : { cause: primaryError }),
        });
    }
}

interface DatabaseDescriptorState {
    ctimeNs: bigint;
    digest: string;
    mtimeNs: bigint;
    nlink: bigint;
    size: bigint;
}

function readDatabaseDescriptorState(descriptor: number, expected: DatabaseFileIdentity): DatabaseDescriptorState & { header: Buffer } {
    assertDescriptorIdentity(descriptor, expected);
    const before = fstatSync(descriptor, { bigint: true });
    const hash = createHash('sha256');
    const header = Buffer.alloc(DATABASE_HEADER_BYTES);
    const chunk = Buffer.alloc(DATABASE_EXPORT_VERIFY_CHUNK_BYTES);
    let position = 0n;
    while (true) {
        const bytesRead = readSync(descriptor, chunk, 0, chunk.length, position);
        if (bytesRead === 0) {
            break;
        }
        if (position === 0n) {
            chunk.copy(header, 0, 0, Math.min(bytesRead, header.length));
        }
        hash.update(chunk.subarray(0, bytesRead));
        position += BigInt(bytesRead);
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.ctimeNs !== after.ctimeNs ||
        before.mtimeNs !== after.mtimeNs ||
        before.nlink !== after.nlink ||
        position !== after.size
    ) {
        throw new Error('Backup destination changed while its bytes were being inspected.');
    }
    return {
        ctimeNs: after.ctimeNs,
        digest: hash.digest('hex'),
        header,
        mtimeNs: after.mtimeNs,
        nlink: after.nlink,
        size: after.size,
    };
}

function encryptedDatabaseStateFromDescriptor(
    descriptor: number,
    expected: DatabaseFileIdentity,
): DatabaseDescriptorState & { cipherSalt: string } {
    fsyncSync(descriptor);
    const state = readDatabaseDescriptorState(descriptor, expected);
    if (state.size < BigInt(DATABASE_HEADER_BYTES) || isPlaintextDatabaseHeader(state.header)) {
        throw new Error('Backup destination did not receive an encrypted database.');
    }
    return { ...state, cipherSalt: state.header.toString('hex').toUpperCase() };
}

function assertDatabaseDescriptorUnchanged(
    descriptor: number,
    expectedIdentity: DatabaseFileIdentity,
    expectedContent: DatabaseDescriptorState,
    expectedVerificationState: Omit<DatabaseDescriptorState, 'digest'>,
): void {
    const current = readDatabaseDescriptorState(descriptor, expectedIdentity);
    if (
        current.digest !== expectedContent.digest ||
        current.size !== expectedContent.size ||
        current.size !== expectedVerificationState.size ||
        current.ctimeNs !== expectedVerificationState.ctimeNs ||
        current.mtimeNs !== expectedVerificationState.mtimeNs ||
        current.nlink !== expectedVerificationState.nlink
    ) {
        throw new Error('Backup destination changed while it was being verified.');
    }
}

function assertFinalDatabaseDescriptorUnchanged(
    descriptor: number,
    expectedIdentity: DatabaseFileIdentity,
    expectedContent: DatabaseDescriptorState,
): DatabaseDescriptorState {
    const current = readDatabaseDescriptorState(descriptor, expectedIdentity);
    if (
        current.digest !== expectedContent.digest ||
        current.size !== expectedContent.size ||
        current.mtimeNs !== expectedContent.mtimeNs ||
        current.nlink !== expectedContent.nlink
    ) {
        throw new Error('Backup destination changed after its keyed verification completed.');
    }
    return current;
}

function assertFinalDatabasePathMatchesDescriptor(
    databasePath: string,
    expectedIdentity: DatabaseFileIdentity,
    expectedState: DatabaseDescriptorState,
): void {
    const current = lstatSync(databasePath, { bigint: true });
    if (
        !current.isFile() ||
        current.dev !== expectedIdentity.dev ||
        current.ino !== expectedIdentity.ino ||
        current.size !== expectedState.size ||
        current.ctimeNs !== expectedState.ctimeNs ||
        current.mtimeNs !== expectedState.mtimeNs ||
        current.nlink !== expectedState.nlink
    ) {
        throw new Error('Backup destination changed at its final pathname seal.');
    }
}

type PathKind = 'regular' | 'symlink' | 'other';

interface PathIdentity extends DatabaseFileIdentity {
    kind: PathKind;
}

interface OwnedDatabasePath {
    path: string;
    quarantinePath?: string;
    descriptor?: number;
    identity?: DatabaseFileIdentity;
}

interface OwnedPathState {
    path: string;
    quarantinePath?: string;
}

function currentPathIdentity(databasePath: string): PathIdentity | undefined {
    try {
        const stats = lstatSync(databasePath, { bigint: true });
        const kind = stats.isFile() ? 'regular' : stats.isSymbolicLink() ? 'symlink' : 'other';
        return { dev: stats.dev, ino: stats.ino, kind };
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

function sameIdentity(actual: DatabaseFileIdentity | undefined, expected: DatabaseFileIdentity): boolean {
    return actual?.dev === expected.dev && actual.ino === expected.ino;
}

function restoreQuarantinedPath(quarantinePath: string, destination: string, moved: PathIdentity, failures: unknown[]): boolean {
    try {
        if (moved.kind === 'regular') {
            linkSync(quarantinePath, destination);
            if (!sameIdentity(currentPathIdentity(destination), moved)) {
                failures.push(new Error(`Backup recovery changed identity; retained recovery remains at ${quarantinePath}.`));
                return false;
            }
        } else if (moved.kind === 'symlink') {
            const target = readlinkSync(quarantinePath);
            symlinkSync(target, destination);
            const restored = currentPathIdentity(destination);
            if (restored?.kind !== 'symlink' || readlinkSync(destination) !== target) {
                failures.push(new Error(`Backup symlink recovery changed target; retained recovery remains at ${quarantinePath}.`));
                return false;
            }
        } else {
            failures.push(new Error(`Backup cannot restore this path type; retained recovery remains at ${quarantinePath}.`));
            return false;
        }

        const retained = currentPathIdentity(quarantinePath);
        if (!sameIdentity(retained, moved)) {
            failures.push(new Error(`Backup recovery changed identity before cleanup; retained recovery remains at ${quarantinePath}.`));
            return false;
        }
        unlinkSync(quarantinePath);
        return true;
    } catch (error: unknown) {
        failures.push(error);
        return false;
    }
}

// Renaming first makes the object selected for deletion stable enough to
// inspect without ever unlinking whatever currently occupies the public path.
// A same-UID actor can still race the final quarantine unlink, so a mismatch is
// always restored or retained and reported rather than treated as our file.
function ownedPathCandidates(owned: OwnedPathState): string[] {
    return owned.quarantinePath === undefined || owned.quarantinePath === owned.path ? [owned.path] : [owned.path, owned.quarantinePath];
}

function retireOwnedPath(owned: OwnedPathState, identity: DatabaseFileIdentity, failures: unknown[]): boolean {
    const sourcePath = owned.path;
    const quarantinePath = `${sourcePath}.${process.pid}.${randomUUID()}.discard`;
    // Record both possible locations before rename(2). A wrapper or filesystem
    // can report failure after the move completed, so the call's return alone
    // cannot decide which pathname still owns the recoverable object.
    owned.quarantinePath = quarantinePath;
    try {
        renameSync(sourcePath, quarantinePath);
    } catch (error: unknown) {
        failures.push(error);
        failures.push(
            new Error(`Backup cleanup could not confirm its quarantine move; recovery may remain at ${sourcePath} or ${quarantinePath}.`),
        );
        return false;
    }

    owned.path = quarantinePath;
    owned.quarantinePath = undefined;

    let moved: PathIdentity | undefined;
    try {
        moved = currentPathIdentity(owned.path);
    } catch (error: unknown) {
        failures.push(error);
        failures.push(new Error(`Backup cleanup could not inspect its quarantine; retained recovery remains at ${owned.path}.`));
        return false;
    }
    if (moved === undefined) {
        failures.push(new Error(`Backup cleanup lost its quarantine path; recovery was last represented at ${owned.path}.`));
        return false;
    }
    if (!sameIdentity(moved, identity)) {
        failures.push(new Error(`Backup cleanup found a substituted path: ${sourcePath}`));
        if (restoreQuarantinedPath(owned.path, sourcePath, moved, failures)) {
            owned.path = sourcePath;
        }
        return false;
    }

    try {
        unlinkSync(owned.path);
        return true;
    } catch (error: unknown) {
        failures.push(error);
        failures.push(new Error(`Backup cleanup could not retire its quarantine; retained recovery remains at ${owned.path}.`));
        return false;
    }
}

function recoverOwnedDescriptor(entry: OwnedDatabasePath, failures: unknown[]): void {
    const descriptor = entry.descriptor;
    if (descriptor === undefined) {
        return;
    }
    try {
        const stats = fstatSync(descriptor, { bigint: true });
        if (stats.isFile()) {
            entry.identity ??= { dev: stats.dev, ino: stats.ino };
        } else {
            failures.push(new Error(`Backup-owned descriptor is not a regular file: ${entry.path}`));
        }
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'EBADF') {
            entry.descriptor = undefined;
            return;
        }
        failures.push(error);
    }
    if (entry.descriptor !== undefined) {
        try {
            closeSync(entry.descriptor);
            entry.descriptor = undefined;
        } catch (error: unknown) {
            failures.push(error);
        }
    }
}

function cleanupOwnedDatabaseFiles(files: OwnedDatabasePath[], failures: unknown[]): void {
    for (const entry of files) {
        recoverOwnedDescriptor(entry, failures);
        if (entry.identity !== undefined) {
            retireOwnedPath(entry, entry.identity, failures);
        }
    }
}

function createOwnedDatabaseFile(databasePath: string, files: OwnedDatabasePath[]): DatabaseFileSeal {
    const entry: OwnedDatabasePath = { path: databasePath };
    files.push(entry);
    const descriptor = createPrivateEmptyDatabaseDescriptor(databasePath);
    entry.descriptor = descriptor;
    const identity = inspectPrivateEmptyDatabaseDescriptor(descriptor);
    entry.identity = identity;
    closeSync(descriptor);
    entry.descriptor = undefined;
    return identity;
}

interface VerificationLinkState {
    ownedPath?: OwnedPathState & { identity: DatabaseFileIdentity };
}

function runIdentityBoundVerification(
    databasePath: string,
    proofPath: string,
    descriptor: number,
    identity: DatabaseFileIdentity,
    expectedContent: DatabaseDescriptorState & { cipherSalt: string },
    verify: (proofPath: string, cipherSalt: string) => void,
    state: VerificationLinkState,
): void {
    linkSync(databasePath, proofPath);
    // link(2) is no-replace. Record ownership before any fallible inspection
    // so caught failures can still retire the created name.
    state.ownedPath = { path: proofPath, identity };
    const linkedIdentity = currentPathIdentity(proofPath);
    if (!sameIdentity(linkedIdentity, identity)) {
        throw new Error('Published backup could not be bound to its verification link.');
    }
    const verificationStats = fstatSync(descriptor, { bigint: true });
    assertDescriptorIdentity(descriptor, identity);
    verifyThroughHeldDescriptor(proofPath, identity, (sqlitePath) => verify(sqlitePath, expectedContent.cipherSalt));
    assertDatabaseFileIdentity(proofPath, identity, 'Backup verification link');
    assertDatabaseFileIdentity(databasePath, identity, 'Published backup');
    assertDatabaseDescriptorUnchanged(descriptor, identity, expectedContent, {
        ctimeNs: verificationStats.ctimeNs,
        mtimeNs: verificationStats.mtimeNs,
        nlink: verificationStats.nlink,
        size: verificationStats.size,
    });
}

function verifyIdentityBoundExport(
    databasePath: string,
    descriptor: number,
    identity: DatabaseFileIdentity,
    expectedContent: DatabaseDescriptorState & { cipherSalt: string },
    verify: (proofPath: string, cipherSalt: string) => void,
): void {
    const proofPath = `${databasePath}.${process.pid}.${randomUUID()}.verify`;
    const state: VerificationLinkState = {};
    let primaryError: unknown;
    const cleanupFailures: unknown[] = [];
    try {
        runIdentityBoundVerification(databasePath, proofPath, descriptor, identity, expectedContent, verify, state);
    } catch (error: unknown) {
        primaryError = error;
    } finally {
        if (state.ownedPath !== undefined) {
            retireOwnedPath(state.ownedPath, state.ownedPath.identity, cleanupFailures);
        }
    }
    if (cleanupFailures.length > 0) {
        if (primaryError !== undefined) {
            throw new AggregateError(
                [primaryError, ...cleanupFailures],
                `Backup verification failed: ${errorMessage(primaryError)}. Proof cleanup also failed: ${cleanupFailures
                    .map(errorMessage)
                    .join('; ')}`,
                { cause: primaryError },
            );
        }
        throw cleanupFailures[0];
    }
    if (primaryError !== undefined) {
        throw primaryError;
    }
}

interface DestinationRollback {
    path: string;
    quarantinePath?: string;
    identity: DatabaseFileIdentity;
    state: 'planned' | 'moving' | 'moved' | 'restored' | 'discarded' | 'indeterminate';
}

function retireDestinationRollback(rollback: DestinationRollback): void {
    if (rollback.state !== 'moved') {
        return;
    }
    const failures: unknown[] = [];
    if (retireOwnedPath(rollback, rollback.identity, failures)) {
        rollback.state = 'discarded';
    }
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, 'Backup rollback cleanup failed.');
    }
}

function planDestinationRollback(destination: string, identity: DatabaseFileIdentity): DestinationRollback {
    return {
        path: `${destination}.${process.pid}.${randomUUID()}.rollback`,
        identity,
        state: 'planned',
    };
}

function preserveExistingDestination(destination: string, rollback: DestinationRollback): void {
    const descriptor = openSync(destination, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));

    try {
        const stats = fstatSync(descriptor, { bigint: true });
        if (!stats.isFile() || stats.dev !== rollback.identity.dev || stats.ino !== rollback.identity.ino) {
            throw new Error('Backup destination changed identity after replacement was authorized.');
        }
        rollback.state = 'moving';
        renameSync(destination, rollback.path);
        rollback.state = 'moved';
        const movedIdentity = currentPathIdentity(rollback.path);
        if (!sameIdentity(movedIdentity, rollback.identity)) {
            const identityError = new Error('Backup destination changed identity before it could be preserved.');
            const recoveryFailures: unknown[] = [];
            if (movedIdentity !== undefined) {
                const restored = restoreQuarantinedPath(rollback.path, destination, movedIdentity, recoveryFailures);
                rollback.state = restored ? 'restored' : 'indeterminate';
            } else {
                rollback.state = 'indeterminate';
            }
            if (recoveryFailures.length > 0) {
                throw new AggregateError(
                    [identityError, ...recoveryFailures],
                    `Backup destination changed identity and recovery failed: ${recoveryFailures.map(errorMessage).join('; ')}`,
                    { cause: identityError },
                );
            }
            throw identityError;
        }
    } finally {
        closeSync(descriptor);
    }
}

function classifyRollbackState(destination: string, rollback: DestinationRollback, failures: unknown[]): void {
    if (rollback.state !== 'moving' && rollback.state !== 'moved') {
        return;
    }
    let movedPath: string | undefined;
    let current: PathIdentity | undefined;
    for (const candidate of ownedPathCandidates(rollback)) {
        try {
            if (sameIdentity(currentPathIdentity(candidate), rollback.identity)) {
                movedPath = candidate;
                break;
            }
        } catch (error: unknown) {
            failures.push(error);
        }
    }
    if (movedPath !== undefined) {
        rollback.path = movedPath;
        rollback.quarantinePath = undefined;
        rollback.state = 'moved';
        return;
    }
    try {
        current = currentPathIdentity(destination);
    } catch (error: unknown) {
        failures.push(error);
    }
    if (sameIdentity(current, rollback.identity)) {
        rollback.state = 'restored';
        return;
    }
    rollback.state = 'indeterminate';
    failures.push(
        new Error(
            `Backup could not classify the interrupted destination move; recovery may remain at ${ownedPathCandidates(rollback).join(
                ' or ',
            )} or ${destination}.`,
        ),
    );
}

function restoreDestination(
    destination: string,
    rollback: DestinationRollback,
    publishedIdentity: DatabaseFileIdentity | undefined,
    failures: unknown[],
): void {
    classifyRollbackState(destination, rollback, failures);
    if (rollback.state === 'planned' || rollback.state === 'restored' || rollback.state === 'discarded') {
        return;
    }
    if (rollback.state !== 'moved') {
        failures.push(new Error(`Backup could not restore the previous destination; recovery may remain at ${rollback.path}.`));
        return;
    }

    const currentDestination = currentPathIdentity(destination);
    if (publishedIdentity !== undefined && sameIdentity(currentDestination, publishedIdentity)) {
        const published: OwnedPathState = { path: destination };
        if (!retireOwnedPath(published, publishedIdentity, failures)) {
            failures.push(new Error(`Backup destination changed identity; the previous file remains at ${rollback.path}.`));
            return;
        }
    } else if (currentDestination !== undefined) {
        failures.push(new Error(`Backup destination changed identity; the previous file remains at ${rollback.path}.`));
        return;
    }

    try {
        assertDatabaseFileIdentity(rollback.path, rollback.identity, 'Backup destination rollback');
        linkSync(rollback.path, destination);
        if (!sameIdentity(currentPathIdentity(destination), rollback.identity)) {
            failures.push(new Error(`Backup rollback restoration changed identity; the previous file remains at ${rollback.path}.`));
            return;
        }
        if (!retireOwnedPath(rollback, rollback.identity, failures)) {
            failures.push(new Error(`Backup rollback cleanup changed identity; the restored file remains at ${destination}.`));
            return;
        }
        rollback.state = 'restored';
    } catch (error: unknown) {
        failures.push(error);
    }
}

function replaceDestination(
    destination: string,
    authorization: DestinationAuthorization,
    writeDestination: (databasePath: string, identity: DatabaseFileSeal) => void,
    verify: (databasePath: string, cipherSalt: string) => void,
): void {
    let rollback: DestinationRollback | undefined;
    let identity: DatabaseFileSeal | undefined;
    const ownedFiles: OwnedDatabasePath[] = [];
    let descriptor: number | undefined;
    let failure: unknown;
    let failed = false;
    let outputCommitted = false;
    try {
        if (authorization.state === 'replace') {
            rollback = planDestinationRollback(destination, authorization.identity);
            preserveExistingDestination(destination, rollback);
        }
        identity = createOwnedDatabaseFile(destination, ownedFiles);
        descriptor = openSync(destination, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
        assertDescriptorIdentity(descriptor, identity);
        writeDestination(destination, identity);
        assertDatabaseFileIdentity(destination, identity, 'Published backup');
        const encryptedState = encryptedDatabaseStateFromDescriptor(descriptor, identity);
        verifyIdentityBoundExport(destination, descriptor, identity, encryptedState, verify);
        if (rollback !== undefined) {
            retireDestinationRollback(rollback);
        }
        // The prior rollback is already retired at this accepted final
        // interval. A seal failure can remove the owned output but cannot
        // restore the prior path without a native three-way exchange.
        const finalDescriptorState = assertFinalDatabaseDescriptorUnchanged(descriptor, identity, encryptedState);
        assertFinalDatabasePathMatchesDescriptor(destination, identity, finalDescriptorState);
        // Both irreversible prior retirement and the final content/path seal
        // have completed. Transfer descriptor ownership before close so a
        // reported close failure cannot enter destructive rollback and remove
        // the only verified export that remains.
        outputCommitted = true;
        const committedDescriptor = descriptor;
        descriptor = undefined;
        closeSync(committedDescriptor);
    } catch (error: unknown) {
        failed = true;
        failure = error;
    }
    if (!failed) {
        return;
    }
    if (outputCommitted) {
        throw failure;
    }

    const cleanupFailures: unknown[] = [];
    if (descriptor !== undefined) {
        try {
            closeSync(descriptor);
        } catch (closeError: unknown) {
            cleanupFailures.push(closeError);
        }
        descriptor = undefined;
    }
    cleanupOwnedDatabaseFiles(ownedFiles, cleanupFailures);
    if (rollback !== undefined) {
        restoreDestination(destination, rollback, identity, cleanupFailures);
    }
    if (cleanupFailures.length > 0) {
        throw new AggregateError(
            [failure, ...cleanupFailures],
            `Backup failed for ${destination}: ${errorMessage(failure)}. Cleanup also failed: ${cleanupFailures
                .map(errorMessage)
                .join('; ')}`,
            { cause: failure },
        );
    }
    throw failure;
}

function readExportSchema(source: Database.Database): SchemaRow[] {
    const placeholders = EXPORTED_TABLES.map(() => '?').join(', ');
    return source
        .prepare(
            `SELECT type, name, sql
             FROM sqlite_master
             WHERE sql IS NOT NULL
               AND ((type = 'table' AND name IN (${placeholders}))
                 OR (type IN ('index', 'trigger') AND tbl_name IN (${placeholders})))`,
        )
        .all(...EXPORTED_TABLES, ...EXPORTED_TABLES) as SchemaRow[];
}

function createExportTables(source: Database.Database, targetSchema: string, schema: SchemaRow[]): void {
    for (const entry of schema.filter((entry) => entry.type === 'table')) {
        source.exec(qualifySQLiteCreateSql(entry.sql, entry.type, entry.name, targetSchema));
    }
}

function createExportSecondarySchema(source: Database.Database, targetSchema: string, schema: SchemaRow[]): void {
    for (const entry of schema.filter((entry) => entry.type !== 'table')) {
        source.exec(qualifySQLiteCreateSql(entry.sql, entry.type, entry.name, targetSchema));
    }
}

function exactProjectIds(source: Database.Database, project: ProjectSet): Array<number | bigint> {
    if (project.paths.length === 0) {
        return project.projectIds;
    }
    const placeholders = project.paths.map(() => '?').join(', ');
    const rows = source
        .prepare(`SELECT id, path FROM projects WHERE path IN (${placeholders}) ORDER BY id`)
        .safeIntegers()
        .all(...project.paths) as Array<{ id: bigint; path: string }>;
    const expectedPaths = new Set(project.paths);
    if (rows.length !== expectedPaths.size || rows.some((row) => !expectedPaths.has(row.path))) {
        throw new Error('Resolved project membership changed before backup export.');
    }
    return rows.map((row) => row.id);
}

function copyProjectRows(source: Database.Database, targetSchema: string, projectIds: Array<number | bigint>): void {
    if (projectIds.length === 0) {
        throw new Error('Resolved project set contains no database rows.');
    }
    const ids = projectIds.map(() => '?').join(', ');
    const target = (table: (typeof EXPORTED_TABLES)[number]) => `"${targetSchema.replaceAll('"', '""')}"."${table}"`;
    source.prepare(`INSERT INTO ${target('projects')} SELECT * FROM main.projects WHERE id IN (${ids})`).run(...projectIds);
    source.prepare(`INSERT INTO ${target('sessions')} SELECT * FROM main.sessions WHERE project_id IN (${ids})`).run(...projectIds);
    source
        .prepare(
            `INSERT INTO ${target('memories')}
             SELECT * FROM main.memories
             WHERE session_id IN (SELECT id FROM main.sessions WHERE project_id IN (${ids}))`,
        )
        .run(...projectIds);
    source
        .prepare(
            `INSERT INTO ${target('session_rollups')}
             SELECT * FROM main.session_rollups
             WHERE session_id IN (SELECT id FROM main.sessions WHERE project_id IN (${ids}))`,
        )
        .run(...projectIds);
}

function cloneProjectDatabase(source: Database.Database, targetSchema: string, project: ProjectSet): void {
    const snapshot = source.transaction(() => {
        const schema = readExportSchema(source);
        const sourceTables = new Set(schema.filter((entry) => entry.type === 'table').map((entry) => entry.name));
        const missingTable = EXPORTED_TABLES.find((table) => !sourceTables.has(table));
        if (missingTable !== undefined) {
            throw new Error(`no such table: ${missingTable}`);
        }
        createExportTables(source, targetSchema, schema);
        copyProjectRows(source, targetSchema, exactProjectIds(source, project));
        createExportSecondarySchema(source, targetSchema, schema);
    });
    snapshot();
}
