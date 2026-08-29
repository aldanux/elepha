import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Command } from 'commander';
import { PRIVATE_FILE_MODE } from '../../config/constants.js';
import { daemonHealth as currentDaemonHealth, type DaemonHealth } from '../../install/health-checks.js';
import { writeBackup } from '../../storage/backup.js';
import { validateCandidateSemantics } from '../../storage/candidate-validator.js';
import { defaultDbPath, openDb } from '../../storage/db.js';
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

type RequiredRestoreTable = (typeof REQUIRED_RESTORE_TABLES)[number];
type RestoreCounts = Record<RequiredRestoreTable, number>;
type TableColumn = { name: string; type: string };
type TranscriptIdentity = { tool: string; native_id: string };

const TOMBSTONE_TABLES = [
    { table: 'purged_transcripts', timestampColumn: 'purged_at' },
    { table: 'incognito_transcripts', timestampColumn: 'tombstoned_at' },
] as const;

type TombstoneTable = (typeof TOMBSTONE_TABLES)[number]['table'];
type TranscriptTombstones = Record<TombstoneTable, TranscriptIdentity[]>;

interface RestoreCommandOptions {
    skipConfirmation: boolean;
}

export interface RestoreRuntime {
    dbPath?: string;
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

/** Opens the staged backup so accepted older backups receive the same idempotent migrations as the active database. */
function verifyStagedSchema(stagedPath: string): void {
    let staged: Database.Database | undefined;
    let canonical: Database.Database | undefined;
    try {
        staged = openDb(stagedPath);
        canonical = openDb(':memory:');
        const errors = schemaDifferences(staged, canonical);
        if (errors.length > 0) {
            throw new Error(`Backup schema does not match the current elepha schema after migration: ${errors.join('; ')}`);
        }
        const semanticViolations = validateCandidateSemantics(staged, ['sessions', 'memories', 'session_rollups', 'consent_roots']);
        if (semanticViolations.length > 0) {
            throw new Error(`Backup is semantically invalid: ${semanticViolations.join('; ')}`);
        }
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

function inspectCandidate(stagedPath: string, candidatePath: string): RestoreCounts {
    let candidate: Database.Database | undefined;
    let counts: RestoreCounts | undefined;
    let validationError: string | undefined;
    try {
        candidate = new Database(stagedPath, { readonly: true, fileMustExist: true });
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
    verifyStagedSchema(stagedPath);
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

function checkpointActiveDatabase(dbPath: string): Database.Database {
    const db = new Database(dbPath);
    db.pragma('wal_checkpoint(TRUNCATE)');
    return db;
}

function activeTranscriptTombstones(dbPath: string): TranscriptTombstones {
    const tombstones: TranscriptTombstones = { purged_transcripts: [], incognito_transcripts: [] };
    if (!existsSync(dbPath)) {
        return tombstones;
    }
    const active = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        for (const { table } of TOMBSTONE_TABLES) {
            const exists = active.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
            if (exists !== undefined) {
                tombstones[table] = active.prepare(`SELECT tool, native_id FROM ${table}`).all() as TranscriptIdentity[];
            }
        }
        return tombstones;
    } finally {
        active.close();
    }
}

function unionTranscriptTombstones(dbPath: string, tombstones: TranscriptTombstones): void {
    const restored = openDb(dbPath);
    try {
        const recordedAt = new Date().toISOString();
        restored.transaction(() => {
            for (const { table, timestampColumn } of TOMBSTONE_TABLES) {
                const insert = restored.prepare(`INSERT OR IGNORE INTO ${table} (tool, native_id, ${timestampColumn}) VALUES (?, ?, ?)`);
                for (const transcript of tombstones[table]) {
                    insert.run(transcript.tool, transcript.native_id, recordedAt);
                }
            }
        })();
        const checkpoint = restored.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
        if (checkpoint[0]?.busy !== 0) {
            throw new Error('Could not checkpoint preserved transcript tombstones.');
        }
    } finally {
        restored.close();
    }
}

function removeStaleSidecars(dbPath: string): void {
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
            unlinkSync(sidecar);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }
}

function verifyRestoredDatabase(dbPath: string, expectedCounts: RestoreCounts): void {
    const restored = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const errors = verifyDatabase(restored, expectedCounts);
        if (errors.length > 0) {
            throw new Error(errors.join('; '));
        }
    } finally {
        restored.close();
    }
}

/** Validates an external SQLite file then replaces the active database; it cannot use runDestructiveOp because the apply is an atomic file replacement, not a SQL transaction. */
export async function runRestoreOperation(candidatePath: string, runtime: RestoreRuntime = {}): Promise<RestoreResult> {
    const dbPath = runtime.dbPath ?? defaultDbPath();
    if (!existsSync(candidatePath)) {
        throw new Error(`Backup file not found: ${candidatePath}`);
    }
    const stagedDirectory = mkdtempSync(path.join(tmpdir(), 'elepha-restore-'));
    const stagedPath = path.join(stagedDirectory, 'candidate.db');
    try {
        atomicCopyPrivateFile(candidatePath, stagedPath, PRIVATE_FILE_MODE);
        const counts = inspectCandidate(stagedPath, candidatePath);
        const stagedHash = await sha256File(stagedPath);
        const health = (runtime.daemonHealth ?? currentDaemonHealth)();
        if (health.healthy) {
            throw new Error(`Refusing restore while the daemon is running (${health.state}). Run elepha pause first.`);
        }
        if (health.state.startsWith('STUCK')) {
            console.error(`Daemon appears stuck (${health.state}); proceeding — it is not writing.`);
        }
        const tombstones = activeTranscriptTombstones(dbPath);
        printPreview(dbPath, candidatePath, counts, tombstones);
        if (runtime.confirm && !(await runtime.confirm())) {
            return { cancelled: true };
        }

        if (!existsSync(dbPath)) {
            throw new Error(`No active elepha database exists at ${dbPath}; nothing can be snapshotted before restore.`);
        }
        const active = checkpointActiveDatabase(dbPath);
        let snapshotPath: string;
        try {
            snapshotPath = (runtime.writeBackup ?? writeBackup)(active, dbPath);
        } finally {
            active.close();
        }
        try {
            atomicCopyPrivateFile(stagedPath, dbPath, PRIVATE_FILE_MODE);
        } catch (error) {
            throw new RestoreApplyError(snapshotPath, error);
        }
        try {
            const installedHash = await sha256File(dbPath);
            if (installedHash !== stagedHash) {
                //noinspection ExceptionCaughtLocallyJS
                throw new Error('Installed database hash does not match the validated backup.');
            }
            removeStaleSidecars(dbPath);
            verifyRestoredDatabase(dbPath, counts);
            unionTranscriptTombstones(dbPath, tombstones);
            // Read-only verification can create fresh empty WAL bookkeeping files;
            // remove them too so no sidecar from before the replacement can survive.
            removeStaleSidecars(dbPath);
        } catch (restoreError) {
            try {
                atomicCopyPrivateFile(snapshotPath, dbPath, PRIVATE_FILE_MODE);
                removeStaleSidecars(dbPath);
            } catch (rollbackError) {
                throw new RestoreApplyError(
                    snapshotPath,
                    new Error(`Rollback failed: ${errorMessage(rollbackError)}. Original restore error: ${errorMessage(restoreError)}`),
                );
            }
            throw new Error(`Restore failed and the previous database was rolled back from ${snapshotPath}: ${errorMessage(restoreError)}`);
        }
        console.log(`Restored ${dbPath} from ${candidatePath}. Pre-restore snapshot: ${snapshotPath}`);
        return { cancelled: false, snapshotPath };
    } finally {
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

/** Registers full-database restore. Project exports are deliberately reserved for the future import command. */
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
