import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
    closeSync,
    copyFileSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportAll } from '../../src/cli/commands/backup.js';
import {
    REQUIRED_RESTORE_TABLES,
    RESTORE_CONSENT_CHANGED_ERROR,
    RESTORE_CONSENT_TRIGGER_ERROR,
    RESTORE_CONTROL_TRIGGER_ERROR,
    RESTORE_ENCRYPTION_CHANGED_ERROR,
    RESTORE_EVICTIONS_CHANGED_ERROR,
    RESTORE_INJECTIONS_CHANGED_ERROR,
    RESTORE_PARANOID_CHANGED_ERROR,
    RESTORE_STAGE_CHANGED_ERROR,
    RESTORE_TOMBSTONES_CHANGED_ERROR,
    runRestoreOperation,
} from '../../src/cli/commands/restore.js';
import {
    DATABASE_SCHEMA_METADATA_MAX_CHARS,
    DATABASE_SCHEMA_METADATA_MAX_ROWS,
    DURABLE_CAPTURE_FILTER_VERSION,
} from '../../src/config/constants.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { recordHookOutput } from '../../src/hooks/output.js';
import { filterTurn } from '../../src/rendering/filtered-turn.js';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import { lexicalRecall, tokenizeRecallQuery } from '../../src/serving/lexical-recall.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { writeBackup } from '../../src/storage/backup.js';
import {
    type DatabaseEncryptionRuntime,
    databaseKey,
    encryptionMetadataPath,
    readEncryptionMetadata,
} from '../../src/storage/database-encryption.js';
import { DATABASE_LIFECYCLE_AMBIGUOUS, DATABASE_LIFECYCLE_BUSY, databaseLifecyclePaths } from '../../src/storage/database-lifecycle.js';
import { type DatabaseMigrationRuntime, migratePrimaryDatabaseToEncrypted } from '../../src/storage/database-migration.js';
import { openDb, openKeyedDatabase, openManagedDatabase, openUnmanagedDb, rekeyDatabaseConnection } from '../../src/storage/db.js';
import { DurableCaptureBackfillStore } from '../../src/storage/durable-capture-backfill.js';
import { assertCanonicalDurableCaptureSchema, DURABLE_CAPTURE_SCHEMA_MISMATCH } from '../../src/storage/durable-capture-integrity.js';
import {
    BACKUP_SOURCE_COMPANION_ERROR,
    createPrivateEmptyDatabaseDescriptor,
    DATABASE_SCHEMA_METADATA_LIMIT_ERROR,
    inspectPrivateEmptyDatabaseDescriptor,
    writeEncryptedDatabaseImport,
} from '../../src/storage/encrypted-database-export.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import {
    enableParanoidMode,
    isMemoryLocked,
    LOCKED_CONTENT_COVERAGE,
    LOCKED_MEMORY_MESSAGE,
    lockMemory,
    unlockMemory,
} from '../../src/storage/paranoid-gate.js';
import { ProjectResolver, type ProjectSet } from '../../src/storage/project-resolver.js';
import { applyManualSplit, planManualSplit } from '../../src/storage/resegmentation.js';
import { planSanitize, verifySanitize } from '../../src/storage/sanitize-backfill.js';
import type { ParsedTurn, SessionAdapter, SessionAdapterMap } from '../../src/types/index.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const elephaCli = path.join(repositoryRoot, 'src', 'cli', 'index.ts');
const restoreModule = new URL('../../src/cli/commands/restore.ts', import.meta.url).href;
const FIXED_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const RESTORE_KILL_PADDING_BYTES = 64 * 1024 * 1024;
const RESTORE_KILL_DEADLINE_MS = 10_000;

function lifecycleIntentFiles(dbPath: string): string[] {
    const directory = databaseLifecyclePaths(dbPath).exclusive;
    if (!existsSync(directory)) {
        return [];
    }
    return readdirSync(directory).map((entry) => path.join(directory, entry));
}

function hasLifecycleIntent(dbPath: string): boolean {
    return lifecycleIntentFiles(dbPath).length > 0;
}

function removeLifecycleIntents(dbPath: string): void {
    for (const file of lifecycleIntentFiles(dbPath)) {
        unlinkSync(file);
    }
}

async function killChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    child.kill('SIGKILL');
    await once(child, 'exit');
}

function encryptionRuntime(): DatabaseEncryptionRuntime {
    return {
        platform: 'linux',
        env: { CI: '1' },
        randomBytes: () => Buffer.from(FIXED_KEY),
        randomUUID: () => '11111111-1111-4111-8111-111111111111',
        keyFilePath: (dbPath) => path.join(path.dirname(dbPath), 'restore.keydata'),
    };
}

function migrationRuntime(directory: string): DatabaseMigrationRuntime {
    return {
        ...encryptionRuntime(),
        arch: 'x64',
        libc: 'glibc',
        statePaths: {
            lock: path.join(directory, 'database-migration.lock'),
            manifest: path.join(directory, 'database-migration.json'),
        },
        availableBytes: () => BigInt(Number.MAX_SAFE_INTEGER),
    };
}

function canReadDatabase(dbPath: string, key?: Buffer): boolean {
    let db: Database.Database | undefined;
    try {
        db =
            key === undefined
                ? new Database(dbPath, { readonly: true, fileMustExist: true })
                : openKeyedDatabase(dbPath, key, {
                      readonly: true,
                      fileMustExist: true,
                  });
        db.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
        return true;
    } catch {
        return false;
    } finally {
        db?.close();
    }
}

const IMPORT_SOURCE_COMPANIONS = ['-wal', '-shm', '-journal'] as const;

function removeImportSourceCompanions(dbPath: string): void {
    for (const suffix of IMPORT_SOURCE_COMPANIONS) {
        if (existsSync(`${dbPath}${suffix}`)) unlinkSync(`${dbPath}${suffix}`);
    }
}

function importSourceStat(dbPath: string) {
    const stat = lstatSync(dbPath, { bigint: true });
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, nlink: stat.nlink };
}

function importSchema(db: Database.Database): unknown[] {
    return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name').all();
}

function importShadowRows(db: Database.Database): Record<string, unknown[]> {
    const tables = db
        .prepare("SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow' ORDER BY name")
        .all() as Array<{ name: string; wr: number }>;
    return Object.fromEntries(
        tables.map(({ name, wr }) => {
            const quoted = `"${name.replaceAll('"', '""')}"`;
            const columns = db.prepare("SELECT name FROM pragma_table_xinfo(?, 'main') ORDER BY cid").all(name) as Array<{ name: string }>;
            const order = wr === 0 ? 'rowid' : columns.map(({ name: column }) => `"${column.replaceAll('"', '""')}"`).join(', ');
            return [name, db.prepare(`SELECT * FROM ${quoted} ORDER BY ${order}`).raw().safeIntegers().all() as unknown[]];
        }),
    );
}

async function encryptDatabase(dbPath: string, runtime: DatabaseEncryptionRuntime): Promise<void> {
    const key = await databaseKey(dbPath, true, runtime);
    const db = new Database(dbPath, { fileMustExist: true });
    try {
        rekeyDatabaseConnection(db, key);
    } finally {
        db.close();
        key.fill(0);
    }
}

class ReingestionProbeAdapter implements SessionAdapter {
    readonly tool = 'codex' as const;
    readonly watchGlobs = ['*.jsonl'];
    readonly parseCalls = new Map<string, number>();

    constructor(private readonly projectPath: string) {}

    matches(filePath: string): boolean {
        return filePath.endsWith('.jsonl');
    }

    nativeSessionId(filePath: string): string {
        return path.basename(filePath, '.jsonl');
    }

    async classifySession() {
        return { kind: 'primary' as const };
    }

    async classifyEmptySession() {
        return undefined;
    }

    async *parseTurns(filePath: string): AsyncIterable<ParsedTurn> {
        const sessionId = this.nativeSessionId(filePath);
        this.parseCalls.set(sessionId, (this.parseCalls.get(sessionId) ?? 0) + 1);
        yield {
            tool: this.tool,
            sessionId,
            sourcePath: filePath,
            projectPath: this.projectPath,
            turnIndex: 0,
            startedAt: '2026-08-01T00:00:00.000Z',
            endedAt: '2026-08-01T00:01:00.000Z',
            userMessage: 'must remain excluded',
            assistantText: 'must remain excluded',
            toolCalls: [],
            cursor: '1',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        };
    }
}

type ScanFileSeam = {
    scanFile(
        adapter: SessionAdapter,
        filePath: string,
        closeTrailingOnIdle: boolean,
    ): Promise<{ ingested: number; skipped?: { category: string } }>;
};

function runRestoreCli(dbPath: string, ...args: string[]) {
    return spawnSync(process.execPath, [tsxCli, elephaCli, 'restore', ...args], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            ELEPHA_DB_PATH: dbPath,
            ELEPHA_HOME: path.join(path.dirname(dbPath), 'isolated-elepha-home'),
            ELEPHA_ENV_FILE: path.join(path.dirname(dbPath), 'missing.env'),
        },
    });
}

function runTtyRestoreCli(dbPath: string, input: string, ...args: string[]) {
    const source = [
        "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
        "Object.defineProperty(process.stdout, 'isTTY', { value: true });",
        `process.argv = [process.execPath, 'restore', ...${JSON.stringify(args)}];`,
        `await import(${JSON.stringify(elephaCli)});`,
    ].join('\n');
    return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        input,
        env: {
            ...process.env,
            ELEPHA_DB_PATH: dbPath,
            ELEPHA_HOME: path.join(path.dirname(dbPath), 'isolated-elepha-home'),
            ELEPHA_ENV_FILE: path.join(path.dirname(dbPath), 'missing.env'),
        },
    });
}

function counts(dbPath: string): Record<string, number> {
    const db = new Database(dbPath, { readonly: true });
    try {
        return Object.fromEntries(
            REQUIRED_RESTORE_TABLES.map((table) => [
                table,
                Number((db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count),
            ]),
        );
    } finally {
        db.close();
    }
}

function consentRows(dbPath: string): unknown[] {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return db.prepare('SELECT ulid, path, state, decided_at, source, nudged_at FROM consent_roots ORDER BY ulid').all();
    } finally {
        db.close();
    }
}

function sessionNativeIds(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
        return (db.prepare('SELECT native_id FROM sessions ORDER BY native_id').all() as Array<{ native_id: string }>).map(
            (row) => row.native_id,
        );
    } finally {
        db.close();
    }
}

function populate(dbPath: string, suffix: string): void {
    const db = openUnmanagedDb(dbPath);
    const store = new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null });
    const project = store.upsertProject(path.join(path.dirname(dbPath), `project-${suffix}`));
    const session = store.upsertSession('codex', `session-${suffix}`, project.id, path.join(path.dirname(dbPath), `${suffix}.jsonl`));
    store.recordTurn(
        {
            tool: 'codex',
            sessionId: session.native_id,
            sourcePath: session.source_path,
            projectPath: project.path,
            turnIndex: 0,
            startedAt: '2026-08-01T00:00:00.000Z',
            endedAt: '2026-08-01T00:00:00.000Z',
            userMessage: 'user',
            assistantText: 'assistant',
            toolCalls: [],
            cursor: '0',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        },
        session.id,
        project.id,
        { decisions: [], pending_items: [], status: 'ok' },
    );
    db.prepare('INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (?, ?, ?, ?, ?)').run(
        `consent-${suffix}`,
        path.join(path.dirname(dbPath), `consent-${suffix}`),
        'approved',
        '2026-08-01T00:00:00.000Z',
        'cli',
    );
    store.recordInjection({
        tool: 'codex',
        nativeSessionId: `session-${suffix}`,
        injectedAt: '2026-08-01T00:00:00.000Z',
        injectionId: `injection-${suffix}`,
        body: 'body',
    });
    db.prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)').run(
        'codex',
        `purged-${suffix}`,
        '2026-08-01T00:00:00.000Z',
    );
    db.close();
}

function fullBackup(sourcePath: string, destination: string): void {
    const db = openUnmanagedDb(sourcePath);
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        copyFileSync(sourcePath, destination);
    } finally {
        db.close();
    }
}

function isolateRestoreTemp(): string {
    const restoreTemp = withTempDir('er-');
    vi.stubEnv('TMPDIR', restoreTemp);
    return restoreTemp;
}

function stagedRestoreDirectories(restoreTemp: string): string[] {
    return readdirSync(restoreTemp).filter((name) => name.startsWith('elepha-restore-'));
}

function removeConsentRootUlid(dbPath: string): void {
    const db = new Database(dbPath);
    try {
        db.exec(`
            ALTER TABLE consent_roots RENAME TO consent_roots_old;
            CREATE TABLE consent_roots (
                id         INTEGER PRIMARY KEY,
                path       TEXT NOT NULL UNIQUE,
                state      TEXT NOT NULL CHECK (state IN ('approved', 'denied', 'pending')),
                decided_at TEXT NOT NULL,
                source     TEXT NOT NULL CHECK (source IN ('discovery', 'cli', 'grandfathered')),
                nudged_at  TEXT
            );
            INSERT INTO consent_roots (id, path, state, decided_at, source, nudged_at)
            SELECT id, path, state, decided_at, source, nudged_at FROM consent_roots_old;
            DROP TABLE consent_roots_old;
        `);
    } finally {
        db.close();
    }
}

function replaceWithLegacySessionsTable(db: Database.Database): void {
    db.pragma('foreign_keys = OFF');
    try {
        db.exec(`
            ALTER TABLE sessions RENAME TO sessions_old;
            CREATE TABLE sessions (
                id               INTEGER PRIMARY KEY,
                tool             TEXT NOT NULL CHECK (tool IN ('claude-code','codex')),
                native_id        TEXT NOT NULL UNIQUE,
                project_id       INTEGER NOT NULL REFERENCES projects(id),
                source_path      TEXT NOT NULL,
                cursor           TEXT,
                started_at       TEXT NOT NULL,
                last_ingested_at TEXT NOT NULL
            );
            INSERT INTO sessions (id, tool, native_id, project_id, source_path, cursor, started_at, last_ingested_at)
            SELECT id, tool, native_id, project_id, source_path, cursor, started_at, last_ingested_at FROM sessions_old;
            DROP TABLE sessions_old;
        `);
    } finally {
        db.pragma('foreign_keys = ON');
    }
}

describe('elepha restore', () => {
    it.each([
        { encrypted: false, label: 'plaintext' },
        { encrypted: true, label: 'same-key encrypted' },
    ])('imports a sealed readonly $label source into a pre-keyed stage with exact native fidelity', ({ encrypted }) => {
        const fixture = createTestDb(`elepha-native-import-${encrypted ? 'encrypted' : 'plaintext'}-`);
        fixture.close();
        const sourcePath = path.join(fixture.directory, 'clean-wal-source.db');
        const destinationRoot = withGrantableTestDir('elepha-native-import-stage-');
        const destinationDirectory = path.join(destinationRoot, 'stage');
        mkdirSync(destinationDirectory);
        const destinationPath = path.join(destinationDirectory, 'encrypted-stage.db');
        if (encrypted) closeSync(createPrivateEmptyDatabaseDescriptor(sourcePath));
        const source = encrypted ? openKeyedDatabase(sourcePath, FIXED_KEY, { fileMustExist: true }) : new Database(sourcePath);
        source.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE import_probe (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                payload BLOB NOT NULL,
                touched INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX import_probe_payload ON import_probe(payload);
            CREATE TRIGGER import_probe_au AFTER UPDATE OF payload ON import_probe
            BEGIN
                UPDATE import_probe SET touched = touched + 1 WHERE id = NEW.id;
            END;
            CREATE VIEW import_probe_view AS SELECT id, hex(payload) AS payload_hex FROM import_probe;
            CREATE TABLE import_rowid_probe (payload BLOB NOT NULL);
            CREATE VIRTUAL TABLE import_fts_probe USING fts5(content);
        `);
        source.prepare('INSERT INTO import_probe (id, payload) VALUES (?, ?)').run(73, Buffer.from([255, 0, 128, 7]));
        source.prepare('INSERT INTO import_rowid_probe (rowid, payload) VALUES (?, ?)').run(9_007_199_254_740_993n, Buffer.from([9, 0, 7]));
        source.prepare('INSERT INTO import_fts_probe (rowid, content) VALUES (?, ?)').run(91, 'native import token');
        source.prepare('INSERT INTO import_fts_probe (rowid, content) VALUES (?, ?)').run(107, 'deleted token');
        source.prepare('DELETE FROM import_fts_probe WHERE rowid = ?').run(107);
        source.pragma('wal_checkpoint(TRUNCATE)');
        source.close();
        removeImportSourceCompanions(sourcePath);

        const expected = encrypted
            ? openKeyedDatabase(sourcePath, FIXED_KEY, { readonly: true, fileMustExist: true })
            : new Database(sourcePath, { readonly: true, fileMustExist: true });
        const expectedSchema = importSchema(expected);
        const expectedShadows = importShadowRows(expected);
        const expectedSequence = expected.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').safeIntegers().all();
        expect(() => expected.prepare("UPDATE import_probe SET payload = X'00'").run()).toThrow(
            expect.objectContaining({ code: 'SQLITE_READONLY' }),
        );
        expected.close();
        const admitted = IMPORT_SOURCE_COMPANIONS.filter((suffix) => existsSync(`${sourcePath}${suffix}`)).map((suffix) => ({
            suffix,
            size: statSync(`${sourcePath}${suffix}`).size,
        }));
        expect(admitted).toEqual([
            { suffix: '-wal', size: 0 },
            { suffix: '-shm', size: 32_768 },
        ]);
        removeImportSourceCompanions(sourcePath);
        const sourceBytes = readFileSync(sourcePath);
        const sourceStat = importSourceStat(sourcePath);

        const destinationDescriptor = createPrivateEmptyDatabaseDescriptor(destinationPath);
        const destinationIdentity = inspectPrivateEmptyDatabaseDescriptor(destinationDescriptor);
        closeSync(destinationDescriptor);
        const importSource = () =>
            writeEncryptedDatabaseImport(
                sourcePath,
                { ...sourceStat },
                destinationPath,
                destinationIdentity,
                FIXED_KEY,
                encrypted ? FIXED_KEY : undefined,
            );
        writeFileSync(`${sourcePath}-wal`, '');
        expect(importSource).toThrow(BACKUP_SOURCE_COMPANION_ERROR);
        expect(existsSync(`${sourcePath}-wal`)).toBe(true);
        unlinkSync(`${sourcePath}-wal`);
        importSource();

        expect(readFileSync(sourcePath)).toEqual(sourceBytes);
        expect(importSourceStat(sourcePath)).toEqual(sourceStat);
        expect(IMPORT_SOURCE_COMPANIONS.filter((suffix) => existsSync(`${sourcePath}${suffix}`))).toEqual([]);
        expect(readFileSync(destinationPath).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        expect(canReadDatabase(destinationPath)).toBe(false);
        const imported = openKeyedDatabase(destinationPath, FIXED_KEY, { fileMustExist: true });
        expect(importSchema(imported)).toEqual(expectedSchema);
        expect(importShadowRows(imported)).toEqual(expectedShadows);
        expect(imported.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').safeIntegers().all()).toEqual(expectedSequence);
        expect(imported.prepare('SELECT rowid, hex(payload) FROM import_rowid_probe').raw().safeIntegers().get()).toEqual([
            9_007_199_254_740_993n,
            '090007',
        ]);
        expect(imported.prepare("SELECT rowid, content FROM import_fts_probe WHERE import_fts_probe MATCH 'native'").all()).toEqual([
            { rowid: 91, content: 'native import token' },
        ]);
        expect(imported.prepare('SELECT * FROM import_probe_view').all()).toEqual([{ id: 73, payload_hex: 'FF008007' }]);
        imported.prepare('UPDATE import_probe SET payload = ? WHERE id = ?').run(Buffer.from([1]), 73);
        expect(imported.prepare('SELECT touched FROM import_probe WHERE id = 73').get()).toEqual({ touched: 1 });
        imported.close();
    });

    it.each([
        {
            label: 'schema object rows',
            expectedRows: { schema_rows: 257n, table_rows: 2n },
            populate(db: Database.Database) {
                db.exec('CREATE TABLE metadata_anchor (value INTEGER)');
                db.exec(
                    Array.from(
                        { length: DATABASE_SCHEMA_METADATA_MAX_ROWS },
                        (_, index) => `CREATE INDEX metadata_index_${index} ON metadata_anchor(value)`,
                    ).join(';'),
                );
            },
        },
        {
            label: 'main table-list rows',
            expectedRows: { schema_rows: 256n, table_rows: 257n },
            populate(db: Database.Database) {
                db.exec(
                    Array.from(
                        { length: DATABASE_SCHEMA_METADATA_MAX_ROWS },
                        (_, index) => `CREATE TABLE metadata_table_${index} (value INTEGER)`,
                    ).join(';'),
                );
            },
        },
        {
            label: 'aggregate schema text',
            expectedRows: { schema_rows: 1n, table_rows: 2n },
            populate(db: Database.Database) {
                db.exec(`CREATE VIEW metadata_view AS SELECT '${'x'.repeat(DATABASE_SCHEMA_METADATA_MAX_CHARS)}' AS value`);
            },
        },
    ])(
        'rejects $label before encrypted reconstruction materializes unbounded metadata',
        ({ expectedRows, populate }) => {
            const directory = withGrantableTestDir('elepha-schema-metadata-import-');
            const sourcePath = path.join(directory, 'source.db');
            const destinationPath = path.join(directory, 'encrypted-stage.db');
            const source = new Database(sourcePath);
            populate(source);
            expect(
                source
                    .prepare(
                        `SELECT (SELECT COUNT(*) FROM sqlite_schema WHERE sql IS NOT NULL) AS schema_rows,
                                (SELECT COUNT(*) FROM pragma_table_list WHERE schema = 'main') AS table_rows`,
                    )
                    .safeIntegers()
                    .get(),
            ).toEqual(expectedRows);
            source.close();
            const descriptor = createPrivateEmptyDatabaseDescriptor(destinationPath);
            const destinationIdentity = inspectPrivateEmptyDatabaseDescriptor(descriptor);
            closeSync(descriptor);

            expect(() =>
                writeEncryptedDatabaseImport(sourcePath, importSourceStat(sourcePath), destinationPath, destinationIdentity, FIXED_KEY),
            ).toThrow(DATABASE_SCHEMA_METADATA_LIMIT_ERROR);
        },
        15_000,
    );

    it.each([
        { encrypted: false, label: 'plaintext' },
        { encrypted: true, label: 'encrypted' },
    ])('rejects excessive schema metadata before $label restore confirmation or active mutation', async ({ encrypted }) => {
        const active = createTestDb('elepha-schema-limit-active-');
        const candidate = createTestDb('elepha-schema-limit-candidate-');
        candidate.db.exec(`CREATE VIEW metadata_view AS SELECT '${'x'.repeat(DATABASE_SCHEMA_METADATA_MAX_CHARS)}' AS value`);
        candidate.close();
        active.close();
        const runtime = encryptionRuntime();
        if (encrypted) {
            await encryptDatabase(active.dbPath, runtime);
        }
        const activeBytes = readFileSync(active.dbPath);
        const restoreTemp = isolateRestoreTemp();
        const confirm = vi.fn(async () => false);
        const snapshot = vi.fn(() => 'unused');

        await expect(
            runRestoreOperation(candidate.dbPath, {
                dbPath: active.dbPath,
                encryption: runtime,
                daemonHealth: () => ({ healthy: false, state: 'STOPPED' }),
                confirm,
                writeBackup: snapshot,
            }),
        ).rejects.toThrow(DATABASE_SCHEMA_METADATA_LIMIT_ERROR);
        expect(confirm).not.toHaveBeenCalled();
        expect(snapshot).not.toHaveBeenCalled();
        expect(readFileSync(active.dbPath)).toEqual(activeBytes);
        expect(stagedRestoreDirectories(restoreTemp)).toEqual([]);
    });

    it('leaves only ciphertext stage data when native import fails foreign-key verification', () => {
        const fixture = createTestDb('elepha-import-foreign-key-failure-');
        fixture.close();
        const sourcePath = path.join(fixture.directory, 'invalid-clean-wal-source.db');
        const stagePath = path.join(fixture.directory, 'failed-encrypted-stage.db');
        const source = new Database(sourcePath);
        source.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = OFF;
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent(id));
            INSERT INTO child VALUES (1);
        `);
        source.pragma('wal_checkpoint(TRUNCATE)');
        source.close();
        removeImportSourceCompanions(sourcePath);
        const sourceBytes = readFileSync(sourcePath);
        const sourceStat = importSourceStat(sourcePath);
        const descriptor = createPrivateEmptyDatabaseDescriptor(stagePath);
        const stageIdentity = inspectPrivateEmptyDatabaseDescriptor(descriptor);
        closeSync(descriptor);
        expect(() => writeEncryptedDatabaseImport(sourcePath, sourceStat, stagePath, stageIdentity, FIXED_KEY)).toThrow(
            'Imported database failed foreign_key_check.',
        );
        expect(readFileSync(stagePath).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        expect(canReadDatabase(stagePath)).toBe(false);
        expect(canReadDatabase(stagePath, FIXED_KEY)).toBe(true);
        expect(readFileSync(sourcePath)).toEqual(sourceBytes);
        expect(importSourceStat(sourcePath)).toEqual(sourceStat);
        expect(IMPORT_SOURCE_COMPANIONS.filter((suffix) => existsSync(`${sourcePath}${suffix}`))).toEqual([]);
    });

    it('restores an encrypted full export with identical schema and row counts using the installation key', async () => {
        const active = createTestDb('elepha-restore-encrypted-active-');
        const candidate = createTestDb('elepha-restore-encrypted-candidate-');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        active.db.exec('DELETE FROM purged_transcripts; DELETE FROM injections');
        active.close();
        candidate.close();
        const runtime = encryptionRuntime();
        await encryptDatabase(active.dbPath, runtime);
        await encryptDatabase(candidate.dbPath, runtime);
        const backup = path.join(candidate.directory, 'full-encrypted.db');
        const candidateDb = openKeyedDatabase(candidate.dbPath, FIXED_KEY);
        const expectedSchema = candidateDb.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
        const expectedCounts = Object.fromEntries(
            REQUIRED_RESTORE_TABLES.map((table) => [
                table,
                table === 'injections'
                    ? 0
                    : Number((candidateDb.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count),
            ]),
        );
        exportAll(candidateDb, backup, FIXED_KEY);
        candidateDb.close();

        const result = await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            encryption: runtime,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
        });

        expect(readFileSync(active.dbPath).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        const unkeyed = new Database(active.dbPath, { readonly: true });
        expect(() => unkeyed.prepare('SELECT name FROM sqlite_master').all()).toThrow();
        unkeyed.close();
        const restored = openKeyedDatabase(active.dbPath, FIXED_KEY, { readonly: true });
        expect(restored.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        expect(restored.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all()).toEqual(expectedSchema);
        expect(
            Object.fromEntries(
                REQUIRED_RESTORE_TABLES.map((table) => [
                    table,
                    Number((restored.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count),
                ]),
            ),
        ).toEqual(expectedCounts);
        restored.close();
        expect(result.snapshotPath).toBeDefined();
        expect(readFileSync(result.snapshotPath!).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
    });

    it('imports a plaintext legacy backup into the active encrypted installation and preserves its locked authority', async () => {
        const active = createTestDb('elepha-plaintext-legacy-active-');
        active.db.pragma('wal_checkpoint(TRUNCATE)');
        const backup = path.join(active.directory, 'plaintext-legacy.db');
        copyFileSync(active.dbPath, backup);
        const legacy = new Database(backup);
        replaceWithLegacySessionsTable(legacy);
        legacy.exec(`
            DROP TABLE filtered_turns_fts;
            DROP TABLE filtered_turns;
            DROP TABLE durable_capture_status;
            DROP TABLE durable_capture_usage;
        `);
        legacy.close();
        const sourceBytes = readFileSync(backup);
        active.close();

        const encryption = encryptionRuntime();
        await encryptDatabase(active.dbPath, encryption);
        const enrolled = await openDb(active.dbPath, { encryption });
        enableParanoidMode(enrolled, 'restore passphrase');
        const authorityBefore = enrolled
            .prepare('SELECT enrolled, state, generation, credential_tag FROM paranoid_authority WHERE id = 1')
            .get();
        enrolled.close();
        const metadataBefore = readEncryptionMetadata(encryptionMetadataPath(active.dbPath));
        const keyPath = encryption.keyFilePath!(active.dbPath);
        const keyBefore = readFileSync(keyPath);
        const restoreTemp = isolateRestoreTemp();
        let stageWasPlaintext: boolean | undefined;

        const result = await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            encryption,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            confirm: async () => {
                const staged = stagedRestoreDirectories(restoreTemp);
                expect(staged).toHaveLength(1);
                stageWasPlaintext =
                    readFileSync(path.join(restoreTemp, staged[0]!, 'candidate.db'))
                        .subarray(0, 16)
                        .toString('binary') === 'SQLite format 3\0';
                return true;
            },
        });

        const activeHeaderAfterRestore = readFileSync(active.dbPath).subarray(0, 16).toString('binary');
        const unkeyedReadable = canReadDatabase(active.dbPath);
        const keyedReadable = canReadDatabase(active.dbPath, FIXED_KEY);
        const restored = await openManagedDatabase(active.dbPath, { readonly: true, fileMustExist: true, encryption });
        const authorityAfter = restored
            .prepare('SELECT enrolled, state, generation, credential_tag FROM paranoid_authority WHERE id = 1')
            .get();
        const lockedAfter = isMemoryLocked(restored);
        const readStateAfter = new SessionReader(restored).serveState();
        restored.close();
        let migration: unknown;
        try {
            migration = await migratePrimaryDatabaseToEncrypted(active.dbPath, migrationRuntime(active.directory));
        } catch (error) {
            migration = { error: error instanceof Error ? error.message : String(error) };
        }

        expect.soft(stageWasPlaintext).toBe(false);
        expect.soft(activeHeaderAfterRestore).not.toBe('SQLite format 3\0');
        expect.soft(unkeyedReadable).toBe(false);
        expect.soft(keyedReadable).toBe(true);
        expect.soft(authorityAfter).toEqual(authorityBefore);
        expect.soft(lockedAfter).toBe(true);
        expect.soft(readStateAfter).toBe('locked');
        expect.soft(migration).toEqual({ status: 'already-encrypted' });
        expect.soft(readEncryptionMetadata(encryptionMetadataPath(active.dbPath))).toEqual(metadataBefore);
        expect.soft(readFileSync(keyPath)).toEqual(keyBefore);
        expect.soft(readFileSync(backup)).toEqual(sourceBytes);
        expect.soft(result.snapshotPath).toBeDefined();
        expect.soft(readFileSync(result.snapshotPath!).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
    });

    it('preserves a hook injection recorded after the backup so its quote-back remains suppressed', async () => {
        const active = createTestDb('elepha-current-injection-active-');
        populate(active.dbPath, 'injection-restore');
        active.close();
        const encryption = encryptionRuntime();
        await encryptDatabase(active.dbPath, encryption);
        const current = await openDb(active.dbPath, { encryption });
        const backup = path.join(active.directory, 'before-current-injection.db');
        exportAll(current, backup, FIXED_KEY);
        current.prepare('DELETE FROM injections').run();
        const store = new MemoryStore(current);
        const body = 'current hook output must remain attributable after restore';
        const output = recordHookOutput({
            store,
            tool: 'codex',
            nativeSessionId: 'current-hook-session',
            body,
            kind: 'brief',
            injectedAt: '2026-09-06T01:00:00.000Z',
        });
        expect(output).toContain(body);
        current.close();

        await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            encryption,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
        });

        const restored = await openDb(active.dbPath, { encryption });
        const restoredStore = new MemoryStore(restored);
        const rows = restoredStore.injectionsForSession('codex', 'current-hook-session', '2026-09-06T01:00:01.000Z');
        expect.soft(restored.prepare('SELECT body FROM injections').all()).toEqual([{ body }]);
        const quoteBack = restoredStore.isInjectionQuoteBack({
            tool: 'codex',
            sessionId: 'current-hook-session',
            sourcePath: path.join(active.directory, 'current-hook-session.jsonl'),
            projectPath: active.directory,
            turnIndex: 1,
            startedAt: '2026-09-06T01:00:00.000Z',
            endedAt: '2026-09-06T01:00:01.000Z',
            userMessage: 'quote follows',
            assistantText: body,
            toolCalls: [],
            cursor: '1',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        });
        restored.close();

        expect.soft(rows).toEqual([expect.objectContaining({ body, tool: 'codex', native_session_id: 'current-hook-session' })]);
        expect.soft(quoteBack).toBe(true);
    });

    it('preserves current terminal eviction through restore so backfill and search cannot resurrect it', async () => {
        const active = createTestDb('elepha-terminal-eviction-active-');
        const project = seedProject(active, { path: path.join(active.directory, 'project') });
        active.store.consent.grant(project.path);
        const sourcePath = path.join(active.directory, 'terminal-session.jsonl');
        writeFileSync(sourcePath, '{}\n');
        const session = seedSession(active, { project, nativeId: 'terminal-session', sourcePath });
        seedMemory(active, { project, session, turnIndex: 0 });
        const candidateOnly = seedSession(active, { project, nativeId: 'candidate-terminal', sourcePath });
        seedMemory(active, { project, session: candidateOnly, turnIndex: 0 });
        active.close();
        const encryption = encryptionRuntime();
        await encryptDatabase(active.dbPath, encryption);
        const current = await openDb(active.dbPath, { encryption });
        const backup = path.join(active.directory, 'before-current-eviction.db');
        const terminal = current.prepare(
            `INSERT INTO durable_capture_status (session_id, state, filter_version, updated_at)
             VALUES (?, 'evicted', 1, ?)
             ON CONFLICT (session_id) DO UPDATE SET state = 'evicted', updated_at = excluded.updated_at`,
        );
        terminal.run(candidateOnly.id, '2026-09-06T01:59:00.000Z');
        exportAll(current, backup, FIXED_KEY);
        current.prepare("UPDATE durable_capture_status SET state = 'complete' WHERE session_id = ?").run(candidateOnly.id);
        terminal.run(session.id, '2026-09-06T02:00:00.000Z');
        const currentOnlyProjectPath = path.join(project.path, 'current-only-project');
        const currentStore = new MemoryStore(current, { resolveGitRoot: () => null, resolveGitRemote: () => null });
        const currentOnlyProject = currentStore.upsertProject(currentOnlyProjectPath);
        const currentOnlySourcePath = path.join(active.directory, 'current-only.jsonl');
        writeFileSync(currentOnlySourcePath, '{}\n');
        const currentOnly = currentStore.upsertSession('codex', 'current-only-absent', currentOnlyProject.id, currentOnlySourcePath);
        current
            .prepare('UPDATE projects SET first_seen_at = ?, last_seen_at = ? WHERE id = ?')
            .run('2026-09-06T01:57:00.000Z', '2026-09-06T01:58:00.000Z', currentOnlyProject.id);
        current
            .prepare('UPDATE sessions SET segment_index = 2, started_at = ?, last_ingested_at = ? WHERE id = ?')
            .run('2026-09-06T01:58:00.000Z', '2026-09-06T01:59:00.000Z', currentOnly.id);
        current.prepare("INSERT INTO durable_capture_status VALUES (?, 'evicted', 1, ?)").run(currentOnly.id, '2026-09-06T02:00:00.000Z');
        current.close();

        await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            encryption,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
        });

        const restored = await openDb(active.dbPath, { encryption });
        const restoredStore = new MemoryStore(restored);
        const backfill = new DurableCaptureBackfillStore(restored, restoredStore.consent);
        const anchor = restored
            .prepare(
                `SELECT s.id, s.project_id, s.tool, s.native_id, s.segment_index, s.source_path, s.started_at, s.last_ingested_at,
                        p.path AS project_path, p.first_seen_at, p.last_seen_at, d.state
                 FROM sessions s
                 JOIN projects p ON p.id = s.project_id
                 JOIN durable_capture_status d ON d.session_id = s.id
                 WHERE s.tool = 'codex' AND s.native_id = 'current-only-absent'`,
            )
            .get() as Record<string, unknown>;
        expect.soft(anchor).toEqual({
            id: expect.any(Number),
            project_id: expect.any(Number),
            tool: 'codex',
            native_id: 'current-only-absent',
            segment_index: 2,
            source_path: currentOnlySourcePath,
            started_at: '2026-09-06T01:58:00.000Z',
            last_ingested_at: '2026-09-06T01:59:00.000Z',
            project_path: currentOnlyProjectPath,
            first_seen_at: '2026-09-06T01:57:00.000Z',
            last_seen_at: '2026-09-06T01:58:00.000Z',
            state: 'evicted',
        });
        const ingested = restoredStore.recordIngestedTurn(
            {
                tool: 'codex',
                sessionId: 'current-only-absent',
                sourcePath: currentOnlySourcePath,
                projectPath: currentOnlyProjectPath,
                turnIndex: 0,
                startedAt: '2026-09-06T02:01:00.000Z',
                endedAt: '2026-09-06T02:01:01.000Z',
                userMessage: 'terminalresurrectionneedle',
                assistantText: 'raw response',
                toolCalls: [],
                cursor: '1',
                hasExternalContent: false,
                resumeMarkerBefore: false,
            },
            {},
            false,
            { decisions: [], pending_items: [], status: 'ok' },
            false,
            undefined,
            undefined,
            { projectIdentity: { gitRoot: null, gitRemote: null, gitRootCommit: null }, gitCommitCount: null },
        );
        expect
            .soft(ingested)
            .toEqual(expect.objectContaining({ inserted: true, session: expect.objectContaining({ id: anchor.id, segment_index: 2 }) }));
        const candidates = backfill.listCandidates([project.id, Number(anchor.project_id)], 10);
        const results = [];
        for (const candidate of candidates) {
            const work = backfill.begin(candidate, '2026-09-06T02:01:00.000Z');
            const touched = new Set<number>();
            for (const turnIndex of work?.missingTurnIndexes ?? []) {
                const result = backfill.record(
                    candidate,
                    turnIndex,
                    filterTurn({
                        userMessage: 'terminalresurrectionneedle',
                        assistantText: 'backfilled response',
                        toolCalls: [],
                    }),
                    '2026-09-06T02:01:00.000Z',
                );
                results.push(result);
                if ('sessionId' in result) touched.add(result.sessionId);
            }
            backfill.finish(candidate, touched, 'success', '2026-09-06T02:01:01.000Z');
        }

        expect.soft(candidates).toEqual([]);
        expect.soft(results).toEqual([]);
        expect
            .soft(
                restored
                    .prepare(
                        "SELECT s.native_id, d.state FROM sessions s JOIN durable_capture_status d ON d.session_id = s.id WHERE d.state = 'evicted' ORDER BY s.native_id",
                    )
                    .all(),
            )
            .toEqual([
                { native_id: 'candidate-terminal', state: 'evicted' },
                { native_id: 'current-only-absent', state: 'evicted' },
                { native_id: 'terminal-session', state: 'evicted' },
            ]);
        expect.soft(restored.prepare('SELECT memory_id FROM filtered_turns').all()).toEqual([]);
        expect
            .soft(
                restored.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'terminalresurrectionneedle'").all(),
            )
            .toEqual([]);
        expect.soft(restored.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get()).toEqual({ total_bytes: 0 });
        restored.close();
    });

    it('preserves plaintext-active injection provenance and terminal eviction', async () => {
        const active = createTestDb('elepha-plaintext-controls-');
        const project = seedProject(active, { path: path.join(active.directory, 'project') });
        active.store.consent.grant(project.path);
        const sourcePath = path.join(active.directory, 'plaintext-terminal.jsonl');
        writeFileSync(sourcePath, '{}\n');
        const session = seedSession(active, { project, nativeId: 'plaintext-terminal', sourcePath });
        seedMemory(active, { project, session, assistantText: 'plaintextresurrectionneedle' });
        recordHookOutput({
            store: active.store,
            tool: 'codex',
            nativeSessionId: 'plaintext-hook-session',
            body: 'candidate forged hook output',
            kind: 'brief',
            injectedAt: '2026-09-06T04:00:00.000Z',
        });
        const backup = path.join(active.directory, 'before-plaintext-controls.db');
        fullBackup(active.dbPath, backup);
        active.db.prepare('DELETE FROM injections').run();
        const body = 'authentic plaintext-active hook output';
        recordHookOutput({
            store: active.store,
            tool: 'codex',
            nativeSessionId: 'plaintext-hook-session',
            body,
            kind: 'brief',
            injectedAt: '2026-09-06T04:01:00.000Z',
        });
        active.db
            .prepare(
                "INSERT INTO durable_capture_status VALUES (?, 'evicted', 1, ?) ON CONFLICT(session_id) DO UPDATE SET state = 'evicted', updated_at = excluded.updated_at",
            )
            .run(session.id, '2026-09-06T04:01:00.000Z');
        active.close();
        await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
        });

        const restored = openUnmanagedDb(active.dbPath);
        const store = new MemoryStore(restored);
        const quoteBack = store.isInjectionQuoteBack({
            tool: 'codex',
            sessionId: 'plaintext-hook-session',
            sourcePath,
            projectPath: project.path,
            turnIndex: 1,
            startedAt: '2026-09-06T04:01:00.000Z',
            endedAt: '2026-09-06T04:02:00.000Z',
            userMessage: 'quote follows',
            assistantText: body,
            toolCalls: [],
            cursor: '1',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        });
        const candidates = new DurableCaptureBackfillStore(restored, store.consent).listCandidates([project.id], 10);

        expect.soft(restored.prepare('SELECT body FROM injections').all()).toEqual([{ body }]);
        expect.soft(quoteBack).toBe(true);
        expect.soft(candidates).toEqual([]);
        expect.soft(restored.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(session.id)).toEqual({
            state: 'evicted',
        });
        expect.soft(restored.prepare('SELECT memory_id FROM filtered_turns').all()).toEqual([]);
        expect
            .soft(
                restored.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'plaintextresurrectionneedle'").all(),
            )
            .toEqual([]);
        expect.soft(restored.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get()).toEqual({ total_bytes: 0 });
        restored.close();
    });

    it.each([
        ['paranoid', RESTORE_PARANOID_CHANGED_ERROR],
        ['injection', RESTORE_INJECTIONS_CHANGED_ERROR],
        ['eviction', RESTORE_EVICTIONS_CHANGED_ERROR],
    ] as const)('aborts before snapshot when active %s control changes during confirmation', async (control, expectedError) => {
        const active = createTestDb(`elepha-${control}-control-stale-`);
        populate(active.dbPath, control);
        active.close();
        const encryption = encryptionRuntime();
        await encryptDatabase(active.dbPath, encryption);
        const current = await openDb(active.dbPath, { encryption });
        current.prepare('DELETE FROM injections').run();
        if (control === 'paranoid') enableParanoidMode(current, 'stale control passphrase');
        const backup = path.join(active.directory, 'control-backup.db');
        exportAll(current, backup, FIXED_KEY);
        current.close();
        let activeBytes!: Buffer;
        const snapshot = vi.fn((_db: Database.Database, _dbPath: string) => 'unreachable');
        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                encryption,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                writeBackup: snapshot,
                confirm: async () => {
                    const changed = await openDb(active.dbPath, { encryption });
                    if (control === 'paranoid') unlockMemory(changed, 'stale control passphrase');
                    else if (control === 'injection')
                        new MemoryStore(changed).recordInjection({
                            tool: 'codex',
                            nativeSessionId: 'stale',
                            injectedAt: '2026-09-06T03:00:00.000Z',
                            injectionId: 'stale',
                            body: 'stale',
                        });
                    else
                        expect(
                            changed
                                .prepare(
                                    "INSERT INTO durable_capture_status SELECT id, 'evicted', 1, '2026-09-06T03:00:00.000Z' FROM sessions ORDER BY id LIMIT 1 ON CONFLICT(session_id) DO UPDATE SET state = 'evicted'",
                                )
                                .run().changes,
                        ).toBe(1);
                    changed.pragma('wal_checkpoint(TRUNCATE)');
                    changed.close();
                    activeBytes = readFileSync(active.dbPath);
                    return true;
                },
            }),
        ).rejects.toThrow(expectedError);
        expect(snapshot).not.toHaveBeenCalled();
        expect(readFileSync(active.dbPath)).toEqual(activeBytes);
    });

    it('aborts before snapshot when plaintext active storage is encrypted during confirmation', async () => {
        const active = createTestDb('elepha-plaintext-encryption-stale-');
        const candidate = createTestDb('elepha-plaintext-encryption-candidate-');
        populate(active.dbPath, 'concurrent-current');
        populate(candidate.dbPath, 'staged-candidate');
        const backup = path.join(candidate.directory, 'plaintext.db');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const runtime = migrationRuntime(active.directory);
        const snapshot = vi.fn(writeBackup);
        let concurrentBytes!: Buffer;

        const outcome = await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            encryption: runtime,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            writeBackup: snapshot,
            confirm: async () => {
                await expect(migratePrimaryDatabaseToEncrypted(active.dbPath, runtime)).resolves.toEqual({ status: 'migrated' });
                concurrentBytes = readFileSync(active.dbPath);
                return true;
            },
        }).then(
            () => ({ status: 'resolved' as const, message: undefined }),
            (error: unknown) => ({
                status: 'rejected' as const,
                message: error instanceof Error ? error.message : String(error),
            }),
        );

        expect.soft(outcome).toEqual({ status: 'rejected', message: RESTORE_ENCRYPTION_CHANGED_ERROR });
        expect.soft(snapshot).not.toHaveBeenCalled();
        expect.soft(readFileSync(active.dbPath).equals(concurrentBytes)).toBe(true);
        expect.soft(readFileSync(active.dbPath).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        expect.soft(readEncryptionMetadata(encryptionMetadataPath(active.dbPath))).toBeDefined();
        const concurrent = await openManagedDatabase(active.dbPath, { readonly: true, fileMustExist: true, encryption: runtime });
        expect
            .soft((concurrent.prepare('SELECT native_id FROM sessions').pluck().all() as string[]).sort())
            .toEqual(['session-concurrent-current']);
        concurrent.close();
    });

    it.each(['main file', 'companion WAL'] as const)(
        'rejects a substituted validated stage %s before overlay or snapshot',
        async (kind) => {
            const active = createTestDb('elepha-stage-substitution-active-');
            const candidate = createTestDb('elepha-stage-substitution-candidate-');
            const substitution = createTestDb('elepha-stage-substitution-malicious-');
            populate(active.dbPath, 'stage-current');
            populate(candidate.dbPath, 'stage-candidate');
            populate(substitution.dbPath, 'stage-malicious');
            const triggerSql = `
            CREATE TRIGGER candidate_consent_expand
            AFTER INSERT ON consent_roots
            BEGIN
              INSERT OR IGNORE INTO consent_roots
              VALUES (NULL, 'evil-ulid', '/tmp/expanded', 'approved', '2026-09-06T00:00:00.000Z', 'cli', NULL);
            END;
        `;
            if (kind === 'main file') substitution.db.exec(triggerSql);
            substitution.db.pragma('wal_checkpoint(TRUNCATE)');
            const backup = path.join(candidate.directory, 'plaintext.db');
            fullBackup(candidate.dbPath, backup);
            active.close();
            candidate.close();
            substitution.close();
            const activeBytes = readFileSync(active.dbPath);
            const restoreTemp = isolateRestoreTemp();
            const snapshot = vi.fn(writeBackup);
            let stagedWriter: Database.Database | undefined;
            let unchangedStageMain: boolean | undefined;
            let stagedWalBytes = 0;

            const outcome = await runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                writeBackup: snapshot,
                confirm: async () => {
                    const staged = stagedRestoreDirectories(restoreTemp);
                    expect(staged).toHaveLength(1);
                    const stagedPath = path.join(restoreTemp, staged[0]!, 'candidate.db');
                    expect(readdirSync(path.dirname(stagedPath))).toEqual(['candidate.db']);
                    if (kind === 'main file') {
                        unlinkSync(stagedPath);
                        copyFileSync(substitution.dbPath, stagedPath);
                    } else {
                        const validatedMain = readFileSync(stagedPath);
                        stagedWriter = new Database(stagedPath);
                        expect(stagedWriter.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
                        stagedWriter.pragma('wal_autocheckpoint = 0');
                        stagedWriter.exec(triggerSql);
                        unchangedStageMain = readFileSync(stagedPath).equals(validatedMain);
                        stagedWalBytes = statSync(`${stagedPath}-wal`).size;
                    }
                    return true;
                },
            }).then(
                () => ({ status: 'resolved' as const, message: undefined }),
                (error: unknown) => ({
                    status: 'rejected' as const,
                    message: error instanceof Error ? error.message : String(error),
                }),
            );
            stagedWriter?.close();

            if (kind === 'companion WAL') {
                expect.soft(unchangedStageMain).toBe(true);
                expect.soft(stagedWalBytes).toBeGreaterThan(0);
            }
            expect.soft(outcome).toEqual({ status: 'rejected', message: RESTORE_STAGE_CHANGED_ERROR });
            expect.soft(snapshot).not.toHaveBeenCalled();
            expect.soft(readFileSync(active.dbPath).equals(activeBytes)).toBe(true);
            expect.soft(sessionNativeIds(active.dbPath)).toEqual(['session-stage-current']);
            expect
                .soft(consentRows(active.dbPath))
                .not.toContainEqual(expect.objectContaining({ path: '/tmp/expanded', state: 'approved' }));
        },
    );
    afterEach(() => vi.unstubAllEnvs());

    it('restores candidate rows, preserves active purge tombstones, snapshots the current database, and removes stale sidecars', () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const candidateBytes = readFileSync(backup);
        const beforeCounts = counts(active.dbPath);
        const candidateCounts = counts(backup);
        const expectedCounts = {
            ...candidateCounts,
            purged_transcripts: candidateCounts.purged_transcripts + beforeCounts.purged_transcripts,
        };
        const restoreTemp = isolateRestoreTemp();
        writeFileSync(`${active.dbPath}-wal`, 'stale wal');
        writeFileSync(`${active.dbPath}-shm`, 'stale shm');

        const result = runRestoreCli(active.dbPath, backup, '--skip-confirmation');

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('Restore preview:');
        for (const table of REQUIRED_RESTORE_TABLES) {
            expect(result.stdout).toContain(`  ${table}: ${candidateCounts[table]}`);
        }
        expect(existsSync(`${active.dbPath}-wal`)).toBe(false);
        expect(existsSync(`${active.dbPath}-shm`)).toBe(false);
        expect(counts(active.dbPath)).toEqual(expectedCounts);
        expect(readFileSync(backup)).toEqual(candidateBytes);
        const snapshot = readdirSync(active.directory).find((name) => name.startsWith('elepha.db.bak-'));
        expect(snapshot).toBeDefined();
        const snapshotPath = path.join(active.directory, snapshot!);
        expect(counts(snapshotPath)).toEqual(beforeCounts);
        expect(sessionNativeIds(snapshotPath)).toEqual(['session-before']);
        expect(stagedRestoreDirectories(restoreTemp)).toEqual([]);
    }, 15000);

    it('restores the validated candidate when its pathname is replaced during confirmation', async () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
        const substitute = createTestDb('elepha-restore-substitute-');
        const backup = path.join(candidate.directory, 'full.db');
        const substituteBackup = path.join(substitute.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'previewed');
        populate(substitute.dbPath, 'substituted');
        fullBackup(candidate.dbPath, backup);
        fullBackup(substitute.dbPath, substituteBackup);
        active.close();
        candidate.close();
        substitute.close();
        expect(counts(backup)).toEqual(counts(substituteBackup));
        const restoreTemp = isolateRestoreTemp();

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                confirm: async () => {
                    const stagedDirectories = stagedRestoreDirectories(restoreTemp);
                    expect(stagedDirectories).toHaveLength(1);
                    expect(readdirSync(path.join(restoreTemp, stagedDirectories[0]!))).toEqual(['candidate.db']);
                    copyFileSync(substituteBackup, backup);
                    return true;
                },
            }),
        ).resolves.toMatchObject({ cancelled: false });

        expect(sessionNativeIds(active.dbPath)).toEqual(['session-previewed']);
        expect(sessionNativeIds(active.dbPath)).not.toContain('session-substituted');
        expect(stagedRestoreDirectories(restoreTemp)).toEqual([]);
    });

    it('pins a relative active database path before confirmation can change cwd', async () => {
        const directoryA = withGrantableTestDir('elepha-restore-relative-a-');
        const directoryB = withGrantableTestDir('elepha-restore-relative-b-');
        const candidate = createTestDb('elepha-restore-relative-candidate-');
        const activeA = path.join(directoryA, 'relative.db');
        const activeB = path.join(directoryB, 'relative.db');
        const backup = path.join(candidate.directory, 'full.db');
        populate(activeA, 'a-before');
        populate(activeB, 'b-before');
        populate(candidate.dbPath, 'candidate');
        fullBackup(candidate.dbPath, backup);
        candidate.close();
        const originalCwd = process.cwd();
        let confirmationChangedCwd = false;

        try {
            process.chdir(directoryA);
            await expect(
                runRestoreOperation(backup, {
                    dbPath: 'relative.db',
                    daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                    confirm: async () => {
                        process.chdir(directoryB);
                        confirmationChangedCwd = true;
                        return true;
                    },
                }),
            ).resolves.toMatchObject({ cancelled: false });
        } finally {
            process.chdir(originalCwd);
        }

        expect({ confirmationChangedCwd, activeA: sessionNativeIds(activeA), activeB: sessionNativeIds(activeB) }).toEqual({
            confirmationChangedCwd: true,
            activeA: ['session-candidate'],
            activeB: ['session-b-before'],
        });
    });

    it('never lets a confirmation-time managed opener acknowledge a write to the replaced inode', async () => {
        const active = createTestDb('elepha-restore-opener-race-active-');
        const candidate = createTestDb('elepha-restore-opener-race-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const openerPath = path.join(active.directory, 'active-hard-link.db');
        linkSync(active.dbPath, openerPath);
        const originalIdentity = statSync(active.dbPath);
        let opener: Database.Database | undefined;
        let writeStarted = false;
        let writeDetached: boolean | undefined;
        let laterOpenerBlocked = false;
        let intentWatcher: Promise<void> | undefined;
        let resolveWrite!: () => void;
        let rejectWrite!: (error: unknown) => void;
        const writeCompleted = new Promise<void>((resolve, reject) => {
            resolveWrite = resolve;
            rejectWrite = reject;
        });
        const writeThroughOpener = (): void => {
            if (writeStarted || opener === undefined) {
                return;
            }
            writeStarted = true;
            try {
                const result = opener.prepare("UPDATE projects SET display_name = 'acknowledged by retained opener' WHERE id = 1").run();
                expect(result.changes).toBe(1);
                const currentIdentity = statSync(active.dbPath);
                writeDetached = currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino;
                opener.close();
                opener = undefined;
                resolveWrite();
            } catch (error) {
                rejectWrite(error);
            }
        };
        const watchExclusiveIntent = async (): Promise<void> => {
            while (!writeStarted) {
                if (hasLifecycleIntent(active.dbPath)) {
                    await expect(openManagedDatabase(active.dbPath, { fileMustExist: true })).rejects.toThrow(DATABASE_LIFECYCLE_BUSY);
                    laterOpenerBlocked = true;
                    writeThroughOpener();
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
        };

        try {
            const result = await runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                confirm: async () => {
                    opener = await openManagedDatabase(openerPath, { fileMustExist: true });
                    intentWatcher = watchExclusiveIntent();
                    return true;
                },
                writeBackup: (db, dbPath) => {
                    const snapshot = writeBackup(db, dbPath);
                    setImmediate(writeThroughOpener);
                    return snapshot;
                },
            });
            await Promise.all([writeCompleted, intentWatcher]);

            expect(result.cancelled).toBe(false);
            expect(laterOpenerBlocked).toBe(true);
            expect(writeDetached).toBe(false);
            expect(sessionNativeIds(active.dbPath)).toEqual(['session-after']);
        } finally {
            opener?.close();
        }
    });

    it('keeps a killed post-install restore ambiguous until completion can be verified', async () => {
        const active = createTestDb('elepha-restore-killed-after-install-active-');
        const candidate = createTestDb('elepha-restore-killed-after-install-candidate-');
        const restoreTemp = withGrantableTestDir('elepha-restore-killed-after-install-temp-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before-kill');
        populate(candidate.dbPath, 'after-kill');
        active.db
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', 'must-stay-purged', '2026-08-02T00:00:00.000Z');
        candidate.db.exec('CREATE TABLE restore_kill_padding (bytes BLOB NOT NULL)');
        candidate.db.prepare('INSERT INTO restore_kill_padding (bytes) VALUES (zeroblob(?))').run(RESTORE_KILL_PADDING_BYTES);
        active.close();
        candidate.close();
        fullBackup(candidate.dbPath, backup);
        const originalIdentity = statSync(active.dbPath);
        const source = `const { runRestoreOperation } = await import(${JSON.stringify(restoreModule)});
await runRestoreOperation(${JSON.stringify(backup)}, {
    dbPath: ${JSON.stringify(active.dbPath)},
    daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
});`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
            cwd: repositoryRoot,
            env: { ...process.env, TMPDIR: restoreTemp },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });
        const exit = once(child, 'exit');

        try {
            const deadline = Date.now() + RESTORE_KILL_DEADLINE_MS;
            let replacementObserved = false;
            while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
                const currentIdentity = statSync(active.dbPath);
                if (currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino) {
                    replacementObserved = true;
                    child.kill('SIGKILL');
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
            expect(replacementObserved, stderr).toBe(true);
            const [, signal] = await exit;
            expect(signal).toBe('SIGKILL');

            const installedDb = new Database(active.dbPath, { readonly: true, fileMustExist: true });
            try {
                const count = installedDb
                    .prepare("SELECT COUNT(*) AS count FROM purged_transcripts WHERE tool = 'codex' AND native_id = 'must-stay-purged'")
                    .get() as { count: number };
                expect(count.count).toBe(1);
            } finally {
                installedDb.close();
            }
            await expect(
                openManagedDatabase(active.dbPath, { fileMustExist: true }).then((db) => {
                    db.close();
                }),
            ).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
        } finally {
            await killChild(child);
            removeLifecycleIntents(active.dbPath);
        }
    }, 15_000);

    it('carries active purge and incognito tombstones created after the backup and reports both counts', async () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.db
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', 'purged-post-backup', '2026-08-02T00:00:00.000Z');
        active.store.recordIncognitoTranscript('codex', 'incognito-post-backup');
        active.close();
        candidate.close();

        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message: unknown) => output.push(String(message)));
        try {
            await expect(
                runRestoreOperation(backup, {
                    dbPath: active.dbPath,
                    daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                }),
            ).resolves.toMatchObject({ cancelled: false });
        } finally {
            log.mockRestore();
        }

        const store = new MemoryStore(openUnmanagedDb(active.dbPath));
        try {
            expect(store.isTranscriptPurged('codex', 'purged-post-backup')).toBe(true);
            expect(store.isTranscriptIncognito('codex', 'incognito-post-backup')).toBe(true);
            expect(output).toContain('Carried tombstones: purged_transcripts: 2, incognito_transcripts: 1');

            const projectPath = `/Users/test/elepha-restore-${path.basename(active.directory)}`;
            store.consent.grant(projectPath);
            const codexHome = path.join(active.directory, 'codex-home');
            const sessionsRoot = path.join(codexHome, 'sessions');
            mkdirSync(sessionsRoot, { recursive: true });
            vi.stubEnv('CODEX_HOME', codexHome);
            const purgedTranscript = path.join(sessionsRoot, 'purged-post-backup.jsonl');
            const incognitoTranscript = path.join(sessionsRoot, 'incognito-post-backup.jsonl');
            writeFileSync(purgedTranscript, `${JSON.stringify({ cwd: projectPath })}\n`);
            writeFileSync(incognitoTranscript, `${JSON.stringify({ cwd: projectPath })}\n`);
            const adapter = new ReingestionProbeAdapter(projectPath);
            const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [sessionsRoot] }) as unknown as ScanFileSeam;

            await expect(daemon.scanFile(adapter, purgedTranscript, true)).resolves.toMatchObject({
                ingested: 0,
                skipped: { category: 'purged' },
            });
            await expect(daemon.scanFile(adapter, incognitoTranscript, true)).resolves.toMatchObject({
                ingested: 0,
                skipped: { category: 'incognito' },
            });
            expect(adapter.parseCalls.size).toBe(0);
        } finally {
            store.database.close();
        }
    });

    it('rejects a hostile UNIQUE index before it can drop a current purge tombstone', async () => {
        const active = createTestDb('elepha-restore-hostile-index-active-');
        const backup = path.join(active.directory, 'hostile-index.db');
        populate(active.dbPath, 'shared');
        fullBackup(active.dbPath, backup);
        const candidate = new Database(backup);
        try {
            candidate.exec('CREATE UNIQUE INDEX candidate_one_purge_per_tool ON purged_transcripts(tool)');
        } finally {
            candidate.close();
        }
        active.db
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', 'purged-post-backup', '2026-09-06T03:00:00.000Z');
        active.close();
        const activeBytes = readFileSync(active.dbPath);
        const confirmation = vi.fn(async () => true);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message: unknown) => output.push(String(message)));

        const outcome = await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            confirm: confirmation,
        }).then(
            () => ({ status: 'resolved' as const, message: undefined }),
            (error: unknown) => ({
                status: 'rejected' as const,
                message: error instanceof Error ? error.message : String(error),
            }),
        );
        log.mockRestore();
        const restored = new Database(active.dbPath, { readonly: true, fileMustExist: true });
        try {
            const tombstones = restored
                .prepare("SELECT native_id FROM purged_transcripts WHERE tool = 'codex' ORDER BY native_id")
                .pluck()
                .all();
            expect.soft(outcome.status).toBe('rejected');
            expect.soft(outcome.message).toContain('Backup schema does not match the current elepha schema after migration');
            expect.soft(confirmation).not.toHaveBeenCalled();
            expect.soft(output).not.toContain(`Restore preview: ${backup}`);
            expect.soft(readFileSync(active.dbPath)).toEqual(activeBytes);
            expect.soft(tombstones).toEqual(['purged-post-backup', 'purged-shared']);
        } finally {
            restored.close();
        }
    });

    it('rejects a noncanonical consent foreign key before preview or active mutation', async () => {
        const active = createTestDb('elepha-restore-hostile-fk-active-');
        const candidate = createTestDb('elepha-restore-hostile-fk-candidate-');
        const backup = path.join(candidate.directory, 'hostile-fk.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        candidate.db
            .prepare('INSERT INTO projects (path, first_seen_at, last_seen_at) VALUES (?, ?, ?)')
            .run(path.join(candidate.directory, 'consent-after'), '2026-09-06T03:00:00.000Z', '2026-09-06T03:00:00.000Z');
        candidate.db.exec(`
            ALTER TABLE consent_roots RENAME TO consent_roots_old;
            CREATE TABLE consent_roots (
                id INTEGER PRIMARY KEY, ulid TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL, decided_at TEXT NOT NULL, source TEXT NOT NULL, nudged_at TEXT,
                FOREIGN KEY (path) REFERENCES projects(path) ON UPDATE CASCADE
            );
            INSERT INTO consent_roots SELECT * FROM consent_roots_old;
            DROP TABLE consent_roots_old;
        `);
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const activeBytes = readFileSync(active.dbPath);
        const confirmation = vi.fn(async () => true);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message: unknown) => output.push(String(message)));

        const outcome = await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            confirm: confirmation,
        }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
        log.mockRestore();

        expect.soft(outcome).toContain('Backup schema does not match the current elepha schema after migration');
        expect.soft(confirmation).not.toHaveBeenCalled();
        expect.soft(output).not.toContain(`Restore preview: ${backup}`);
        expect.soft(readFileSync(active.dbPath)).toEqual(activeBytes);
    });

    it.each([
        ['future-only CHECK', "purged_at TEXT NOT NULL, CHECK (native_id <> 'future-purge')"],
        ['column ON CONFLICT', 'purged_at TEXT NOT NULL ON CONFLICT IGNORE'],
        ['non-key COLLATE', 'purged_at TEXT COLLATE NOCASE NOT NULL'],
    ])('rejects a noncanonical %s declaration before preview or active mutation', async (_label, finalColumn) => {
        const active = createTestDb('elepha-restore-hostile-clause-active-');
        const candidate = createTestDb('elepha-restore-hostile-clause-candidate-');
        const backup = path.join(candidate.directory, 'hostile-clause.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        candidate.db.exec(`
            ALTER TABLE purged_transcripts RENAME TO purged_transcripts_old;
            CREATE TABLE purged_transcripts (
                tool TEXT NOT NULL, native_id TEXT NOT NULL, ${finalColumn}, PRIMARY KEY (tool, native_id)
            );
            INSERT INTO purged_transcripts SELECT * FROM purged_transcripts_old;
            DROP TABLE purged_transcripts_old;
        `);
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const activeBytes = readFileSync(active.dbPath);
        const confirmation = vi.fn(async () => true);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message: unknown) => output.push(String(message)));

        const outcome = await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            confirm: confirmation,
        }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
        log.mockRestore();

        expect.soft(outcome).toContain('Backup schema does not match the current elepha schema after migration');
        expect.soft(confirmation).not.toHaveBeenCalled();
        expect.soft(output).not.toContain(`Restore preview: ${backup}`);
        expect.soft(readFileSync(active.dbPath)).toEqual(activeBytes);
    });

    it('rejects an extra-table cascade trigger before preview or active mutation', async () => {
        const active = createTestDb('elepha-restore-extra-trigger-active-');
        const candidate = createTestDb('elepha-restore-extra-trigger-candidate-');
        const backup = path.join(candidate.directory, 'extra-trigger.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        candidate.db.exec(`
            CREATE TABLE candidate_project_paths (
                path TEXT PRIMARY KEY REFERENCES projects(path) ON UPDATE CASCADE
            );
            INSERT INTO candidate_project_paths SELECT path FROM projects ORDER BY id LIMIT 1;
            CREATE TRIGGER candidate_cascade_control AFTER UPDATE ON candidate_project_paths
            BEGIN DELETE FROM purged_transcripts; END;
        `);
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const activeBytes = readFileSync(active.dbPath);
        const confirmation = vi.fn(async () => true);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message: unknown) => output.push(String(message)));

        const outcome = await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            confirm: confirmation,
        }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
        log.mockRestore();

        expect.soft(outcome).toBe(RESTORE_CONTROL_TRIGGER_ERROR);
        expect.soft(confirmation).not.toHaveBeenCalled();
        expect.soft(output).not.toContain(`Restore preview: ${backup}`);
        expect.soft(readFileSync(active.dbPath)).toEqual(activeBytes);
    });

    it('accepts ALTER-derived clause order and identifier quoting', async () => {
        const active = createTestDb('elepha-restore-clause-order-active-');
        const candidate = createTestDb('elepha-restore-clause-order-candidate-');
        const backup = path.join(candidate.directory, 'clause-order.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        candidate.db.exec(`
            ALTER TABLE purged_transcripts RENAME TO purged_transcripts_old;
            CREATE TABLE /* harmless legacy block comment: ), */ "purged_transcripts" (
                -- harmless legacy line comment: (,
                "native_id" TEXT NOT NULL, "purged_at" TEXT NOT NULL /* inline comment */, "tool" TEXT NOT NULL,
                PRIMARY KEY ("tool", "native_id")
            );
            INSERT INTO purged_transcripts (tool, native_id, purged_at)
            SELECT tool, native_id, purged_at FROM purged_transcripts_old;
            DROP TABLE purged_transcripts_old;
        `);
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            }),
        ).resolves.toMatchObject({ cancelled: false });
    });

    it('rejects the legacy sessions_old FK shape when the parent object still exists', async () => {
        const active = createTestDb('elepha-restore-legacy-fk-active-');
        const candidate = createTestDb('elepha-restore-legacy-fk-candidate-');
        const backup = path.join(candidate.directory, 'legacy-fk.db');
        populate(active.dbPath, 'before');
        replaceWithLegacySessionsTable(candidate.db);
        candidate.db.exec('CREATE TABLE sessions_old (id INTEGER PRIMARY KEY)');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const activeBytes = readFileSync(active.dbPath);
        const confirmation = vi.fn(async () => true);

        const outcome = await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            confirm: confirmation,
        }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

        expect.soft(outcome).toContain('Backup schema does not match the current elepha schema after migration');
        expect.soft(confirmation).not.toHaveBeenCalled();
        expect.soft(readFileSync(active.dbPath)).toEqual(activeBytes);
    });

    it('scrubs restored durable copies and FTS terms for active purge and incognito tombstones', async () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        const project = candidate.store.upsertProject(path.join(candidate.directory, 'durable-project'));
        for (const [nativeId, needle] of [
            ['restored-purged-copy', 'restorepurgedneedle'],
            ['restored-incognito-copy', 'restoreincognitoneedle'],
        ] as const) {
            const session = candidate.store.upsertSession(
                'codex',
                nativeId,
                project.id,
                path.join(candidate.directory, `${nativeId}.jsonl`),
            );
            candidate.store.recordTurn(
                {
                    tool: 'codex',
                    sessionId: nativeId,
                    sourcePath: session.source_path,
                    projectPath: project.path,
                    turnIndex: 0,
                    startedAt: '2026-08-01T00:00:00.000Z',
                    endedAt: '2026-08-01T00:00:01.000Z',
                    userMessage: needle,
                    assistantText: 'restored sensitive response',
                    toolCalls: [],
                    cursor: '0',
                    hasExternalContent: false,
                    resumeMarkerBefore: false,
                },
                session.id,
                project.id,
                { decisions: [], pending_items: [], status: 'ok' },
                true,
            );
        }
        fullBackup(candidate.dbPath, backup);
        active.db
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', 'restored-purged-copy', '2026-08-02T00:00:00.000Z');
        active.store.recordIncognitoTranscript('codex', 'restored-incognito-copy');
        active.close();
        candidate.close();

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            }),
        ).resolves.toMatchObject({ cancelled: false });

        const restored = openUnmanagedDb(active.dbPath);
        try {
            expect(
                restored
                    .prepare(
                        `SELECT s.native_id
                         FROM filtered_turns ft
                         JOIN memories m ON m.id = ft.memory_id
                         JOIN sessions s ON s.id = m.session_id
                         WHERE s.native_id IN ('restored-purged-copy', 'restored-incognito-copy')`,
                    )
                    .all(),
            ).toEqual([]);
            expect(
                restored.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'restorepurgedneedle'").all(),
            ).toEqual([]);
            expect(
                restored.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'restoreincognitoneedle'").all(),
            ).toEqual([]);
            expect(
                restored.prepare("SELECT native_id FROM sessions WHERE native_id LIKE 'restored-%-copy' ORDER BY native_id").all(),
            ).toEqual([{ native_id: 'restored-incognito-copy' }, { native_id: 'restored-purged-copy' }]);
            expect(
                restored
                    .prepare(
                        `SELECT COUNT(*) AS count
                         FROM memories m
                         JOIN sessions s ON s.id = m.session_id
                         WHERE s.native_id IN ('restored-purged-copy', 'restored-incognito-copy')`,
                    )
                    .get(),
            ).toEqual({ count: 2 });
        } finally {
            restored.close();
        }
    });

    it('rebuilds orphaned durable FTS postings and the forged usage singleton before installing a candidate', async () => {
        const active = createTestDb('elepha-restore-derived-active-');
        const candidate = createTestDb('elepha-restore-derived-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        const needle = 'orphanpostingneedle';
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        const project = candidate.store.upsertProject(path.join(candidate.directory, 'durable-project'));
        const session = candidate.store.upsertSession(
            'codex',
            'orphaned-index-session',
            project.id,
            path.join(candidate.directory, 'orphan.jsonl'),
        );
        const orphanTurn: ParsedTurn = {
            tool: 'codex',
            sessionId: session.native_id,
            sourcePath: session.source_path,
            projectPath: project.path,
            turnIndex: 0,
            startedAt: '2026-08-01T00:00:00.000Z',
            endedAt: '2026-08-01T00:00:01.000Z',
            userMessage: needle,
            assistantText: 'orphaned response',
            toolCalls: [],
            cursor: '0',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        };
        candidate.store.recordTurn(orphanTurn, session.id, project.id, { decisions: [], pending_items: [], status: 'ok' }, true);
        const memoryId = candidate.store.listMemoriesForSession(session.id)[0]?.id;
        if (memoryId === undefined) throw new Error('durable memory was not recorded');
        candidate.store.recordTurn(
            { ...orphanTurn, turnIndex: 1, userMessage: 'retained durable prompt', assistantText: 'retained response', cursor: '1' },
            session.id,
            project.id,
            { decisions: [], pending_items: [], status: 'ok' },
            true,
        );
        candidate.db.exec(`
            DROP TRIGGER filtered_turns_ad;
            DROP TRIGGER filtered_turns_usage_ad;
        `);
        candidate.db.prepare('DELETE FROM filtered_turns WHERE memory_id = ?').run(memoryId);
        candidate.db.prepare('UPDATE durable_capture_usage SET total_bytes = ? WHERE id = 1').run(424_242);
        candidate.db.exec('CREATE VIRTUAL TABLE temp.candidate_terms USING fts5vocab(main, filtered_turns_fts, instance)');
        expect(candidate.db.prepare('SELECT memory_id FROM filtered_turns WHERE memory_id = ?').all(memoryId)).toEqual([]);
        expect(candidate.db.prepare('SELECT term, doc FROM temp.candidate_terms WHERE term = ?').all(needle)).toEqual([
            { term: needle, doc: memoryId },
        ]);
        expect(candidate.db.prepare('SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH ?').all(needle)).toEqual([
            { rowid: memoryId },
        ]);
        expect(candidate.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get()).toEqual({ total_bytes: 424_242 });
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            }),
        ).resolves.toMatchObject({ cancelled: false });

        const restored = new Database(active.dbPath, { readonly: true, fileMustExist: true });
        try {
            restored.exec('CREATE VIRTUAL TABLE temp.restored_terms USING fts5vocab(main, filtered_turns_fts, instance)');
            const usage = restored.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get();
            const measuredUsage = restored
                .prepare(
                    `SELECT COALESCE(SUM(
                         length(CAST(user_prompt AS BLOB)) +
                         length(CAST(assistant_response AS BLOB)) +
                         length(CAST(tool_calls AS BLOB))
                     ), 0) AS total_bytes
                     FROM filtered_turns`,
                )
                .get() as { total_bytes: number };

            expect.soft(restored.prepare('SELECT term, doc FROM temp.restored_terms WHERE term = ?').all(needle)).toEqual([]);
            expect.soft(restored.prepare('SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH ?').all(needle)).toEqual([]);
            expect.soft(measuredUsage.total_bytes).toBeGreaterThan(0);
            expect.soft(usage).toEqual(measuredUsage);
        } finally {
            restored.close();
        }
    });

    it('normalizes every legacy summarizer and durable text field before installing a candidate', async () => {
        const active = createTestDb('elepha-restore-sanitize-active-');
        const candidate = createTestDb('elepha-restore-sanitize-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        const tainted = (label: string) => `${label}\n\\|| active\u0085control`;
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        const project = candidate.store.upsertProject(path.join(candidate.directory, 'sanitize-project'));
        const session = candidate.store.upsertSession(
            'codex',
            'legacy-sanitize-session',
            project.id,
            path.join(candidate.directory, 'sanitize.jsonl'),
        );
        candidate.store.recordTurn(
            {
                tool: 'codex',
                sessionId: session.native_id,
                sourcePath: session.source_path,
                projectPath: project.path,
                turnIndex: 0,
                startedAt: '2026-08-01T00:00:00.000Z',
                endedAt: '2026-08-01T00:00:01.000Z',
                userMessage: 'safe prompt',
                assistantText: 'safe response',
                toolCalls: [],
                cursor: '0',
                hasExternalContent: false,
                resumeMarkerBefore: false,
            },
            session.id,
            project.id,
            { decisions: [], pending_items: [], status: 'ok' },
            true,
        );
        const memoryId = candidate.store.listMemoriesForSession(session.id)[0]?.id;
        if (memoryId === undefined) throw new Error('durable memory was not recorded');
        candidate.db
            .prepare('UPDATE memories SET decisions = ?, pending_items = ? WHERE id = ?')
            .run(
                JSON.stringify([{ what: tainted('memory what'), why: tainted('memory why') }]),
                JSON.stringify([tainted('memory pending')]),
                memoryId,
            );
        candidate.db
            .prepare(
                `INSERT INTO session_rollups
                 (session_id, project_id, tool, title, summary, decisions, pending_items, files_touched, turn_count,
                  started_at, ended_at, kind, parent_session_id, summarizer_status, rollup_state,
                  rolled_up_through_turn_index, computed_at, rollup_version)
                 VALUES (?, ?, 'codex', ?, ?, ?, ?, '[]', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z',
                         'primary', NULL, 'ok', 'final', 0, '2026-08-01T00:00:01.000Z', 1)`,
            )
            .run(
                session.id,
                project.id,
                tainted('rollup title'),
                tainted('rollup summary'),
                JSON.stringify([{ what: tainted('rollup what'), why: tainted('rollup why') }]),
                JSON.stringify([tainted('rollup pending')]),
            );
        candidate.db.prepare('UPDATE filtered_turns SET user_prompt = ?, assistant_response = ?, tool_calls = ? WHERE memory_id = ?').run(
            tainted('filtered prompt'),
            tainted('filtered response'),
            JSON.stringify([
                {
                    name: tainted('tool name'),
                    filePaths: [tainted('tool path')],
                    legacy: { nested: tainted('nested tool value') },
                },
            ]),
            memoryId,
        );
        expect([...new Set(verifySanitize(candidate.db).map(({ table, field }) => `${table}.${field}`))].sort()).toEqual([
            'filtered_turns.assistant_response',
            'filtered_turns.tool_calls',
            'filtered_turns.user_prompt',
            'memories.decisions',
            'memories.pending_items',
            'session_rollups.decisions',
            'session_rollups.pending_items',
            'session_rollups.summary',
            'session_rollups.title',
        ]);
        fullBackup(candidate.dbPath, backup);
        const candidateBytes = readFileSync(backup);
        active.close();
        candidate.close();

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            }),
        ).resolves.toMatchObject({ cancelled: false });

        const restored = new Database(active.dbPath, { readonly: true, fileMustExist: true });
        try {
            expect.soft(verifySanitize(restored)).toEqual([]);
            expect.soft(planSanitize(restored).changes).toEqual([]);
        } finally {
            restored.close();
        }
        expect(readFileSync(backup)).toEqual(candidateBytes);
    });

    it('rejects missing, extra, and substituted durable maintenance objects with a source-owned error', () => {
        const canonical = openUnmanagedDb(':memory:');
        const mutations = [
            'DROP TRIGGER filtered_turns_usage_ai',
            'CREATE TRIGGER extra_memory_trigger AFTER UPDATE ON memories BEGIN SELECT 1; END',
            'CREATE INDEX extra_memory_index ON memories(turn_index)',
            `DROP TRIGGER filtered_turns_ai;
             CREATE TRIGGER filtered_turns_ai AFTER INSERT ON filtered_turns BEGIN SELECT 1; END`,
        ];
        try {
            for (const mutation of mutations) {
                const candidate = createTestDb('elepha-restore-durable-schema-');
                candidate.db.exec(mutation);

                expect(() => assertCanonicalDurableCaptureSchema(candidate.db, canonical)).toThrow(DURABLE_CAPTURE_SCHEMA_MISMATCH);
            }
        } finally {
            canonical.close();
        }
    });

    it('aborts before mutation when an incognito tombstone is created during confirmation', async () => {
        const active = createTestDb('elepha-restore-tombstone-race-active-');
        const candidate = createTestDb('elepha-restore-tombstone-race-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        const nativeId = 'confirmation-race-incognito';
        const needle = 'confirmationneedle';
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        const project = candidate.store.upsertProject(path.join(candidate.directory, 'durable-project'));
        const session = candidate.store.upsertSession('codex', nativeId, project.id, path.join(candidate.directory, `${nativeId}.jsonl`));
        candidate.store.recordTurn(
            {
                tool: 'codex',
                sessionId: nativeId,
                sourcePath: session.source_path,
                projectPath: project.path,
                turnIndex: 0,
                startedAt: '2026-08-01T00:00:00.000Z',
                endedAt: '2026-08-01T00:00:01.000Z',
                userMessage: needle,
                assistantText: 'must not be restored after the tombstone',
                toolCalls: [],
                cursor: '0',
                hasExternalContent: false,
                resumeMarkerBefore: false,
            },
            session.id,
            project.id,
            { decisions: [], pending_items: [], status: 'ok' },
            true,
        );
        expect(candidate.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 1 });
        expect(candidate.db.prepare('SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH ?').all(needle)).toHaveLength(1);
        expect(
            (candidate.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number })
                .total_bytes,
        ).toBeGreaterThan(0);
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();

        let markConfirmationStarted!: () => void;
        const confirmationStarted = new Promise<void>((resolve) => {
            markConfirmationStarted = resolve;
        });
        let releaseConfirmation!: () => void;
        const confirmationRelease = new Promise<void>((resolve) => {
            releaseConfirmation = resolve;
        });
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message: unknown) => output.push(String(message)));
        let previewShownWhenConfirmationStarted = false;
        const restore = runRestoreOperation(backup, {
            dbPath: active.dbPath,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            confirm: async () => {
                previewShownWhenConfirmationStarted = output.includes(`Restore preview: ${backup}`);
                markConfirmationStarted();
                await confirmationRelease;
                return true;
            },
        });

        await confirmationStarted;
        const current = new MemoryStore(openUnmanagedDb(active.dbPath));
        try {
            current.recordIncognitoTranscript('codex', nativeId);
        } finally {
            current.database.close();
        }
        const activeBytesAfterTombstone = readFileSync(active.dbPath);
        releaseConfirmation();
        const outcome = await restore.then(
            () => ({ status: 'resolved' as const, message: undefined }),
            (error: unknown) => ({
                status: 'rejected' as const,
                message: error instanceof Error ? error.message : String(error),
            }),
        );
        log.mockRestore();
        const activeBytesAfterRestore = readFileSync(active.dbPath);

        const inspected = new Database(active.dbPath, { readonly: true, fileMustExist: true });
        try {
            inspected.exec('CREATE VIRTUAL TABLE temp.confirmation_terms USING fts5vocab(main, filtered_turns_fts, instance)');
            const rows = inspected
                .prepare(
                    `SELECT s.native_id,
                            COUNT(DISTINCT m.id) AS memories,
                            COUNT(DISTINCT ft.memory_id) AS filtered_turns
                     FROM sessions s
                     LEFT JOIN memories m ON m.session_id = s.id
                     LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                     WHERE s.tool = ? AND s.native_id = ?
                     GROUP BY s.id, s.native_id`,
                )
                .all('codex', nativeId);
            const tombstones = inspected
                .prepare('SELECT tool, native_id FROM incognito_transcripts WHERE tool = ? AND native_id = ?')
                .all('codex', nativeId);
            const vocabulary = inspected.prepare('SELECT term, doc FROM temp.confirmation_terms WHERE term = ?').all(needle);
            const matches = inspected.prepare('SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH ?').all(needle);
            const usage = inspected.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get();
            const measuredUsage = inspected
                .prepare(
                    `SELECT COALESCE(SUM(
                         length(CAST(user_prompt AS BLOB)) +
                         length(CAST(assistant_response AS BLOB)) +
                         length(CAST(tool_calls AS BLOB))
                     ), 0) AS total_bytes
                     FROM filtered_turns`,
                )
                .get();

            expect.soft(outcome).toEqual({ status: 'rejected', message: RESTORE_TOMBSTONES_CHANGED_ERROR });
            expect.soft(previewShownWhenConfirmationStarted).toBe(true);
            expect.soft(activeBytesAfterRestore).toEqual(activeBytesAfterTombstone);
            expect.soft(tombstones).toEqual([{ tool: 'codex', native_id: nativeId }]);
            expect.soft(rows).toEqual([]);
            expect.soft(vocabulary).toEqual([]);
            expect.soft(matches).toEqual([]);
            expect.soft(usage).toEqual({ total_bytes: 0 });
            expect.soft(measuredUsage).toEqual({ total_bytes: 0 });
        } finally {
            inspected.close();
        }
    });

    it('aborts before mutation when approved consent is revoked during confirmation', async () => {
        const active = createTestDb('elepha-restore-consent-race-active-');
        const candidate = createTestDb('elepha-restore-consent-race-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        const consentPath = active.directory;
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        active.store.consent.grant(consentPath);
        candidate.store.consent.grant(consentPath);
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();

        let markConfirmationStarted!: () => void;
        const confirmationStarted = new Promise<void>((resolve) => {
            markConfirmationStarted = resolve;
        });
        let releaseConfirmation!: () => void;
        const confirmationRelease = new Promise<void>((resolve) => {
            releaseConfirmation = resolve;
        });
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message: unknown) => output.push(String(message)));
        let previewShownWhenConfirmationStarted = false;
        const restore = runRestoreOperation(backup, {
            dbPath: active.dbPath,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            confirm: async () => {
                previewShownWhenConfirmationStarted = output.includes(`Restore preview: ${backup}`);
                markConfirmationStarted();
                await confirmationRelease;
                return true;
            },
        });

        await confirmationStarted;
        const current = new MemoryStore(openUnmanagedDb(active.dbPath));
        try {
            current.consent.revoke(consentPath);
        } finally {
            current.database.close();
        }
        const activeBytesAfterRevoke = readFileSync(active.dbPath);
        releaseConfirmation();
        const outcome = await restore.then(
            () => ({ status: 'resolved' as const, message: undefined }),
            (error: unknown) => ({
                status: 'rejected' as const,
                message: error instanceof Error ? error.message : String(error),
            }),
        );
        log.mockRestore();

        const inspected = new MemoryStore(openUnmanagedDb(active.dbPath));
        try {
            expect.soft(outcome).toEqual({
                status: 'rejected',
                message: RESTORE_CONSENT_CHANGED_ERROR,
            });
            expect.soft(previewShownWhenConfirmationStarted).toBe(true);
            expect.soft(readFileSync(active.dbPath)).toEqual(activeBytesAfterRevoke);
            expect.soft(inspected.consent.consentState(consentPath)).toBe('denied');
            expect.soft(sessionNativeIds(active.dbPath)).toEqual(['session-before']);
        } finally {
            inspected.database.close();
        }
    });

    it('overlays exact current consent without deleting durable rows for a revoked root', async () => {
        const active = createTestDb('elepha-restore-consent-overlay-active-');
        const candidate = createTestDb('elepha-restore-consent-overlay-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        const consentPath = active.directory;
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        active.store.consent.revoke(consentPath);
        candidate.store.consent.grant(consentPath);
        const project = candidate.store.upsertProject(consentPath);
        const nativeId = 'revoked-root-durable-copy';
        const session = candidate.store.upsertSession('codex', nativeId, project.id, path.join(candidate.directory, `${nativeId}.jsonl`));
        candidate.store.recordTurn(
            {
                tool: 'codex',
                sessionId: nativeId,
                sourcePath: session.source_path,
                projectPath: project.path,
                turnIndex: 0,
                startedAt: '2026-08-01T00:00:00.000Z',
                endedAt: '2026-08-01T00:00:01.000Z',
                userMessage: 'retained while revoked',
                assistantText: 'durable response',
                toolCalls: [],
                cursor: '0',
                hasExternalContent: false,
                resumeMarkerBefore: false,
            },
            session.id,
            project.id,
            { decisions: [], pending_items: [], status: 'ok' },
            true,
        );
        const expectedConsent = consentRows(active.dbPath);
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            }),
        ).resolves.toMatchObject({ cancelled: false });

        const restored = new MemoryStore(openUnmanagedDb(active.dbPath));
        try {
            expect(consentRows(active.dbPath)).toEqual(expectedConsent);
            expect(restored.consent.consentState(consentPath)).toBe('denied');
            expect(
                restored.database
                    .prepare(
                        `SELECT COUNT(*) AS count
                         FROM filtered_turns ft
                         JOIN memories m ON m.id = ft.memory_id
                         JOIN sessions s ON s.id = m.session_id
                         WHERE s.tool = ? AND s.native_id = ?`,
                    )
                    .get('codex', nativeId),
            ).toEqual({ count: 1 });
        } finally {
            restored.database.close();
        }
    });

    it('rejects an indirect control trigger before a later first-prompt skip write can fire it', async () => {
        const active = createTestDb('elepha-restore-indirect-trigger-active-');
        const candidate = createTestDb('elepha-restore-indirect-trigger-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        active.db.exec("INSERT INTO incognito_transcripts VALUES ('codex', 'incognito-before', '2026-09-06T00:00:00.000Z')");
        candidate.db.exec(`
            CREATE TRIGGER candidate_indirect_control_mutation
            AFTER INSERT ON first_prompt_search_backfill_skips
            BEGIN
              DELETE FROM purged_transcripts;
              DELETE FROM incognito_transcripts;
              DELETE FROM consent_roots;
              INSERT INTO consent_roots VALUES
                (NULL, 'evil-ulid', '/tmp/expanded', 'approved', '2026-09-06T00:00:00.000Z', 'cli', NULL);
            END;
        `);
        fullBackup(candidate.dbPath, backup);
        const expectedConsent = consentRows(active.dbPath);
        active.close();
        candidate.close();
        const outcome = await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
        }).catch((caught: unknown) => (caught instanceof Error ? caught.message : String(caught)));
        const restored = openUnmanagedDb(active.dbPath);
        try {
            restored
                .prepare(
                    "INSERT INTO first_prompt_search_backfill_skips SELECT id, '2026-09-06T00:01:00.000Z' FROM sessions ORDER BY id LIMIT 1",
                )
                .run();
            expect.soft(outcome).toBe(RESTORE_CONTROL_TRIGGER_ERROR);
            expect.soft(consentRows(active.dbPath)).toEqual(expectedConsent);
            expect.soft(restored.prepare('SELECT COUNT(*) FROM purged_transcripts').pluck().get()).toBe(1);
            expect.soft(restored.prepare('SELECT COUNT(*) FROM incognito_transcripts').pluck().get()).toBe(1);
        } finally {
            restored.close();
        }
    });

    it.each([
        ['consent_roots', RESTORE_CONSENT_TRIGGER_ERROR],
        ['purged_transcripts', RESTORE_CONTROL_TRIGGER_ERROR],
        ['incognito_transcripts', RESTORE_CONTROL_TRIGGER_ERROR],
        ['paranoid_authority', RESTORE_CONTROL_TRIGGER_ERROR],
        ['injections', RESTORE_CONTROL_TRIGGER_ERROR],
        ['durable_capture_status', RESTORE_CONTROL_TRIGGER_ERROR],
        ['projects', RESTORE_CONTROL_TRIGGER_ERROR],
        ['sessions', RESTORE_CONTROL_TRIGGER_ERROR],
        ['first_prompt_search_backfill_skips', RESTORE_CONTROL_TRIGGER_ERROR],
        ['meta', RESTORE_CONTROL_TRIGGER_ERROR],
        ['shown_session_lists', RESTORE_CONTROL_TRIGGER_ERROR],
    ])('rejects a candidate trigger targeting %s before preview or active mutation', async (triggerTable, expectedError) => {
        const active = createTestDb('elepha-restore-consent-trigger-active-');
        const candidate = createTestDb('elepha-restore-consent-trigger-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        const consentPath = active.directory;
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        active.store.consent.revoke(consentPath);
        candidate.store.consent.grant(consentPath);
        candidate.db.exec(`
            CREATE TRIGGER candidate_consent_expand
            AFTER INSERT ON "${triggerTable}"
            BEGIN
              INSERT OR IGNORE INTO consent_roots
              VALUES (NULL, 'evil-ulid', '/tmp/expanded', 'approved', '2026-09-06T00:00:00.000Z', 'cli', NULL);
            END;
        `);
        fullBackup(candidate.dbPath, backup);
        const expectedConsent = consentRows(active.dbPath);
        active.close();
        candidate.close();
        const activeBytes = readFileSync(active.dbPath);
        const confirmation = vi.fn(async () => true);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message: unknown) => output.push(String(message)));

        const outcome = await runRestoreOperation(backup, {
            dbPath: active.dbPath,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            confirm: confirmation,
        }).then(
            () => ({ status: 'resolved' as const, message: undefined }),
            (error: unknown) => ({
                status: 'rejected' as const,
                message: error instanceof Error ? error.message : String(error),
            }),
        );
        log.mockRestore();

        expect.soft(outcome).toEqual({
            status: 'rejected',
            message: expectedError,
        });
        expect.soft(confirmation).not.toHaveBeenCalled();
        expect.soft(output).not.toContain(`Restore preview: ${backup}`);
        expect.soft(readFileSync(active.dbPath)).toEqual(activeBytes);
        expect.soft(consentRows(active.dbPath)).toEqual(expectedConsent);
        expect.soft(sessionNativeIds(active.dbPath)).toEqual(['session-before']);
        expect.soft(consentRows(active.dbPath)).not.toContainEqual(expect.objectContaining({ path: '/tmp/expanded', state: 'approved' }));
    });

    it.each([
        { mutation: 'grant', initialState: 'denied' as const },
        { mutation: 'identity substitution', initialState: 'approved' as const },
    ])('invalidates the consent preview after concurrent $mutation', async ({ mutation, initialState }) => {
        const active = createTestDb('elepha-restore-consent-change-active-');
        const candidate = createTestDb('elepha-restore-consent-change-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        const consentPath = active.directory;
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        if (initialState === 'approved') {
            active.store.consent.grant(consentPath);
        } else {
            active.store.consent.revoke(consentPath);
        }
        candidate.store.consent.grant(consentPath);
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                confirm: async () => {
                    const current = new MemoryStore(openUnmanagedDb(active.dbPath));
                    try {
                        if (mutation === 'grant') {
                            current.consent.grant(consentPath);
                        } else {
                            current.database
                                .prepare('UPDATE consent_roots SET ulid = ? WHERE path = ?')
                                .run('01JCONSENTSUBSTITUTION00000', consentPath);
                        }
                    } finally {
                        current.database.close();
                    }
                    return true;
                },
            }),
        ).rejects.toThrow(RESTORE_CONSENT_CHANGED_ERROR);

        expect(sessionNativeIds(active.dbPath)).toEqual(['session-before']);
        const current = new MemoryStore(openUnmanagedDb(active.dbPath));
        try {
            expect(current.consent.consentState(consentPath)).toBe(mutation === 'grant' ? 'approved' : initialState);
        } finally {
            current.database.close();
        }
    });

    it('unions active incognito vetoes into a restored backup that predates the tombstone table', async () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
        const backup = path.join(candidate.directory, 'pre-d90.db');
        populate(active.dbPath, 'before');
        active.store.recordIncognitoTranscript('codex', 'active-veto');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const legacyBackup = new Database(backup);
        try {
            legacyBackup.exec('DROP TABLE incognito_transcripts');
        } finally {
            legacyBackup.close();
        }

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            }),
        ).resolves.toMatchObject({ cancelled: false });

        const store = new MemoryStore(openUnmanagedDb(active.dbPath));
        try {
            const projectPath = `/Users/test/elepha-restore-${path.basename(active.directory)}`;
            store.consent.grant(projectPath);
            const codexHome = path.join(active.directory, 'codex-home');
            const sessionsRoot = path.join(codexHome, 'sessions');
            mkdirSync(sessionsRoot, { recursive: true });
            vi.stubEnv('CODEX_HOME', codexHome);
            const transcript = path.join(sessionsRoot, 'active-veto.jsonl');
            writeFileSync(transcript, `${JSON.stringify({ cwd: projectPath })}\n`);
            const adapter = new ReingestionProbeAdapter(projectPath);
            const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [sessionsRoot] }) as unknown as ScanFileSeam;

            expect(store.isTranscriptIncognito('codex', 'active-veto')).toBe(true);
            await expect(daemon.scanFile(adapter, transcript, true)).resolves.toMatchObject({
                ingested: 0,
                skipped: { category: 'incognito' },
            });
            expect(adapter.parseCalls.get('active-veto')).toBeUndefined();
            expect(store.findSession('codex', 'active-veto')).toBeUndefined();
        } finally {
            store.database.close();
        }
    });

    it('refuses a project export with the import direction and leaves the active database byte-for-byte unchanged', () => {
        const active = createTestDb('elepha-restore-active-');
        const source = createTestDb('elepha-restore-project-');
        populate(active.dbPath, 'before');
        const project = seedProject(source, { path: path.join(source.directory, 'project') });
        const session = seedSession(source, { project, nativeId: 'project-export' });
        seedMemory(source, { project, session });
        seedRollup(source, { project, session });
        const resolution = new ProjectResolver(source.db).resolve(project.path);
        if (!('project' in resolution) || resolution.project === null) throw new Error('project did not resolve');
        const partial = path.join(source.directory, 'project.db');
        source.db.pragma('wal_checkpoint(TRUNCATE)');
        copyFileSync(source.dbPath, partial);
        const partialDb = new Database(partial);
        try {
            for (const table of REQUIRED_RESTORE_TABLES.filter(
                (table) => !['projects', 'sessions', 'memories', 'session_rollups'].includes(table),
            )) {
                partialDb.exec(`DROP TABLE "${table}"`);
            }
        } finally {
            partialDb.close();
        }
        active.close();
        source.close();
        const before = readFileSync(active.dbPath);

        const result = runRestoreCli(active.dbPath, partial, '--skip-confirmation');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('elepha import');
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
    }, 15000);

    it('rejects a backup with a required-table column that migrations cannot repair before replacing the active database', () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        removeConsentRootUlid(backup);
        const before = readFileSync(active.dbPath);

        const result = runRestoreCli(active.dbPath, backup, '--skip-confirmation');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Backup schema does not match the current elepha schema after migration');
        expect(result.stderr).toContain('consent_roots: missing column(s): ulid');
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
    }, 15000);

    it('reports a missing backup as not found instead of invalid SQLite', async () => {
        const active = createTestDb('elepha-restore-active-');
        const missing = path.join(active.directory, 'missing.db');
        active.close();

        const error = await runRestoreOperation(missing, {
            dbPath: active.dbPath,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
        }).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('not found');
        expect((error as Error).message).not.toContain('valid SQLite backup');
    });

    it('refuses a non-SQLite candidate without touching the active database', () => {
        const active = createTestDb('elepha-restore-active-');
        populate(active.dbPath, 'before');
        active.close();
        const before = readFileSync(active.dbPath);
        const invalid = path.join(active.directory, 'not-a-database.txt');
        writeFileSync(invalid, 'not sqlite');
        const restoreTemp = isolateRestoreTemp();

        const result = runRestoreCli(active.dbPath, invalid, '--skip-confirmation');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Not a valid SQLite backup');
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(stagedRestoreDirectories(restoreTemp)).toEqual([]);
    }, 15000);

    it('refuses a live daemon before taking a snapshot or replacing the active database', async () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const before = readFileSync(active.dbPath);

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'RUNNING (pid 1, heartbeat 0s ago)', healthy: true }),
            }),
        ).rejects.toThrow('elepha pause');
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
    });

    it('rechecks daemon state under exclusive intent after confirmation', async () => {
        const active = createTestDb('elepha-restore-daemon-confirmation-active-');
        const candidate = createTestDb('elepha-restore-daemon-confirmation-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const before = readFileSync(active.dbPath);
        let healthChecks = 0;

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () =>
                    healthChecks++ === 0
                        ? { state: 'NOT RUNNING', healthy: false }
                        : { state: 'RUNNING (pid 1, heartbeat 0s ago)', healthy: true },
                confirm: async () => true,
            }),
        ).rejects.toThrow('elepha pause');

        expect(healthChecks).toBe(2);
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(hasLifecycleIntent(active.dbPath)).toBe(false);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
    });

    it('cancels before snapshot/replacement and restores with --skip-confirmation without calling a prompt', async () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const before = readFileSync(active.dbPath);
        const activeCounts = counts(active.dbPath);
        const candidateCounts = counts(backup);

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                confirm: async () => false,
            }),
        ).resolves.toEqual({ cancelled: true });
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);

        const restored = runRestoreCli(active.dbPath, backup, '--skip-confirmation');
        expect(restored.status, restored.stderr).toBe(0);
        expect(restored.stdout).not.toContain('Replace the current elepha database');
        expect(counts(active.dbPath)).toEqual({
            ...candidateCounts,
            purged_transcripts: candidateCounts.purged_transcripts + activeCounts.purged_transcripts,
        });
    }, 15000);

    it('rolls the active database back to its pre-restore bytes when post-swap verification fails', async () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const before = readFileSync(active.dbPath);
        const restoreTemp = isolateRestoreTemp();
        let snapshotPath: string | undefined;
        let blockedOpenerCheck: Promise<void> | undefined;

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                writeBackup: (db, dbPath) => {
                    expect(hasLifecycleIntent(dbPath)).toBe(true);
                    blockedOpenerCheck = expect(openManagedDatabase(dbPath, { fileMustExist: true })).rejects.toThrow(
                        DATABASE_LIFECYCLE_BUSY,
                    );
                    snapshotPath = writeBackup(db, dbPath);
                    const stagedDirectories = stagedRestoreDirectories(restoreTemp);
                    expect(stagedDirectories).toHaveLength(1);
                    writeFileSync(path.join(restoreTemp, stagedDirectories[0]!, 'candidate.db'), 'changed after validation');
                    return snapshotPath;
                },
            }),
        ).rejects.toThrow('Installed database hash does not match the validated backup');

        await blockedOpenerCheck;
        expect(snapshotPath).toBeDefined();
        expect(existsSync(snapshotPath!)).toBe(true);
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(hasLifecycleIntent(active.dbPath)).toBe(false);
        expect(stagedRestoreDirectories(restoreTemp)).toEqual([]);
    });

    it('cleans the exact randomized install temporary when destination rename fails', async () => {
        const active = createTestDb('elepha-restore-rename-failure-active-');
        const candidate = createTestDb('elepha-restore-rename-failure-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const activeBytes = readFileSync(active.dbPath);
        const backupBytes = readFileSync(backup);
        const restoreTemp = isolateRestoreTemp();
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalRenameSync = mutableFs.renameSync;
        const primaryError = new Error('injected restore destination rename failure') as NodeJS.ErrnoException;
        primaryError.code = 'EISDIR';
        let exactTemporary: string | undefined;
        mutableFs.renameSync = ((oldPath, newPath) => {
            const oldName = String(oldPath);
            if (
                exactTemporary === undefined &&
                String(newPath) === active.dbPath &&
                oldName.startsWith(`${active.dbPath}.${process.pid}.`) &&
                oldName.endsWith('.tmp')
            ) {
                exactTemporary = oldName;
                for (const suffix of ['-wal', '-shm', '-journal']) {
                    writeFileSync(`${exactTemporary}${suffix}`, `temporary ${suffix}`);
                }
                throw primaryError;
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof import('node:fs').renameSync;
        syncBuiltinESMExports();

        let caught: unknown;
        try {
            await runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            });
        } catch (error) {
            caught = error;
        } finally {
            mutableFs.renameSync = originalRenameSync;
            syncBuiltinESMExports();
        }

        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain('Restore failed and the previous database was rolled back from');
        expect((caught as Error).message).toContain(primaryError.message);
        expect(exactTemporary?.startsWith(`${active.dbPath}.${process.pid}.`)).toBe(true);
        expect(exactTemporary?.endsWith('.tmp')).toBe(true);
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
            expect(existsSync(`${exactTemporary}${suffix}`)).toBe(false);
        }
        expect(readFileSync(active.dbPath)).toEqual(activeBytes);
        expect(statSync(active.dbPath).mode & 0o777).toBe(0o600);
        expect(readFileSync(backup)).toEqual(backupBytes);
        expect(sessionNativeIds(active.dbPath)).toEqual(['session-before']);
        expect(hasLifecycleIntent(active.dbPath)).toBe(false);
        expect(stagedRestoreDirectories(restoreTemp)).toEqual([]);
    });

    it('cleans and verifies the lifecycle-owned physical companions before releasing rollback ownership', async () => {
        const active = createTestDb('elepha-restore-physical-rollback-active-');
        const candidate = createTestDb('elepha-restore-physical-rollback-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        const activeAlias = path.join(active.directory, 'active-link.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        symlinkSync(active.dbPath, activeAlias);
        const physicalWal = `${active.dbPath}-wal`;
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalUnlinkSync = mutableFs.unlinkSync;
        let physicalCompanionRecreated = false;
        let ownershipHeldDuringFault = false;
        mutableFs.unlinkSync = ((file) => {
            if (String(file) === physicalWal && !physicalCompanionRecreated) {
                try {
                    originalUnlinkSync(file);
                } catch (error: unknown) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw error;
                    }
                }
                writeFileSync(physicalWal, 'recreated during cleanup');
                physicalCompanionRecreated = true;
                ownershipHeldDuringFault = hasLifecycleIntent(activeAlias);
                return;
            }
            return originalUnlinkSync(file);
        }) as typeof import('node:fs').unlinkSync;
        syncBuiltinESMExports();

        try {
            await expect(
                runRestoreOperation(backup, {
                    dbPath: activeAlias,
                    daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                }),
            ).rejects.toThrow('managed database companion remained after cleanup');
        } finally {
            mutableFs.unlinkSync = originalUnlinkSync;
            syncBuiltinESMExports();
        }

        expect(physicalCompanionRecreated).toBe(true);
        expect(ownershipHeldDuringFault).toBe(true);
        for (const databasePath of [activeAlias, active.dbPath]) {
            for (const suffix of ['-wal', '-shm', '-journal']) {
                expect(existsSync(`${databasePath}${suffix}`)).toBe(false);
            }
        }
        expect(hasLifecycleIntent(activeAlias)).toBe(false);
        expect(sessionNativeIds(active.dbPath)).toEqual(['session-before']);
        await expect(openManagedDatabase(activeAlias, { fileMustExist: true }).then((database) => database.close())).resolves.toBeDefined();
    });

    it('rolls back while retaining exclusive ownership when install reports an error after replacement', async () => {
        const active = createTestDb('elepha-restore-post-rename-error-active-');
        const candidate = createTestDb('elepha-restore-post-rename-error-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const originalIdentity = statSync(active.dbPath);
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalChmodSync = mutableFs.chmodSync;
        let errorInjectedAfterReplacement = false;
        mutableFs.chmodSync = ((file, mode) => {
            if (file === active.dbPath && !errorInjectedAfterReplacement) {
                const currentIdentity = statSync(active.dbPath);
                if (currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino) {
                    errorInjectedAfterReplacement = true;
                    const error = new Error('simulated post-replacement chmod failure') as NodeJS.ErrnoException;
                    error.code = 'EIO';
                    throw error;
                }
            }
            return originalChmodSync(file, mode);
        }) as typeof import('node:fs').chmodSync;
        syncBuiltinESMExports();

        try {
            await expect(
                runRestoreOperation(backup, {
                    dbPath: active.dbPath,
                    daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                }),
            ).rejects.toThrow('simulated post-replacement chmod failure');
        } finally {
            mutableFs.chmodSync = originalChmodSync;
            syncBuiltinESMExports();
        }

        expect(errorInjectedAfterReplacement).toBe(true);
        expect(sessionNativeIds(active.dbPath)).toEqual(['session-before']);
        expect(hasLifecycleIntent(active.dbPath)).toBe(false);
    });

    it('does not roll back through a post-install connection whose close is unproven', async () => {
        const active = createTestDb('elepha-restore-verification-close-failure-active-');
        const candidate = createTestDb('elepha-restore-verification-close-failure-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const originalClose = Database.prototype.close;
        let closeFailureInjected = false;
        let failedDatabase: Database.Database | undefined;
        Database.prototype.close = function () {
            const main = (this.pragma('database_list') as Array<{ seq: number; file: string }>).find((entry) => entry.seq === 0);
            const installedCandidate =
                main !== undefined &&
                path.resolve(main.file) === path.resolve(active.dbPath) &&
                this.prepare("SELECT 1 FROM sessions WHERE native_id = 'session-after'").get() !== undefined;
            if (!closeFailureInjected && installedCandidate) {
                closeFailureInjected = true;
                failedDatabase = this;
                throw new Error('simulated post-install SQLite close failure');
            }
            return originalClose.call(this);
        };

        try {
            await expect(
                runRestoreOperation(backup, {
                    dbPath: active.dbPath,
                    daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                }),
            ).rejects.toThrow('managed database connections remain open');

            expect(closeFailureInjected).toBe(true);
            expect(sessionNativeIds(active.dbPath)).toEqual(['session-after']);
            expect(hasLifecycleIntent(active.dbPath)).toBe(true);
            await expect(openManagedDatabase(active.dbPath, { fileMustExist: true })).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
        } finally {
            Database.prototype.close = originalClose;
            if (failedDatabase?.open) {
                failedDatabase.close();
            }
            removeLifecycleIntents(active.dbPath);
        }
    });

    it('leaves failed rollback ownership durable so unverified bytes cannot be reopened', async () => {
        const active = createTestDb('elepha-restore-rollback-copy-error-active-');
        const candidate = createTestDb('elepha-restore-rollback-copy-error-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const restoreTemp = isolateRestoreTemp();
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalCopyFileSync = mutableFs.copyFileSync;
        let rollbackFailureInjected = false;
        mutableFs.copyFileSync = ((source, destination, mode) => {
            if (String(source).includes('.bak-')) {
                rollbackFailureInjected = true;
                const error = new Error('simulated rollback copy failure') as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
            }
            return originalCopyFileSync(source, destination, mode);
        }) as typeof import('node:fs').copyFileSync;
        syncBuiltinESMExports();

        try {
            await expect(
                runRestoreOperation(backup, {
                    dbPath: active.dbPath,
                    daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                    writeBackup: (db, dbPath) => {
                        const snapshot = writeBackup(db, dbPath);
                        const stagedDirectories = stagedRestoreDirectories(restoreTemp);
                        writeFileSync(path.join(restoreTemp, stagedDirectories[0]!, 'candidate.db'), 'changed after validation');
                        return snapshot;
                    },
                }),
            ).rejects.toThrow('simulated rollback copy failure');
        } finally {
            mutableFs.copyFileSync = originalCopyFileSync;
            syncBuiltinESMExports();
        }

        expect(rollbackFailureInjected).toBe(true);
        expect(hasLifecycleIntent(active.dbPath)).toBe(true);
        await expect(openManagedDatabase(active.dbPath, { fileMustExist: true }).then((database) => database.close())).rejects.toThrow(
            DATABASE_LIFECYCLE_AMBIGUOUS,
        );

        removeLifecycleIntents(active.dbPath);
    });

    it('accepts a legacy-minimum backup and migrates its durable schema without changing the source', async () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
        const backup = path.join(candidate.directory, 'legacy-minimum.db');
        populate(active.dbPath, 'before');
        candidate.db
            .prepare('INSERT INTO projects (path, first_seen_at, last_seen_at) VALUES (?, ?, ?)')
            .run(path.join(candidate.directory, 'legacy-project'), '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
        candidate.db
            .prepare(
                'INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(
                'codex',
                'legacy-session',
                1,
                path.join(candidate.directory, 'legacy.jsonl'),
                '2026-08-01T00:00:00.000Z',
                '2026-08-01T00:00:00.000Z',
            );
        replaceWithLegacySessionsTable(candidate.db);
        candidate.db.exec(`
            DROP TABLE filtered_turns_fts;
            DROP TABLE filtered_turns;
            DROP TABLE durable_capture_status;
            DROP TABLE durable_capture_usage;
        `);
        expect(
            candidate.db
                .prepare(
                    `SELECT name FROM sqlite_master
                     WHERE lower(name) GLOB 'filtered_turns*'
                        OR lower(name) GLOB 'durable_capture*'
                        OR lower(tbl_name) = 'filtered_turns'`,
                )
                .all(),
        ).toEqual([]);
        active.close();
        candidate.db.pragma('wal_checkpoint(TRUNCATE)');
        candidate.close();
        copyFileSync(candidate.dbPath, backup);
        const legacyBytes = readFileSync(backup);

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            }),
        ).resolves.toMatchObject({ cancelled: false });
        expect(sessionNativeIds(active.dbPath)).toEqual(['legacy-session']);
        const restored = new Database(active.dbPath, { readonly: true, fileMustExist: true });
        const canonical = openUnmanagedDb(':memory:');
        try {
            expect((restored.pragma('table_info(sessions)') as Array<{ name: string }>).map((column) => column.name)).toContain(
                'segment_index',
            );
            expect(() => assertCanonicalDurableCaptureSchema(restored, canonical)).not.toThrow();
            expect(restored.prepare('SELECT id, total_bytes FROM durable_capture_usage').all()).toEqual([{ id: 1, total_bytes: 0 }]);
        } finally {
            canonical.close();
            restored.close();
        }
        expect(readFileSync(backup)).toEqual(legacyBytes);
    });

    it('composes encrypted restore, current authority, inert capture, terminal eviction, and reopen', async () => {
        const active = createTestDb('elepha-integrated-restore-active-');
        const candidate = createTestDb('elepha-integrated-restore-candidate-');
        const codexHome = path.join(active.directory, 'codex-home');
        const sessionsRoot = path.join(codexHome, 'sessions');
        const restoreProjectPath = path.join(active.directory, 'restore-project');
        const purgeProjectPath = path.join(active.directory, 'purge-project');
        const liveProjectPath = path.join(active.directory, 'live-project');
        mkdirSync(sessionsRoot, { recursive: true });
        mkdirSync(restoreProjectPath, { recursive: true });
        mkdirSync(purgeProjectPath, { recursive: true });
        mkdirSync(liveProjectPath, { recursive: true });
        vi.stubEnv('CODEX_HOME', codexHome);

        const sourceFor = (nativeId: string): string => {
            const sourcePath = path.join(sessionsRoot, `${nativeId}.jsonl`);
            writeFileSync(sourcePath, '{}\n');
            return sourcePath;
        };
        const turn = (
            nativeId: string,
            sourcePath: string,
            projectPath: string,
            turnIndex: number,
            userMessage: string,
            assistantText: string,
        ): ParsedTurn => ({
            tool: 'codex',
            sessionId: nativeId,
            sourcePath,
            projectPath,
            turnIndex,
            startedAt: `2026-09-06T10:0${turnIndex}:00.000Z`,
            endedAt: `2026-09-06T10:0${turnIndex}:01.000Z`,
            userMessage,
            assistantText,
            toolCalls: [{ name: `\n&& hostile-tool-${turnIndex}\u009b`, filePaths: [path.join(projectPath, `file-${turnIndex}.ts`)] }],
            cursor: `${turnIndex + 1}`,
            hasExternalContent: false,
            resumeMarkerBefore: false,
        });
        const adapterForTurns = (turns: ParsedTurn[]): SessionAdapter => ({
            tool: 'codex',
            watchGlobs: ['*.jsonl'],
            matches: () => true,
            nativeSessionId: (filePath) => path.basename(filePath, '.jsonl'),
            classifySession: async () => ({ kind: 'primary' }),
            classifyEmptySession: async () => undefined,
            async *parseTurns() {
                for (const parsed of turns) yield parsed;
            },
        });
        type IntegratedDaemon = {
            persistTurn(adapter: SessionAdapter, parsed: ParsedTurn): Promise<boolean>;
            backfillDurableCapture(): Promise<void>;
        };
        const daemonWith = (store: MemoryStore, adapter: SessionAdapter, maxBytes: number): IntegratedDaemon =>
            new IngestionDaemon({
                store,
                adapters: [adapter],
                watchRoots: [],
                readConfig: () => ({
                    config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true, durableCaptureMaxBytes: maxBytes },
                }),
            }) as unknown as IntegratedDaemon;

        const activeRestoreProject = seedProject(active, { path: restoreProjectPath });
        const activeTerminal = seedSession(active, {
            project: activeRestoreProject,
            nativeId: 'terminal-eviction',
            sourcePath: sourceFor('terminal-eviction'),
        });
        seedMemory(active, { project: activeRestoreProject, session: activeTerminal });
        active.store.consent.grant(restoreProjectPath);
        const activePurgeProject = seedProject(active, { path: purgeProjectPath });
        const activePurge = seedSession(active, {
            project: activePurgeProject,
            nativeId: 'purged-session',
            sourcePath: sourceFor('purged-session'),
        });
        seedMemory(active, { project: activePurgeProject, session: activePurge });

        const candidateRestoreProject = seedProject(candidate, { path: restoreProjectPath });
        const candidatePurgeProject = seedProject(candidate, { path: purgeProjectPath });
        candidate.store.consent.grant(restoreProjectPath);
        const legacySource = sourceFor('legacy-tainted-session');
        const candidateLegacy = seedSession(candidate, {
            project: candidateRestoreProject,
            nativeId: 'legacy-tainted-session',
            sourcePath: legacySource,
        });
        const legacyMemory = seedMemory(candidate, { project: candidateRestoreProject, session: candidateLegacy });
        const candidateTerminal = seedSession(candidate, {
            project: candidateRestoreProject,
            nativeId: activeTerminal.native_id,
            sourcePath: activeTerminal.source_path,
        });
        const terminalMemory = seedMemory(candidate, { project: candidateRestoreProject, session: candidateTerminal });
        const candidatePurge = seedSession(candidate, {
            project: candidatePurgeProject,
            nativeId: activePurge.native_id,
            sourcePath: activePurge.source_path,
        });
        const purgeMemory = seedMemory(candidate, { project: candidatePurgeProject, session: candidatePurge });
        const candidateIncognito = seedSession(candidate, {
            project: candidateRestoreProject,
            nativeId: 'incognito-session',
            sourcePath: sourceFor('incognito-session'),
        });
        const incognitoMemory = seedMemory(candidate, { project: candidateRestoreProject, session: candidateIncognito });
        const candidateOrphan = seedSession(candidate, {
            project: candidateRestoreProject,
            nativeId: 'orphaned-index-session',
            sourcePath: sourceFor('orphaned-index-session'),
        });
        const orphanMemory = seedMemory(candidate, { project: candidateRestoreProject, session: candidateOrphan });
        const legacyTaint = `\n|| legacytaintneedle \u0085\u009b`;
        const insertFiltered = candidate.db.prepare(
            `INSERT INTO filtered_turns
             (memory_id, included, user_prompt, assistant_response, tool_calls, omitted_tool_call_count,
              dropped_tool_ref_count, omitted_before_chars, filter_version, captured_at)
             VALUES (?, 1, ?, ?, ?, 0, 0, 0, ?, '2026-09-01T00:00:00.000Z')`,
        );
        insertFiltered.run(legacyMemory.id, legacyTaint, `\t&& legacy-response\u009f`, JSON.stringify([{ name: legacyTaint }]), 1);
        insertFiltered.run(terminalMemory.id, 'terminalresurrectionneedle', '', '[]', 1);
        insertFiltered.run(purgeMemory.id, 'purgeresurrectionneedle', '', '[]', 1);
        insertFiltered.run(incognitoMemory.id, 'incognitoresurrectionneedle', '', '[]', 1);
        insertFiltered.run(orphanMemory.id, 'staleorphanneedle', '', '[]', 1);
        candidate.db
            .prepare('UPDATE memories SET decisions = ?, pending_items = ? WHERE id = ?')
            .run(JSON.stringify([{ what: legacyTaint, why: `\t&& legacy-why\u0080` }]), JSON.stringify([legacyTaint]), legacyMemory.id);
        candidate.db
            .prepare(
                `INSERT INTO durable_capture_status (session_id, state, filter_version, updated_at)
                 VALUES (?, 'complete', ?, '2026-09-01T00:00:00.000Z')`,
            )
            .run(candidateTerminal.id, DURABLE_CAPTURE_FILTER_VERSION);
        candidate.store.recordInjection({
            tool: 'codex',
            nativeSessionId: 'hook-quote-session',
            injectedAt: '2026-09-01T00:00:00.000Z',
            injectionId: 'forged-candidate-injection',
            body: 'forged candidate hook output',
        });
        candidate.db.prepare("INSERT INTO purged_transcripts VALUES ('codex', 'candidate-old-purge', '2026-09-01T00:00:00.000Z')").run();
        candidate.db
            .prepare("INSERT INTO incognito_transcripts VALUES ('codex', 'candidate-old-incognito', '2026-09-01T00:00:00.000Z')")
            .run();
        candidate.db
            .prepare(
                "UPDATE paranoid_authority SET enrolled = 1, state = 'locked', generation = 1, credential_tag = 'forged-candidate-gate' WHERE id = 1",
            )
            .run();
        candidate.db.pragma('wal_checkpoint(TRUNCATE)');
        candidate.close();
        const stale = new Database(candidate.dbPath);
        stale.exec(`
            DROP TRIGGER filtered_turns_ad;
            DROP TRIGGER filtered_turns_usage_ad;
            DELETE FROM filtered_turns WHERE memory_id = ${orphanMemory.id};
            UPDATE durable_capture_usage SET total_bytes = 424242 WHERE id = 1;
        `);
        stale.close();
        const recreateMaintenance = openUnmanagedDb(candidate.dbPath);
        recreateMaintenance.close();
        const candidateBytes = readFileSync(candidate.dbPath);
        expect(candidateBytes.subarray(0, 16).toString('binary')).toBe('SQLite format 3\0');

        active.db.pragma('wal_checkpoint(TRUNCATE)');
        active.close();
        const encryption = encryptionRuntime();
        await encryptDatabase(active.dbPath, encryption);
        const gated = await openDb(active.dbPath, { encryption });
        enableParanoidMode(gated, 'active restore passphrase');
        expect(lockMemory(gated)).toBe('locked');
        expect(isMemoryLocked(gated)).toBe(true);
        expect(unlockMemory(gated, 'active restore passphrase')).toBe('unlocked');
        gated.close();
        const metadataBefore = readEncryptionMetadata(encryptionMetadataPath(active.dbPath));
        const keyPath = encryption.keyFilePath!(active.dbPath);
        const keyBefore = readFileSync(keyPath);
        const restoreTemp = withGrantableTestDir('elepha-integrated-restore-temp-');
        vi.stubEnv('TMPDIR', restoreTemp);
        const writeSnapshot = vi.fn(writeBackup);
        const currentHookBody = 'current hook output survives restore';
        let authorityAfterRace: unknown;
        let activeBytesAfterRace!: Buffer;

        await expect(
            runRestoreOperation(candidate.dbPath, {
                dbPath: active.dbPath,
                encryption,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                writeBackup: writeSnapshot,
                confirm: async () => {
                    const current = await openDb(active.dbPath, { encryption });
                    const currentStore = new MemoryStore(current);
                    currentStore.consent.revoke(restoreProjectPath);
                    currentStore.purge({ projectIds: [activePurgeProject.id] }, '2026-09-06T11:00:00.000Z');
                    currentStore.recordIncognitoTranscript('codex', candidateIncognito.native_id);
                    recordHookOutput({
                        store: currentStore,
                        tool: 'codex',
                        nativeSessionId: 'hook-quote-session',
                        body: currentHookBody,
                        kind: 'brief',
                        injectedAt: '2026-09-06T11:01:00.000Z',
                    });
                    current
                        .prepare(
                            `INSERT INTO durable_capture_status (session_id, state, filter_version, updated_at)
                             VALUES (?, 'evicted', ?, '2026-09-06T11:02:00.000Z')
                             ON CONFLICT (session_id) DO UPDATE SET state = 'evicted', updated_at = excluded.updated_at`,
                        )
                        .run(activeTerminal.id, DURABLE_CAPTURE_FILTER_VERSION);
                    expect(lockMemory(current)).toBe('locked');
                    authorityAfterRace = current
                        .prepare('SELECT enrolled, state, generation, credential_tag FROM paranoid_authority WHERE id = 1')
                        .get();
                    current.pragma('wal_checkpoint(TRUNCATE)');
                    current.close();
                    activeBytesAfterRace = readFileSync(active.dbPath);
                    return true;
                },
            }),
        ).rejects.toThrow(RESTORE_TOMBSTONES_CHANGED_ERROR);
        expect(writeSnapshot).not.toHaveBeenCalled();
        expect(readFileSync(active.dbPath)).toEqual(activeBytesAfterRace);

        const preRestoreIdentity = statSync(active.dbPath);
        let competingOpener: Database.Database | undefined;
        let intentWatcher: Promise<void> | undefined;
        let lifecycleIntentObserved = false;
        let restoredResult!: Awaited<ReturnType<typeof runRestoreOperation>>;
        try {
            restoredResult = await runRestoreOperation(candidate.dbPath, {
                dbPath: active.dbPath,
                encryption,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                confirm: async () => {
                    competingOpener = await openManagedDatabase(active.dbPath, { readonly: true, fileMustExist: true, encryption });
                    intentWatcher = (async () => {
                        try {
                            for (let attempts = 0; attempts < 1_000 && !hasLifecycleIntent(active.dbPath); attempts += 1) {
                                await new Promise((resolve) => setTimeout(resolve, 5));
                            }
                            expect(competingOpener).toBeDefined();
                            expect(hasLifecycleIntent(active.dbPath)).toBe(true);
                            expect(statSync(active.dbPath)).toMatchObject({ dev: preRestoreIdentity.dev, ino: preRestoreIdentity.ino });
                            lifecycleIntentObserved = true;
                        } finally {
                            competingOpener?.close();
                            competingOpener = undefined;
                        }
                    })();
                    return true;
                },
            });
        } finally {
            try {
                await intentWatcher;
            } finally {
                competingOpener?.close();
            }
        }
        expect(lifecycleIntentObserved).toBe(true);
        expect(stagedRestoreDirectories(restoreTemp)).toEqual([]);

        const restored = await openDb(active.dbPath, { encryption });
        const restoredStore = new MemoryStore(restored, { resolveGitRoot: () => null, resolveGitRemote: () => null });
        expect(isMemoryLocked(restored)).toBe(true);
        expect(restored.prepare('SELECT enrolled, state, generation, credential_tag FROM paranoid_authority WHERE id = 1').get()).toEqual(
            authorityAfterRace,
        );
        expect(restoredStore.consent.consentState(restoreProjectPath)).toBe('denied');
        expect(
            restored
                .prepare(
                    "SELECT native_id FROM purged_transcripts WHERE native_id IN ('candidate-old-purge', 'purged-session') ORDER BY native_id",
                )
                .all(),
        ).toEqual([{ native_id: 'candidate-old-purge' }, { native_id: 'purged-session' }]);
        expect(
            restored
                .prepare(
                    "SELECT native_id FROM incognito_transcripts WHERE native_id IN ('candidate-old-incognito', 'incognito-session') ORDER BY native_id",
                )
                .all(),
        ).toEqual([{ native_id: 'candidate-old-incognito' }, { native_id: 'incognito-session' }]);
        expect(restored.prepare('SELECT body FROM injections ORDER BY body').all()).toEqual([{ body: currentHookBody }]);
        expect(
            restored
                .prepare(
                    `SELECT d.state
                     FROM durable_capture_status d
                     JOIN sessions s ON s.id = d.session_id
                     WHERE s.tool = 'codex' AND s.native_id = 'terminal-eviction'`,
                )
                .get(),
        ).toEqual({ state: 'evicted' });
        expect(
            restored
                .prepare(
                    `SELECT ft.memory_id
                     FROM filtered_turns ft
                     JOIN memories m ON m.id = ft.memory_id
                     JOIN sessions s ON s.id = m.session_id
                     WHERE s.native_id IN ('terminal-eviction', 'purged-session', 'incognito-session')`,
                )
                .all(),
        ).toEqual([]);
        expect(restored.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'staleorphanneedle'").all()).toEqual(
            [],
        );
        expect(
            restored.prepare('SELECT rowid FROM filtered_turns_fts WHERE rowid NOT IN (SELECT memory_id FROM filtered_turns)').all(),
        ).toEqual([]);
        const restoredLegacy = restored
            .prepare(
                `SELECT ft.user_prompt, ft.assistant_response, ft.tool_calls, m.decisions, m.pending_items
                 FROM filtered_turns ft
                 JOIN memories m ON m.id = ft.memory_id
                 JOIN sessions s ON s.id = m.session_id
                 WHERE s.native_id = 'legacy-tainted-session'`,
            )
            .get() as Record<string, string>;
        for (const value of Object.values(restoredLegacy)) {
            expect(detectShellSyntax(value)).toBe(false);
            expect(value).not.toMatch(/[\u0080-\u009f]/u);
        }
        const measuredUsage = () =>
            restored
                .prepare(
                    `SELECT COALESCE(SUM(
                         length(CAST(user_prompt AS BLOB)) +
                         length(CAST(assistant_response AS BLOB)) +
                         length(CAST(tool_calls AS BLOB))
                     ), 0) AS total_bytes
                     FROM filtered_turns`,
                )
                .get();
        expect(restored.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get()).toEqual(measuredUsage());
        const restoredProject = restored.prepare('SELECT id FROM projects WHERE path = ?').get(restoreProjectPath) as { id: number };
        const projectSet: ProjectSet = {
            key: 'restored-project',
            displayName: 'restored project',
            paths: [restoreProjectPath],
            projectIds: [restoredProject.id],
            gitRoot: null,
            gitRemote: null,
        };
        const lockedReader = new SessionReader(restored);
        expect(lockedReader.sessionsFor(projectSet)).toEqual([]);
        const lockedQuery = tokenizeRecallQuery('legacytaintneedle');
        if (!lockedQuery) throw new Error('Locked query unexpectedly empty');
        await expect(lexicalRecall(lockedReader, [projectSet], lockedQuery, 'here', undefined, undefined, 'strict')).resolves.toEqual({
            body: LOCKED_MEMORY_MESSAGE,
            state: 'locked',
            sessionIds: [],
            content_coverage: LOCKED_CONTENT_COVERAGE,
        });

        restoredStore.consent.grant(liveProjectPath);
        const liveTaint = `\n&& livetaintneedle \u0085\u009b`;
        const liveSource = sourceFor('live-taint');
        const liveTurn = turn('live-taint', liveSource, liveProjectPath, 0, liveTaint, `\n|| live response\u0080`);
        const restoredQuoteSource = sourceFor('hook-quote-session');
        const restoredQuote = turn('hook-quote-session', restoredQuoteSource, liveProjectPath, 0, 'quote follows', currentHookBody);
        restoredQuote.startedAt = '2026-09-06T11:00:00.000Z';
        restoredQuote.endedAt = '2026-09-06T11:02:00.000Z';
        const liveAdapter = adapterForTurns([]);
        const liveDaemon = daemonWith(restoredStore, liveAdapter, 1_000_000);
        await expect(liveDaemon.persistTurn(liveAdapter, liveTurn)).resolves.toBe(true);
        await expect(liveDaemon.persistTurn(liveAdapter, restoredQuote)).resolves.toBe(false);
        expect(restoredStore.findSession('codex', 'hook-quote-session')).toBeUndefined();

        const backfillSource = sourceFor('backfill-taint');
        const backfillSession = restoredStore.upsertSession(
            'codex',
            'backfill-taint',
            restoredStore.upsertProject(liveProjectPath).id,
            backfillSource,
        );
        const backfillTaint = turn('backfill-taint', backfillSource, liveProjectPath, 0, `\n|| backfilltaintneedle\u009b`, 'backfill');
        const backfillQuoteBody = 'backfill hook output must not be copied';
        const backfillQuote = turn('backfill-taint', backfillSource, liveProjectPath, 1, 'quote follows', backfillQuoteBody);
        restoredStore.recordTurn(backfillTaint, backfillSession.id, backfillSession.project_id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });
        restoredStore.recordTurn(backfillQuote, backfillSession.id, backfillSession.project_id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });
        restoredStore.recordInjection({
            tool: 'codex',
            nativeSessionId: backfillSession.native_id,
            injectedAt: '2026-09-06T10:01:00.500Z',
            injectionId: 'backfill-injection',
            body: backfillQuoteBody,
        });
        const backfillAdapter = adapterForTurns([backfillTaint, backfillQuote]);
        await daemonWith(restoredStore, backfillAdapter, 1_000_000).backfillDurableCapture();
        const capturedBeforeCap = restored
            .prepare(
                `SELECT s.native_id, m.turn_index, ft.user_prompt, ft.assistant_response, ft.tool_calls
                 FROM filtered_turns ft
                 JOIN memories m ON m.id = ft.memory_id
                 JOIN sessions s ON s.id = m.session_id
                 WHERE s.native_id IN ('live-taint', 'backfill-taint')
                 ORDER BY s.native_id, m.turn_index`,
            )
            .all() as Array<Record<string, string | number>>;
        expect(capturedBeforeCap.map(({ native_id, turn_index }) => ({ native_id, turn_index }))).toEqual([
            { native_id: 'backfill-taint', turn_index: 0 },
            { native_id: 'live-taint', turn_index: 0 },
        ]);
        for (const row of capturedBeforeCap) {
            for (const value of [row.user_prompt, row.assistant_response, row.tool_calls]) {
                expect(detectShellSyntax(String(value))).toBe(false);
                expect(String(value)).not.toMatch(/[\u0080-\u009f]/u);
            }
        }
        expect(JSON.stringify(capturedBeforeCap)).not.toContain(currentHookBody);
        expect(JSON.stringify(capturedBeforeCap)).not.toContain(backfillQuoteBody);

        const capSource = sourceFor('cap-session');
        const capTurns = [
            turn('cap-session', capSource, liveProjectPath, 0, 'capevictionneedle zero', 'response zero'),
            turn('cap-session', capSource, liveProjectPath, 1, 'capevictionneedle one', 'response one'),
        ];
        const capAdapter = adapterForTurns(capTurns);
        const capDaemon = daemonWith(restoredStore, capAdapter, 1);
        await expect(capDaemon.persistTurn(capAdapter, capTurns[0]!)).resolves.toBe(true);
        await expect(capDaemon.persistTurn(capAdapter, capTurns[1]!)).resolves.toBe(true);
        const capSession = restoredStore.findSession('codex', 'cap-session');
        if (!capSession) throw new Error('Cap session was not recorded');
        const adapters = { codex: capAdapter, 'claude-code': capAdapter } as SessionAdapterMap;
        const split = await planManualSplit(restored, adapters, capSession.id, 1);
        applyManualSplit(restored, split);
        await capDaemon.backfillDurableCapture();
        expect(
            restored
                .prepare(
                    `SELECT s.segment_index, d.state
                     FROM sessions s
                     JOIN durable_capture_status d ON d.session_id = s.id
                     WHERE s.native_id = 'cap-session'
                     ORDER BY s.segment_index`,
                )
                .all(),
        ).toEqual([
            { segment_index: 0, state: 'evicted' },
            { segment_index: 1, state: 'evicted' },
        ]);
        expect(restored.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'capevictionneedle'").all()).toEqual(
            [],
        );
        expect(
            restored.prepare('SELECT rowid FROM filtered_turns_fts WHERE rowid NOT IN (SELECT memory_id FROM filtered_turns)').all(),
        ).toEqual([]);
        expect(restored.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get()).toEqual(measuredUsage());
        expect((measuredUsage() as { total_bytes: number }).total_bytes).toBeLessThanOrEqual(1);

        const encryptedExport = path.join(active.directory, 'integrated-full-export.db');
        exportAll(restored, encryptedExport, FIXED_KEY);
        restored.close();
        expect(readFileSync(active.dbPath).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        expect(readFileSync(encryptedExport).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        expect(readFileSync(restoredResult.snapshotPath!).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        const exported = openKeyedDatabase(encryptedExport, FIXED_KEY, { readonly: true, fileMustExist: true });
        expect(exported.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        exported.close();
        const reopened = await openDb(active.dbPath, { encryption });
        expect(isMemoryLocked(reopened)).toBe(true);
        expect(reopened.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        reopened.close();
        await expect(migratePrimaryDatabaseToEncrypted(active.dbPath, migrationRuntime(active.directory))).resolves.toEqual({
            status: 'already-encrypted',
        });
        expect(readEncryptionMetadata(encryptionMetadataPath(active.dbPath))).toEqual(metadataBefore);
        expect(readFileSync(keyPath)).toEqual(keyBefore);
        expect(readFileSync(candidate.dbPath)).toEqual(candidateBytes);
    });

    it('leaves the database untouched when a TTY declines confirmation', () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        fullBackup(candidate.dbPath, backup);
        active.close();
        candidate.close();
        const before = readFileSync(active.dbPath);

        const result = runTtyRestoreCli(active.dbPath, 'n\n', backup);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('Candidate rows (the active database will become):');
        expect(result.stdout).toContain('Replace the current elepha database with this backup? A snapshot is saved first. [y/N] ');
        expect(result.stdout).toContain('Cancelled — no changes were made.');
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
    }, 15000);

    it('requires a file when standard input is not a TTY', () => {
        const active = createTestDb('elepha-restore-active-');
        active.close();

        const result = runRestoreCli(active.dbPath);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Specify a backup file when not running interactively.');
    }, 15000);
});
