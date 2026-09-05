import { fchmodSync, constants as fsConstants, fstatSync, lstatSync, openSync } from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import { PRIVATE_FILE_MODE } from '../config/constants.js';
import { pinSQLitePathForOpen, type SQLiteFileIdentitySeal } from './database-lifecycle.js';
import { hasPlaintextDatabaseHeader, openKeyedDatabase } from './db.js';

const ATTACHED_EXPORT_SCHEMA = 'elepha_export';
const ROWID_ALIASES = ['rowid', '_rowid_', 'oid'] as const;
const SQLITE_COMPANION_SUFFIXES = ['-journal', '-shm', '-wal'] as const;

export const BACKUP_DESTINATION_COMPANION_ERROR = 'Backup destination has an existing SQLite companion; refusing to export.';

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
        try {
            source.exec(`DETACH DATABASE ${quoteIdentifier(ATTACHED_EXPORT_SCHEMA)}`);
        } catch (error) {
            cleanupFailures.push(error);
        }
    }
    try {
        const state = seal.captureMutationState();
        seal.assertCurrent(state);
    } catch (error) {
        cleanupFailures.push(error);
    }
    try {
        seal.release();
    } catch (error) {
        cleanupFailures.push(error);
    }
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
    const integrity = source.pragma(`${ATTACHED_EXPORT_SCHEMA}.integrity_check`) as Array<{ integrity_check: string }>;
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

function copyWholeTable(source: Database.Database, targetSchema: string, table: TableListRow, clearTarget = false): void {
    const columns = tableColumns(source, table.name);
    const writableColumns = columns.filter((column) => column.hidden === 0).map((column) => column.name);
    const hiddenRowid = rowidAlias(columns, table);
    const selectedColumns = hiddenRowid === undefined ? writableColumns : [hiddenRowid, ...writableColumns];
    if (selectedColumns.length === 0) {
        throw new Error(`Backup cannot copy table ${table.name} without writable columns.`);
    }
    const target = `${quoteIdentifier(targetSchema)}.${quoteIdentifier(table.name)}`;
    if (clearTarget) {
        source.exec(`DELETE FROM ${target}`);
    }
    const columnSql = selectedColumns.map(quoteIdentifier).join(', ');
    source.exec(`INSERT INTO ${target} (${columnSql}) SELECT ${columnSql} FROM main.${quoteIdentifier(table.name)}`);
}

function readFullSchema(source: Database.Database): { schema: FullSchemaRow[]; tables: Map<string, TableListRow> } {
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

function cloneFullDatabase(source: Database.Database, targetSchema: string): void {
    const snapshot = source.transaction(() => {
        const { schema, tables } = readFullSchema(source);
        const tableEntries = schema.filter((entry) => entry.type === 'table' && entry.name !== 'sqlite_sequence');
        for (const entry of tableEntries) {
            const table = tables.get(entry.name);
            if (table?.type === 'table') {
                source.exec(qualifyCreateSql(entry, targetSchema));
            }
        }
        for (const entry of tableEntries) {
            const table = tables.get(entry.name);
            if (table?.type === 'table') {
                copyWholeTable(source, targetSchema, table);
            }
        }
        for (const entry of tableEntries) {
            const table = tables.get(entry.name);
            if (table?.type === 'virtual') {
                source.exec(qualifyCreateSql(entry, targetSchema));
            }
        }

        // CREATE VIRTUAL TABLE materializes FTS5's shadow schema but not its
        // exact segment state. Direct shadow writes are the only public SQL
        // route that preserves the selected snapshot byte-for-byte; keep the
        // defensive-mode exception scoped to fixed, target-qualified DML and
        // restore it before executing any source schema text.
        source.unsafeMode(true);
        try {
            for (const entry of tableEntries) {
                const table = tables.get(entry.name);
                if (table?.type === 'shadow') {
                    copyWholeTable(source, targetSchema, table, true);
                }
            }
        } finally {
            source.unsafeMode(false);
        }
        const sequence = tables.get('sqlite_sequence');
        if (sequence !== undefined) {
            copyWholeTable(source, targetSchema, sequence, true);
        }
        for (const entry of schema) {
            if (entry.type !== 'table') {
                source.exec(qualifyCreateSql(entry, targetSchema));
            }
        }
    });
    snapshot();
}

// The selected SQLite connection owns the authoritative snapshot and the
// codec. Its attached empty target inherits that exact codec before any page
// write, while C01's opened-object seal proves the attachment reached the
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
