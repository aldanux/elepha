import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, lstatSync, mkdtempSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import type { Command } from 'commander';
import { PRIVATE_FILE_MODE, SQLITE_MINIMUM_DATABASE_BYTES } from '../../config/constants.js';
import { daemonHealth as currentDaemonHealth, type DaemonHealth } from '../../install/health-checks.js';
import { normalizeForNearVerbatim } from '../../security/self-ingestion.js';
import { writeBackup } from '../../storage/backup.js';
import { validateCandidateSemantics } from '../../storage/candidate-validator.js';
import {
    type DatabaseEncryptionRuntime,
    databaseKey,
    type EncryptionMetadata,
    encryptionMetadataPath,
    readEncryptionMetadata,
    readStoredDatabaseKey,
} from '../../storage/database-encryption.js';
import {
    type ExclusiveDatabaseLifecycleLease,
    withExclusiveDatabaseLifecycle,
    withSharedDatabaseLifecycle,
} from '../../storage/database-lifecycle.js';
import {
    defaultDbPath,
    hasPlaintextDatabaseHeader,
    openDb,
    openInitializedKeyedDatabase,
    openKeyedDatabase,
    openManagedDatabase,
    openUnmanagedDb,
} from '../../storage/db.js';
import {
    assertCanonicalDurableCaptureSchema,
    normalizeAndVerifyDurableCapture,
    tableClauseSignature,
} from '../../storage/durable-capture-integrity.js';
import {
    assertBoundedDatabaseSchemaMetadata,
    assertEncryptedDatabaseFile,
    createPrivateEmptyDatabaseDescriptor,
    DATABASE_SCHEMA_METADATA_LIMIT_ERROR,
    inspectDatabaseImportSource,
    inspectPrivateEmptyDatabaseDescriptor,
    writeEncryptedDatabaseImport,
} from '../../storage/encrypted-database-export.js';
import type { InjectionRow } from '../../storage/injection-store.js';
import { type ParanoidControlState, readParanoidControlState } from '../../storage/paranoid-gate.js';
import { isToolName } from '../../types/index.js';
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
export const RESTORE_PARANOID_CHANGED_ERROR =
    'Restore preview is stale because active paranoid authority changed. Run restore again to review the current state.';
export const RESTORE_INJECTIONS_CHANGED_ERROR =
    'Restore preview is stale because active injection provenance changed. Run restore again to review the current state.';
export const RESTORE_EVICTIONS_CHANGED_ERROR =
    'Restore preview is stale because active terminal evictions changed. Run restore again to review the current state.';
export const RESTORE_ENCRYPTION_CHANGED_ERROR =
    'Restore preview is stale because active database encryption changed. Run restore again to review the current state.';
export const RESTORE_STAGE_CHANGED_ERROR =
    'Restore preview is stale because the validated staging database changed. Run restore again to review the current state.';
export const RESTORE_CONTROL_TRIGGER_ERROR = 'Backup is unsafe because it contains a restore-control trigger.';
export const RESTORE_CONSENT_TRIGGER_ERROR = 'Backup is unsafe because it contains a consent-root trigger.';

type RequiredRestoreTable = (typeof REQUIRED_RESTORE_TABLES)[number];
type RestoreCounts = Record<RequiredRestoreTable, number>;
type TableColumn = {
    name: string;
    type: string;
    dflt_value: string | null;
    default_length: number | null;
} & Record<'notnull' | 'pk' | 'hidden', number>;
type ForeignKeyRow = {
    target_table: string | null;
    source_column: string | null;
    target_column: string | null;
} & Record<'id' | 'seq' | 'bounded_text', number> &
    Record<'on_update' | 'on_delete' | 'match', string>;
type IndexRow = { name: string | null; unique_index: number; origin: string; partial: number };
type IndexColumn = { cid: number; name: string | null; descending: number; collation: string | null; bounded_text: number };
type IndexShape = [number, string, number, Array<[string | null, number | null, number, string | null, number]>];
type TranscriptIdentity = { tool: string; native_id: string };
type TerminalEvictionAnchor = TranscriptIdentity & {
    segment_index: number;
    project_path: string;
    project_first_seen_at: string;
    project_last_seen_at: string;
    source_path: string;
    session_started_at: string;
    session_last_ingested_at: string;
};
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
type LogicalPlan<T> = { rows: T[]; fingerprint: string };
type TerminalEvictionPlan = LogicalPlan<TerminalEvictionAnchor>;
type InjectionPlanRow = Omit<InjectionRow, 'id'>;
type RestoreControls = {
    paranoid?: ParanoidControlState;
    paranoidFingerprint?: string;
    injections: LogicalPlan<InjectionPlanRow>;
    evictions: TerminalEvictionPlan;
};
type ActiveEncryption = { metadata: EncryptionMetadata; key: Buffer };

const LEGACY_SESSION_FK_CHILDREN = new Set(['memories', 'session_rollups', 'first_prompt_search_backfill_skips']);

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
    const findTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1");
    return REQUIRED_RESTORE_TABLES.filter((table) => findTable.get(table) === undefined);
}

function tableColumns(db: Database.Database, table: string, limit: number, textLimit: number): TableColumn[] {
    return db
        .prepare(
            `SELECT CASE WHEN length(name) <= ? THEN name END AS name,
                    CASE WHEN length(type) <= ? THEN type END AS type,
                    "notnull", CASE WHEN dflt_value IS NULL OR length(dflt_value) <= ? THEN dflt_value END AS dflt_value,
                    length(dflt_value) AS default_length, pk, hidden
             FROM pragma_table_xinfo(?, 'main') ORDER BY name LIMIT ?`,
        )
        .all(textLimit, textLimit, textLimit, table, limit) as TableColumn[];
}

function foreignKeyRows(db: Database.Database, table: string, limit: number, textLimit: number): ForeignKeyRow[] {
    return db
        .prepare(
            `SELECT id, seq, CASE WHEN length("table") <= ? THEN "table" END AS target_table,
                    CASE WHEN length("from") <= ? THEN "from" END AS source_column,
                    CASE WHEN "to" IS NULL OR length("to") <= ? THEN "to" END AS target_column,
                    on_update, on_delete, match,
                    length("table") <= ? AND length("from") <= ? AND ("to" IS NULL OR length("to") <= ?) AS bounded_text
             FROM pragma_foreign_key_list(?, 'main') ORDER BY id, seq LIMIT ?`,
        )
        .all(textLimit, textLimit, textLimit, textLimit, textLimit, textLimit, table, limit) as ForeignKeyRow[];
}

function foreignKeySignature(rows: ForeignKeyRow[], allowLegacySessionForeignKeys = false): string[] {
    const groups = new Map<number, unknown[]>();
    for (const row of rows) {
        const group = groups.get(row.id) ?? [];
        group.push([
            row.seq,
            allowLegacySessionForeignKeys && row.target_table?.toLowerCase() === 'sessions_old'
                ? 'sessions'
                : (row.target_table?.toLowerCase() ?? null),
            row.source_column?.toLowerCase() ?? null,
            row.target_column?.toLowerCase() ?? null,
            row.on_update,
            row.on_delete,
            row.match,
            row.bounded_text,
        ]);
        groups.set(row.id, group);
    }
    return [...groups.values()].map((group) => JSON.stringify(group)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function indexShapes(db: Database.Database, table: string, indexLimit: number, keyLimit: number, textLimit: number): IndexShape[] {
    const indexes = db
        .prepare(
            `SELECT CASE WHEN length(name) <= ? THEN name END AS name, "unique" AS unique_index, origin, partial
             FROM pragma_index_list(?, 'main') ORDER BY seq LIMIT ?`,
        )
        .all(textLimit, table, indexLimit) as IndexRow[];
    return indexes
        .map((index): IndexShape => {
            if (index.name === null) {
                return [index.unique_index, index.origin, index.partial, []];
            }
            const keys = db
                .prepare(
                    `SELECT cid, CASE WHEN name IS NULL OR length(name) <= ? THEN name END AS name,
                            "desc" AS descending, CASE WHEN length(coll) <= ? THEN coll END AS collation,
                            (name IS NULL OR length(name) <= ?) AND length(coll) <= ? AS bounded_text
                     FROM pragma_index_xinfo(?, 'main') WHERE "key" = 1 ORDER BY seqno LIMIT ?`,
                )
                .all(textLimit, textLimit, textLimit, textLimit, index.name, keyLimit) as IndexColumn[];
            return [
                index.unique_index,
                index.origin,
                index.partial,
                keys.map((key) => [
                    key.name?.toLowerCase() ?? null,
                    key.name === null ? key.cid : null,
                    key.descending,
                    key.collation,
                    key.bounded_text,
                ]),
            ];
        })
        .sort((left, right) => {
            const a = JSON.stringify(left);
            const b = JSON.stringify(right);
            return a < b ? -1 : a > b ? 1 : 0;
        });
}

function normalizedColumns(table: string, columns: TableColumn[]): TableColumn[] {
    return columns.map((column) =>
        table === 'sessions' &&
        (column.name === 'rendered_chars' || column.name === 'rendered_turns') &&
        column.type === 'INTEGER' &&
        column.notnull === 0 &&
        column.dflt_value === null
            ? { ...column, dflt_value: '0', default_length: 1 }
            : column,
    );
}

function hasNoncanonicalTrigger(db: Database.Database): boolean {
    return (
        db
            .prepare(
                `SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND NOT (
                     tbl_name COLLATE NOCASE = 'filtered_turns' AND name COLLATE NOCASE IN
                     ('filtered_turns_ai', 'filtered_turns_ad', 'filtered_turns_au',
                      'filtered_turns_usage_ai', 'filtered_turns_usage_ad', 'filtered_turns_usage_au')
                 ) LIMIT 1`,
            )
            .get() !== undefined
    );
}

function schemaDifferences(candidate: Database.Database, canonical: Database.Database): string[] {
    const errors: string[] = [];
    const tables = canonical
        .prepare(
            `SELECT p.name, p.wr, p.strict, m.sql FROM pragma_table_list p
             JOIN sqlite_master m ON m.name = p.name AND m.type = 'table'
             WHERE p.schema = 'main' AND p.type = 'table' AND p.name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string; wr: number; strict: number; sql: string }>;
    const textLimit = tables.reduce((total, table) => total + table.sql.length, 0) + 1;
    for (const table of tables) {
        const candidateTable = candidate
            .prepare("SELECT type, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ? COLLATE NOCASE LIMIT 2")
            .all(table.name);
        if (JSON.stringify(candidateTable) !== JSON.stringify([{ type: 'table', wr: table.wr, strict: table.strict }])) {
            errors.push(`${table.name}: table structure differs`);
        }
        const canonicalColumns = tableColumns(canonical, table.name, -1, textLimit);
        const candidateColumns = tableColumns(candidate, table.name, canonicalColumns.length + 1, textLimit);
        const expectedByName = new Map(canonicalColumns.map((column) => [column.name, column]));
        const actualByName = new Map(candidateColumns.map((column) => [column.name, column]));
        const missing = [...expectedByName.keys()].filter((column) => !actualByName.has(column));
        const extra = [...actualByName.keys()].filter((column) => !expectedByName.has(column));

        if (missing.length > 0) {
            errors.push(`${table.name}: missing column(s): ${missing.join(', ')}`);
        }
        if (extra.length > 0) {
            errors.push(`${table.name}: unexpected column(s): ${extra.join(', ')}`);
        }
        if (
            missing.length === 0 &&
            extra.length === 0 &&
            JSON.stringify(normalizedColumns(table.name, candidateColumns)) !== JSON.stringify(canonicalColumns)
        ) {
            errors.push(`${table.name}: column structure differs`);
        }
        const canonicalForeignKeys = foreignKeyRows(canonical, table.name, -1, textLimit);
        const candidateForeignKeys = foreignKeyRows(candidate, table.name, canonicalForeignKeys.length + 1, textLimit);
        const expectedForeignKeySignature = foreignKeySignature(canonicalForeignKeys);
        const legacySessionForeignKeys =
            LEGACY_SESSION_FK_CHILDREN.has(table.name) &&
            candidateForeignKeys.some((row) => row.target_table?.toLowerCase() === 'sessions_old') &&
            candidate.prepare(`SELECT 1 FROM "${table.name.replaceAll('"', '""')}" LIMIT 1`).get() === undefined &&
            candidate
                .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = 'sessions_old' COLLATE NOCASE LIMIT 1")
                .get() === undefined &&
            JSON.stringify(foreignKeySignature(candidateForeignKeys, true)) === JSON.stringify(expectedForeignKeySignature);
        if (
            !legacySessionForeignKeys &&
            JSON.stringify(foreignKeySignature(candidateForeignKeys)) !== JSON.stringify(expectedForeignKeySignature)
        ) {
            errors.push(`${table.name}: foreign key structure differs`);
        }
        const canonicalIndexes = indexShapes(canonical, table.name, -1, -1, textLimit);
        const keyLimit = Math.max(0, ...canonicalIndexes.map((index) => index[3].length)) + 1;
        if (
            JSON.stringify(indexShapes(candidate, table.name, canonicalIndexes.length + 1, keyLimit, textLimit)) !==
            JSON.stringify(canonicalIndexes)
        ) {
            errors.push(`${table.name}: index structure differs`);
        }
        const candidateDeclaration = candidate
            .prepare(
                `SELECT substr(sql, 1, ?) AS sql, length(COALESCE(sql, '')) AS sql_length
                 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE LIMIT 2`,
            )
            .all(textLimit, table.name) as Array<{ sql: string | null; sql_length: number }>;
        try {
            const declaration = candidateDeclaration[0];
            if (
                declaration === undefined ||
                candidateDeclaration.length !== 1 ||
                declaration.sql_length > textLimit ||
                tableClauseSignature(declaration.sql, table.name, legacySessionForeignKeys) !== tableClauseSignature(table.sql, table.name)
            ) {
                errors.push(`${table.name}: declaration structure differs`);
            }
        } catch {
            errors.push(`${table.name}: declaration structure differs`);
        }
    }
    return errors;
}

function removeTemporaryDatabase(dbPath: string, directory: string): void {
    let cleanupError: unknown;
    for (const file of [dbPath, ...DATABASE_COMPANION_SUFFIXES.map((suffix) => `${dbPath}${suffix}`)]) {
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
        staged = encryptionKey === undefined ? openUnmanagedDb(stagedPath) : openInitializedKeyedDatabase(stagedPath, encryptionKey);
        canonical = openDb(':memory:');
        if (hasNoncanonicalTrigger(staged)) {
            throw new Error(RESTORE_CONTROL_TRIGGER_ERROR);
        }
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
    const integrity = db.pragma('integrity_check(1)') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        errors.push(`integrity_check failed: ${integrity.map((row) => row.integrity_check).join('; ')}`);
    }
    const foreignKeyCount = db.prepare('SELECT COUNT(*) FROM pragma_foreign_key_check').pluck().safeIntegers().get() as bigint;
    if (foreignKeyCount > 0n) {
        errors.push(`foreign_key_check found ${foreignKeyCount} violation(s)`);
    }
    const actualCounts = candidateCounts(db);
    for (const table of REQUIRED_RESTORE_TABLES) {
        if (actualCounts[table] !== expectedCounts[table]) {
            errors.push(`${table} row count is ${actualCounts[table]}, expected ${expectedCounts[table]}`);
        }
    }
    return errors;
}

function validateCandidate(candidate: Database.Database, candidatePath: string): RestoreCounts {
    let counts: RestoreCounts | undefined;
    let validationError: string | undefined;
    try {
        assertBoundedDatabaseSchemaMetadata(candidate);
        if (candidate.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name COLLATE NOCASE = 'consent_roots'").get()) {
            validationError = RESTORE_CONSENT_TRIGGER_ERROR;
        }
        if (validationError === undefined && hasNoncanonicalTrigger(candidate)) {
            validationError = RESTORE_CONTROL_TRIGGER_ERROR;
        } else if (validationError === undefined) {
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
        if (error instanceof Error && error.message === DATABASE_SCHEMA_METADATA_LIMIT_ERROR) {
            throw error;
        }
        throw new Error(`Not a valid SQLite backup at ${candidatePath}: ${errorMessage(error)}`);
    }
    if (validationError !== undefined) {
        throw new Error(validationError);
    }
    if (counts === undefined) {
        throw new Error(`Not a valid SQLite backup at ${candidatePath}.`);
    }
    return counts;
}

function inspectCandidate(stagedPath: string, candidatePath: string, encryptionKey?: Buffer): RestoreCounts {
    const candidate =
        encryptionKey === undefined
            ? new Database(stagedPath, { readonly: true, fileMustExist: true })
            : openKeyedDatabase(stagedPath, encryptionKey, { readonly: true, fileMustExist: true });
    let counts: RestoreCounts;
    try {
        counts = validateCandidate(candidate, candidatePath);
    } finally {
        candidate.close();
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

function logicalPlan<T>(rows: T[]): LogicalPlan<T> {
    const normalized = [...rows].sort((left, right) => {
        const a = JSON.stringify(left);
        const b = JSON.stringify(right);
        return a < b ? -1 : a > b ? 1 : 0;
    });
    return { rows: normalized, fingerprint: createHash('sha256').update(JSON.stringify(normalized)).digest('hex') };
}

function terminalEvictions(db: Database.Database): LogicalPlan<TranscriptIdentity> {
    return logicalPlan(
        db
            .prepare(
                `SELECT DISTINCT s.tool, s.native_id FROM sessions s
                 JOIN durable_capture_status d ON d.session_id = s.id WHERE d.state = 'evicted'`,
            )
            .all() as TranscriptIdentity[],
    );
}

function terminalEvictionAnchors(db: Database.Database): TerminalEvictionPlan {
    const rows = db
        .prepare(
            `WITH terminal_identities AS (
                 SELECT DISTINCT s.tool, s.native_id FROM sessions s
                 JOIN durable_capture_status d ON d.session_id = s.id WHERE d.state = 'evicted'
             ), latest AS (
                 SELECT s.tool, s.native_id, s.segment_index, s.source_path, s.started_at, s.last_ingested_at,
                        p.path AS project_path, p.first_seen_at AS project_first_seen_at, p.last_seen_at AS project_last_seen_at,
                        ROW_NUMBER() OVER (PARTITION BY s.tool, s.native_id ORDER BY s.segment_index DESC, s.id DESC) AS rank
                 FROM sessions s JOIN projects p ON p.id = s.project_id
                 JOIN terminal_identities t ON t.tool = s.tool AND t.native_id = s.native_id
             )
             SELECT tool, native_id, segment_index, project_path, project_first_seen_at, project_last_seen_at,
                    source_path, started_at AS session_started_at, last_ingested_at AS session_last_ingested_at
             FROM latest WHERE rank = 1`,
        )
        .all() as TerminalEvictionAnchor[];
    const normalized = logicalPlan(rows).rows;
    return {
        rows: normalized,
        fingerprint: logicalPlan(normalized.map(({ tool, native_id }) => ({ tool, native_id }))).fingerprint,
    };
}

async function activeRestoreControls(
    dbPath: string,
    encryption: DatabaseEncryptionRuntime | undefined,
    retainParanoid: boolean,
    lifecycle?: ExclusiveDatabaseLifecycleLease,
): Promise<RestoreControls> {
    const db = await openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption, lifecycle });
    try {
        const paranoid = retainParanoid ? readParanoidControlState(db) : undefined;
        const { injections, evictions } = db.transaction(() => ({
            injections: db
                .prepare('SELECT tool, native_session_id, injected_at, injection_id, body_hash, body FROM injections')
                .all() as InjectionPlanRow[],
            evictions: terminalEvictionAnchors(db),
        }))();
        for (const row of injections) {
            const hash = createHash('sha256').update(normalizeForNearVerbatim(row.body)).digest('hex');
            if (!isToolName(row.tool) || row.body_hash !== hash) {
                throw new Error('Active injection provenance is invalid.');
            }
        }
        return {
            ...(paranoid === undefined
                ? {}
                : { paranoid, paranoidFingerprint: createHash('sha256').update(JSON.stringify(paranoid)).digest('hex') }),
            injections: logicalPlan(injections),
            evictions,
        };
    } finally {
        db.close();
    }
}

function assertRestoreControls(
    current: RestoreControls,
    expected: RestoreControls,
    evictions: { fingerprint: string } = expected.evictions,
): void {
    if (expected.paranoid !== undefined && current.paranoidFingerprint !== expected.paranoidFingerprint) {
        throw new Error(RESTORE_PARANOID_CHANGED_ERROR);
    }
    if (current.injections.fingerprint !== expected.injections.fingerprint) {
        throw new Error(RESTORE_INJECTIONS_CHANGED_ERROR);
    }
    if (current.evictions.fingerprint !== evictions.fingerprint) {
        throw new Error(RESTORE_EVICTIONS_CHANGED_ERROR);
    }
}

async function activeEncryption(dbPath: string, runtime?: DatabaseEncryptionRuntime): Promise<ActiveEncryption> {
    const metadata = readEncryptionMetadata(encryptionMetadataPath(dbPath));
    if (metadata === undefined) {
        throw new Error('Encryption metadata is missing for the active elepha database.');
    }
    const key = await readStoredDatabaseKey(dbPath, metadata, runtime);
    if (key === undefined) {
        throw new Error('The active elepha database key is unavailable.');
    }
    try {
        const active = await openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption: runtime });
        active.close();
        return { metadata, key };
    } catch (error) {
        key.fill(0);
        throw error;
    }
}

async function assertActiveEncryption(
    active: ActiveEncryption,
    dbPath: string,
    lifecycle: ExclusiveDatabaseLifecycleLease,
    runtime?: DatabaseEncryptionRuntime,
): Promise<void> {
    const metadata = readEncryptionMetadata(encryptionMetadataPath(dbPath));
    const key = metadata === undefined ? undefined : await readStoredDatabaseKey(dbPath, metadata, runtime);
    try {
        if (JSON.stringify(metadata) !== JSON.stringify(active.metadata) || key === undefined || !key.equals(active.key)) {
            throw new Error('Active database encryption identity changed during restore confirmation.');
        }
        const db = await openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption: runtime, lifecycle });
        db.close();
    } finally {
        key?.fill(0);
    }
}

function assertActivePlaintext(dbPath: string, lifecycle: ExclusiveDatabaseLifecycleLease): void {
    const identity = lifecycle.captureDatabaseIdentity();
    const plaintext = identity.exists && hasPlaintextDatabaseHeader(dbPath);
    const metadataExists = existsSync(encryptionMetadataPath(dbPath));
    identity.assertCurrent();
    if (!plaintext || metadataExists) {
        throw new Error(RESTORE_ENCRYPTION_CHANGED_ERROR);
    }
}

function overlayControlState(
    stagedPath: string,
    roots: ConsentRoot[],
    tombstones: TranscriptTombstones,
    key?: Buffer,
    controls?: RestoreControls,
) {
    const restored = key === undefined ? openUnmanagedDb(stagedPath) : openKeyedDatabase(stagedPath, key);
    try {
        const timestamp = new Date().toISOString();
        const candidateEvictions = terminalEvictions(restored);
        const currentEvictions = (controls?.evictions.rows ?? []).map(({ tool, native_id }) => ({ tool, native_id }));
        const evictions = logicalPlan([...currentEvictions, ...candidateEvictions.rows]).rows.filter(
            (row, index, rows) => index === 0 || JSON.stringify(row) !== JSON.stringify(rows[index - 1]),
        );
        restored.transaction(() => {
            restored.prepare('DELETE FROM consent_roots').run();
            const insert = restored.prepare(
                `INSERT INTO consent_roots (ulid, path, state, decided_at, source, nudged_at)
                 VALUES (@ulid, @path, @state, @decided_at, @source, @nudged_at)`,
            );
            for (const root of roots) {
                insert.run(root);
            }
            for (const { table, timestampColumn } of TOMBSTONE_TABLES) {
                const insert = restored.prepare(`INSERT OR IGNORE INTO ${table} (tool, native_id, ${timestampColumn}) VALUES (?, ?, ?)`);
                for (const transcript of tombstones[table]) {
                    insert.run(transcript.tool, transcript.native_id, timestamp);
                }
            }
            if (controls !== undefined) {
                if (controls.paranoid !== undefined) {
                    const authority = restored
                        .prepare('UPDATE paranoid_authority SET enrolled = ?, state = ?, generation = ?, credential_tag = ? WHERE id = 1')
                        .run(
                            controls.paranoid.enrolled,
                            controls.paranoid.state,
                            controls.paranoid.generation,
                            controls.paranoid.credential_tag,
                        );
                    if (authority.changes !== 1) {
                        throw new Error('Restored paranoid authority row is missing.');
                    }
                }
                restored.prepare('DELETE FROM injections').run();
                const insert = restored.prepare(
                    'INSERT INTO injections (tool, native_session_id, injected_at, injection_id, body_hash, body) VALUES (@tool, @native_session_id, @injected_at, @injection_id, @body_hash, @body)',
                );
                for (const injection of controls.injections.rows) {
                    insert.run(injection);
                }
                const hasSession = restored.prepare('SELECT 1 FROM sessions WHERE tool = ? AND native_id = ? LIMIT 1');
                const insertProject = restored.prepare(
                    `INSERT OR IGNORE INTO projects (path, first_seen_at, last_seen_at)
                     VALUES (?, ?, ?)`,
                );
                const projectByPath = restored.prepare('SELECT id FROM projects WHERE path = ?');
                const insertSession = restored.prepare(
                    `INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                );
                for (const anchor of controls.evictions.rows) {
                    if (hasSession.get(anchor.tool, anchor.native_id) !== undefined) {
                        continue;
                    }
                    insertProject.run(anchor.project_path, anchor.project_first_seen_at, anchor.project_last_seen_at);
                    const project = projectByPath.get(anchor.project_path) as { id: number } | undefined;
                    if (project === undefined) {
                        throw new Error('Could not materialize restored terminal-eviction project anchor.');
                    }
                    insertSession.run(
                        anchor.tool,
                        anchor.native_id,
                        anchor.segment_index,
                        project.id,
                        anchor.source_path,
                        anchor.session_started_at,
                        anchor.session_last_ingested_at,
                    );
                }
                const evict = restored.prepare(
                    `INSERT INTO durable_capture_status (session_id, state, filter_version, updated_at)
                     SELECT id, 'evicted', 1, ? FROM sessions WHERE tool = ? AND native_id = ?
                     ON CONFLICT(session_id) DO UPDATE SET state = 'evicted', updated_at = excluded.updated_at`,
                );
                for (const identity of evictions) {
                    evict.run(timestamp, identity.tool, identity.native_id);
                }
            }
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
            const deleteEvicted = restored.prepare(
                'DELETE FROM filtered_turns WHERE memory_id IN (SELECT m.id FROM memories m JOIN sessions s ON s.id = m.session_id WHERE s.tool = ? AND s.native_id = ?)',
            );
            for (const identity of evictions) {
                deleteEvicted.run(identity.tool, identity.native_id);
            }
        })();
        normalizeAndVerifyDurableCapture(restored);
        const checkpoint = restored.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
        if (checkpoint[0]?.busy !== 0) {
            throw new Error('Could not checkpoint restored control state.');
        }
        return { counts: candidateCounts(restored), ...(controls === undefined ? {} : { evictions: logicalPlan(evictions) }) };
    } finally {
        restored.close();
    }
}

function removeDatabaseCompanions(databaseFilenames: string[]): void {
    const companions = [
        ...new Set(
            databaseFilenames.flatMap((databaseFilename) => DATABASE_COMPANION_SUFFIXES.map((suffix) => `${databaseFilename}${suffix}`)),
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

function removeAndVerifyDatabaseCompanions(dbPath: string, lifecycle: ExclusiveDatabaseLifecycleLease): void {
    // SQLite derives companions from its physical filename, which differs from
    // the configured path when the final component is a symlink.
    removeDatabaseCompanions([dbPath, lifecycle.resolvePhysicalDatabaseFilename()]);
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

async function validatedStageHash(stagedPath: string): Promise<string> {
    if (DATABASE_COMPANION_SUFFIXES.some((suffix) => existsSync(`${stagedPath}${suffix}`))) {
        throw new Error(RESTORE_STAGE_CHANGED_ERROR);
    }
    const hash = await sha256File(stagedPath);
    if (DATABASE_COMPANION_SUFFIXES.some((suffix) => existsSync(`${stagedPath}${suffix}`))) {
        throw new Error(RESTORE_STAGE_CHANGED_ERROR);
    }
    return hash;
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
    let retainedEncryption: ActiveEncryption | undefined;
    try {
        await withSharedDatabaseLifecycle(dbPath, async () => {
            if (existsSync(dbPath) && !hasPlaintextDatabaseHeader(dbPath)) {
                retainedEncryption = await activeEncryption(dbPath, runtime.encryption);
            }
        });
        let counts: RestoreCounts;
        if (retainedEncryption !== undefined) {
            const source = inspectDatabaseImportSource(candidatePath);
            if (source.identity.size < BigInt(SQLITE_MINIMUM_DATABASE_BYTES)) {
                throw new Error(`Not a valid SQLite backup at ${candidatePath}.`);
            }
            const descriptor = createPrivateEmptyDatabaseDescriptor(stagedPath);
            const destination = inspectPrivateEmptyDatabaseDescriptor(descriptor);
            closeSync(descriptor);
            let sourceCounts: RestoreCounts | undefined;
            writeEncryptedDatabaseImport(
                candidatePath,
                source.identity,
                stagedPath,
                destination,
                retainedEncryption.key,
                source.plaintext ? undefined : retainedEncryption.key,
                (candidate) => {
                    sourceCounts = validateCandidate(candidate, candidatePath);
                },
            );
            if (sourceCounts === undefined) {
                throw new Error(`Not a valid SQLite backup at ${candidatePath}.`);
            }
            verifyStagedSchema(stagedPath, retainedEncryption.key);
            counts = sourceCounts;
        } else {
            atomicCopyPrivateFile(candidatePath, stagedPath, PRIVATE_FILE_MODE);
            if (!hasPlaintextDatabaseHeader(stagedPath)) {
                if (statSync(stagedPath).size < SQLITE_MINIMUM_DATABASE_BYTES) {
                    throw new Error(`Not a valid SQLite backup at ${candidatePath}.`);
                }
                candidateKey = await withSharedDatabaseLifecycle(dbPath, () => databaseKey(dbPath, false, runtime.encryption));
            }
            counts = inspectCandidate(stagedPath, candidatePath, candidateKey);
        }
        const expectedStageHash = await validatedStageHash(stagedPath);
        const health = (runtime.daemonHealth ?? currentDaemonHealth)();
        if (health.healthy) {
            throw new Error(`Refusing restore while the daemon is running (${health.state}). Run elepha pause first.`);
        }
        if (health.state.startsWith('STUCK')) {
            console.error(`Daemon appears stuck (${health.state}); proceeding — it is not writing.`);
        }
        const tombstonePlan = await activeTranscriptTombstones(dbPath, runtime.encryption);
        const currentConsentPlan = await activeConsent(dbPath, runtime.encryption);
        const controlPlan = await activeRestoreControls(dbPath, runtime.encryption, retainedEncryption !== undefined);
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
            if (retainedEncryption === undefined) {
                assertActivePlaintext(dbPath, lifecycle);
            }
            const currentTombstonePlan = await activeTranscriptTombstones(dbPath, runtime.encryption, lifecycle);
            if (currentTombstonePlan.fingerprint !== tombstonePlan.fingerprint) {
                throw new Error(RESTORE_TOMBSTONES_CHANGED_ERROR);
            }
            const confirmedConsentPlan = await activeConsent(dbPath, runtime.encryption, lifecycle);
            if (confirmedConsentPlan.fingerprint !== currentConsentPlan.fingerprint) {
                throw new Error(RESTORE_CONSENT_CHANGED_ERROR);
            }
            if (retainedEncryption !== undefined) {
                await assertActiveEncryption(retainedEncryption, dbPath, lifecycle, runtime.encryption);
            }
            const confirmedControls = await activeRestoreControls(dbPath, runtime.encryption, retainedEncryption !== undefined, lifecycle);
            assertRestoreControls(confirmedControls, controlPlan);
            if ((await validatedStageHash(stagedPath)) !== expectedStageHash) {
                throw new Error(RESTORE_STAGE_CHANGED_ERROR);
            }
            const overlay = overlayControlState(
                stagedPath,
                confirmedConsentPlan.roots,
                currentTombstonePlan.tombstones,
                retainedEncryption?.key ?? candidateKey,
                confirmedControls,
            );
            removeDatabaseCompanions([stagedPath]);
            if (retainedEncryption !== undefined) {
                assertEncryptedDatabaseFile(stagedPath, retainedEncryption.key, 'Restored database stage');
                removeDatabaseCompanions([stagedPath]);
            }
            const installStageHash = await sha256File(stagedPath);
            const active = await checkpointActiveDatabase(dbPath, lifecycle, runtime.encryption);
            let snapshotPath: string;
            try {
                snapshotPath = (runtime.writeBackup ?? writeBackup)(active, dbPath);
            } finally {
                active.close();
            }
            if (retainedEncryption !== undefined) {
                assertEncryptedDatabaseFile(snapshotPath, retainedEncryption.key, 'Pre-restore snapshot');
                removeDatabaseCompanions([snapshotPath]);
            }
            const snapshotHash = await sha256File(snapshotPath);
            lifecycle.beginReplacement();
            try {
                lifecycle.assertReplacementReady();
                atomicCopyPrivateFile(stagedPath, dbPath, PRIVATE_FILE_MODE);
                const installedHash = await sha256File(dbPath);
                assertInstalledRestoreHash(installedHash, installStageHash);
                removeAndVerifyDatabaseCompanions(dbPath, lifecycle);
                await verifyRestoredDatabase(dbPath, overlay.counts, lifecycle, runtime.encryption);
                if (retainedEncryption !== undefined) {
                    await assertActiveEncryption(retainedEncryption, dbPath, lifecycle, runtime.encryption);
                } else {
                    assertActivePlaintext(dbPath, lifecycle);
                }
                assertRestoreControls(
                    await activeRestoreControls(dbPath, runtime.encryption, retainedEncryption !== undefined, lifecycle),
                    confirmedControls,
                    overlay.evictions,
                );
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
                    if (retainedEncryption !== undefined) {
                        await assertActiveEncryption(retainedEncryption, dbPath, lifecycle, runtime.encryption);
                        removeAndVerifyDatabaseCompanions(dbPath, lifecycle);
                    } else {
                        assertActivePlaintext(dbPath, lifecycle);
                    }
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
        retainedEncryption?.key.fill(0);
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
