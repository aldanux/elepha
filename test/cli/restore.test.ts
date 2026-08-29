import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportAll, exportProject } from '../../src/cli/commands/backup.js';
import { REQUIRED_RESTORE_TABLES, runRestoreOperation } from '../../src/cli/commands/restore.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { writeBackup } from '../../src/storage/backup.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import type { ParsedTurn, SessionAdapter } from '../../src/types/index.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';
import { withTempDir } from '../helpers/tmp.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const elephaCli = path.join(repositoryRoot, 'src', 'cli', 'index.ts');

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
    const db = openDb(dbPath);
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
    const db = openDb(sourcePath);
    try {
        exportAll(db, destination);
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
    });

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

        const store = new MemoryStore(openDb(active.dbPath));
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

        const store = new MemoryStore(openDb(active.dbPath));
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
        exportProject(source.db, resolution.project, partial);
        active.close();
        source.close();
        const before = readFileSync(active.dbPath);

        const result = runRestoreCli(active.dbPath, partial, '--skip-confirmation');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('elepha import');
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
    });

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
    });

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
    });

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
    });

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

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
                writeBackup: (db, dbPath) => {
                    snapshotPath = writeBackup(db, dbPath);
                    const stagedDirectories = stagedRestoreDirectories(restoreTemp);
                    expect(stagedDirectories).toHaveLength(1);
                    writeFileSync(path.join(restoreTemp, stagedDirectories[0]!, 'candidate.db'), 'changed after validation');
                    return snapshotPath;
                },
            }),
        ).rejects.toThrow('Installed database hash does not match the validated backup');

        expect(snapshotPath).toBeDefined();
        expect(existsSync(snapshotPath!)).toBe(true);
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(stagedRestoreDirectories(restoreTemp)).toEqual([]);
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
        const restored = openDb(active.dbPath);
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
    });

    it('requires a file when standard input is not a TTY', () => {
        const active = createTestDb('elepha-restore-active-');
        active.close();

        const result = runRestoreCli(active.dbPath);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Specify a backup file when not running interactively.');
    });
});
