import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdtempSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import type { Command } from 'commander';
import { PRIVATE_FILE_MODE, SQLITE_MINIMUM_DATABASE_BYTES } from '../../config/constants.js';
import { daemonHealth as currentDaemonHealth, type DaemonHealth } from '../../install/health-checks.js';
import { writeBackup } from '../../storage/backup.js';
import { validateCandidateSemantics } from '../../storage/candidate-validator.js';
import { type DatabaseEncryptionRuntime, databaseKey } from '../../storage/database-encryption.js';
import {
    type ExclusiveDatabaseLifecycleLease,
    withExclusiveDatabaseLifecycle,
    withSharedDatabaseLifecycle,
} from '../../storage/database-lifecycle.js';
import {
    defaultDbPath,
    hasPlaintextDatabaseHeader,
    openDb,
    openKeyedDatabase,
    openManagedDatabase,
    openUnmanagedDb,
} from '../../storage/db.js';
import { assertCanonicalDurableCaptureSchema, normalizeAndVerifyDurableCapture } from '../../storage/durable-capture-integrity.js';
import { errorMessage } from '../../util/error.js';
import { atomicCopyPrivateFile } from '../../util/fs.js';
import { runRestoreWizard } from '../restore-wizard.js';
import { confirmYesNo } from '../shared.js';

export const REQUIRED_RESTORE_TABLES = [
    'projects',
    'sessions',
    'memories',
    'session_rollups',
    'consent_roots',
    'injections',
    'purged_transcripts',
] as const;
export const RESTORE_TOMBSTONES_CHANGED_ERROR =
    'Restore preview is stale because active transcript tombstones changed. Run restore again to review the current state.';
export const RESTORE_CONSENT_CHANGED_ERROR =
    'Restore preview is stale because active consent changed. Run restore again to review the current state.';
export const RESTORE_CONSENT_TRIGGER_ERROR = 'Backup is unsafe because it contains a consent-root trigger.';

type RequiredRestoreTable = (typeof REQUIRED_RESTORE_TABLES)[number];
type RestoreCounts = Record<RequiredRestoreTable, number>;
type TableColumn = { name: string; type: string };
type TranscriptIdentity = { tool: string; native_id: string };
type ConsentRoot = {
    ulid: string;
    path: string;
    state: string;
    decided_at: string;
    source: string;
    nudged_at: string | null;
};

const TOMBSTONE_TABLES = [
    { table: 'purged_transcripts', timestampColumn: 'purged_at' },
    { table: 'incognito_transcripts', timestampColumn: 'tombstoned_at' },
] as const;
const DATABASE_COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

type TombstoneTable = (typeof TOMBSTONE_TABLES)[number]['table'];
type TranscriptTombstones = Record<TombstoneTable, TranscriptIdentity[]>;
type TranscriptTombstonePlan = { tombstones: TranscriptTombstones; fingerprint: string };
type ConsentPlan = { roots: ConsentRoot[]; fingerprint: string };

interface RestoreCommandOptions {
    skipConfirmation: boolean;
}

export interface RestoreRuntime {
    dbPath?: string;
    encryption?: DatabaseEncryptionRuntime;
    daemonHealth?: () => DaemonHealth;
    writeBackup?: (db: Database.Database, dbPath: string) => string;
    confirm?: () => Promise<boolean>;
}

export interface RestoreResult {
    cancelled: boolean;
    snapshotPath?: string;
}

class RestoreApplyError extends Error {
    constructor(
        readonly snapshotPath: string,
        cause: unknown,
    ) {
        super(`Restore failed after saving the pre-restore snapshot to ${snapshotPath}: ${errorMessage(cause)}`);
    }
}

function quoteTable(table: RequiredRestoreTable): string {
    return `"${table}"`;
}

function candidateCounts(db: Database.Database): RestoreCounts {
    return Object.fromEntries(
        REQUIRED_RESTORE_TABLES.map((table) => [
            table,
            Number((db.prepare(`SELECT COUNT(*) AS count FROM ${quoteTable(table)}`).get() as { count: number }).count),
        ]),
    ) as RestoreCounts;
}

function missingRequiredTables(db: Database.Database): RequiredRestoreTable[] {
    const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    return REQUIRED_RESTORE_TABLES.filter((table) => !tables.has(table));
}

function tableColumns(db: Database.Database, table: RequiredRestoreTable): Map<string, string> {
    return new Map(
        (db.prepare(`PRAGMA table_info(${quoteTable(table)})`).all() as TableColumn[]).map((column) => [column.name, column.type]),
    );
}

function schemaDifferences(candidate: Database.Database, canonical: Database.Database): string[] {
    const errors: string[] = [];
    for (const table of REQUIRED_RESTORE_TABLES) {
        const candidateColumns = tableColumns(candidate, table);
        const canonicalColumns = tableColumns(canonical, table);
        const missing = [...canonicalColumns.keys()].filter((column) => !candidateColumns.has(column));
        const extra = [...candidateColumns.keys()].filter((column) => !canonicalColumns.has(column));
        const typeMismatches = [...canonicalColumns].filter(
            ([column, type]) => candidateColumns.has(column) && candidateColumns.get(column) !== type,
        );

        if (missing.length > 0) {
            errors.push(`${table}: missing column(s): ${missing.join(', ')}`);
        }
        if (extra.length > 0) {
            errors.push(`${table}: unexpected column(s): ${extra.join(', ')}`);
        }
        for (const [column, type] of typeMismatches) {
            errors.push(`${table}: ${column} has type ${candidateColumns.get(column)}, expected ${type}`);
        }
    }
    return errors;
}

function removeTemporaryDatabase(dbPath: string, directory: string): void {
    let cleanupError: unknown;
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
            unlinkSync(file);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && cleanupError === undefined) {
                cleanupError = error;
            }
        }
    }
    try {
        rmdirSync(directory);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && cleanupError === undefined) {
            cleanupError = error;
        }
    }
    if (cleanupError !== undefined) {
        throw cleanupError;
    }
}

// Opens the staged backup so accepted older backups receive the same idempotent migrations as the active database.
function verifyStagedSchema(stagedPath: string, encryptionKey?: Buffer): void {
    let staged: Database.Database | undefined;
    let canonical: Database.Database | undefined;
    try {
        staged = encryptionKey === undefined ? openUnmanagedDb(stagedPath) : openKeyedDatabase(stagedPath, encryptionKey);
        canonical = openDb(':memory:');
        const errors = schemaDifferences(staged, canonical);
        if (errors.length > 0) {
            throw new Error(`Backup schema does not match the current elepha schema after migration: ${errors.join('; ')}`);
        }
        assertCanonicalDurableCaptureSchema(staged, canonical);
        const semanticViolations = validateCandidateSemantics(staged, ['sessions', 'memories', 'session_rollups', 'consent_roots']);
        if (semanticViolations.length > 0) {
            throw new Error(`Backup is semantically invalid: ${semanticViolations.join('; ')}`);
        }
        normalizeAndVerifyDurableCapture(staged);
    } finally {
        canonical?.close();
        staged?.close();
    }
}

function verifyDatabase(db: Database.Database, expectedCounts: RestoreCounts): string[] {
    const missing = missingRequiredTables(db);
    const errors = missing.length > 0 ? [`missing required table(s): ${missing.join(', ')}`] : [];
    if (missing.length > 0) {
        return errors;
    }
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        errors.push(`integrity_check failed: ${integrity.map((row) => row.integrity_check).join('; ')}`);
    }
    const foreignKeys = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeys.length > 0) {
        errors.push(`foreign_key_check found ${foreignKeys.length} violation(s)`);
    }
    const actualCounts = candidateCounts(db);
    for (const table of REQUIRED_RESTORE_TABLES) {
        if (actualCounts[table] !== expectedCounts[table]) {
            errors.push(`${table} row count is ${actualCounts[table]}, expected ${expectedCounts[table]}`);
        }
    }
    return errors;
}

function inspectCandidate(stagedPath: string, candidatePath: string, encryptionKey?: Buffer): RestoreCounts {
    let candidate: Database.Database | undefined;
    let counts: RestoreCounts | undefined;
    let validationError: string | undefined;
    try {
        candidate =
            encryptionKey === undefined
                ? new Database(stagedPath, { readonly: true, fileMustExist: true })
                : openKeyedDatabase(stagedPath, encryptionKey, { readonly: true, fileMustExist: true });
        const consentTrigger = candidate
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'consent_roots' COLLATE NOCASE LIMIT 1")
            .get();
        if (consentTrigger !== undefined) {
            validationError = RESTORE_CONSENT_TRIGGER_ERROR;
        } else {
            const missing = missingRequiredTables(candidate);
            if (missing.length > 0) {
                validationError = `Backup is incomplete (missing required table(s): ${missing.join(', ')}). Project exports cannot be restored; use the future elepha import command instead.`;
            } else {
                counts = candidateCounts(candidate);
                const errors = verifyDatabase(candidate, counts);
                if (errors.length > 0) {
                    validationError = `Backup failed validation: ${errors.join('; ')}`;
                }
            }
        }
    } catch (error) {
        throw new Error(`Not a valid SQLite backup at ${candidatePath}: ${errorMessage(error)}`);
    } finally {
        candidate?.close();
    }
    if (validationError !== undefined) {
        throw new Error(validationError);
    }
    if (counts === undefined) {
        throw new Error(`Not a valid SQLite backup at ${candidatePath}.`);
    }
    verifyStagedSchema(stagedPath, encryptionKey);
    return counts;
}

async function sha256File(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

function printPreview(dbPath: string, candidatePath: string, counts: RestoreCounts, tombstones: TranscriptTombstones): void {
    console.log(`Restore preview: ${candidatePath}`);
    console.log(`Active database: ${dbPath}`);
    console.log('Candidate rows (the active database will become):');
    for (const table of REQUIRED_RESTORE_TABLES) {
        console.log(`  ${table}: ${counts[table]}`);
    }
    console.log(
        `Carried tombstones: purged_transcripts: ${tombstones.purged_transcripts.length}, incognito_transcripts: ${tombstones.incognito_transcripts.length}`,
    );
}

async function checkpointActiveDatabase(
    dbPath: string,
    lifecycle: ExclusiveDatabaseLifecycleLease,
    encryption?: DatabaseEncryptionRuntime,
): Promise<Database.Database> {
    const db = await openManagedDatabase(dbPath, { fileMustExist: true, encryption, lifecycle });
    db.pragma('wal_checkpoint(TRUNCATE)');
    return db;
}

function transcriptTombstonePlan(tombstones: TranscriptTombstones): TranscriptTombstonePlan {
    const normalized: TranscriptTombstones = { purged_transcripts: [], incognito_transcripts: [] };
    for (const { table } of TOMBSTONE_TABLES) {
        normalized[table] = [...tombstones[table]].sort((left, right) => {
            if (left.tool < right.tool) {
                return -1;
            }
            if (left.tool > right.tool) {
                return 1;
            }
            if (left.native_id < right.native_id) {
                return -1;
            }
            if (left.native_id > right.native_id) {
                return 1;
            }
            return 0;
        });
    }
    const serialized = JSON.stringify(
        TOMBSTONE_TABLES.map(({ table }) => [table, normalized[table].map(({ tool, native_id }) => [tool, native_id])]),
    );
    return { tombstones: normalized, fingerprint: createHash('sha256').update(serialized).digest('hex') };
}

async function activeTranscriptTombstones(
    dbPath: string,
    encryption?: DatabaseEncryptionRuntime,
    lifecycle?: ExclusiveDatabaseLifecycleLease,
): Promise<TranscriptTombstonePlan> {
    const tombstones: TranscriptTombstones = { purged_transcripts: [], incognito_transcripts: [] };
    if (!existsSync(dbPath)) {
        return transcriptTombstonePlan(tombstones);
    }
    const active = await openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption, lifecycle });
    try {
        for (const { table } of TOMBSTONE_TABLES) {
            const exists = active.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
            if (exists !== undefined) {
                tombstones[table] = active.prepare(`SELECT tool, native_id FROM ${table}`).all() as TranscriptIdentity[];
            }
        }
        return transcriptTombstonePlan(tombstones);
    } finally {
        active.close();
    }
}

function consentPlan(roots: ConsentRoot[]): ConsentPlan {
    const normalized = [...roots].sort((left, right) => {
        const leftIdentity = JSON.stringify([left.ulid, left.path]);
        const rightIdentity = JSON.stringify([right.ulid, right.path]);
        return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
    });
    const serialized = JSON.stringify(
        normalized.map(({ ulid, path, state, decided_at, source, nudged_at }) => [ulid, path, state, decided_at, source, nudged_at]),
    );
    return { roots: normalized, fingerprint: createHash('sha256').update(serialized).digest('hex') };
}

async function activeConsent(
    dbPath: string,
    encryption?: DatabaseEncryptionRuntime,
    lifecycle?: ExclusiveDatabaseLifecycleLease,
): Promise<ConsentPlan> {
    if (!existsSync(dbPath)) {
        return consentPlan([]);
    }
    const active = await openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption, lifecycle });
    try {
        return consentPlan(
            active.prepare('SELECT ulid, path, state, decided_at, source, nudged_at FROM consent_roots').all() as ConsentRoot[],
        );
    } finally {
        active.close();
    }
}

async function overlayConsent(
    dbPath: string,
    roots: ConsentRoot[],
    lifecycle: ExclusiveDatabaseLifecycleLease,
    encryption?: DatabaseEncryptionRuntime,
): Promise<void> {
    const restored = await openDb(dbPath, { encryption, lifecycle });
    try {
        const replace = restored.transaction(() => {
            restored.prepare('DELETE FROM consent_roots').run();
            const insert = restored.prepare(
                `INSERT INTO consent_roots (ulid, path, state, decided_at, source, nudged_at)
                 VALUES (@ulid, @path, @state, @decided_at, @source, @nudged_at)`,
            );
            for (const root of roots) {
                insert.run(root);
            }
        });
        replace();
        const checkpoint = restored.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
        if (checkpoint[0]?.busy !== 0) {
            throw new Error('Could not checkpoint preserved consent state.');
        }
    } finally {
        restored.close();
    }
}

async function unionTranscriptTombstones(
    dbPath: string,
    tombstones: TranscriptTombstones,
    lifecycle: ExclusiveDatabaseLifecycleLease,
    encryption?: DatabaseEncryptionRuntime,
): Promise<void> {
    const restored = await openDb(dbPath, { encryption, lifecycle });
    try {
        const recordedAt = new Date().toISOString();
        restored.transaction(() => {
            for (const { table, timestampColumn } of TOMBSTONE_TABLES) {
                const insert = restored.prepare(`INSERT OR IGNORE INTO ${table} (tool, native_id, ${timestampColumn}) VALUES (?, ?, ?)`);
                for (const transcript of tombstones[table]) {
                    insert.run(transcript.tool, transcript.native_id, recordedAt);
                }
            }
            // Delete explicitly so the filtered-turn AFTER DELETE trigger also
            // removes every indexed term from the external-content FTS table.
            restored
                .prepare(
                    `DELETE FROM filtered_turns
                     WHERE memory_id IN (
                         SELECT m.id
                         FROM memories m
                         JOIN sessions s ON s.id = m.session_id
                         WHERE EXISTS (
                                   SELECT 1 FROM purged_transcripts p
                                   WHERE p.tool = s.tool AND p.native_id = s.native_id
                               )
                            OR EXISTS (
                                   SELECT 1 FROM incognito_transcripts i
                                   WHERE i.tool = s.tool AND i.native_id = s.native_id
                               )
                     )`,
                )
                .run();
        })();
        normalizeAndVerifyDurableCapture(restored);
        const checkpoint = restored.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
        if (checkpoint[0]?.busy !== 0) {
            throw new Error('Could not checkpoint preserved transcript tombstones.');
        }
    } finally {
        restored.close();
    }
}

function removeAndVerifyDatabaseCompanions(dbPath: string, lifecycle: ExclusiveDatabaseLifecycleLease): void {
    // SQLite derives companions from its physical filename, which differs from
    // the configured path when the final component is a symlink.
    const physicalDatabaseFilename = lifecycle.resolvePhysicalDatabaseFilename();
    const companions = [
        ...new Set(
            [dbPath, physicalDatabaseFilename].flatMap((databaseFilename) =>
                DATABASE_COMPANION_SUFFIXES.map((suffix) => `${databaseFilename}${suffix}`),
            ),
        ),
    ];
    for (const companion of companions) {
        try {
            unlinkSync(companion);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }
    for (const companion of companions) {
        try {
            lstatSync(companion);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                continue;
            }
            throw error;
        }
        throw new Error(`managed database companion remained after cleanup: ${companion}`);
    }
}

async function verifyRestoredDatabase(
    dbPath: string,
    expectedCounts: RestoreCounts,
    lifecycle: ExclusiveDatabaseLifecycleLease,
    encryption?: DatabaseEncryptionRuntime,
): Promise<void> {
    const restored = await openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption, lifecycle });
    try {
        const errors = verifyDatabase(restored, expectedCounts);
        if (errors.length > 0) {
            throw new Error(errors.join('; '));
        }
    } finally {
        restored.close();
    }
}

function assertInstalledRestoreHash(installedHash: string, stagedHash: string): void {
    if (installedHash !== stagedHash) {
        throw new Error('Installed database hash does not match the validated backup.');
    }
}

function assertRolledBackRestoreHash(rolledBackHash: string, snapshotHash: string): void {
    if (rolledBackHash !== snapshotHash) {
        throw new Error('Rolled-back database hash does not match the pre-restore snapshot.');
    }
}

// Restore replaces the database file atomically after validation, so its apply
// step cannot use the SQL-transaction destructive-operation runner.
export async function runRestoreOperation(candidatePath: string, runtime: RestoreRuntime = {}): Promise<RestoreResult> {
    const dbPath = path.resolve(runtime.dbPath ?? defaultDbPath());
    if (!existsSync(candidatePath)) {
        throw new Error(`Backup file not found: ${candidatePath}`);
    }
    const stagedDirectory = mkdtempSync(path.join(tmpdir(), 'elepha-restore-'));
    const stagedPath = path.join(stagedDirectory, 'candidate.db');
    let candidateKey: Buffer | undefined;
    try {
        atomicCopyPrivateFile(candidatePath, stagedPath, PRIVATE_FILE_MODE);
        if (!hasPlaintextDatabaseHeader(stagedPath)) {
            if (statSync(stagedPath).size < SQLITE_MINIMUM_DATABASE_BYTES) {
                throw new Error(`Not a valid SQLite backup at ${candidatePath}.`);
            }
            candidateKey = await withSharedDatabaseLifecycle(dbPath, () => databaseKey(dbPath, false, runtime.encryption));
        }
        const counts = inspectCandidate(stagedPath, candidatePath, candidateKey);
        const stagedHash = await sha256File(stagedPath);
        const health = (runtime.daemonHealth ?? currentDaemonHealth)();
        if (health.healthy) {
            throw new Error(`Refusing restore while the daemon is running (${health.state}). Run elepha pause first.`);
        }
        if (health.state.startsWith('STUCK')) {
            console.error(`Daemon appears stuck (${health.state}); proceeding — it is not writing.`);
        }
        const tombstonePlan = await activeTranscriptTombstones(dbPath, runtime.encryption);
        const currentConsentPlan = await activeConsent(dbPath, runtime.encryption);
        printPreview(dbPath, candidatePath, counts, tombstonePlan.tombstones);
        if (runtime.confirm && !(await runtime.confirm())) {
            return { cancelled: true };
        }

        return await withExclusiveDatabaseLifecycle(dbPath, async (lifecycle) => {
            const currentHealth = (runtime.daemonHealth ?? currentDaemonHealth)();
            if (currentHealth.healthy) {
                throw new Error(`Refusing restore while the daemon is running (${currentHealth.state}). Run elepha pause first.`);
            }
            if (currentHealth.state.startsWith('STUCK') && currentHealth.state !== health.state) {
                console.error(`Daemon appears stuck (${currentHealth.state}); proceeding — it is not writing.`);
            }
            if (!existsSync(dbPath)) {
                throw new Error(`No active elepha database exists at ${dbPath}; nothing can be snapshotted before restore.`);
            }
            const currentTombstonePlan = await activeTranscriptTombstones(dbPath, runtime.encryption, lifecycle);
            if (currentTombstonePlan.fingerprint !== tombstonePlan.fingerprint) {
                throw new Error(RESTORE_TOMBSTONES_CHANGED_ERROR);
            }
            const confirmedConsentPlan = await activeConsent(dbPath, runtime.encryption, lifecycle);
            if (confirmedConsentPlan.fingerprint !== currentConsentPlan.fingerprint) {
                throw new Error(RESTORE_CONSENT_CHANGED_ERROR);
            }
            const active = await checkpointActiveDatabase(dbPath, lifecycle, runtime.encryption);
            let snapshotPath: string;
            try {
                snapshotPath = (runtime.writeBackup ?? writeBackup)(active, dbPath);
            } finally {
                active.close();
            }
            const snapshotHash = await sha256File(snapshotPath);
            lifecycle.beginReplacement();
            try {
                lifecycle.assertReplacementReady();
                atomicCopyPrivateFile(stagedPath, dbPath, PRIVATE_FILE_MODE);
                const installedHash = await sha256File(dbPath);
                assertInstalledRestoreHash(installedHash, stagedHash);
                removeAndVerifyDatabaseCompanions(dbPath, lifecycle);
                await verifyRestoredDatabase(dbPath, counts, lifecycle, runtime.encryption);
                await overlayConsent(dbPath, confirmedConsentPlan.roots, lifecycle, runtime.encryption);
                await unionTranscriptTombstones(dbPath, currentTombstonePlan.tombstones, lifecycle, runtime.encryption);
                // Read-only verification can create fresh empty WAL bookkeeping files;
                // remove them too so no sidecar from before the replacement can survive.
                removeAndVerifyDatabaseCompanions(dbPath, lifecycle);
                lifecycle.completeReplacement();
            } catch (restoreError) {
                try {
                    lifecycle.assertReplacementReady();
                    atomicCopyPrivateFile(snapshotPath, dbPath, PRIVATE_FILE_MODE);
                    assertRolledBackRestoreHash(await sha256File(dbPath), snapshotHash);
                    removeAndVerifyDatabaseCompanions(dbPath, lifecycle);
                    lifecycle.completeReplacement();
                } catch (rollbackError) {
                    throw new RestoreApplyError(
                        snapshotPath,
                        new Error(`Rollback failed: ${errorMessage(rollbackError)}. Original restore error: ${errorMessage(restoreError)}`),
                    );
                }
                throw new Error(
                    `Restore failed and the previous database was rolled back from ${snapshotPath}: ${errorMessage(restoreError)}`,
                );
            }
            console.log(`Restored ${dbPath} from ${candidatePath}. Pre-restore snapshot: ${snapshotPath}`);
            return { cancelled: false, snapshotPath };
        });
    } finally {
        candidateKey?.fill(0);
        removeTemporaryDatabase(stagedPath, stagedDirectory);
    }
}

async function confirmRestore(): Promise<boolean> {
    return confirmYesNo('Replace the current elepha database with this backup? A snapshot is saved first. [y/N] ');
}

function reportRestoreError(error: unknown): void {
    console.error(errorMessage(error));
    process.exitCode = 1;
}

// Registers full-database restore. Project exports are deliberately reserved for the future import command.
export function registerRestore(program: Command): void {
    program
        .command('restore [file]')
        .description('Replace the local elepha database from a full elepha backup')
        .option('--skip-confirmation', 'restore without an interactive confirmation')
        .action(async (file: string | undefined, opts: RestoreCommandOptions) => {
            const restore = (candidate: string, confirm?: () => Promise<boolean>) =>
                runRestoreOperation(candidate, { dbPath: defaultDbPath(), confirm });
            if (file === undefined) {
                if (!process.stdin.isTTY) {
                    console.error('Specify a backup file when not running interactively.');
                    process.exitCode = 1;
                    return;
                }
                try {
                    process.exitCode = await runRestoreWizard({
                        restore: (candidate, confirm) => restore(candidate, confirm),
                    });
                } catch (error) {
                    reportRestoreError(error);
                }
                return;
            }

            const confirm = opts.skipConfirmation
                ? undefined
                : process.stdin.isTTY
                  ? confirmRestore
                  : async () => {
                        throw new Error('Refusing to restore without a TTY confirmation. Re-run interactively or use --skip-confirmation.');
                    };
            try {
                const result = await restore(path.resolve(file), confirm);
                if (result.cancelled) {
                    console.log('Cancelled — no changes were made.');
                }
            } catch (error) {
                reportRestoreError(error);
            }
        });
}
