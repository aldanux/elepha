import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
    copyFileSync,
    existsSync,
    linkSync,
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
    RESTORE_TOMBSTONES_CHANGED_ERROR,
    runRestoreOperation,
} from '../../src/cli/commands/restore.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { writeBackup } from '../../src/storage/backup.js';
import { type DatabaseEncryptionRuntime, databaseKey } from '../../src/storage/database-encryption.js';
import { DATABASE_LIFECYCLE_AMBIGUOUS, DATABASE_LIFECYCLE_BUSY, databaseLifecyclePaths } from '../../src/storage/database-lifecycle.js';
import { openKeyedDatabase, openManagedDatabase, openUnmanagedDb, rekeyDatabaseConnection } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import type { ParsedTurn, SessionAdapter } from '../../src/types/index.js';
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
    db.prepare(
        'INSERT INTO injections (tool, native_session_id, injected_at, injection_id, body_hash, body) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('codex', `session-${suffix}`, '2026-08-01T00:00:00.000Z', `injection-${suffix}`, `hash-${suffix}`, 'body');
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
    it('restores an encrypted full export with identical schema and row counts using the installation key', async () => {
        const active = createTestDb('elepha-restore-encrypted-active-');
        const candidate = createTestDb('elepha-restore-encrypted-candidate-');
        populate(active.dbPath, 'before');
        populate(candidate.dbPath, 'after');
        active.db.exec('DELETE FROM purged_transcripts');
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
                Number((candidateDb.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count),
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
                expect(count.count).toBe(0);
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

    it('aborts before mutation when an incognito tombstone is created during confirmation', async () => {
        const active = createTestDb('elepha-restore-tombstone-race-active-');
        const candidate = createTestDb('elepha-restore-tombstone-race-candidate-');
        const backup = path.join(candidate.directory, 'full.db');
        const nativeId = 'confirmation-race-incognito';
        const needle = 'c19confirmationneedle';
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
            inspected.exec('CREATE VIRTUAL TABLE temp.c19_terms USING fts5vocab(main, filtered_turns_fts, instance)');
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
            const vocabulary = inspected.prepare('SELECT term, doc FROM temp.c19_terms WHERE term = ?').all(needle);
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

    it('rejects a candidate consent trigger before preview or active mutation', async () => {
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
            AFTER INSERT ON consent_roots
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
            message: RESTORE_CONSENT_TRIGGER_ERROR,
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

    it('accepts an older sessions schema when the current migration can bring it forward', async () => {
        const active = createTestDb('elepha-restore-active-');
        const candidate = createTestDb('elepha-restore-candidate-');
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
        active.close();
        candidate.close();

        await expect(
            runRestoreOperation(candidate.dbPath, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            }),
        ).resolves.toMatchObject({ cancelled: false });
        expect(sessionNativeIds(active.dbPath)).toEqual(['legacy-session']);
        const restored = openUnmanagedDb(active.dbPath);
        try {
            expect((restored.pragma('table_info(sessions)') as Array<{ name: string }>).map((column) => column.name)).toContain(
                'segment_index',
            );
        } finally {
            restored.close();
        }
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
