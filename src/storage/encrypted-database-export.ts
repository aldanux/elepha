import { createHash } from 'node:crypto';
import {
    closeSync,
    fchmodSync,
    constants as fsConstants,
    fstatSync,
    lstatSync,
    openSync,
    readSync,
    realpathSync,
    unlinkSync,
} from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import {
    DATABASE_EXPORT_VERIFY_CHUNK_BYTES,
    DATABASE_HEADER_BYTES,
    DATABASE_SCHEMA_METADATA_MAX_CHARS,
    DATABASE_SCHEMA_METADATA_MAX_ROWS,
    PRIVATE_FILE_MODE,
} from '../config/constants.js';
import { pinSQLitePathForOpen, type SQLiteFileIdentitySeal } from './database-lifecycle.js';
import { hasPlaintextDatabaseHeader, isPlaintextDatabaseHeader, keyDatabaseConnection, openKeyedDatabase } from './db.js';

const ATTACHED_EXPORT_SCHEMA = 'elepha_export';
const ROWID_ALIASES = ['rowid', '_rowid_', 'oid'] as const;
const SQLITE_COMPANION_SUFFIXES = ['-journal', '-shm', '-wal'] as const;

export const BACKUP_DESTINATION_COMPANION_ERROR = 'Backup destination has an existing SQLite companion; refusing to export.';
export const BACKUP_SOURCE_COMPANION_ERROR = 'Backup source has a SQLite companion; refusing to import.';
export const DATABASE_SCHEMA_METADATA_LIMIT_ERROR = 'Backup schema metadata exceeds the supported limit.';

export interface DatabaseFileIdentity {
    dev: bigint;
    ino: bigint;
}

export interface DatabaseFileSeal extends DatabaseFileIdentity, SQLiteFileIdentitySeal {
    size: bigint;
}

interface FullSchemaRow {
    rowid: bigint;
    type: 'table' | 'index' | 'trigger' | 'view';
    name: string;
    tbl_name: string;
    sql: string;
}

interface TableListRow {
    schema: string;
    name: string;
    type: 'table' | 'view' | 'shadow' | 'virtual';
    wr: number;
}

interface TableColumnRow {
    name: string;
    hidden: number;
}

interface AttachedExportState {
    attached: boolean;
}

type AttachedEncryption = { kind: 'inherited'; cipherSalt: string } | { kind: 'explicit'; key: Buffer };

function attemptCleanup(failures: unknown[], cleanup: () => void): void {
    try {
        cleanup();
    } catch (error) {
        failures.push(error);
    }
}

function privateEmptyDatabaseIdentity(descriptor: number): DatabaseFileSeal {
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile() || stats.size !== 0n) {
        throw new Error('Backup temporary is not an empty regular file.');
    }
    return {
        dev: stats.dev,
        ino: stats.ino,
        ctimeNs: stats.ctimeNs,
        nlink: stats.nlink,
        size: stats.size,
    };
}

export function createPrivateEmptyDatabaseDescriptor(databasePath: string): number {
    return openSync(
        databasePath,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE,
    );
}

export function inspectPrivateEmptyDatabaseDescriptor(descriptor: number): DatabaseFileSeal {
    return privateEmptyDatabaseIdentity(descriptor);
}

export function inspectDatabaseImportSource(databasePath: string): { identity: DatabaseFileSeal; plaintext: boolean } {
    const descriptor = openSync(databasePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const stats = fstatSync(descriptor, { bigint: true });
        if (!stats.isFile()) {
            throw new Error(`Backup source is not a regular file: ${databasePath}`);
        }
        const header = Buffer.alloc(DATABASE_HEADER_BYTES);
        const bytes = readSync(descriptor, header, 0, header.length, 0);
        return {
            identity: { dev: stats.dev, ino: stats.ino, size: stats.size, ctimeNs: stats.ctimeNs, nlink: stats.nlink },
            plaintext: isPlaintextDatabaseHeader(header.subarray(0, bytes)),
        };
    } finally {
        closeSync(descriptor);
    }
}

export function assertDatabaseFileIdentity(databasePath: string, expected: DatabaseFileIdentity, label = 'Backup temporary'): void {
    const stats = lstatSync(databasePath, { bigint: true });
    if (!stats.isFile() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
        throw new Error(`${label} changed identity.`);
    }
}

function encryptedConnectionSalt(source: Database.Database): string {
    const cipherSalt = source.pragma('main.cipher_salt', { simple: true });
    if (typeof cipherSalt !== 'string' || !/^[0-9a-f]{32}$/i.test(cipherSalt)) {
        throw new Error('Backup source is plaintext; refusing to create a plaintext temporary copy.');
    }
    return cipherSalt.toUpperCase();
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
}

function attachedPragma(source: Database.Database, pragma: string, options: { simple: true }): unknown {
    return source.pragma(`${ATTACHED_EXPORT_SCHEMA}.${pragma}`, options);
}

export function writeEncryptedAttachedDatabase(
    source: Database.Database,
    destinationPath: string,
    expectedIdentity: DatabaseFileSeal,
    writer: (targetSchema: string) => void,
    encryptionKey?: Buffer,
): void {
    const encryption: AttachedEncryption =
        encryptionKey === undefined
            ? { kind: 'inherited', cipherSalt: encryptedConnectionSalt(source) }
            : { kind: 'explicit', key: encryptionKey };
    const seal = pinSQLitePathForOpen(destinationPath, expectedIdentity);
    const state: AttachedExportState = { attached: false };
    let primaryError: unknown;
    const cleanupFailures: unknown[] = [];
    try {
        runAttachedEncryptedExport(source, encryption, seal, writer, state);
    } catch (error) {
        primaryError = error;
    }
    if (state.attached) {
        attemptCleanup(cleanupFailures, () => source.exec(`DETACH DATABASE ${quoteIdentifier(ATTACHED_EXPORT_SCHEMA)}`));
    }
    attemptCleanup(cleanupFailures, () => {
        const state = seal.captureMutationState();
        seal.assertCurrent(state);
    });
    attemptCleanup(cleanupFailures, () => seal.release());
    if (primaryError !== undefined && cleanupFailures.length === 0) {
        throw primaryError;
    }
    if (primaryError !== undefined || cleanupFailures.length > 0) {
        const failures = primaryError === undefined ? cleanupFailures : [primaryError, ...cleanupFailures];
        throw new AggregateError(failures, `Encrypted database attachment failed for ${destinationPath}.`, {
            ...(primaryError === undefined ? {} : { cause: primaryError }),
        });
    }
}

function runAttachedEncryptedExport(
    source: Database.Database,
    encryption: AttachedEncryption,
    seal: ReturnType<typeof pinSQLitePathForOpen>,
    writer: (targetSchema: string) => void,
    state: AttachedExportState,
): void {
    for (const suffix of SQLITE_COMPANION_SUFFIXES) {
        if (lstatSync(`${seal.sqlitePath}${suffix}`, { throwIfNoEntry: false }) !== undefined) {
            throw new Error(BACKUP_DESTINATION_COMPANION_ERROR);
        }
    }
    if (encryption.kind === 'explicit') {
        source.pragma("cipher='chacha20'");
        const rawKey = Buffer.from(`raw:${encryption.key.toString('hex')}`, 'ascii');
        try {
            source.prepare(`ATTACH DATABASE ? AS ${quoteIdentifier(ATTACHED_EXPORT_SCHEMA)} KEY ?`).run(seal.sqlitePath, rawKey);
        } finally {
            rawKey.fill(0);
        }
    } else {
        source.prepare(`ATTACH DATABASE ? AS ${quoteIdentifier(ATTACHED_EXPORT_SCHEMA)}`).run(seal.sqlitePath);
    }
    state.attached = true;
    seal.confirmOpen(source, ATTACHED_EXPORT_SCHEMA);
    const opened = fstatSync(seal.descriptor, { bigint: true });
    if (!opened.isFile() || opened.size !== 0n) {
        throw new Error('Backup temporary changed before its first encrypted page write.');
    }
    const targetCipherSalt = attachedPragma(source, 'cipher_salt', { simple: true });
    if (
        typeof targetCipherSalt !== 'string' ||
        !/^[0-9a-f]{32}$/i.test(targetCipherSalt) ||
        (encryption.kind === 'inherited' && targetCipherSalt.toUpperCase() !== encryption.cipherSalt)
    ) {
        throw new Error('Backup target did not receive the selected encryption key.');
    }
    const journalMode = attachedPragma(source, 'journal_mode = MEMORY', { simple: true });
    if (journalMode !== 'memory') {
        throw new Error(`Backup could not keep target journaling in memory (observed ${String(journalMode)}).`);
    }
    writer(ATTACHED_EXPORT_SCHEMA);
    const integrity = source.pragma(`${ATTACHED_EXPORT_SCHEMA}.integrity_check(1)`) as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error(`Backup failed integrity_check: ${integrity.map((row) => row.integrity_check).join('; ')}`);
    }
}

export function qualifySQLiteCreateSql(sql: string, type: FullSchemaRow['type'], objectName: string, targetSchema: string): string {
    const patterns: Record<FullSchemaRow['type'], RegExp> = {
        table: /^\s*CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
        index: /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
        trigger: /^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
        view: /^\s*CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
    };
    const pattern = patterns[type];
    const match = pattern.exec(sql);
    if (match === null) {
        throw new Error(`Backup cannot qualify ${type} ${objectName}.`);
    }
    return `${sql.slice(0, match[0].length)}${quoteIdentifier(targetSchema)}.${sql.slice(match[0].length)}`;
}

function qualifyCreateSql(entry: FullSchemaRow, targetSchema: string): string {
    return qualifySQLiteCreateSql(entry.sql, entry.type, entry.name, targetSchema);
}

function tableColumns(source: Database.Database, table: string): TableColumnRow[] {
    return source.prepare("SELECT name, hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid").all(table) as TableColumnRow[];
}

function rowidAlias(columns: readonly TableColumnRow[], table: TableListRow): string | undefined {
    if (table.wr !== 0) {
        return undefined;
    }
    const names = new Set(columns.map((column) => column.name.toLowerCase()));
    const alias = ROWID_ALIASES.find((candidate) => !names.has(candidate));
    if (alias === undefined) {
        throw new Error(`Backup cannot preserve the hidden rowid for table ${table.name}.`);
    }
    return alias;
}

function copyProjection(source: Database.Database, table: TableListRow): { columnSql: string; tableSql: string; valuesSql: string } {
    const columns = tableColumns(source, table.name);
    const writableColumns = columns.filter(({ hidden }) => hidden === 0).map(({ name }) => name);
    const hiddenRowid = rowidAlias(columns, table);
    const selectedColumns = hiddenRowid === undefined ? writableColumns : [hiddenRowid, ...writableColumns];
    if (selectedColumns.length === 0) {
        throw new Error(`Backup cannot copy table ${table.name} without writable columns.`);
    }
    const columnSql = selectedColumns.map(quoteIdentifier).join(', ');
    return { columnSql, tableSql: quoteIdentifier(table.name), valuesSql: selectedColumns.map(() => '?').join(', ') };
}

function copyWholeTable(source: Database.Database, targetSchema: string, table: TableListRow, clear = false): void {
    const { columnSql, tableSql } = copyProjection(source, table);
    const target = `${quoteIdentifier(targetSchema)}.${tableSql}`;
    if (clear) {
        source.exec(`DELETE FROM ${target}`);
    }
    source.exec(`INSERT INTO ${target} (${columnSql}) SELECT ${columnSql} FROM main.${tableSql}`);
}

export function assertBoundedDatabaseSchemaMetadata(source: Database.Database): void {
    const totals = source
        .prepare(
            `SELECT (SELECT COUNT(*) FROM main.sqlite_schema WHERE sql IS NOT NULL) AS schema_rows,
                    (SELECT COUNT(*) FROM pragma_table_list WHERE schema = 'main') AS table_rows,
                    (SELECT COALESCE(SUM(length(sql) + length(name) + length(tbl_name)), 0)
                     FROM main.sqlite_schema WHERE sql IS NOT NULL) AS text_chars`,
        )
        .safeIntegers()
        .get() as { schema_rows: bigint; table_rows: bigint; text_chars: bigint };
    if (
        totals.schema_rows > BigInt(DATABASE_SCHEMA_METADATA_MAX_ROWS) ||
        totals.table_rows > BigInt(DATABASE_SCHEMA_METADATA_MAX_ROWS) ||
        totals.text_chars > BigInt(DATABASE_SCHEMA_METADATA_MAX_CHARS)
    ) {
        throw new Error(DATABASE_SCHEMA_METADATA_LIMIT_ERROR);
    }
}

function readFullSchema(source: Database.Database): { schema: FullSchemaRow[]; tables: Map<string, TableListRow> } {
    assertBoundedDatabaseSchemaMetadata(source);
    const schema = source
        .prepare(
            `SELECT rowid, type, name, tbl_name, sql
             FROM main.sqlite_schema
             WHERE sql IS NOT NULL
             ORDER BY rowid`,
        )
        .safeIntegers()
        .all() as FullSchemaRow[];
    const tableRows = source.pragma('main.table_list') as TableListRow[];
    const tables = new Map(tableRows.filter((table) => table.schema === 'main').map((table) => [table.name, table]));
    for (const entry of schema) {
        if (entry.type === 'table' && entry.name.startsWith('sqlite_') && entry.name !== 'sqlite_sequence') {
            throw new Error(`Backup cannot safely reconstruct internal SQLite table ${entry.name}.`);
        }
        if (entry.name !== 'sqlite_sequence') {
            qualifyCreateSql(entry, ATTACHED_EXPORT_SCHEMA);
        }
    }
    return { schema, tables };
}

function reconstructFullDatabase(
    source: Database.Database,
    create: (entry: FullSchemaRow) => void,
    copy: (table: TableListRow, clear?: boolean) => void,
    unsafe: (enabled: boolean) => void,
): void {
    const { schema, tables } = readFullSchema(source);
    const entries = schema.filter(({ type, name }) => type === 'table' && name !== 'sqlite_sequence');
    const withType = (type: TableListRow['type']) => entries.filter(({ name }) => tables.get(name)?.type === type);
    withType('table').forEach(create);
    withType('table').forEach(({ name }) => {
        copy(tables.get(name) as TableListRow);
    });
    withType('virtual').forEach(create);
    // CREATE VIRTUAL TABLE materializes FTS5's shadow schema but not its
    // exact segment state. Direct shadow writes are the only public SQL
    // route that preserves the selected snapshot byte-for-byte; keep the
    // exception scoped to fixed destination shadow DML and restore it before
    // executing any source-provided schema SQL.
    unsafe(true);
    try {
        withType('shadow').forEach(({ name }) => {
            copy(tables.get(name) as TableListRow, true);
        });
    } finally {
        unsafe(false);
    }
    const sequence = tables.get('sqlite_sequence');
    if (sequence !== undefined) {
        copy(sequence, true);
    }
    schema.filter(({ type }) => type !== 'table').forEach(create);
}

function cloneFullDatabase(source: Database.Database, targetSchema: string): void {
    const foreignKeys = source.pragma('foreign_keys', { simple: true });
    if (foreignKeys !== 0 && foreignKeys !== 1) {
        throw new Error('Backup source returned an invalid foreign_keys setting.');
    }
    source.pragma('foreign_keys = OFF');
    try {
        source.transaction(() => {
            reconstructFullDatabase(
                source,
                (entry) => source.exec(qualifyCreateSql(entry, targetSchema)),
                (table, clear) => copyWholeTable(source, targetSchema, table, clear),
                (enabled) => source.unsafeMode(enabled),
            );
            const violations = source.pragma(`${targetSchema}.foreign_key_check`) as unknown[];
            if (violations.length !== 0) {
                throw new Error('Backup target failed foreign_key_check.');
            }
        })();
    } finally {
        source.pragma(`foreign_keys = ${foreignKeys === 1 ? 'ON' : 'OFF'}`);
    }
}

function copyWholeTableBetween(source: Database.Database, target: Database.Database, table: TableListRow, clear = false): void {
    const { columnSql, tableSql, valuesSql } = copyProjection(source, table);
    if (clear) {
        target.exec(`DELETE FROM ${tableSql}`);
    }
    const insert = target.prepare(`INSERT INTO ${tableSql} (${columnSql}) VALUES (${valuesSql})`);
    let copied = 0n;
    for (const row of source.prepare(`SELECT ${columnSql} FROM ${tableSql}`).raw().safeIntegers().iterate() as Iterable<unknown[]>) {
        insert.run(...row);
        copied += 1n;
    }
    if ((target.prepare(`SELECT COUNT(*) FROM ${tableSql}`).pluck().safeIntegers().get() as bigint) !== copied) {
        throw new Error(`Backup row count changed while copying table ${table.name}.`);
    }
}

function descriptorHash(descriptor: number): string {
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(DATABASE_EXPORT_VERIFY_CHUNK_BYTES);
    let offset = 0;
    while (true) {
        const bytes = readSync(descriptor, chunk, 0, chunk.length, offset);
        if (bytes === 0) {
            return hash.digest('hex');
        }
        hash.update(chunk.subarray(0, bytes));
        offset += bytes;
    }
}

type SQLitePathSeal = ReturnType<typeof pinSQLitePathForOpen>;

interface EncryptedDatabaseImportState {
    preflightPassed: boolean;
    physicalSource?: string;
    sourceState?: ReturnType<SQLitePathSeal['captureMutationState']>;
    sourceHash?: string;
    destinationSeal?: SQLitePathSeal;
    source?: Database.Database;
    destination?: Database.Database;
}

function runEncryptedDatabaseImport(
    sourceSeal: SQLitePathSeal,
    destinationPath: string,
    destinationIdentity: DatabaseFileSeal,
    destinationKey: Buffer,
    sourceKey: Buffer | undefined,
    validateSource: ((source: Database.Database) => void) | undefined,
    state: EncryptedDatabaseImportState,
): void {
    state.physicalSource = realpathSync(sourceSeal.sqlitePath);
    state.sourceState = sourceSeal.captureMutationState();
    state.sourceHash = descriptorHash(sourceSeal.descriptor);
    for (const suffix of SQLITE_COMPANION_SUFFIXES) {
        if (lstatSync(`${state.physicalSource}${suffix}`, { throwIfNoEntry: false }) !== undefined) {
            throw new Error(BACKUP_SOURCE_COMPANION_ERROR);
        }
    }
    state.preflightPassed = true;
    state.destinationSeal = pinSQLitePathForOpen(destinationPath, destinationIdentity);
    state.source = new Database(sourceSeal.sqlitePath, { readonly: true, fileMustExist: true });
    sourceSeal.confirmOpen(state.source);
    if (sourceKey !== undefined) {
        keyDatabaseConnection(state.source, sourceKey);
    }
    state.source.pragma('temp_store = MEMORY');
    validateSource?.(state.source);
    state.destination = new Database(state.destinationSeal.sqlitePath, { fileMustExist: true });
    state.destinationSeal.confirmOpen(state.destination);
    keyDatabaseConnection(state.destination, destinationKey);
    state.destination.pragma('temp_store = MEMORY');
    state.destination.pragma('journal_mode = MEMORY');
    state.destination.exec('VACUUM');
    state.destination.pragma('foreign_keys = OFF');
    const openedSource = state.source;
    const openedDestination = state.destination;
    openedSource.transaction(() =>
        openedDestination.transaction(() => {
            reconstructFullDatabase(
                openedSource,
                ({ sql }) => openedDestination.exec(sql),
                (table, clear) => copyWholeTableBetween(openedSource, openedDestination, table, clear),
                (enabled) => openedDestination.unsafeMode(enabled),
            );
            if ((openedDestination.pragma('integrity_check(1)') as Array<{ integrity_check: string }>)[0]?.integrity_check !== 'ok') {
                throw new Error('Imported database failed integrity_check.');
            }
            if ((openedDestination.prepare('SELECT COUNT(*) FROM pragma_foreign_key_check').pluck().safeIntegers().get() as bigint) > 0n) {
                throw new Error('Imported database failed foreign_key_check.');
            }
        })(),
    )();
}

export function writeEncryptedDatabaseImport(
    sourcePath: string,
    sourceIdentity: DatabaseFileSeal,
    destinationPath: string,
    destinationIdentity: DatabaseFileSeal,
    destinationKey: Buffer,
    sourceKey?: Buffer,
    validateSource?: (source: Database.Database) => void,
): void {
    const sourceSeal = pinSQLitePathForOpen(sourcePath, sourceIdentity);
    const cleanupFailures: unknown[] = [];
    let primaryError: unknown;
    let primaryFailed = false;
    const state: EncryptedDatabaseImportState = { preflightPassed: false };
    try {
        runEncryptedDatabaseImport(sourceSeal, destinationPath, destinationIdentity, destinationKey, sourceKey, validateSource, state);
    } catch (error) {
        primaryFailed = true;
        primaryError = error;
    }
    if (state.destination !== undefined) {
        const closing = state.destination;
        attemptCleanup(cleanupFailures, () => closing.close());
    }
    if (state.source !== undefined) {
        const closing = state.source;
        attemptCleanup(cleanupFailures, () => closing.close());
    }
    for (const suffix of state.preflightPassed && state.physicalSource !== undefined ? SQLITE_COMPANION_SUFFIXES : []) {
        const companion = `${state.physicalSource}${suffix}`;
        attemptCleanup(cleanupFailures, () => {
            const observed = lstatSync(companion, { bigint: true, throwIfNoEntry: false });
            const confirmed = observed === undefined ? undefined : lstatSync(companion, { bigint: true });
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
                unlinkSync(companion);
            } else if (observed !== undefined) {
                throw new Error('Backup source created an unsupported SQLite companion.');
            }
            if (admitted && lstatSync(companion, { throwIfNoEntry: false }) !== undefined) {
                throw new Error('Backup source SQLite companion cleanup failed.');
            }
        });
    }
    const { sourceState, sourceHash } = state;
    if (sourceState !== undefined && sourceHash !== undefined) {
        attemptCleanup(cleanupFailures, () => {
            sourceSeal.assertCurrent(sourceState);
            if (descriptorHash(sourceSeal.descriptor) !== sourceHash) {
                throw new Error('Backup source changed while importing.');
            }
        });
    }
    if (state.destinationSeal !== undefined) {
        const closingSeal = state.destinationSeal;
        attemptCleanup(cleanupFailures, () => closingSeal.assertCurrent(closingSeal.captureMutationState()));
        attemptCleanup(cleanupFailures, () => closingSeal.release());
    }
    attemptCleanup(cleanupFailures, () => sourceSeal.release());
    if (primaryFailed && cleanupFailures.length === 0) {
        throw primaryError;
    }
    if (primaryFailed || cleanupFailures.length > 0) {
        throw new AggregateError(
            primaryFailed ? [primaryError, ...cleanupFailures] : cleanupFailures,
            `Encrypted database import failed for ${destinationPath}.`,
            { ...(primaryFailed ? { cause: primaryError } : {}) },
        );
    }
    assertEncryptedDatabaseFile(destinationPath, destinationKey, 'Imported database stage');
}

// The selected SQLite connection owns the authoritative snapshot and the
// codec. Its attached empty target inherits that exact codec before any page
// write, while the opened-object seal proves the attachment reached the
// precreated destination inode.
export function writeEncryptedDatabaseSnapshot(
    source: Database.Database,
    destinationPath: string,
    expectedIdentity: DatabaseFileSeal,
): void {
    writeEncryptedAttachedDatabase(source, destinationPath, expectedIdentity, (targetSchema) => {
        cloneFullDatabase(source, targetSchema);
    });
}

export function writeEncryptedDatabaseSnapshotWithKey(
    source: Database.Database,
    destinationPath: string,
    expectedIdentity: DatabaseFileSeal,
    encryptionKey: Buffer,
): void {
    writeEncryptedAttachedDatabase(
        source,
        destinationPath,
        expectedIdentity,
        (targetSchema) => cloneFullDatabase(source, targetSchema),
        encryptionKey,
    );
}

export function assertEncryptedDatabaseFile(databasePath: string, encryptionKey: Buffer, label: string): void {
    if (hasPlaintextDatabaseHeader(databasePath)) {
        throw new Error(`${label} is plaintext; refusing to create a plaintext temporary copy.`);
    }

    const keyed = openKeyedDatabase(databasePath, encryptionKey, { readonly: true, fileMustExist: true });
    keyed.close();

    const unkeyed = new Database(databasePath, { readonly: true, fileMustExist: true });
    let unkeyedResult: { opened: true } | { opened: false; error: unknown } = { opened: true };
    try {
        unkeyed.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
    } catch (error: unknown) {
        unkeyedResult = { opened: false, error };
    } finally {
        unkeyed.close();
    }
    if (!unkeyedResult.opened) {
        if (unkeyedResult.error instanceof Database.SqliteError && unkeyedResult.error.code === 'SQLITE_NOTADB') {
            return;
        }
        throw unkeyedResult.error;
    }
    throw new Error(`${label} opened without its encryption key.`);
}
