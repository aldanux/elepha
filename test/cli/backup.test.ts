import { spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it, vi } from 'vitest';
import { type BackupPrompts, runBackupWizard } from '../../src/cli/backup-wizard.js';
import { defaultBackupPath, exportAll, exportProject, listFullBackups } from '../../src/cli/commands/backup.js';
import { ELEPHA_TAGLINE, ELEPHA_WORDMARK } from '../../src/config/constants.js';
import { isSupportedPlatform } from '../../src/install/platform.js';
import { openKeyedDatabase, rekeyDatabaseConnection } from '../../src/storage/db.js';
import { BACKUP_DESTINATION_COMPANION_ERROR } from '../../src/storage/encrypted-database-export.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const FIXED_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const SQLITE_COMPANION_SUFFIXES = ['-journal', '-shm', '-wal'] as const;

function seedExportFixture() {
    const fixture = createTestDb('elepha-backup-');
    const store = fixture.store;
    const primary = seedProject(fixture, { path: repositoryRoot });
    const fragmentPath = path.join(repositoryRoot, 'src');
    const fragmentId = Number(
        fixture.db
            .prepare(
                `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                fragmentPath,
                'src',
                primary.git_root,
                primary.git_remote,
                primary.git_root_commit,
                primary.first_seen_at,
                primary.last_seen_at,
            ).lastInsertRowid,
    );
    const fragment = store.getProjectById(fragmentId);
    if (!fragment) throw new Error('fragment project was not created');
    // Stored path data only: keep this unrelated project outside the selected
    // repository tree now that the database fixture itself lives inside it.
    const other = seedProject(fixture, {
        path: path.join(path.dirname(repositoryRoot), path.basename(fixture.directory), 'other-project'),
    });
    const primarySession = seedSession(fixture, { project: primary, nativeId: 'primary-session' });
    const fragmentSession = seedSession(fixture, { project: fragment, nativeId: 'fragment-session' });
    const otherSession = seedSession(fixture, { project: other, nativeId: 'other-session' });
    seedMemory(fixture, { project: primary, session: primarySession });
    seedMemory(fixture, { project: fragment, session: fragmentSession });
    seedMemory(fixture, { project: other, session: otherSession });
    seedRollup(fixture, { project: primary, session: primarySession });
    seedRollup(fixture, { project: fragment, session: fragmentSession });
    seedRollup(fixture, { project: other, session: otherSession });
    const resolution = new ProjectResolver(fixture.db).resolve('elepha');
    if (!('project' in resolution) || resolution.project === null) throw new Error('fragmented project did not resolve');
    fixture.db.pragma('wal_checkpoint(TRUNCATE)');
    fixture.db.pragma('journal_mode = DELETE');
    rekeyDatabaseConnection(fixture.db, FIXED_KEY);
    fixture.db.pragma('journal_mode = WAL');
    return { fixture, project: resolution.project, other };
}

function allTableCounts(db: Database.Database): Record<string, number> {
    const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{
        name: string;
    }>;
    return Object.fromEntries(
        tables.map(({ name }) => [name, (db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }).count]),
    );
}

function schemaRows(db: Database.Database): Array<Record<string, unknown>> {
    return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all() as Array<Record<string, unknown>>;
}

function shadowTableRows(db: Database.Database): Record<string, Array<Record<string, unknown>>> {
    const tables = db
        .prepare("SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow' ORDER BY name")
        .all() as Array<{ name: string; wr: number }>;
    return Object.fromEntries(
        tables.map(({ name, wr }) => {
            const quoted = `"${name.replaceAll('"', '""')}"`;
            const columns = db.prepare("SELECT name FROM pragma_table_xinfo(?, 'main') ORDER BY cid").all(name) as Array<{ name: string }>;
            const orderBy = wr === 0 ? 'rowid' : columns.map((column) => `"${column.name.replaceAll('"', '""')}"`).join(', ');
            const projection = wr === 0 ? 'rowid AS physical_rowid, *' : '*';
            const rows = db.prepare(`SELECT ${projection} FROM ${quoted} ORDER BY ${orderBy}`).safeIntegers().all() as Array<
                Record<string, unknown>
            >;
            return [name, rows];
        }),
    );
}

function portableSchemaRows(db: Database.Database): Array<Record<string, unknown>> {
    return db
        .prepare(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE (type = 'table' AND name IN ('projects', 'sessions', 'memories', 'session_rollups'))
                OR (type IN ('index', 'trigger') AND tbl_name IN ('projects', 'sessions', 'memories', 'session_rollups'))
             ORDER BY type, name`,
        )
        .all() as Array<Record<string, unknown>>;
}

function temporaryFilesFor(destination: string): string[] {
    const basename = path.basename(destination);
    const prefix = `${basename}.`;
    return readdirSync(path.dirname(destination)).filter((entry) => {
        const companionSuffix = SQLITE_COMPANION_SUFFIXES.find((suffix) => entry.endsWith(suffix));
        const main = companionSuffix === undefined ? entry : entry.slice(0, -companionSuffix.length);
        if (main === basename) {
            return companionSuffix !== undefined;
        }
        return main.startsWith(prefix) && /\.(?:discard|rollback|tmp|verify)$/.test(main);
    });
}

async function waitForFile(filePath: string, child: ReturnType<typeof spawn>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for project-export pause marker. stderr: ${stderr}`));
        }, 10_000);
        const interval = setInterval(() => {
            if (existsSync(filePath) && statSync(filePath).size > 0) {
                cleanup();
                resolve();
            }
        }, 10);
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.once('exit', (code, signal) => {
            cleanup();
            reject(new Error(`Project-export child exited before pausing (${String(code)}/${String(signal)}). stderr: ${stderr}`));
        });

        function cleanup(): void {
            clearTimeout(timeout);
            clearInterval(interval);
        }
    });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
}

interface BoundedChildObservation {
    markerReached: boolean;
    forced: 'after-marker' | 'overall' | null;
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
}

async function observeBoundedChild(child: ReturnType<typeof spawn>, markerPath: string): Promise<BoundedChildObservation> {
    return new Promise((resolve, reject) => {
        let markerReached = false;
        let forced: BoundedChildObservation['forced'] = null;
        let markerTimeout: ReturnType<typeof setTimeout> | undefined;
        let stderr = '';
        const overallTimeout = setTimeout(() => {
            forced = 'overall';
            child.kill('SIGKILL');
        }, 10_000);
        const interval = setInterval(observeMarker, 10);
        const onData = (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            observeMarker();
            cleanup();
            resolve({ markerReached, forced, code, signal, stderr });
        };
        child.stderr?.on('data', onData);
        child.once('error', onError);
        child.once('exit', onExit);
        observeMarker();

        function observeMarker(): void {
            if (markerReached || !existsSync(markerPath)) {
                return;
            }
            try {
                if (statSync(markerPath).size === 0) {
                    return;
                }
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return;
                }
                cleanup();
                reject(error);
                return;
            }
            markerReached = true;
            markerTimeout = setTimeout(() => {
                if (forced === null && child.exitCode === null && child.signalCode === null) {
                    forced = 'after-marker';
                    child.kill('SIGKILL');
                }
            }, 2_000);
        }

        function cleanup(): void {
            clearTimeout(overallTimeout);
            clearInterval(interval);
            if (markerTimeout !== undefined) {
                clearTimeout(markerTimeout);
            }
            child.stderr?.off('data', onData);
            child.off('error', onError);
            child.off('exit', onExit);
        }
    });
}

function exportDatabaseSurvivors(destination: string): Array<{ name: string; bytes: Buffer }> {
    const directory = path.dirname(destination);
    const basename = path.basename(destination);
    return readdirSync(directory)
        .filter((entry) => {
            const companionSuffix = SQLITE_COMPANION_SUFFIXES.find((suffix) => entry.endsWith(suffix));
            const main = companionSuffix === undefined ? entry : entry.slice(0, -companionSuffix.length);
            return main === basename || main.startsWith(`${basename}.`);
        })
        .map((name) => {
            const candidate = path.join(directory, name);
            return { name, bytes: lstatSync(candidate).isFile() ? readFileSync(candidate) : Buffer.alloc(0) };
        });
}

function ttyStream(): PassThrough {
    const stream = new PassThrough();
    Object.defineProperty(stream, 'isTTY', { value: true });
    return stream;
}

function fakePrompts(selections: string[], destination: string): { prompts: BackupPrompts; events: string[] } {
    const events: string[] = [];
    return {
        prompts: {
            intro: (title) => events.push(`intro:${title}`),
            select: vi.fn(async () => selections.shift() ?? Symbol('cancelled')),
            text: vi.fn(async () => destination),
            isCancel: (value) => typeof value === 'symbol',
            cancel: vi.fn(),
            outro: vi.fn(),
        },
        events,
    };
}

describe('elepha backup exports', () => {
    it('configures the production attached target while its first encrypted page is still unwritten', () => {
        const { fixture } = seedExportFixture();
        const output = path.join(fixture.directory, 'keyed-from-first-write.db');
        const sourceCipherSalt = fixture.db.pragma('cipher_salt', { simple: true });
        const originalPragma = fixture.db.pragma.bind(fixture.db);
        let attachedCipherSalt: unknown;
        const pragmaSpy = vi.spyOn(fixture.db, 'pragma').mockImplementation(((source: string, ...args: unknown[]) => {
            if (source === 'elepha_export.cipher_salt') {
                expect(statSync(output).size).toBe(0);
            }
            const result = (originalPragma as (...pragmaArgs: unknown[]) => unknown)(source, ...args);
            if (source === 'elepha_export.cipher_salt') {
                attachedCipherSalt = result;
            }
            return result;
        }) as typeof fixture.db.pragma);

        try {
            exportAll(fixture.db, output, FIXED_KEY);
        } finally {
            pragmaSpy.mockRestore();
        }

        expect(attachedCipherSalt).toBe(sourceCipherSalt);
        expect(readFileSync(output).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        const unkeyed = new Database(output, { readonly: true, fileMustExist: true });
        expect(() => unkeyed.prepare('SELECT * FROM sessions').all()).toThrow(expect.objectContaining({ code: 'SQLITE_NOTADB' }));
        unkeyed.close();
        const keyed = openKeyedDatabase(output, FIXED_KEY, { readonly: true, fileMustExist: true });
        try {
            expect(keyed.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 3 });
        } finally {
            keyed.close();
        }
    });

    it('lists only full backups newest-first with file metadata', () => {
        const fixture = createTestDb('elepha-list-full-backups-');
        const previousHome = process.env.ELEPHA_HOME;
        const isolatedHome = path.join(fixture.directory, 'isolated-elepha-home');
        const backupsDirectory = path.join(isolatedHome, 'backups');
        const older = path.join(backupsDirectory, 'elepha-full-older.db');
        const newest = path.join(backupsDirectory, 'elepha-full-newest.db');
        mkdirSync(backupsDirectory, { recursive: true });
        writeFileSync(older, Buffer.alloc(1_024));
        writeFileSync(newest, Buffer.alloc(2_048));
        writeFileSync(path.join(backupsDirectory, 'elepha-project-newer.db'), Buffer.alloc(4_096));
        writeFileSync(path.join(backupsDirectory, 'elepha-full-not-a-database.txt'), Buffer.alloc(8_192));
        utimesSync(older, new Date(Date.UTC(2026, 7, 24)), new Date(Date.UTC(2026, 7, 24)));
        utimesSync(newest, new Date(Date.UTC(2026, 7, 25)), new Date(Date.UTC(2026, 7, 25)));
        process.env.ELEPHA_HOME = isolatedHome;

        try {
            expect(listFullBackups()).toEqual([
                expect.objectContaining({ path: newest, bytes: 2_048 }),
                expect.objectContaining({ path: older, bytes: 1_024 }),
            ]);
        } finally {
            if (previousHome === undefined) {
                delete process.env.ELEPHA_HOME;
            } else {
                process.env.ELEPHA_HOME = previousHome;
            }
            fixture.close();
        }
    });

    it.each([
        [
            '--all',
            (fixture: ReturnType<typeof seedExportFixture>, destination: string) =>
                exportAll(fixture.fixture.db, destination, FIXED_KEY, true),
        ],
        [
            '--project',
            (fixture: ReturnType<typeof seedExportFixture>, destination: string) =>
                exportProject(fixture.fixture.db, fixture.project, destination, FIXED_KEY, true),
        ],
    ])('refuses the active database as the %s destination directly and through filesystem aliases', (_scope, exportBackup) => {
        const fixture = seedExportFixture();
        fixture.fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const dbPath = fixture.fixture.dbPath;
        const original = readFileSync(dbPath);

        expect(() => exportBackup(fixture, dbPath)).toThrow('Backup destination must not be the active database.');
        expect(readFileSync(dbPath)).toEqual(original);

        const parentAlias = path.join(fixture.fixture.directory, 'database-parent-alias');
        symlinkSync(fixture.fixture.directory, parentAlias, 'dir');
        const aliasedDatabase = path.join(parentAlias, path.basename(dbPath));
        expect(() => exportBackup(fixture, aliasedDatabase)).toThrow('Backup destination must not be the active database.');
        expect(readFileSync(dbPath)).toEqual(original);

        const hardLinkAlias = path.join(fixture.fixture.directory, 'database-hard-link-alias.db');
        linkSync(dbPath, hardLinkAlias);
        expect(() => exportBackup(fixture, hardLinkAlias)).toThrow('Backup destination must not be the active database.');
        expect(readFileSync(dbPath)).toEqual(original);
    });

    it.each(['--all', '--project'] as const)(
        'revalidates an active-database hard link created during %s destination preparation',
        async (scope) => {
            const { fixture, project } = seedExportFixture();
            fixture.db.pragma('wal_checkpoint(TRUNCATE)');
            const sourceBytes = readFileSync(fixture.dbPath);
            fixture.close();

            const output = path.join(fixture.directory, `active-hard-link-prepare-${scope.slice(2)}.db`);
            const reached = path.join(fixture.directory, `active-hard-link-prepare-${scope.slice(2)}.reached`);
            const source = `
                import { createRequire, syncBuiltinESMExports } from 'node:module';

                const [scope, sourcePath, destination, reachedPath, projectJson, keyHex] = process.argv.slice(1);
                const require = createRequire(import.meta.url);
                const fs = require('node:fs');
                const originalLstatSync = fs.lstatSync;
                let destinationChecks = 0;
                let linkedAtCheck = 0;
                fs.lstatSync = function linkActiveSourceDuringPreparation(file, ...args) {
                    if (file === destination) {
                        destinationChecks += 1;
                        if (destinationChecks === 2) {
                            fs.linkSync(sourcePath, destination);
                            linkedAtCheck = destinationChecks;
                        }
                    }
                    return originalLstatSync(file, ...args);
                };
                syncBuiltinESMExports();

                const { exportAll, exportProject } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
                const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
                const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
                let errorMessage = '';
                let returned = false;
                try {
                    if (scope === '--all') {
                        exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                    } else {
                        exportProject(sourceDb, JSON.parse(projectJson), destination, Buffer.from(keyHex, 'hex'), true);
                    }
                    returned = true;
                } catch (error) {
                    errorMessage = error instanceof Error ? error.message : String(error);
                } finally {
                    sourceDb.close();
                }
                const sourceInfo = originalLstatSync(sourcePath, { bigint: true });
                const destinationInfo = originalLstatSync(destination, { bigint: true });
                fs.writeFileSync(
                    reachedPath,
                    JSON.stringify({
                        destinationChecks,
                        errorMessage,
                        linkedAtCheck,
                        returned,
                        sharesSourceIdentity: sourceInfo.dev === destinationInfo.dev && sourceInfo.ino === destinationInfo.ino,
                    }),
                    { mode: 0o600 },
                );
            `;
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    source,
                    '--',
                    scope,
                    fixture.dbPath,
                    output,
                    reached,
                    JSON.stringify(project),
                    FIXED_KEY.toString('hex'),
                ],
                { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
            );

            await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
            const state = JSON.parse(readFileSync(reached, 'utf8')) as {
                destinationChecks: number;
                errorMessage: string;
                linkedAtCheck: number;
                returned: boolean;
                sharesSourceIdentity: boolean;
            };
            expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
            expect(state).toEqual({
                destinationChecks: 3,
                errorMessage: 'Backup destination must not be the active database.',
                linkedAtCheck: 2,
                returned: false,
                sharesSourceIdentity: true,
            });
            expect(readFileSync(output)).toEqual(sourceBytes);
        },
        15000,
    );

    it('writes a standalone database with both fragment rows and no other project data through --project', () => {
        const { fixture, project, other } = seedExportFixture();
        const output = path.join(fixture.directory, 'project-export.db');
        const blobTitle = Buffer.from([0, 1, 2, 3, 254, 255]);
        fixture.db.exec(`
            CREATE TRIGGER export_sessions_title_audit
            AFTER UPDATE OF title ON sessions
            BEGIN
                SELECT NEW.id;
            END
        `);
        fixture.db.prepare('UPDATE sessions SET title = ? WHERE native_id = ?').run(blobTitle, 'primary-session');
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        const sourceSchema = portableSchemaRows(fixture.db);
        const sourceSession = fixture.db
            .prepare(
                `SELECT rowid AS physical_rowid, id, typeof(title) AS storage, hex(title) AS title
                 FROM sessions
                 WHERE native_id = 'primary-session'`,
            )
            .get();
        expect(sourceSession).toEqual({
            physical_rowid: expect.any(Number),
            id: expect.any(Number),
            storage: 'blob',
            title: blobTitle.toString('hex').toUpperCase(),
        });

        exportProject(fixture.db, project, output, FIXED_KEY);
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        expect(readFileSync(output).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        const unkeyed = new Database(output, { readonly: true });
        expect(() => unkeyed.prepare('SELECT name FROM sqlite_master').all()).toThrow();
        unkeyed.close();
        const exported = openKeyedDatabase(output, FIXED_KEY, { readonly: true });
        try {
            expect(exported.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([
                { name: 'memories' },
                { name: 'projects' },
                { name: 'session_rollups' },
                { name: 'sessions' },
            ]);
            expect(exported.prepare('SELECT id FROM projects ORDER BY id').all()).toEqual(project.projectIds.map((id) => ({ id })));
            expect(exported.prepare('SELECT DISTINCT project_id FROM sessions ORDER BY project_id').all()).toEqual(
                project.projectIds.map((project_id) => ({ project_id })),
            );
            expect(exported.prepare('SELECT DISTINCT project_id FROM memories ORDER BY project_id').all()).toEqual(
                project.projectIds.map((project_id) => ({ project_id })),
            );
            expect(exported.prepare('SELECT DISTINCT project_id FROM session_rollups ORDER BY project_id').all()).toEqual(
                project.projectIds.map((project_id) => ({ project_id })),
            );
            expect(exported.prepare('SELECT COUNT(*) AS count FROM projects WHERE id = ?').get(other.id)).toEqual({ count: 0 });
            expect(portableSchemaRows(exported)).toEqual(sourceSchema);
            expect(
                exported
                    .prepare(
                        `SELECT rowid AS physical_rowid, id, typeof(title) AS storage, hex(title) AS title
                         FROM sessions
                         WHERE native_id = 'primary-session'`,
                    )
                    .get(),
            ).toEqual(sourceSession);
            expect(statSync(output).mode & 0o777).toBe(0o600);
        } finally {
            exported.close();
        }
    }, 15000);

    it('never leaves plaintext project data when killed after the populated direct export appears', async () => {
        const { fixture, project } = seedExportFixture();
        const leakedMarker = 'project-export-crash-secret';
        fixture.db.prepare('UPDATE sessions SET title = ? WHERE project_id = ?').run(leakedMarker, project.projectIds[0]);
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const output = path.join(fixture.directory, 'crash-project.db');
        const ready = path.join(fixture.directory, 'project-export.ready');
        const source = `
            import { writeFileSync } from 'node:fs';
            import { exportProject } from ${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)};
            import { openKeyedDatabase } from ${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)};

            const [sourcePath, destination, readyPath, projectIdsJson, keyHex] = process.argv.slice(1);
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            const originalExec = sourceDb.exec.bind(sourceDb);
            sourceDb.exec = function pauseBeforeAttachedExportDetach(sql) {
                if (sql.startsWith('DETACH DATABASE ')) {
                    writeFileSync(readyPath, destination, { mode: 0o600 });
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
                }
                return originalExec(sql);
            };
            exportProject(
                sourceDb,
                { projectIds: JSON.parse(projectIdsJson), displayName: 'crash-test', paths: [] },
                destination,
                Buffer.from(keyHex, 'hex'),
            );
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                output,
                ready,
                JSON.stringify(project.projectIds),
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await waitForFile(ready, child);
        const exit = waitForExit(child);
        child.kill('SIGKILL');
        await expect(exit).resolves.toEqual({ code: null, signal: 'SIGKILL' });

        expect(existsSync(output)).toBe(true);
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        const interrupted = readFileSync(ready, 'utf8');
        const survivors = exportDatabaseSurvivors(output);
        const survivorNames = survivors.map(({ name }) => name);
        expect(survivors.length).toBeGreaterThan(0);
        expect(survivorNames).toContain(path.basename(interrupted));
        expect({
            plaintextHeaders: survivors
                .filter(({ bytes }) => bytes.subarray(0, 16).toString('binary') === 'SQLite format 3\0')
                .map(({ name }) => name),
            leakedFiles: survivors.filter(({ bytes }) => bytes.includes(Buffer.from(leakedMarker))).map(({ name }) => name),
        }).toEqual({ plaintextHeaders: [], leakedFiles: [] });
        const unkeyed = new Database(interrupted, { readonly: true, fileMustExist: true });
        expect(() => unkeyed.prepare('SELECT name FROM sqlite_master').all()).toThrow(expect.objectContaining({ code: 'SQLITE_NOTADB' }));
        unkeyed.close();
        const keyed = openKeyedDatabase(interrupted, FIXED_KEY, { readonly: true, fileMustExist: true });
        try {
            expect(keyed.prepare('SELECT title FROM sessions WHERE title = ?').get(leakedMarker)).toEqual({ title: leakedMarker });
        } finally {
            keyed.close();
        }
    }, 15000);

    it('writes a full database copy with matching portable-table row counts through --all', () => {
        const { fixture } = seedExportFixture();
        const output = path.join(fixture.directory, 'full-export.db');
        const blob = Buffer.from([255, 0, 128, 64, 32]);
        fixture.db.exec(`
            CREATE TABLE backup_copy_probe (id INTEGER PRIMARY KEY, payload BLOB NOT NULL, touched INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX backup_copy_probe_payload ON backup_copy_probe(payload);
            CREATE TRIGGER backup_copy_probe_au
            AFTER UPDATE OF payload ON backup_copy_probe
            BEGIN
                UPDATE backup_copy_probe SET touched = touched + 1 WHERE id = NEW.id;
            END;
            CREATE VIEW backup_copy_view AS
            SELECT id, hex(payload) AS payload_hex FROM backup_copy_probe;
            CREATE TABLE backup_rowid_probe (payload BLOB NOT NULL);
            CREATE VIRTUAL TABLE backup_fts_probe USING fts5(content);
        `);
        fixture.db.prepare('INSERT INTO backup_copy_probe (id, payload) VALUES (?, ?)').run(73, blob);
        fixture.db.prepare('INSERT INTO backup_fts_probe (rowid, content) VALUES (?, ?)').run(91, 'full export fts token');
        fixture.db.prepare('INSERT INTO backup_fts_probe (rowid, content) VALUES (?, ?)').run(107, 'deleted segment token');
        fixture.db.prepare('DELETE FROM backup_fts_probe WHERE rowid = ?').run(107);
        fixture.db.prepare('INSERT INTO backup_rowid_probe (rowid, payload) VALUES (?, ?)').run(5, Buffer.from([5]));
        fixture.db.prepare('INSERT INTO backup_rowid_probe (rowid, payload) VALUES (?, ?)').run(17, Buffer.from([17]));
        fixture.db.prepare('DELETE FROM backup_rowid_probe WHERE rowid = ?').run(5);
        const largeRowid = 9_007_199_254_740_993n;
        fixture.db.prepare('INSERT INTO backup_rowid_probe (rowid, payload) VALUES (?, ?)').run(largeRowid, Buffer.from([9, 0, 7]));
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        const sourceFtsShadows = shadowTableRows(fixture.db);

        exportAll(fixture.db, output, FIXED_KEY);
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        // Cross-schema reconstruction produces an independent page layout; the
        // schema, rows, rowids, BLOBs, and virtual-table behavior below are the
        // fidelity contract.
        expect(readFileSync(output).equals(sourceBytes)).toBe(false);
        const source = openKeyedDatabase(fixture.dbPath, FIXED_KEY, { readonly: true, fileMustExist: true });
        expect(readFileSync(output).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        const unkeyed = new Database(output, { readonly: true });
        expect(() => unkeyed.prepare('SELECT name FROM sqlite_master').all()).toThrow();
        unkeyed.close();
        const exported = openKeyedDatabase(output, FIXED_KEY);
        try {
            expect(allTableCounts(exported)).toEqual(allTableCounts(source));
            expect(schemaRows(exported)).toEqual(schemaRows(source));
            expect(
                exported
                    .prepare(
                        'SELECT rowid AS physical_rowid, id, typeof(payload) AS storage, hex(payload) AS payload FROM backup_copy_probe',
                    )
                    .get(),
            ).toEqual({ physical_rowid: 73, id: 73, storage: 'blob', payload: blob.toString('hex').toUpperCase() });
            expect(exported.prepare("SELECT rowid, content FROM backup_fts_probe WHERE backup_fts_probe MATCH 'token'").all()).toEqual([
                { rowid: 91, content: 'full export fts token' },
            ]);
            expect(shadowTableRows(exported)).toEqual(sourceFtsShadows);
            expect(exported.prepare('SELECT * FROM backup_copy_view').all()).toEqual([
                { id: 73, payload_hex: blob.toString('hex').toUpperCase() },
            ]);
            expect(
                exported.prepare('SELECT rowid, hex(payload) AS payload FROM backup_rowid_probe ORDER BY rowid').safeIntegers().all(),
            ).toEqual([
                { rowid: 17n, payload: '11' },
                { rowid: largeRowid, payload: '090007' },
            ]);
            exported.prepare('UPDATE backup_copy_probe SET payload = ? WHERE id = ?').run(Buffer.from([1]), 73);
            expect(exported.prepare('SELECT touched FROM backup_copy_probe WHERE id = ?').get(73)).toEqual({ touched: 1 });
            expect(statSync(output).mode & 0o777).toBe(0o600);
        } finally {
            source.close();
            exported.close();
        }
    }, 15000);

    it('never leaves plaintext full-export data when killed during identity-bound verification', async () => {
        const { fixture } = seedExportFixture();
        const marker = 'full-export-verification-crash-secret';
        fixture.db.prepare("UPDATE sessions SET title = ? WHERE native_id = 'primary-session'").run(marker);
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const output = path.join(fixture.directory, 'verification-crash-full-export.db');
        const ready = path.join(fixture.directory, 'verification-crash-full-export.ready');
        const source = `
            import { readdirSync, writeFileSync } from 'node:fs';
            import path from 'node:path';
            import Database from 'better-sqlite3-multiple-ciphers';

            const [sourcePath, destination, readyPath, keyHex] = process.argv.slice(1);
            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            const originalClose = Database.prototype.close;
            let paused = false;
            Database.prototype.close = function pauseDuringIdentityBoundVerification() {
                const databasePath = this.name;
                const descriptorVerification = databasePath.startsWith('/dev/fd/') || databasePath.startsWith('/proc/self/fd/');
                const namedVerification = databasePath.startsWith(destination + '.') && databasePath.endsWith('.verify');
                if (!paused && (descriptorVerification || namedVerification)) {
                    const destinationName = path.basename(destination);
                    const proofName = readdirSync(path.dirname(destination)).find(
                        (entry) => entry.startsWith(destinationName + '.') && entry.endsWith('.verify'),
                    );
                    if (proofName === undefined) throw new Error('verification proof was not present at the descriptor close seam');
                    const proofPath = path.join(path.dirname(destination), proofName);
                    paused = true;
                    writeFileSync(readyPath, JSON.stringify({ databasePath, proofPath, seamReached: true }), { mode: 0o600 });
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
                }
                return originalClose.call(this);
            };
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
            } finally {
                sourceDb.close();
            }
        `;
        const child = spawn(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '--eval', source, fixture.dbPath, output, ready, FIXED_KEY.toString('hex')],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await waitForFile(ready, child);
        const exit = waitForExit(child);
        child.kill('SIGKILL');
        await expect(exit).resolves.toEqual({ code: null, signal: 'SIGKILL' });

        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        const readyState = JSON.parse(readFileSync(ready, 'utf8')) as {
            databasePath: string;
            proofPath: string;
            seamReached: boolean;
        };
        expect(readyState.seamReached).toBe(true);
        expect(
            readyState.databasePath.startsWith('/dev/fd/') ||
                readyState.databasePath.startsWith('/proc/self/fd/') ||
                readyState.databasePath.endsWith('.verify'),
        ).toBe(true);
        const survivors = exportDatabaseSurvivors(output);
        expect({
            plaintextHeaders: survivors
                .filter(({ bytes }) => bytes.subarray(0, 16).toString('binary') === 'SQLite format 3\0')
                .map(({ name }) => name),
            leakedFiles: survivors.filter(({ bytes }) => bytes.includes(Buffer.from(marker))).map(({ name }) => name),
        }).toEqual({ plaintextHeaders: [], leakedFiles: [] });
        expect(survivors.map(({ name }) => name)).toEqual(
            expect.arrayContaining([path.basename(output), path.basename(readyState.proofPath)]),
        );
        const keyed = openKeyedDatabase(output, FIXED_KEY, { readonly: true, fileMustExist: true });
        try {
            expect(keyed.prepare('SELECT title FROM sessions WHERE title = ?').get(marker)).toEqual({ title: marker });
        } finally {
            keyed.close();
        }
    }, 15000);

    it('rejects post-write path substitution without deleting the unknown inode or prior destination', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const marker = 'published-plaintext-secret';
        const substitute = path.join(fixture.directory, 'publication-plaintext.db');
        const substituteDb = new Database(substitute);
        substituteDb.exec('CREATE TABLE publication_probe (payload TEXT NOT NULL)');
        substituteDb.prepare('INSERT INTO publication_probe (payload) VALUES (?)').run(marker);
        substituteDb.close();
        const substituteBytes = readFileSync(substitute);
        const output = path.join(fixture.directory, 'publication-race.db');
        const priorDestination = Buffer.from('prior destination must remain recoverable');
        writeFileSync(output, priorDestination);
        const encryptedAside = path.join(fixture.directory, 'direct-ciphertext-aside.db');
        const reached = path.join(fixture.directory, 'publication-race.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, substitutePath, destination, encryptedAsidePath, reachedPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalLstatSync = fs.lstatSync;
            const originalOpenSync = fs.openSync;
            let directTargetCreated = false;
            let substituted = false;
            fs.openSync = function armAfterDirectTargetCreation(file, flags, ...args) {
                const descriptor = originalOpenSync(file, flags, ...args);
                if (file === destination && (flags & fs.constants.O_EXCL) !== 0) directTargetCreated = true;
                return descriptor;
            };
            fs.lstatSync = function substituteAfterDirectWrite(file, ...args) {
                const result = originalLstatSync(file, ...args);
                if (directTargetCreated && !substituted && file === destination && Number(result.size) > 0 && result.isFile()) {
                    fs.renameSync(destination, encryptedAsidePath);
                    fs.renameSync(substitutePath, destination);
                    substituted = true;
                }
                return result;
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            try {
                let errorMessage = '';
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                } catch (error) {
                    errorMessage = error instanceof Error ? error.message : String(error);
                }
                fs.writeFileSync(reachedPath, JSON.stringify({ substituted, errorMessage }), { mode: 0o600 });
            } finally {
                sourceDb.close();
            }
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                substitute,
                output,
                encryptedAside,
                reached,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        const state = JSON.parse(readFileSync(reached, 'utf8')) as { substituted: boolean; errorMessage: string };
        expect(state.substituted).toBe(true);
        expect(state.errorMessage).toContain('Backup failed for');
        expect(readFileSync(output)).toEqual(substituteBytes);
        expect(readFileSync(output).includes(Buffer.from(marker))).toBe(true);
        const unkeyedAside = new Database(encryptedAside, { readonly: true, fileMustExist: true });
        expect(() => unkeyedAside.prepare('SELECT name FROM sqlite_master').all()).toThrow(
            expect.objectContaining({ code: 'SQLITE_NOTADB' }),
        );
        unkeyedAside.close();
        const rollbackFiles = readdirSync(fixture.directory).filter(
            (entry) => entry.startsWith(`${path.basename(output)}.`) && entry.endsWith('.rollback'),
        );
        expect(rollbackFiles).toHaveLength(1);
        expect(readFileSync(path.join(fixture.directory, rollbackFiles[0] ?? 'missing'))).toEqual(priorDestination);
    }, 15000);

    it('keeps every publication-race SIGKILL survivor ciphertext', async () => {
        const { fixture } = seedExportFixture();
        const marker = 'publication-sigkill-encrypted-secret';
        fixture.db.prepare("UPDATE sessions SET title = ? WHERE native_id = 'primary-session'").run(marker);
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const output = path.join(fixture.directory, 'publication-kill.db');
        const ready = path.join(fixture.directory, 'publication-kill.ready');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, destination, readyPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalLstatSync = fs.lstatSync;
            let paused = false;
            fs.lstatSync = function pauseAfterDirectEncryptedWrite(file, ...args) {
                const result = originalLstatSync(file, ...args);
                if (!paused && file === destination && Number(result.size) > 0 && result.isFile()) {
                    paused = true;
                    fs.writeFileSync(readyPath, file, { mode: 0o600 });
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
                }
                return result;
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
            } finally {
                sourceDb.close();
            }
        `;
        const child = spawn(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '--eval', source, fixture.dbPath, output, ready, FIXED_KEY.toString('hex')],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await waitForFile(ready, child);
        const exit = waitForExit(child);
        child.kill('SIGKILL');
        await expect(exit).resolves.toEqual({ code: null, signal: 'SIGKILL' });

        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        const survivors = exportDatabaseSurvivors(output);
        expect({
            plaintextHeaders: survivors
                .filter(({ bytes }) => bytes.subarray(0, 16).toString('binary') === 'SQLite format 3\0')
                .map(({ name }) => name),
            leakedFiles: survivors.filter(({ bytes }) => bytes.includes(Buffer.from(marker))).map(({ name }) => name),
        }).toEqual({ plaintextHeaders: [], leakedFiles: [] });
        const keyed = openKeyedDatabase(output, FIXED_KEY, { readonly: true, fileMustExist: true });
        try {
            expect(keyed.prepare('SELECT title FROM sessions WHERE title = ?').get(marker)).toEqual({ title: marker });
        } finally {
            keyed.close();
        }
    }, 15000);

    it.each(['move', 'create', 'rollback-restore', 'rollback-cleanup'] as const)(
        'keeps every --force %s crash survivor recoverable and non-plaintext',
        async (phase) => {
            const { fixture } = seedExportFixture();
            const marker = `force-${phase}-encrypted-secret`;
            fixture.db.prepare("UPDATE sessions SET title = ? WHERE native_id = 'primary-session'").run(marker);
            fixture.db.pragma('wal_checkpoint(TRUNCATE)');
            const sourceBytes = readFileSync(fixture.dbPath);
            fixture.close();

            const output = path.join(fixture.directory, `force-${phase}.db`);
            const priorDestination = Buffer.from(`recoverable prior destination at ${phase}`);
            writeFileSync(output, priorDestination);
            const ready = path.join(fixture.directory, `force-${phase}.ready`);
            const source = `
                import { createRequire, syncBuiltinESMExports } from 'node:module';

                const [sourcePath, destination, readyPath, phase, keyHex] = process.argv.slice(1);
                const require = createRequire(import.meta.url);
                const fs = require('node:fs');
                const originalLinkSync = fs.linkSync;
                const originalOpenSync = fs.openSync;
                const originalRenameSync = fs.renameSync;
                const originalUnlinkSync = fs.unlinkSync;
                let rollbackPath = '';
                const pause = (boundary) => {
                    fs.writeFileSync(readyPath, JSON.stringify({ boundary, rollbackPath }), { mode: 0o600 });
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
                };
                fs.renameSync = function pauseAtMove(oldPath, newPath, ...args) {
                    const result = originalRenameSync(oldPath, newPath, ...args);
                    if (oldPath === destination && typeof newPath === 'string' && newPath.endsWith('.rollback')) {
                        rollbackPath = newPath;
                        if (phase === 'move') pause('move');
                    }
                    return result;
                };
                fs.linkSync = function pauseAtRollbackRestore(oldPath, newPath, ...args) {
                    const result = originalLinkSync(oldPath, newPath, ...args);
                    if (phase === 'rollback-restore' && oldPath === rollbackPath && newPath === destination) {
                        pause('rollback-restore');
                    }
                    return result;
                };
                fs.openSync = function pauseAtCreate(file, flags, ...args) {
                    const descriptor = originalOpenSync(file, flags, ...args);
                    if (phase === 'create' && file === destination && (flags & fs.constants.O_EXCL) !== 0) pause('create');
                    return descriptor;
                };
                fs.unlinkSync = function pauseAtRollbackCleanup(file, ...args) {
                    if (
                        phase === 'rollback-cleanup' &&
                        typeof file === 'string' &&
                        file.startsWith(rollbackPath + '.') &&
                        file.endsWith('.discard')
                    ) {
                        rollbackPath = file;
                        pause('rollback-cleanup');
                    }
                    return originalUnlinkSync(file, ...args);
                };
                syncBuiltinESMExports();

                const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
                const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
                const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
                if (phase === 'rollback-restore') {
                    const originalPrepare = sourceDb.prepare.bind(sourceDb);
                    sourceDb.prepare = function failSnapshotWrite(sql, ...args) {
                        if (sql.startsWith('ATTACH DATABASE ? AS ')) {
                            return { run() { throw new Error('injected writer failure'); } };
                        }
                        return originalPrepare(sql, ...args);
                    };
                }
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                } finally {
                    sourceDb.close();
                }
            `;
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    source,
                    fixture.dbPath,
                    output,
                    ready,
                    phase,
                    FIXED_KEY.toString('hex'),
                ],
                { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
            );

            const exit = waitForExit(child);
            await waitForFile(ready, child);
            child.kill('SIGKILL');
            await expect(exit).resolves.toEqual({ code: null, signal: 'SIGKILL' });

            const state = JSON.parse(readFileSync(ready, 'utf8')) as { boundary: string; rollbackPath: string };
            expect(state.boundary).toBe(phase);
            if (phase === 'rollback-restore') {
                expect(readFileSync(output)).toEqual(priorDestination);
            }
            expect(readFileSync(state.rollbackPath)).toEqual(priorDestination);
            expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
            const survivors = exportDatabaseSurvivors(output);
            expect({
                plaintextHeaders: survivors
                    .filter(({ bytes }) => bytes.subarray(0, 16).toString('binary') === 'SQLite format 3\0')
                    .map(({ name }) => name),
                leakedFiles: survivors.filter(({ bytes }) => bytes.includes(Buffer.from(marker))).map(({ name }) => name),
            }).toEqual({ plaintextHeaders: [], leakedFiles: [] });

            const sourceDb = openKeyedDatabase(fixture.dbPath, FIXED_KEY, { fileMustExist: true });
            try {
                exportAll(sourceDb, output, FIXED_KEY, true);
            } finally {
                sourceDb.close();
            }
            expect(readFileSync(state.rollbackPath)).toEqual(priorDestination);
            const keyed = openKeyedDatabase(output, FIXED_KEY, { readonly: true, fileMustExist: true });
            try {
                expect(keyed.prepare('SELECT title FROM sessions WHERE title = ?').get(marker)).toEqual({ title: marker });
            } finally {
                keyed.close();
            }
        },
        30000,
    );

    it('never opens the raw source stream that an in-place overwrite could corrupt', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const marker = 'in-place-plaintext-secret';
        const substitute = path.join(fixture.directory, 'in-place-plaintext.db');
        const substituteDb = new Database(substitute);
        substituteDb.exec('CREATE TABLE in_place_probe (payload TEXT NOT NULL)');
        substituteDb.prepare('INSERT INTO in_place_probe (payload) VALUES (?)').run(marker);
        substituteDb.close();
        const output = path.join(fixture.directory, 'in-place-race.db');
        const ready = path.join(fixture.directory, 'in-place-race.ready');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, substitutePath, destination, readyPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const sourceDb = (await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)})).openKeyedDatabase(
                sourcePath,
                Buffer.from(keyHex, 'hex'),
                { fileMustExist: true },
            );
            const originalOpenSync = fs.openSync;
            const originalReadSync = fs.readSync;
            let sourceDescriptor;
            let rawSourceOpens = 0;
            let rawStreamReads = 0;

            fs.openSync = function captureCopyDescriptors(file, flags, ...args) {
                const descriptor = originalOpenSync(file, flags, ...args);
                if (file === sourcePath) {
                    sourceDescriptor = descriptor;
                    rawSourceOpens += 1;
                }
                return descriptor;
            };
            fs.readSync = function countRawSourceReads(descriptor, buffer, offset, length, position) {
                const bytesRead = originalReadSync(descriptor, buffer, offset, length, position);
                if (descriptor === sourceDescriptor && position === null) {
                    rawStreamReads += 1;
                }
                return bytesRead;
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
                fs.writeFileSync(readyPath, JSON.stringify({ rawSourceOpens, rawStreamReads }), { mode: 0o600 });
            } finally {
                sourceDb.close();
            }
        `;

        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                substitute,
                output,
                ready,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        expect(JSON.parse(readFileSync(ready, 'utf8'))).toEqual({ rawSourceOpens: 0, rawStreamReads: 0 });

        const survivors = exportDatabaseSurvivors(output);
        expect({
            plaintextHeaders: survivors
                .filter(({ bytes }) => bytes.subarray(0, 16).toString('binary') === 'SQLite format 3\0')
                .map(({ name }) => name),
            leakedFiles: survivors.filter(({ bytes }) => bytes.includes(Buffer.from(marker))).map(({ name }) => name),
        }).toEqual({ plaintextHeaders: [], leakedFiles: [] });
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        expect(readFileSync(substitute).includes(Buffer.from(marker))).toBe(true);
    }, 15000);

    it('exports one SQLite snapshot while a keyed WAL writer checkpoints', async () => {
        const { fixture } = seedExportFixture();
        const rowCount = 1_024;
        const payloadBytes = 64 * 1024;
        fixture.db.exec('CREATE TABLE full_snapshot_probe (id INTEGER PRIMARY KEY, generation TEXT NOT NULL, payload BLOB NOT NULL)');
        const insert = fixture.db.prepare('INSERT INTO full_snapshot_probe (id, generation, payload) VALUES (?, ?, ?)');
        const oldPayload = Buffer.alloc(payloadBytes, 0x4f);
        fixture.db.transaction(() => {
            for (let id = 1; id <= rowCount; id += 1) {
                insert.run(id, 'old', oldPayload);
            }
        })();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        fixture.close();

        const output = path.join(fixture.directory, 'concurrent-snapshot.db');
        const heartbeat = path.join(fixture.directory, 'concurrent-writer.heartbeat');
        const resumeWriter = path.join(fixture.directory, 'concurrent-writer.resume');
        const writerAdvanced = path.join(fixture.directory, 'concurrent-writer.advanced');
        const stop = path.join(fixture.directory, 'concurrent-writer.stop');
        const targetReady = path.join(fixture.directory, 'concurrent-export-target.ready');
        const beginVacuum = path.join(fixture.directory, 'concurrent-export.begin');
        const exportState = path.join(fixture.directory, 'concurrent-export.state');
        const writerSource = `
            import { existsSync, writeFileSync } from 'node:fs';

            const [sourcePath, heartbeatPath, resumePath, advancedPath, stopPath, keyHex, rows] = process.argv.slice(1);
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const writer = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            writer.pragma('journal_mode = WAL');
            const updateAll = writer.prepare('UPDATE full_snapshot_probe SET generation = ?');
            const sleeper = new Int32Array(new SharedArrayBuffer(4));
            let generation = 1;
            updateAll.run('g' + String(generation).padStart(8, '0'));
            writer.pragma('wal_checkpoint(TRUNCATE)');
            writeFileSync(heartbeatPath, String(generation), { mode: 0o600 });
            while (!existsSync(resumePath)) Atomics.wait(sleeper, 0, 0, 10);
            while (!existsSync(stopPath)) {
                generation += 1;
                const label = 'g' + String(generation).padStart(8, '0');
                updateAll.run(label);
                writer.pragma('wal_checkpoint(TRUNCATE)');
                writeFileSync(heartbeatPath, String(generation), { mode: 0o600 });
                if (generation === 2) writeFileSync(advancedPath, 'ready', { mode: 0o600 });
                Atomics.wait(sleeper, 0, 0, 5);
            }
            writer.close();
        `;
        const writer = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                writerSource,
                fixture.dbPath,
                heartbeat,
                resumeWriter,
                writerAdvanced,
                stop,
                FIXED_KEY.toString('hex'),
                String(rowCount),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );
        const writerExit = waitForExit(writer);
        await waitForFile(heartbeat, writer);

        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, destination, heartbeatPath, targetReadyPath, beginPath, statePath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            const originalOpenSync = fs.openSync;
            let targetCreationReached = false;
            fs.openSync = function pauseAfterDirectTargetCreation(file, flags, ...args) {
                const descriptor = originalOpenSync(file, flags, ...args);
                if (!targetCreationReached && file === destination) {
                    targetCreationReached = true;
                    fs.writeFileSync(targetReadyPath, 'ready', { mode: 0o600 });
                    const sleeper = new Int32Array(new SharedArrayBuffer(4));
                    while (!fs.existsSync(beginPath)) Atomics.wait(sleeper, 0, 0, 10);
                }
                return descriptor;
            };
            syncBuiltinESMExports();
            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            try {
                const before = Number(fs.readFileSync(heartbeatPath, 'utf8'));
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
                const after = Number(fs.readFileSync(heartbeatPath, 'utf8'));
                fs.writeFileSync(statePath, JSON.stringify({ before, after, targetCreationReached }), { mode: 0o600 });
            } finally {
                sourceDb.close();
            }
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                output,
                heartbeat,
                targetReady,
                beginVacuum,
                exportState,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let exportStderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            exportStderr += chunk.toString('utf8');
        });
        const exit = waitForExit(child);
        await waitForFile(targetReady, child);
        writeFileSync(resumeWriter, 'resume', { mode: 0o600 });
        await waitForFile(writerAdvanced, writer);
        writeFileSync(beginVacuum, 'begin', { mode: 0o600 });
        const exportExit = await exit;
        writeFileSync(stop, 'stop', { mode: 0o600 });
        await expect(writerExit).resolves.toEqual({ code: 0, signal: null });
        expect({ ...exportExit, stderr: exportStderr }).toEqual({ code: 0, signal: null, stderr: '' });
        const state = JSON.parse(readFileSync(exportState, 'utf8')) as {
            before: number;
            after: number;
            targetCreationReached: boolean;
        };
        expect(state.targetCreationReached).toBe(true);
        expect(state.after).toBeGreaterThan(state.before);

        const exported = openKeyedDatabase(output, FIXED_KEY, { readonly: true, fileMustExist: true });
        try {
            expect(exported.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            const generations = exported
                .prepare('SELECT generation, COUNT(*) AS count FROM full_snapshot_probe GROUP BY generation ORDER BY generation')
                .all() as Array<{ generation: string; count: number }>;
            expect(generations).toHaveLength(1);
            expect(generations[0]).toEqual({ generation: expect.stringMatching(/^g\d{8}$/), count: rowCount });
        } finally {
            exported.close();
        }
    }, 60000);

    it('exports the selected connection when its pathname is replaced by same-key ciphertext', async () => {
        const selected = seedExportFixture();
        const substitute = seedExportFixture();
        const selectedMarker = 'selected-source-row';
        const substituteMarker = 'same-key-substitute-row';
        selected.fixture.db.prepare("UPDATE sessions SET title = ? WHERE native_id = 'primary-session'").run(selectedMarker);
        substitute.fixture.db.prepare("UPDATE sessions SET title = ? WHERE native_id = 'primary-session'").run(substituteMarker);
        selected.fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        substitute.fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const selectedBytes = readFileSync(selected.fixture.dbPath);
        const substituteBytes = readFileSync(substitute.fixture.dbPath);
        selected.fixture.close();
        substitute.fixture.close();

        const retiredSelected = path.join(selected.fixture.directory, 'retired-selected.db');
        const output = path.join(selected.fixture.directory, 'same-key-substitution.db');
        const reached = path.join(selected.fixture.directory, 'same-key-substitution.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, substitutePath, retiredPath, destination, reachedPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            const originalOpenSync = fs.openSync;
            let substituted = false;
            fs.openSync = function substituteSourceWhenSnapshotTargetIsCreated(file, flags, ...args) {
                const descriptor = originalOpenSync(file, flags, ...args);
                if (!substituted && file === destination) {
                    fs.renameSync(sourcePath, retiredPath);
                    fs.renameSync(substitutePath, sourcePath);
                    substituted = true;
                }
                return descriptor;
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
                fs.writeFileSync(reachedPath, JSON.stringify({ substituted }), { mode: 0o600 });
            } finally {
                sourceDb.close();
            }
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                selected.fixture.dbPath,
                substitute.fixture.dbPath,
                retiredSelected,
                output,
                reached,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        expect(JSON.parse(readFileSync(reached, 'utf8'))).toEqual({ substituted: true });
        const exported = openKeyedDatabase(output, FIXED_KEY, { readonly: true, fileMustExist: true });
        try {
            expect(exported.prepare("SELECT title FROM sessions WHERE native_id = 'primary-session'").get()).toEqual({
                title: selectedMarker,
            });
        } finally {
            exported.close();
        }
        const selectedSurvivor = existsSync(retiredSelected) ? retiredSelected : selected.fixture.dbPath;
        const substituteSurvivor = existsSync(substitute.fixture.dbPath) ? substitute.fixture.dbPath : selected.fixture.dbPath;
        expect(readFileSync(selectedSurvivor)).toEqual(selectedBytes);
        expect(readFileSync(substituteSurvivor)).toEqual(substituteBytes);
    }, 15000);

    it('preserves int64 session ids and their dependent project rows', () => {
        const { fixture, project } = seedExportFixture();
        const originalSession = fixture.db.prepare("SELECT id FROM sessions WHERE native_id = 'primary-session'").safeIntegers().get() as {
            id: bigint;
        };
        const largeSessionId = 9_007_199_254_740_993n;
        fixture.db.pragma('foreign_keys = OFF');
        fixture.db.prepare('UPDATE memories SET session_id = ? WHERE session_id = ?').run(largeSessionId, originalSession.id);
        fixture.db.prepare('UPDATE session_rollups SET session_id = ? WHERE session_id = ?').run(largeSessionId, originalSession.id);
        fixture.db.prepare('UPDATE sessions SET id = ? WHERE id = ?').run(largeSessionId, originalSession.id);
        fixture.db.pragma('foreign_keys = ON');
        expect(fixture.db.pragma('foreign_key_check')).toEqual([]);
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        const output = path.join(fixture.directory, 'int64-project-export.db');

        exportProject(fixture.db, project, output, FIXED_KEY);

        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        const exported = openKeyedDatabase(output, FIXED_KEY, { readonly: true, fileMustExist: true });
        try {
            expect(exported.prepare("SELECT id FROM sessions WHERE native_id = 'primary-session'").safeIntegers().get()).toEqual({
                id: largeSessionId,
            });
            expect(exported.prepare('SELECT session_id FROM memories').safeIntegers().all()).toContainEqual({ session_id: largeSessionId });
            expect(exported.prepare('SELECT session_id FROM session_rollups').safeIntegers().all()).toContainEqual({
                session_id: largeSessionId,
            });
        } finally {
            exported.close();
        }
    }, 15000);

    it('preserves an int64 project id selected through the production resolver', () => {
        const { fixture } = seedExportFixture();
        const largeProjectId = 9_007_199_254_740_993n;
        const projectPath = path.join(fixture.directory, 'huge-project');
        const timestamp = '2026-09-05T00:00:00.000Z';
        fixture.db
            .prepare(
                `INSERT INTO projects
                 (id, path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                 VALUES (?, ?, 'huge-project', NULL, NULL, NULL, ?, ?)`,
            )
            .run(largeProjectId, projectPath, timestamp, timestamp);
        fixture.db
            .prepare(
                `INSERT INTO sessions
                 (id, tool, native_id, project_id, source_path, started_at, last_ingested_at)
                 VALUES (47, 'codex', 'huge-project-session', ?, ?, ?, ?)`,
            )
            .run(largeProjectId, path.join(projectPath, 'session.jsonl'), timestamp, timestamp);
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        const resolution = new ProjectResolver(fixture.db).resolve('huge-project');
        if (!('project' in resolution) || resolution.project === null) {
            throw new Error('large project did not resolve');
        }
        const output = path.join(fixture.directory, 'int64-project-id-export.db');

        exportProject(fixture.db, resolution.project, output, FIXED_KEY);

        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        const exported = openKeyedDatabase(output, FIXED_KEY, { readonly: true, fileMustExist: true });
        try {
            expect(resolution.project.paths).toEqual([projectPath]);
            expect(exported.prepare('SELECT id FROM projects').safeIntegers().all()).toEqual([{ id: largeProjectId }]);
            expect(exported.prepare('SELECT id, project_id FROM sessions').safeIntegers().all()).toEqual([
                { id: 47n, project_id: largeProjectId },
            ]);
        } finally {
            exported.close();
        }
    }, 15000);

    it('validates the full-export ATTACH handle before it can mutate a substituted database', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const output = path.join(fixture.directory, 'full-reopen-output.db');
        const ownedAside = path.join(fixture.directory, 'full-reopen-owned-aside.db');
        const unknownTarget = path.join(fixture.directory, 'full-reopen-unknown-target.db');
        const unknownBytes = Buffer.alloc(0);
        writeFileSync(unknownTarget, unknownBytes);
        const reached = path.join(fixture.directory, 'full-reopen.reached');
        const source = `
            import { symlinkSync, renameSync, writeFileSync } from 'node:fs';

            const [sourcePath, destination, ownedAside, unknownTarget, reachedPath, keyHex] = process.argv.slice(1);
            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            const originalPrepare = sourceDb.prepare.bind(sourceDb);
            let seamReached = false;
            sourceDb.prepare = function substituteAttachedTarget(sql, ...args) {
                const statement = originalPrepare(sql, ...args);
                if (!sql.startsWith('ATTACH DATABASE ? AS ')) return statement;
                return {
                    run(output) {
                        renameSync(output, ownedAside);
                        symlinkSync(unknownTarget, output);
                        seamReached = true;
                        return statement.run(output);
                    },
                };
            };
            let errorMessage = '';
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            } finally {
                sourceDb.close();
            }
            writeFileSync(reachedPath, JSON.stringify({ seamReached, errorMessage }), { mode: 0o600 });
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                output,
                ownedAside,
                unknownTarget,
                reached,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as { seamReached: boolean; errorMessage: string };
        expect(state.seamReached).toBe(true);
        expect(state.errorMessage).not.toBe('');
        expect(readFileSync(unknownTarget)).toEqual(unknownBytes);
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
    }, 15000);

    it('validates the project-export SQLite handle before it can mutate a substituted database', async () => {
        const { fixture, project } = seedExportFixture();
        fixture.db.prepare("UPDATE sessions SET native_id = 'project-reopen-secret' WHERE native_id = 'primary-session'").run();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const unknownTarget = path.join(fixture.directory, 'project-reopen-unknown.db');
        const unknown = new Database(unknownTarget);
        unknown.pragma("cipher='chacha20'");
        unknown.key(Buffer.from(`raw:${FIXED_KEY.toString('hex')}`, 'ascii'));
        unknown.exec("CREATE TABLE unrelated (payload TEXT NOT NULL); INSERT INTO unrelated VALUES ('unknown-original')");
        unknown.close();
        const unknownBytes = readFileSync(unknownTarget);
        const output = path.join(fixture.directory, 'project-reopen-output.db');
        const ownedAside = path.join(fixture.directory, 'project-reopen-owned-aside.db');
        const retainedSymlink = path.join(fixture.directory, 'project-reopen-retained-symlink');
        const reached = path.join(fixture.directory, 'project-reopen.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, unknownTarget, destination, ownedAside, retainedSymlink, reachedPath, projectJson, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalOpenSync = fs.openSync;
            const originalLstatSync = fs.lstatSync;
            let redirected = false;
            let restored = false;
            fs.openSync = function redirectProjectTarget(file, flags, ...args) {
                const descriptor = originalOpenSync(file, flags, ...args);
                if (!redirected && file === destination && typeof flags === 'number' && (flags & 3) === fs.constants.O_RDONLY) {
                    fs.renameSync(destination, ownedAside);
                    fs.symlinkSync(unknownTarget, destination);
                    redirected = true;
                }
                return descriptor;
            };
            fs.lstatSync = function restoreOwnedPath(file, ...args) {
                if (redirected && !restored && file === destination) {
                    fs.renameSync(destination, retainedSymlink);
                    fs.renameSync(ownedAside, destination);
                    restored = true;
                }
                return originalLstatSync(file, ...args);
            };
            syncBuiltinESMExports();

            const { exportProject } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            let errorMessage = '';
            try {
                exportProject(sourceDb, JSON.parse(projectJson), destination, Buffer.from(keyHex, 'hex'));
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            } finally {
                sourceDb.close();
            }
            fs.writeFileSync(reachedPath, JSON.stringify({ redirected, restored, errorMessage }), { mode: 0o600 });
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                unknownTarget,
                output,
                ownedAside,
                retainedSymlink,
                reached,
                JSON.stringify(project),
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as {
            redirected: boolean;
            restored: boolean;
            errorMessage: string;
        };
        expect({ redirected: state.redirected, restored: state.restored }).toEqual({ redirected: true, restored: true });
        expect(state.errorMessage).not.toBe('');
        expect(readFileSync(unknownTarget)).toEqual(unknownBytes);
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
    }, 15000);

    it.each(['main-fchmod', 'main-fstat', 'main-close'])(
        'handles owned-file boundary %s without losing the authorized destination',
        async (fault) => {
            const { fixture } = seedExportFixture();
            fixture.db.pragma('wal_checkpoint(TRUNCATE)');
            fixture.close();

            const output = path.join(fixture.directory, `owned-create-${fault}.db`);
            const priorDestination = Buffer.from(`prior destination survives ${fault}`);
            writeFileSync(output, priorDestination);
            const reached = path.join(fixture.directory, `owned-create-${fault}.reached`);
            const source = `
                import { createRequire, syncBuiltinESMExports } from 'node:module';

                const [sourcePath, destination, reachedPath, fault, keyHex] = process.argv.slice(1);
                const require = createRequire(import.meta.url);
                const fs = require('node:fs');
                const originalOpenSync = fs.openSync;
                const originalFchmodSync = fs.fchmodSync;
                const originalFstatSync = fs.fstatSync;
                const originalCloseSync = fs.closeSync;
                let mainDescriptor;
                let seamReached = false;
                fs.openSync = function captureOwnedDescriptor(file, flags, ...args) {
                    const descriptor = originalOpenSync(file, flags, ...args);
                    if (typeof flags === 'number' && (flags & fs.constants.O_EXCL) !== 0) {
                        if (file === destination) mainDescriptor = descriptor;
                    }
                    return descriptor;
                };
                fs.fchmodSync = function failOwnedFchmod(descriptor, ...args) {
                    if (!seamReached && fault.endsWith('fchmod') && descriptor === mainDescriptor) {
                        seamReached = true;
                        throw Object.assign(new Error('injected ' + fault), { code: 'EIO' });
                    }
                    return originalFchmodSync(descriptor, ...args);
                };
                fs.fstatSync = function failOwnedFstat(descriptor, ...args) {
                    if (!seamReached && fault.endsWith('fstat') && descriptor === mainDescriptor) {
                        seamReached = true;
                        throw Object.assign(new Error('injected ' + fault), { code: 'EIO' });
                    }
                    return originalFstatSync(descriptor, ...args);
                };
                fs.closeSync = function failOwnedClose(descriptor) {
                    const result = originalCloseSync(descriptor);
                    if (!seamReached && fault.endsWith('close') && descriptor === mainDescriptor) {
                        seamReached = true;
                        throw Object.assign(new Error('injected ' + fault), { code: 'EIO' });
                    }
                    return result;
                };
                syncBuiltinESMExports();

                const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
                const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
                const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
                let errorMessage = '';
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                } catch (error) {
                    errorMessage = error instanceof Error ? error.message : String(error);
                } finally {
                    sourceDb.close();
                }
                fs.writeFileSync(reachedPath, JSON.stringify({ seamReached, errorMessage }), { mode: 0o600 });
            `;
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    source,
                    fixture.dbPath,
                    output,
                    reached,
                    fault,
                    FIXED_KEY.toString('hex'),
                ],
                { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
            );

            await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
            const state = JSON.parse(readFileSync(reached, 'utf8')) as { seamReached: boolean; errorMessage: string };
            expect(state.seamReached).toBe(true);
            expect(state.errorMessage).toContain(`injected ${fault}`);
            expect(readFileSync(output)).toEqual(priorDestination);
            expect(temporaryFilesFor(output)).toEqual([]);
        },
        15000,
    );

    it.each(['close', 'lstat'])(
        'restores the prior destination when post-move rollback %s fails before state transfer',
        async (fault) => {
            const { fixture } = seedExportFixture();
            fixture.db.pragma('wal_checkpoint(TRUNCATE)');
            fixture.close();

            const output = path.join(fixture.directory, `rollback-state-${fault}.db`);
            const priorDestination = Buffer.from(`prior destination survives rollback ${fault}`);
            writeFileSync(output, priorDestination);
            const reached = path.join(fixture.directory, `rollback-state-${fault}.reached`);
            const source = `
                import { createRequire, syncBuiltinESMExports } from 'node:module';

                const [sourcePath, destination, reachedPath, fault, keyHex] = process.argv.slice(1);
                const require = createRequire(import.meta.url);
                const fs = require('node:fs');
                const originalOpenSync = fs.openSync;
                const originalCloseSync = fs.closeSync;
                const originalRenameSync = fs.renameSync;
                const originalLstatSync = fs.lstatSync;
                let preserveDescriptor;
                let rollbackPath = '';
                let seamReached = false;
                fs.openSync = function capturePreserveDescriptor(file, flags, ...args) {
                    const descriptor = originalOpenSync(file, flags, ...args);
                    if (preserveDescriptor === undefined && file === destination && typeof flags === 'number' && (flags & 3) === fs.constants.O_RDONLY) {
                        preserveDescriptor = descriptor;
                    }
                    return descriptor;
                };
                fs.renameSync = function captureRollbackPath(oldPath, newPath, ...args) {
                    const result = originalRenameSync(oldPath, newPath, ...args);
                    if (oldPath === destination && typeof newPath === 'string' && newPath.endsWith('.rollback')) {
                        rollbackPath = newPath;
                    }
                    return result;
                };
                fs.closeSync = function failPostMoveClose(descriptor) {
                    const result = originalCloseSync(descriptor);
                    if (!seamReached && fault === 'close' && descriptor === preserveDescriptor && rollbackPath !== '') {
                        seamReached = true;
                        throw Object.assign(new Error('injected rollback close'), { code: 'EIO' });
                    }
                    return result;
                };
                fs.lstatSync = function failPostMoveLstat(file, ...args) {
                    if (!seamReached && fault === 'lstat' && file === rollbackPath) {
                        seamReached = true;
                        throw Object.assign(new Error('injected rollback lstat'), { code: 'EIO' });
                    }
                    return originalLstatSync(file, ...args);
                };
                syncBuiltinESMExports();

                const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
                const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
                const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
                let errorMessage = '';
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                } catch (error) {
                    errorMessage = error instanceof Error ? error.message : String(error);
                } finally {
                    sourceDb.close();
                }
                fs.writeFileSync(reachedPath, JSON.stringify({ seamReached, rollbackPath, errorMessage }), { mode: 0o600 });
            `;
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    source,
                    fixture.dbPath,
                    output,
                    reached,
                    fault,
                    FIXED_KEY.toString('hex'),
                ],
                { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
            );

            await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
            const state = JSON.parse(readFileSync(reached, 'utf8')) as {
                seamReached: boolean;
                rollbackPath: string;
                errorMessage: string;
            };
            expect(state.seamReached).toBe(true);
            expect(state.errorMessage).toContain(`injected rollback ${fault}`);
            expect(readFileSync(output)).toEqual(priorDestination);
            expect(temporaryFilesFor(output)).toEqual([]);
        },
        15000,
    );

    it.each([
        ['full', '-journal'],
        ['full', '-shm'],
        ['full', '-wal'],
        ['project', '-journal'],
        ['project', '-shm'],
        ['project', '-wal'],
    ] as const)('refuses %s export when an unknown direct %s companion exists', (scope, suffix) => {
        const { fixture, project } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        const output = path.join(fixture.directory, `unknown-direct-companion-${scope}-${suffix.slice(1)}.db`);
        const companionPath = `${output}${suffix}`;
        const marker = Buffer.from(`unknown-${scope}-${suffix}-marker-${path.basename(fixture.directory)}`);
        writeFileSync(companionPath, marker);
        const identity = lstatSync(companionPath, { bigint: true });

        let errorMessage = '';
        let returned = false;
        try {
            if (scope === 'full') {
                exportAll(fixture.db, output, FIXED_KEY);
            } else {
                exportProject(fixture.db, project, output, FIXED_KEY);
            }
            returned = true;
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error);
        }

        expect({ errorMessage, returned }).toEqual({ errorMessage: BACKUP_DESTINATION_COMPANION_ERROR, returned: false });
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        expect(existsSync(output)).toBe(false);
        const current = lstatSync(companionPath, { bigint: true });
        expect({
            path: companionPath,
            dev: current.dev,
            ino: current.ino,
            regular: current.isFile(),
            bytes: readFileSync(companionPath),
        }).toEqual({
            path: companionPath,
            dev: identity.dev,
            ino: identity.ino,
            regular: true,
            bytes: marker,
        });
        expect(exportDatabaseSurvivors(output)).toEqual([{ name: path.basename(companionPath), bytes: marker }]);
        expect(temporaryFilesFor(output).filter((entry) => entry !== path.basename(companionPath))).toEqual([]);
    });

    it.skipIf(!isSupportedPlatform())(
        'refuses an unknown direct FIFO journal without opening or mutating it',
        async () => {
            const { fixture } = seedExportFixture();
            fixture.db.pragma('wal_checkpoint(TRUNCATE)');
            const sourceBytes = readFileSync(fixture.dbPath);
            fixture.close();

            const output = path.join(fixture.directory, 'unknown-direct-fifo-journal.db');
            const journal = `${output}-journal`;
            const created = spawnSync('mkfifo', [journal], { encoding: 'utf8' });
            if (created.error !== undefined) {
                throw created.error;
            }
            expect({ status: created.status, stderr: created.stderr }).toEqual({ status: 0, stderr: '' });
            const identity = lstatSync(journal, { bigint: true });
            expect(identity.isFIFO()).toBe(true);

            const started = path.join(fixture.directory, 'unknown-direct-fifo-journal.started');
            const resultPath = path.join(fixture.directory, 'unknown-direct-fifo-journal.result');
            const source = `
            import { writeFileSync } from 'node:fs';

            const [sourcePath, destination, startedPath, resultPath, keyHex] = process.argv.slice(1);
            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            let errorMessage = '';
            let returned = false;
            writeFileSync(startedPath, 'started', { mode: 0o600 });
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
                returned = true;
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            } finally {
                sourceDb.close();
            }
            writeFileSync(resultPath, JSON.stringify({ errorMessage, returned }), { mode: 0o600 });
        `;
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    source,
                    fixture.dbPath,
                    output,
                    started,
                    resultPath,
                    FIXED_KEY.toString('hex'),
                ],
                { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
            );
            const observation = await observeBoundedChild(child, started);
            const result = existsSync(resultPath)
                ? (JSON.parse(readFileSync(resultPath, 'utf8')) as { errorMessage: string; returned: boolean })
                : undefined;
            const identityLocations = readdirSync(fixture.directory).filter((entry) => {
                const current = lstatSync(path.join(fixture.directory, entry), { bigint: true });
                return current.dev === identity.dev && current.ino === identity.ino;
            });

            expect(observation).toEqual({ markerReached: true, forced: null, code: 0, signal: null, stderr: '' });
            expect(result).toEqual({ errorMessage: BACKUP_DESTINATION_COMPANION_ERROR, returned: false });
            expect(identityLocations).toEqual([path.basename(journal)]);
            const current = lstatSync(journal, { bigint: true });
            expect({ dev: current.dev, ino: current.ino, fifo: current.isFIFO() }).toEqual({
                dev: identity.dev,
                ino: identity.ino,
                fifo: true,
            });
            expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
            expect(existsSync(output)).toBe(false);
            expect(exportDatabaseSurvivors(output)).toEqual([{ name: path.basename(journal), bytes: Buffer.alloc(0) }]);
        },
        15000,
    );

    it('keeps attached-export journaling in memory without pathname companion ownership', () => {
        const { fixture } = seedExportFixture();
        const output = path.join(fixture.directory, 'memory-journal.db');
        const originalPragma = fixture.db.pragma.bind(fixture.db);
        let memoryJournalObserved = false;
        const pragmaSpy = vi.spyOn(fixture.db, 'pragma').mockImplementation(((source: string, ...args: unknown[]) => {
            if (source === 'elepha_export.journal_mode = MEMORY') {
                memoryJournalObserved = true;
            }
            return (originalPragma as (...pragmaArgs: unknown[]) => unknown)(source, ...args);
        }) as typeof fixture.db.pragma);

        try {
            exportAll(fixture.db, output, FIXED_KEY);
        } finally {
            pragmaSpy.mockRestore();
        }
        expect(memoryJournalObserved).toBe(true);
        expect(existsSync(`${output}-journal`)).toBe(false);
        expect(existsSync(`${output}-wal`)).toBe(false);
        expect(existsSync(`${output}-shm`)).toBe(false);
        expect(temporaryFilesFor(output)).toEqual([]);
    });

    it.skipIf(!isSupportedPlatform())(
        'does not block when an identity-checked verification link is replaced by a FIFO before header proof',
        async () => {
            const { fixture } = seedExportFixture();
            fixture.db.pragma('wal_checkpoint(TRUNCATE)');
            const sourceBytes = readFileSync(fixture.dbPath);
            fixture.close();

            const output = path.join(fixture.directory, 'verification-header-raced-fifo.db');
            const fifoSource = path.join(fixture.directory, 'verification-header-raced-fifo-source');
            const created = spawnSync('mkfifo', [fifoSource], { encoding: 'utf8' });
            if (created.error !== undefined) {
                throw created.error;
            }
            expect({ status: created.status, stderr: created.stderr }).toEqual({ status: 0, stderr: '' });
            const fifoIdentity = lstatSync(fifoSource, { bigint: true });
            expect(fifoIdentity.isFIFO()).toBe(true);

            const reached = path.join(fixture.directory, 'verification-header-raced-fifo.reached');
            const resultPath = path.join(fixture.directory, 'verification-header-raced-fifo.result');
            const source = `
                import { createRequire, syncBuiltinESMExports } from 'node:module';

                const [sourcePath, destination, fifoSource, reachedPath, resultPath, keyHex] = process.argv.slice(1);
                const require = createRequire(import.meta.url);
                const fs = require('node:fs');
                const originalOpenSync = fs.openSync;
                let retainedProof = '';
                fs.openSync = function substituteVerificationHeaderProof(file, flags, ...args) {
                    if (
                        retainedProof === '' &&
                        typeof file === 'string' &&
                        file.endsWith('.verify') &&
                        typeof flags === 'number' &&
                        (flags & 3) === fs.constants.O_RDONLY
                    ) {
                        retainedProof = file + '.expected';
                        fs.renameSync(file, retainedProof);
                        fs.renameSync(fifoSource, file);
                        fs.writeFileSync(
                            reachedPath,
                            JSON.stringify({
                                noFollow: (flags & (fs.constants.O_NOFOLLOW ?? 0)) !== 0,
                                nonblocking: (flags & fs.constants.O_NONBLOCK) !== 0,
                                proofPath: file,
                                retainedProof,
                            }),
                            { mode: 0o600 },
                        );
                    }
                    return originalOpenSync(file, flags, ...args);
                };
                syncBuiltinESMExports();

                const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
                const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
                const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
                let thrown;
                let returned = false;
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
                    returned = true;
                } catch (error) {
                    thrown = error;
                } finally {
                    sourceDb.close();
                }
                const errorMessages = [];
                const seen = new Set();
                function collectErrors(error) {
                    if (error === undefined || error === null || seen.has(error)) return;
                    seen.add(error);
                    errorMessages.push(error instanceof Error ? error.message : String(error));
                    if (error instanceof AggregateError) {
                        for (const nested of error.errors) collectErrors(nested);
                    }
                    if (error instanceof Error) collectErrors(error.cause);
                }
                collectErrors(thrown);
                fs.writeFileSync(resultPath, JSON.stringify({ errorMessages, retainedProof, returned }), { mode: 0o600 });
            `;
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    source,
                    fixture.dbPath,
                    output,
                    fifoSource,
                    reached,
                    resultPath,
                    FIXED_KEY.toString('hex'),
                ],
                { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
            );
            const observation = await observeBoundedChild(child, reached);
            const marker = JSON.parse(readFileSync(reached, 'utf8')) as {
                noFollow: boolean;
                nonblocking: boolean;
                proofPath: string;
                retainedProof: string;
            };
            const result = existsSync(resultPath)
                ? (JSON.parse(readFileSync(resultPath, 'utf8')) as {
                      errorMessages: string[];
                      retainedProof: string;
                      returned: boolean;
                  })
                : undefined;
            const fifoSurvivors = readdirSync(fixture.directory)
                .map((entry) => path.join(fixture.directory, entry))
                .filter((candidate) => {
                    const current = lstatSync(candidate, { bigint: true });
                    return current.isFIFO() && current.dev === fifoIdentity.dev && current.ino === fifoIdentity.ino;
                });
            const retainedFifo = fifoSurvivors[0];

            expect(marker.proofPath.endsWith('.verify')).toBe(true);
            expect(marker.retainedProof).toBe(`${marker.proofPath}.expected`);
            expect(fifoSurvivors).toHaveLength(1);
            expect(retainedFifo).toBeDefined();
            const retained = lstatSync(marker.retainedProof, { bigint: true });
            expect({
                regular: retained.isFile(),
                plaintext: readFileSync(marker.retainedProof).subarray(0, 16).toString('binary'),
            }).toEqual({
                regular: true,
                plaintext: expect.not.stringMatching('SQLite format 3'),
            });
            expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
            expect(observation).toEqual({ markerReached: true, forced: null, code: 0, signal: null, stderr: '' });
            expect({ noFollow: marker.noFollow, nonblocking: marker.nonblocking }).toEqual({ noFollow: true, nonblocking: true });
            expect(result?.returned).toBe(false);
            expect(result?.retainedProof).toBe(marker.retainedProof);
            expect(result?.errorMessages.length).toBeGreaterThan(0);
            expect(result?.errorMessages.some((message) => retainedFifo !== undefined && message.includes(retainedFifo))).toBe(true);
            expect(existsSync(output)).toBe(false);
        },
        15000,
    );

    it('restores a prior destination after verification fails on the completed encrypted object', () => {
        const { fixture } = seedExportFixture();
        const output = path.join(fixture.directory, 'verification-failure.db');
        const priorDestination = Buffer.from('prior destination survives verification failure');
        writeFileSync(output, priorDestination);
        const originalPragma = Database.prototype.pragma;
        let seamReached = false;
        const pragmaSpy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
            this: Database.Database,
            source: string,
            ...args: unknown[]
        ) {
            const descriptorVerification = this.name.startsWith('/dev/fd/') || this.name.startsWith('/proc/self/fd/');
            const namedVerification = this.name.startsWith(`${output}.`) && this.name.endsWith('.verify');
            if ((descriptorVerification || namedVerification) && source === 'integrity_check') {
                seamReached = true;
                throw new Error('injected verification failure');
            }
            return (originalPragma as (...pragmaArgs: unknown[]) => unknown).call(this, source, ...args);
        } as typeof Database.prototype.pragma);

        try {
            expect(() => exportAll(fixture.db, output, FIXED_KEY, true)).toThrow('injected verification failure');
        } finally {
            pragmaSpy.mockRestore();
        }
        expect(seamReached).toBe(true);
        expect(readFileSync(output)).toEqual(priorDestination);
        expect(temporaryFilesFor(output)).toEqual([]);
    });

    it('rejects a same-key database substituted while the verification connection opens', async () => {
        const selected = seedExportFixture();
        const substitute = seedExportFixture();
        substitute.fixture.db.prepare("UPDATE sessions SET title = 'verification-substitute-row'").run();
        selected.fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        substitute.fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(selected.fixture.dbPath);
        const substituteBytes = readFileSync(substitute.fixture.dbPath);
        selected.fixture.close();
        substitute.fixture.close();

        const output = path.join(selected.fixture.directory, 'verification-constructor-race.db');
        const priorDestination = Buffer.from('prior destination survives verifier substitution');
        writeFileSync(output, priorDestination);
        const reached = path.join(selected.fixture.directory, 'verification-constructor-race.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';
            import path from 'node:path';
            import Database from 'better-sqlite3-multiple-ciphers';

            const [sourcePath, substitutePath, destination, reachedPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalFstatSync = fs.fstatSync;
            const originalOpenSync = fs.openSync;
            const originalPragma = Database.prototype.pragma;
            let substituted = false;
            let verificationDescriptor;
            let verificationOpened = false;
            let retiredProof = '';
            fs.openSync = function recordVerificationDescriptor(file, ...args) {
                const descriptor = originalOpenSync(file, ...args);
                if (typeof file === 'string' && file.endsWith('.verify')) {
                    verificationDescriptor = descriptor;
                }
                return descriptor;
            };
            fs.fstatSync = function substituteAfterDescriptorProof(descriptor, ...args) {
                const result = originalFstatSync(descriptor, ...args);
                if (!substituted && descriptor === verificationDescriptor) {
                    const proofName = fs.readdirSync(path.dirname(destination)).find(
                        (entry) => entry.startsWith(path.basename(destination) + '.') && entry.endsWith('.verify'),
                    );
                    if (proofName === undefined) throw new Error('verification proof was not present after descriptor validation');
                    const fullProofPath = path.join(path.dirname(destination), proofName);
                    retiredProof = fullProofPath + '.expected';
                    fs.renameSync(fullProofPath, retiredProof);
                    fs.linkSync(substitutePath, fullProofPath);
                    substituted = true;
                }
                return result;
            };
            Database.prototype.pragma = function recordDescriptorVerification(source, ...args) {
                if (
                    source === 'cipher_salt' &&
                    (this.name.startsWith('/dev/fd/') || this.name.startsWith('/proc/self/fd/') || this.name.endsWith('.verify'))
                ) {
                    verificationOpened = true;
                }
                return originalPragma.call(this, source, ...args);
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            try {
                let errorMessage = '';
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                } catch (error) {
                    errorMessage = error instanceof Error ? error.message : String(error);
                }
                fs.writeFileSync(reachedPath, JSON.stringify({ substituted, verificationOpened, retiredProof, errorMessage }), { mode: 0o600 });
            } finally {
                sourceDb.close();
            }
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                selected.fixture.dbPath,
                substitute.fixture.dbPath,
                output,
                reached,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as {
            substituted: boolean;
            verificationOpened: boolean;
            retiredProof: string;
            errorMessage: string;
        };
        expect(state.substituted).toBe(true);
        expect(state.verificationOpened).toBe(true);
        expect(state.errorMessage).toContain('Backup verification link changed identity.');
        expect(readFileSync(output)).toEqual(priorDestination);
        expect(readFileSync(selected.fixture.dbPath)).toEqual(sourceBytes);
        expect(readFileSync(substitute.fixture.dbPath)).toEqual(substituteBytes);
        const substitutedProofs = readdirSync(selected.fixture.directory).filter((entry) => entry.endsWith('.verify'));
        expect(substitutedProofs).toHaveLength(1);
        expect(readFileSync(path.join(selected.fixture.directory, substitutedProofs[0] ?? 'missing'))).toEqual(substituteBytes);
        const expectedProof = readFileSync(state.retiredProof);
        expect(expectedProof.subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
    }, 15000);

    it('rejects same-salt verification ABA after the owned inode is overwritten in place', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        const cipherSalt = fixture.db.pragma('cipher_salt', { simple: true });
        if (typeof cipherSalt !== 'string') throw new Error('encrypted fixture did not expose its cipher salt');
        fixture.close();

        const substitute = path.join(fixture.directory, 'verification-same-salt.db');
        const substituteDb = new Database(substitute);
        substituteDb.pragma("cipher='chacha20'");
        substituteDb.pragma(`cipher_salt='${cipherSalt}'`);
        substituteDb.key(Buffer.from(`raw:${FIXED_KEY.toString('hex')}`, 'ascii'));
        substituteDb.exec("CREATE TABLE verification_probe (payload TEXT NOT NULL); INSERT INTO verification_probe VALUES ('same-salt')");
        substituteDb.close();
        expect(readFileSync(substitute).subarray(0, 16).toString('hex').toUpperCase()).toBe(cipherSalt);

        const plaintext = path.join(fixture.directory, 'verification-plaintext.db');
        const plaintextDb = new Database(plaintext);
        plaintextDb.exec(
            "CREATE TABLE verification_probe (payload TEXT NOT NULL); INSERT INTO verification_probe VALUES ('plaintext-overwrite')",
        );
        plaintextDb.close();
        const plaintextBytes = readFileSync(plaintext);

        const output = path.join(fixture.directory, 'verification-same-salt-aba.db');
        const priorDestination = Buffer.from('prior destination survives same-salt verification ABA');
        writeFileSync(output, priorDestination);
        const reached = path.join(fixture.directory, 'verification-same-salt-aba.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';
            import path from 'node:path';
            import Database from 'better-sqlite3-multiple-ciphers';

            const [sourcePath, substitutePath, plaintextPath, destination, reachedPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalClose = Database.prototype.close;
            const originalPragma = Database.prototype.pragma;
            let substituted = false;
            let restored = false;
            let retiredProof = '';
            let verifiedConnection;
            let verificationPath = '';
            Database.prototype.pragma = function recordVerifiedConnection(source, ...args) {
                const descriptorVerification = this.name.startsWith('/dev/fd/') || this.name.startsWith('/proc/self/fd/');
                const namedVerification = this.name.endsWith('.verify');
                const result = originalPragma.call(this, source, ...args);
                if (source === 'integrity_check' && (descriptorVerification || namedVerification)) {
                    verifiedConnection = this;
                    verificationPath = this.name;
                }
                return result;
            };
            Database.prototype.close = function overwriteAfterVerifiedConnectionCloses() {
                const result = originalClose.call(this);
                if (!substituted && this === verifiedConnection) {
                    const destinationDirectory = path.dirname(destination);
                    const destinationName = path.basename(destination);
                    const proofName = fs.readdirSync(destinationDirectory).find(
                        (entry) => entry.startsWith(destinationName + '.') && entry.endsWith('.verify'),
                    );
                    if (proofName === undefined) throw new Error('verification proof was not present at the verified-close seam');
                    const proofPath = path.join(destinationDirectory, proofName);
                    fs.writeFileSync(destination, fs.readFileSync(plaintextPath));
                    retiredProof = proofPath + '.expected';
                    fs.renameSync(proofPath, retiredProof);
                    fs.linkSync(substitutePath, proofPath);
                    substituted = true;
                    fs.unlinkSync(proofPath);
                    fs.renameSync(retiredProof, proofPath);
                    restored = true;
                }
                return result;
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            try {
                let errorMessage = '';
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                } catch (error) {
                    errorMessage = error instanceof Error ? error.message : String(error);
                }
                fs.writeFileSync(reachedPath, JSON.stringify({ substituted, restored, verificationPath, errorMessage }), { mode: 0o600 });
            } finally {
                sourceDb.close();
            }
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                substitute,
                plaintext,
                output,
                reached,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as {
            substituted: boolean;
            restored: boolean;
            verificationPath: string;
            errorMessage: string;
        };
        expect({ substituted: state.substituted, restored: state.restored }).toEqual({ substituted: true, restored: true });
        expect(
            state.verificationPath.startsWith('/dev/fd/') ||
                state.verificationPath.startsWith('/proc/self/fd/') ||
                state.verificationPath.endsWith('.verify'),
        ).toBe(true);
        expect(state.errorMessage).toContain('Backup destination changed while it was being verified.');
        expect(readFileSync(output)).toEqual(priorDestination);
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        expect(readFileSync(plaintext)).toEqual(plaintextBytes);
    }, 15000);

    it('rejects a plaintext overwrite after the keyed proof but before proof-link cleanup', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const plaintext = path.join(fixture.directory, 'post-verification-plaintext.db');
        const plaintextDb = new Database(plaintext);
        plaintextDb.exec("CREATE TABLE leak (value TEXT NOT NULL); INSERT INTO leak VALUES ('post-verification-plaintext-secret')");
        plaintextDb.close();
        const plaintextBytes = readFileSync(plaintext);
        const output = path.join(fixture.directory, 'post-verification-overwrite.db');
        const reached = path.join(fixture.directory, 'post-verification-overwrite.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, plaintextPath, destination, reachedPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalRenameSync = fs.renameSync;
            let proofCleanupMoves = 0;
            let seamReached = false;
            fs.renameSync = function overwriteAsProofCleanupStarts(oldPath, newPath, ...args) {
                if (
                    !seamReached &&
                    typeof oldPath === 'string' &&
                    oldPath.endsWith('.verify') &&
                    typeof newPath === 'string' &&
                    newPath.endsWith('.discard')
                ) {
                    proofCleanupMoves += 1;
                    fs.writeFileSync(destination, fs.readFileSync(plaintextPath));
                    seamReached = true;
                }
                return originalRenameSync(oldPath, newPath, ...args);
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            let errorMessage = '';
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            } finally {
                sourceDb.close();
            }
            fs.writeFileSync(reachedPath, JSON.stringify({ seamReached, proofCleanupMoves, errorMessage }), { mode: 0o600 });
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                plaintext,
                output,
                reached,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as {
            seamReached: boolean;
            proofCleanupMoves: number;
            errorMessage: string;
        };
        expect({ seamReached: state.seamReached, proofCleanupMoves: state.proofCleanupMoves }).toEqual({
            seamReached: true,
            proofCleanupMoves: 1,
        });
        expect(state.errorMessage).toContain('changed after its keyed verification completed');
        if (existsSync(output)) {
            expect(readFileSync(output).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        }
        expect(readFileSync(plaintext)).toEqual(plaintextBytes);
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
    }, 15000);

    it('rejects a plaintext pathname substituted after proof cleanup and before the final seal', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const plaintext = path.join(fixture.directory, 'post-final-check-plaintext.db');
        const plaintextDb = new Database(plaintext);
        plaintextDb.exec("CREATE TABLE leak (value TEXT NOT NULL); INSERT INTO leak VALUES ('post-final-check-plaintext-secret')");
        plaintextDb.close();
        const plaintextBytes = readFileSync(plaintext);
        const output = path.join(fixture.directory, 'post-final-check-output.db');
        const encryptedAside = path.join(fixture.directory, 'post-final-check-encrypted-aside.db');
        const reached = path.join(fixture.directory, 'post-final-check.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, plaintextPath, destination, encryptedAside, reachedPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalUnlinkSync = fs.unlinkSync;
            let proofCleanupUnlinks = 0;
            let seamReached = false;
            fs.unlinkSync = function substituteAfterProofCleanup(file, ...args) {
                const result = originalUnlinkSync(file, ...args);
                if (!seamReached && typeof file === 'string' && file.endsWith('.discard')) {
                    proofCleanupUnlinks += 1;
                    fs.renameSync(destination, encryptedAside);
                    fs.renameSync(plaintextPath, destination);
                    seamReached = true;
                }
                return result;
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            let errorMessage = '';
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            } finally {
                sourceDb.close();
            }
            fs.writeFileSync(reachedPath, JSON.stringify({ seamReached, proofCleanupUnlinks, errorMessage }), { mode: 0o600 });
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                plaintext,
                output,
                encryptedAside,
                reached,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as {
            seamReached: boolean;
            proofCleanupUnlinks: number;
            errorMessage: string;
        };
        expect({ seamReached: state.seamReached, proofCleanupUnlinks: state.proofCleanupUnlinks }).toEqual({
            seamReached: true,
            proofCleanupUnlinks: 1,
        });
        expect(state.errorMessage).not.toBe('');
        expect(readFileSync(output)).toEqual(plaintextBytes);
        const keyedAside = openKeyedDatabase(encryptedAside, FIXED_KEY, { readonly: true, fileMustExist: true });
        keyedAside.close();
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
    }, 15000);

    it('rejects a same-inode plaintext overwrite at the final pathname seal after force cleanup', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const plaintext = path.join(fixture.directory, 'final-seal-same-inode-plaintext.db');
        const plaintextDb = new Database(plaintext);
        plaintextDb.exec("CREATE TABLE leak (value TEXT NOT NULL); INSERT INTO leak VALUES ('final-seal-same-inode-secret')");
        plaintextDb.close();
        const plaintextBytes = readFileSync(plaintext);
        const output = path.join(fixture.directory, 'final-seal-same-inode-output.db');
        const priorDestination = Buffer.from('prior destination is committed before the final completion seal');
        writeFileSync(output, priorDestination);
        const reached = path.join(fixture.directory, 'final-seal-same-inode.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, plaintextPath, destination, reachedPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalLstatSync = fs.lstatSync;
            const originalUnlinkSync = fs.unlinkSync;
            let discardUnlinks = 0;
            let seamReached = false;
            fs.unlinkSync = function countCompletedCleanup(file, ...args) {
                const result = originalUnlinkSync(file, ...args);
                if (typeof file === 'string' && file.endsWith('.discard')) {
                    discardUnlinks += 1;
                }
                return result;
            };
            fs.lstatSync = function overwriteBeforeFinalPathnameResult(file, ...args) {
                if (!seamReached && file === destination && discardUnlinks === 2) {
                    fs.writeFileSync(destination, fs.readFileSync(plaintextPath));
                    seamReached = true;
                }
                return originalLstatSync(file, ...args);
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            let returned = false;
            let errorMessage = '';
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                returned = true;
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            } finally {
                sourceDb.close();
            }
            const outputExists = fs.existsSync(destination);
            fs.writeFileSync(
                reachedPath,
                JSON.stringify({
                    discardUnlinks,
                    errorMessage,
                    outputExists,
                    outputHeader: outputExists ? fs.readFileSync(destination).subarray(0, 16).toString('binary') : null,
                    returned,
                    seamReached,
                }),
                { mode: 0o600 },
            );
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                plaintext,
                output,
                reached,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as {
            discardUnlinks: number;
            errorMessage: string;
            outputExists: boolean;
            outputHeader: string | null;
            returned: boolean;
            seamReached: boolean;
        };
        expect(state).toEqual({
            discardUnlinks: 3,
            errorMessage: 'Backup destination changed at its final pathname seal.',
            outputExists: false,
            outputHeader: null,
            returned: false,
            seamReached: true,
        });
        expect(readFileSync(plaintext)).toEqual(plaintextBytes);
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        expect(temporaryFilesFor(output)).toEqual([]);
    }, 15000);

    it('retains the verified output when its committed descriptor close reports failure', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const output = path.join(fixture.directory, 'committed-close-output.db');
        const priorDestination = Buffer.from('prior destination retired before the committed close');
        writeFileSync(output, priorDestination);
        const reached = path.join(fixture.directory, 'committed-close.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, destination, reachedPath, priorHex, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const path = require('node:path');
            const originalOpenSync = fs.openSync;
            const originalCloseSync = fs.closeSync;
            const originalRenameSync = fs.renameSync;
            const originalUnlinkSync = fs.unlinkSync;
            const originalLstatSync = fs.lstatSync;
            let destinationReaders = 0;
            let heldOutputDescriptor;
            let rollbackPath = '';
            let rollbackDiscardPath = '';
            let rollbackRetired = false;
            let finalPathSealReached = false;
            let seamReached = false;
            fs.openSync = function captureHeldOutput(file, flags, ...args) {
                const descriptor = originalOpenSync(file, flags, ...args);
                if (file === destination && typeof flags === 'number' && (flags & 3) === fs.constants.O_RDONLY) {
                    destinationReaders += 1;
                    if (rollbackPath !== '' && heldOutputDescriptor === undefined) {
                        heldOutputDescriptor = descriptor;
                    }
                }
                return descriptor;
            };
            fs.renameSync = function captureRollbackRetirement(oldPath, newPath, ...args) {
                const result = originalRenameSync(oldPath, newPath, ...args);
                if (oldPath === destination && typeof newPath === 'string' && newPath.endsWith('.rollback')) {
                    rollbackPath = newPath;
                }
                if (oldPath === rollbackPath && typeof newPath === 'string' && newPath.endsWith('.discard')) {
                    rollbackDiscardPath = newPath;
                }
                return result;
            };
            fs.unlinkSync = function observeRollbackRetirement(file, ...args) {
                const result = originalUnlinkSync(file, ...args);
                if (file === rollbackDiscardPath) {
                    rollbackRetired = true;
                }
                return result;
            };
            fs.lstatSync = function observeFinalPathSeal(file, ...args) {
                const result = originalLstatSync(file, ...args);
                if (file === destination && rollbackRetired) {
                    finalPathSealReached = true;
                }
                return result;
            };
            fs.closeSync = function failCommittedOutputClose(descriptor) {
                const result = originalCloseSync(descriptor);
                if (!seamReached && descriptor === heldOutputDescriptor && finalPathSealReached) {
                    seamReached = true;
                    throw Object.assign(new Error('injected committed output close'), { code: 'EIO' });
                }
                return result;
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            let returned = false;
            let thrown;
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                returned = true;
            } catch (error) {
                thrown = error;
            } finally {
                sourceDb.close();
            }
            const errorCodes = [];
            const errorMessages = [];
            const visited = new Set();
            function collectErrors(error) {
                if (!(error instanceof Error) || visited.has(error)) return;
                visited.add(error);
                errorMessages.push(error.message);
                if (typeof error.code === 'string') errorCodes.push(error.code);
                if (error instanceof AggregateError) {
                    for (const nested of error.errors) collectErrors(nested);
                }
                collectErrors(error.cause);
            }
            collectErrors(thrown);
            const outputExists = fs.existsSync(destination);
            let keyedReadable = false;
            if (outputExists) {
                try {
                    const exported = openKeyedDatabase(destination, Buffer.from(keyHex, 'hex'), {
                        readonly: true,
                        fileMustExist: true,
                    });
                    exported.prepare('SELECT COUNT(*) FROM projects').get();
                    exported.close();
                    keyedReadable = true;
                } catch {}
            }
            const priorBytes = Buffer.from(priorHex, 'hex');
            const priorSurvivors = fs
                .readdirSync(path.dirname(destination))
                .filter((name) => name === path.basename(destination) || name.startsWith(path.basename(destination) + '.'))
                .filter((name) => {
                    const candidate = path.join(path.dirname(destination), name);
                    return fs.lstatSync(candidate).isFile() && fs.readFileSync(candidate).equals(priorBytes);
                });
            fs.writeFileSync(
                reachedPath,
                JSON.stringify({
                    destinationReaders,
                    errorCodes,
                    errorMessages,
                    finalPathSealReached,
                    keyedReadable,
                    outputExists,
                    priorSurvivors,
                    rollbackRetired,
                    returned,
                    seamReached,
                }),
                { mode: 0o600 },
            );
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                output,
                reached,
                priorDestination.toString('hex'),
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as {
            destinationReaders: number;
            errorCodes: string[];
            errorMessages: string[];
            finalPathSealReached: boolean;
            keyedReadable: boolean;
            outputExists: boolean;
            priorSurvivors: string[];
            rollbackRetired: boolean;
            returned: boolean;
            seamReached: boolean;
        };
        expect(state.destinationReaders).toBeGreaterThanOrEqual(2);
        expect({
            finalPathSealReached: state.finalPathSealReached,
            keyedReadable: state.keyedReadable,
            outputExists: state.outputExists,
            priorSurvivors: state.priorSurvivors,
            rollbackRetired: state.rollbackRetired,
            returned: state.returned,
            seamReached: state.seamReached,
        }).toEqual({
            finalPathSealReached: true,
            keyedReadable: true,
            outputExists: true,
            priorSurvivors: [],
            rollbackRetired: true,
            returned: false,
            seamReached: true,
        });
        expect(state.errorMessages).toContain('injected committed output close');
        expect(state.errorCodes).toContain('EIO');
        expect(state.errorCodes).not.toContain('EBADF');
        expect(readFileSync(output)).not.toEqual(priorDestination);
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        expect(temporaryFilesFor(output)).toEqual([]);
    }, 15000);

    it.each(['rename', 'lstat'])(
        'restores or explicitly names the prior destination when rollback retirement %s reports failure',
        async (fault) => {
            const { fixture } = seedExportFixture();
            fixture.db.pragma('wal_checkpoint(TRUNCATE)');
            const sourceBytes = readFileSync(fixture.dbPath);
            fixture.close();

            const output = path.join(fixture.directory, `rollback-retirement-${fault}.db`);
            const priorDestination = Buffer.from(`prior destination survives rollback retirement ${fault}`);
            writeFileSync(output, priorDestination);
            const reached = path.join(fixture.directory, `rollback-retirement-${fault}.reached`);
            const source = `
                import { createRequire, syncBuiltinESMExports } from 'node:module';

                const [sourcePath, destination, reachedPath, priorHex, fault, keyHex] = process.argv.slice(1);
                const require = createRequire(import.meta.url);
                const fs = require('node:fs');
                const path = require('node:path');
                const originalRenameSync = fs.renameSync;
                const originalLstatSync = fs.lstatSync;
                let rollbackPath = '';
                let discardPath = '';
                let seamReached = false;
                fs.renameSync = function failRollbackRetirement(oldPath, newPath, ...args) {
                    const result = originalRenameSync(oldPath, newPath, ...args);
                    if (oldPath === destination && typeof newPath === 'string' && newPath.endsWith('.rollback')) {
                        rollbackPath = newPath;
                    }
                    if (oldPath === rollbackPath && typeof newPath === 'string' && newPath.endsWith('.discard')) {
                        discardPath = newPath;
                        if (!seamReached && fault === 'rename') {
                            seamReached = true;
                            throw Object.assign(new Error('injected rollback retirement rename'), { code: 'EIO' });
                        }
                    }
                    return result;
                };
                fs.lstatSync = function failFirstRollbackQuarantineInspection(file, ...args) {
                    if (!seamReached && fault === 'lstat' && file === discardPath) {
                        seamReached = true;
                        throw Object.assign(new Error('injected rollback retirement lstat'), { code: 'EIO' });
                    }
                    return originalLstatSync(file, ...args);
                };
                syncBuiltinESMExports();

                const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
                const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
                const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
                let returned = false;
                let thrown;
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                    returned = true;
                } catch (error) {
                    thrown = error;
                } finally {
                    sourceDb.close();
                }
                const errorMessages = [];
                const visited = new Set();
                function collectErrors(error) {
                    if (!(error instanceof Error) || visited.has(error)) return;
                    visited.add(error);
                    errorMessages.push(error.message);
                    if (error instanceof AggregateError) {
                        for (const nested of error.errors) collectErrors(nested);
                    }
                    collectErrors(error.cause);
                }
                collectErrors(thrown);
                const priorBytes = Buffer.from(priorHex, 'hex');
                const directory = path.dirname(destination);
                const priorSurvivors = fs
                    .readdirSync(directory)
                    .filter((name) => name === path.basename(destination) || name.startsWith(path.basename(destination) + '.'))
                    .filter((name) => {
                        const candidate = path.join(directory, name);
                        return fs.lstatSync(candidate).isFile() && fs.readFileSync(candidate).equals(priorBytes);
                    })
                    .map((name) => path.join(directory, name));
                const everyRetainedRecoveryIsNamed = priorSurvivors.every(
                    (candidate) => candidate === destination || errorMessages.some((message) => message.includes(candidate)),
                );
                fs.writeFileSync(
                    reachedPath,
                    JSON.stringify({
                        discardPath,
                        errorMessages,
                        everyRetainedRecoveryIsNamed,
                        outputHex: fs.existsSync(destination) ? fs.readFileSync(destination).toString('hex') : '',
                        priorSurvivors,
                        returned,
                        rollbackPath,
                        seamReached,
                    }),
                    { mode: 0o600 },
                );
            `;
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    source,
                    fixture.dbPath,
                    output,
                    reached,
                    priorDestination.toString('hex'),
                    fault,
                    FIXED_KEY.toString('hex'),
                ],
                { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
            );

            await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
            const state = JSON.parse(readFileSync(reached, 'utf8')) as {
                discardPath: string;
                errorMessages: string[];
                everyRetainedRecoveryIsNamed: boolean;
                outputHex: string;
                priorSurvivors: string[];
                returned: boolean;
                rollbackPath: string;
                seamReached: boolean;
            };
            expect({
                everyRetainedRecoveryIsNamed: state.everyRetainedRecoveryIsNamed,
                outputHex: state.outputHex,
                priorSurvivors: state.priorSurvivors,
                returned: state.returned,
                seamReached: state.seamReached,
            }).toEqual({
                everyRetainedRecoveryIsNamed: true,
                outputHex: priorDestination.toString('hex'),
                priorSurvivors: [output],
                returned: false,
                seamReached: true,
            });
            expect(state.rollbackPath).not.toBe('');
            expect(state.discardPath).not.toBe('');
            expect(state.errorMessages).toContain(`injected rollback retirement ${fault}`);
            expect(state.errorMessages.some((message) => message.includes(state.discardPath))).toBe(true);
            expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
            expect(temporaryFilesFor(output)).toEqual([]);
        },
        15000,
    );

    it('restores but never deletes an unknown inode substituted at the prior-destination move', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const output = path.join(fixture.directory, 'rollback-move-race.db');
        const retiredPrior = path.join(fixture.directory, 'retired-prior-destination');
        const substitute = path.join(fixture.directory, 'rollback-move-unknown');
        const priorBytes = Buffer.from('prior destination moved aside by the injected racer');
        const substituteBytes = Buffer.from('unknown destination inode must not be deleted');
        writeFileSync(output, priorBytes);
        writeFileSync(substitute, substituteBytes);
        const reached = path.join(fixture.directory, 'rollback-move-race.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, substitutePath, destination, retiredPath, reachedPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalRenameSync = fs.renameSync;
            let substituted = false;
            fs.renameSync = function substituteDuringRollbackMove(oldPath, newPath, ...args) {
                if (!substituted && oldPath === destination && typeof newPath === 'string' && newPath.endsWith('.rollback')) {
                    originalRenameSync(destination, retiredPath);
                    fs.linkSync(substitutePath, destination);
                    substituted = true;
                }
                return originalRenameSync(oldPath, newPath, ...args);
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            try {
                let errorMessage = '';
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                } catch (error) {
                    errorMessage = error instanceof Error ? error.message : String(error);
                }
                fs.writeFileSync(reachedPath, JSON.stringify({ substituted, errorMessage }), { mode: 0o600 });
            } finally {
                sourceDb.close();
            }
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                substitute,
                output,
                retiredPrior,
                reached,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as { substituted: boolean; errorMessage: string };
        expect(state.substituted).toBe(true);
        expect(state.errorMessage).toContain('changed identity before it could be preserved');
        expect(readFileSync(output)).toEqual(substituteBytes);
        expect(readFileSync(substitute)).toEqual(substituteBytes);
        expect(readFileSync(retiredPrior)).toEqual(priorBytes);
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        expect(readdirSync(fixture.directory).filter((entry) => entry.endsWith('.rollback'))).toEqual([]);
    }, 15000);

    it('never deletes an unknown file substituted after a rollback ownership check', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        fixture.close();

        const output = path.join(fixture.directory, 'rollback-unlink-race.db');
        const priorDestination = Buffer.from('authorized prior destination');
        writeFileSync(output, priorDestination);
        const unknownPath = path.join(fixture.directory, 'rollback-unlink-unknown');
        const unknownBytes = Buffer.from('unknown rollback substitute must survive');
        writeFileSync(unknownPath, unknownBytes);
        const retainedPrior = path.join(fixture.directory, 'rollback-unlink-retained-prior');
        const reached = path.join(fixture.directory, 'rollback-unlink-race.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, destination, unknownPath, retainedPrior, reachedPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalRenameSync = fs.renameSync;
            let rollbackPath = '';
            let rollbackCleanupMoves = 0;
            let seamReached = false;
            fs.renameSync = function substituteAsRollbackCleanupStarts(oldPath, newPath, ...args) {
                if (
                    !seamReached &&
                    oldPath === rollbackPath &&
                    typeof newPath === 'string' &&
                    newPath.endsWith('.discard')
                ) {
                    rollbackCleanupMoves += 1;
                    originalRenameSync(rollbackPath, retainedPrior);
                    originalRenameSync(unknownPath, rollbackPath);
                    seamReached = true;
                }
                const result = originalRenameSync(oldPath, newPath, ...args);
                if (oldPath === destination && typeof newPath === 'string' && newPath.endsWith('.rollback')) {
                    rollbackPath = newPath;
                }
                return result;
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            let errorMessage = '';
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            } finally {
                sourceDb.close();
            }
            fs.writeFileSync(reachedPath, JSON.stringify({ seamReached, rollbackCleanupMoves, rollbackPath, errorMessage }), { mode: 0o600 });
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                output,
                unknownPath,
                retainedPrior,
                reached,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as {
            seamReached: boolean;
            rollbackCleanupMoves: number;
            rollbackPath: string;
            errorMessage: string;
        };
        expect({ seamReached: state.seamReached, rollbackCleanupMoves: state.rollbackCleanupMoves }).toEqual({
            seamReached: true,
            rollbackCleanupMoves: 1,
        });
        expect(state.errorMessage).not.toBe('');
        expect(readFileSync(retainedPrior)).toEqual(priorDestination);
        expect(
            readdirSync(fixture.directory).some((entry) => {
                const candidate = path.join(fixture.directory, entry);
                return lstatSync(candidate).isFile() && readFileSync(candidate).includes(unknownBytes);
            }),
        ).toBe(true);
    }, 15000);

    it('never overwrites a destination created while a caught failure restores its rollback', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);
        fixture.close();

        const output = path.join(fixture.directory, 'rollback-restore-race.db');
        const priorDestination = Buffer.from('prior destination remains in the rollback');
        const concurrentDestination = Buffer.from('concurrent destination must not be overwritten');
        writeFileSync(output, priorDestination);
        const reached = path.join(fixture.directory, 'rollback-restore-race.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, destination, reachedPath, priorHex, concurrentHex, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalLinkSync = fs.linkSync;
            const originalRenameSync = fs.renameSync;
            let rollbackPath = '';
            let restoreAttempted = false;
            fs.renameSync = function observeRollbackMove(oldPath, newPath, ...args) {
                if (oldPath === rollbackPath && newPath === destination) {
                    fs.writeFileSync(destination, Buffer.from(concurrentHex, 'hex'), { mode: 0o600 });
                    restoreAttempted = true;
                }
                const result = originalRenameSync(oldPath, newPath, ...args);
                if (oldPath === destination && typeof newPath === 'string' && newPath.endsWith('.rollback')) {
                    rollbackPath = newPath;
                }
                return result;
            };
            fs.linkSync = function raceNoReplaceRestore(oldPath, newPath, ...args) {
                if (oldPath === rollbackPath && newPath === destination) {
                    fs.writeFileSync(destination, Buffer.from(concurrentHex, 'hex'), { mode: 0o600 });
                    restoreAttempted = true;
                }
                return originalLinkSync(oldPath, newPath, ...args);
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            const originalPrepare = sourceDb.prepare.bind(sourceDb);
            sourceDb.prepare = function failSnapshotWrite(sql, ...args) {
                if (sql.startsWith('ATTACH DATABASE ? AS ')) {
                    return { run() { throw new Error('injected writer failure'); } };
                }
                return originalPrepare(sql, ...args);
            };
            let errorMessage = '';
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            } finally {
                sourceDb.close();
            }
            fs.writeFileSync(
                reachedPath,
                JSON.stringify({
                    errorMessage,
                    restoreAttempted,
                    rollbackPath,
                    outputHex: fs.readFileSync(destination).toString('hex'),
                    rollbackHex: fs.existsSync(rollbackPath) ? fs.readFileSync(rollbackPath).toString('hex') : '',
                    priorHex,
                }),
                { mode: 0o600 },
            );
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                output,
                reached,
                priorDestination.toString('hex'),
                concurrentDestination.toString('hex'),
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as {
            errorMessage: string;
            restoreAttempted: boolean;
            rollbackPath: string;
            outputHex: string;
            rollbackHex: string;
        };
        expect(state.restoreAttempted).toBe(true);
        expect(Buffer.from(state.outputHex, 'hex')).toEqual(concurrentDestination);
        expect(Buffer.from(state.rollbackHex, 'hex')).toEqual(priorDestination);
        expect(state.errorMessage).toContain('Cleanup also failed');
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
    }, 15000);

    it('does not replace a destination created after a no-force absence check', () => {
        const { fixture } = seedExportFixture();
        const output = path.join(fixture.directory, 'created-after-prepare.db');
        const concurrentBytes = Buffer.from('concurrently created destination remains untouched');
        const originalPragma = fixture.db.pragma.bind(fixture.db);
        let injected = false;
        const pragmaSpy = vi.spyOn(fixture.db, 'pragma').mockImplementation(((source: string, ...args: unknown[]) => {
            const result = (originalPragma as (...pragmaArgs: unknown[]) => unknown)(source, ...args);
            if (!injected && source === 'wal_checkpoint(TRUNCATE)') {
                writeFileSync(output, concurrentBytes);
                injected = true;
            }
            return result;
        }) as typeof fixture.db.pragma);

        try {
            expect(() => exportAll(fixture.db, output, FIXED_KEY)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
        } finally {
            pragmaSpy.mockRestore();
        }
        expect(injected).toBe(true);
        expect(readFileSync(output)).toEqual(concurrentBytes);
        expect(readdirSync(fixture.directory).filter((entry) => entry.endsWith('.rollback'))).toEqual([]);
    });

    it('does not move or replace an inode substituted after force authorization', () => {
        const { fixture } = seedExportFixture();
        const output = path.join(fixture.directory, 'substituted-after-force-prepare.db');
        const retiredAuthorized = path.join(fixture.directory, 'retired-authorized-destination');
        const substitute = path.join(fixture.directory, 'force-authorization-substitute');
        const authorizedBytes = Buffer.from('force-authorized destination inode');
        const substituteBytes = Buffer.from('unauthorized replacement inode');
        writeFileSync(output, authorizedBytes);
        writeFileSync(substitute, substituteBytes);
        const originalPragma = fixture.db.pragma.bind(fixture.db);
        let substituted = false;
        const pragmaSpy = vi.spyOn(fixture.db, 'pragma').mockImplementation(((source: string, ...args: unknown[]) => {
            const result = (originalPragma as (...pragmaArgs: unknown[]) => unknown)(source, ...args);
            if (!substituted && source === 'wal_checkpoint(TRUNCATE)') {
                renameSync(output, retiredAuthorized);
                linkSync(substitute, output);
                substituted = true;
            }
            return result;
        }) as typeof fixture.db.pragma);

        try {
            expect(() => exportAll(fixture.db, output, FIXED_KEY, true)).toThrow(
                'Backup destination changed identity after replacement was authorized.',
            );
        } finally {
            pragmaSpy.mockRestore();
        }
        expect(substituted).toBe(true);
        expect(readFileSync(output)).toEqual(substituteBytes);
        expect(readFileSync(substitute)).toEqual(substituteBytes);
        expect(readFileSync(retiredAuthorized)).toEqual(authorizedBytes);
        expect(readdirSync(fixture.directory).filter((entry) => entry.endsWith('.rollback'))).toEqual([]);
    });

    it.skipIf(!isSupportedPlatform())(
        'refuses an existing FIFO before force replacement opens it',
        async () => {
            const { fixture } = seedExportFixture();
            fixture.db.pragma('wal_checkpoint(TRUNCATE)');
            const sourceBytes = readFileSync(fixture.dbPath);
            fixture.close();

            const output = path.join(fixture.directory, 'force-existing-fifo.db');
            const openReached = path.join(fixture.directory, 'force-existing-fifo.open-reached');
            const resultPath = path.join(fixture.directory, 'force-existing-fifo.result');
            const created = spawnSync('mkfifo', [output], { encoding: 'utf8' });
            if (created.error !== undefined) {
                throw created.error;
            }
            expect({ status: created.status, stderr: created.stderr }).toEqual({ status: 0, stderr: '' });
            const before = lstatSync(output, { bigint: true });
            expect(before.isFIFO()).toBe(true);

            const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, destination, openReachedPath, resultPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalOpenSync = fs.openSync;
            fs.openSync = function observeDestinationOpen(file, flags, ...args) {
                if (file === destination && typeof flags === 'number' && (flags & 3) === fs.constants.O_RDONLY) {
                    fs.writeFileSync(openReachedPath, 'hazardous FIFO open reached', { mode: 0o600 });
                }
                return originalOpenSync(file, flags, ...args);
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { readonly: true, fileMustExist: true });
            let errorMessage = '';
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            } finally {
                sourceDb.close();
            }
            fs.writeFileSync(resultPath, JSON.stringify({ errorMessage }), { mode: 0o600 });
        `;
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    source,
                    fixture.dbPath,
                    output,
                    openReached,
                    resultPath,
                    FIXED_KEY.toString('hex'),
                ],
                { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
            );
            const observation = await observeBoundedChild(child, openReached);
            const result = existsSync(resultPath) ? (JSON.parse(readFileSync(resultPath, 'utf8')) as { errorMessage: string }) : undefined;
            const after = lstatSync(output, { bigint: true });
            expect({ dev: after.dev, ino: after.ino, fifo: after.isFIFO() }).toEqual({ dev: before.dev, ino: before.ino, fifo: true });
            expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
            expect(temporaryFilesFor(output)).toEqual([]);
            expect({ observation, result }).toEqual({
                observation: { markerReached: false, forced: null, code: 0, signal: null, stderr: '' },
                result: { errorMessage: `refusing to overwrite a non-regular backup destination: ${output}` },
            });
        },
        15000,
    );

    it.skipIf(!isSupportedPlatform())(
        'does not block when a force-authorized destination is replaced by a FIFO before preservation',
        async () => {
            const { fixture } = seedExportFixture();
            fixture.db.pragma('wal_checkpoint(TRUNCATE)');
            const sourceBytes = readFileSync(fixture.dbPath);
            fixture.close();

            const output = path.join(fixture.directory, 'force-preserve-raced-fifo.db');
            const retainedPrior = path.join(fixture.directory, 'force-preserve-authorized-prior.db');
            const fifoSource = path.join(fixture.directory, 'force-preserve-raced-fifo-source');
            const priorBytes = Buffer.from('force-authorized prior destination');
            writeFileSync(output, priorBytes);
            const created = spawnSync('mkfifo', [fifoSource], { encoding: 'utf8' });
            if (created.error !== undefined) {
                throw created.error;
            }
            expect({ status: created.status, stderr: created.stderr }).toEqual({ status: 0, stderr: '' });
            const fifoIdentity = lstatSync(fifoSource, { bigint: true });
            expect(fifoIdentity.isFIFO()).toBe(true);

            const reached = path.join(fixture.directory, 'force-preserve-raced-fifo.reached');
            const resultPath = path.join(fixture.directory, 'force-preserve-raced-fifo.result');
            const source = `
                import { createRequire, syncBuiltinESMExports } from 'node:module';

                const [sourcePath, destination, retainedPrior, fifoSource, reachedPath, resultPath, keyHex] = process.argv.slice(1);
                const require = createRequire(import.meta.url);
                const fs = require('node:fs');
                const originalOpenSync = fs.openSync;
                let substituted = false;
                fs.openSync = function substituteBeforePreservationOpen(file, flags, ...args) {
                    if (!substituted && file === destination && typeof flags === 'number' && (flags & 3) === fs.constants.O_RDONLY) {
                        fs.renameSync(destination, retainedPrior);
                        fs.renameSync(fifoSource, destination);
                        substituted = true;
                        fs.writeFileSync(
                            reachedPath,
                            JSON.stringify({ nonblocking: (flags & fs.constants.O_NONBLOCK) !== 0 }),
                            { mode: 0o600 },
                        );
                    }
                    return originalOpenSync(file, flags, ...args);
                };
                syncBuiltinESMExports();

                const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
                const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
                const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
                let errorMessage = '';
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
                } catch (error) {
                    errorMessage = error instanceof Error ? error.message : String(error);
                } finally {
                    sourceDb.close();
                }
                fs.writeFileSync(resultPath, JSON.stringify({ errorMessage, substituted }), { mode: 0o600 });
            `;
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    source,
                    fixture.dbPath,
                    output,
                    retainedPrior,
                    fifoSource,
                    reached,
                    resultPath,
                    FIXED_KEY.toString('hex'),
                ],
                { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
            );
            const observation = await observeBoundedChild(child, reached);
            const marker = JSON.parse(readFileSync(reached, 'utf8')) as { nonblocking: boolean };
            const result = existsSync(resultPath)
                ? (JSON.parse(readFileSync(resultPath, 'utf8')) as { errorMessage: string; substituted: boolean })
                : undefined;
            const fifoAfter = lstatSync(output, { bigint: true });

            expect({ dev: fifoAfter.dev, ino: fifoAfter.ino, fifo: fifoAfter.isFIFO() }).toEqual({
                dev: fifoIdentity.dev,
                ino: fifoIdentity.ino,
                fifo: true,
            });
            expect(readFileSync(retainedPrior)).toEqual(priorBytes);
            expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
            expect(temporaryFilesFor(output)).toEqual([]);
            expect({ observation, marker, result }).toEqual({
                observation: { markerReached: true, forced: null, code: 0, signal: null, stderr: '' },
                marker: { nonblocking: true },
                result: {
                    errorMessage: 'Backup destination changed identity after replacement was authorized.',
                    substituted: true,
                },
            });
        },
        15000,
    );

    it.skipIf(!isSupportedPlatform())(
        'does not block when a precreated output is replaced by a FIFO before lifecycle pinning',
        async () => {
            const { fixture } = seedExportFixture();
            fixture.db.pragma('wal_checkpoint(TRUNCATE)');
            const sourceBytes = readFileSync(fixture.dbPath);
            fixture.close();

            const output = path.join(fixture.directory, 'pin-raced-fifo.db');
            const ownedAside = path.join(fixture.directory, 'pin-raced-owned-output.db');
            const fifoSource = path.join(fixture.directory, 'pin-raced-fifo-source');
            const created = spawnSync('mkfifo', [fifoSource], { encoding: 'utf8' });
            if (created.error !== undefined) {
                throw created.error;
            }
            expect({ status: created.status, stderr: created.stderr }).toEqual({ status: 0, stderr: '' });
            const fifoIdentity = lstatSync(fifoSource, { bigint: true });
            expect(fifoIdentity.isFIFO()).toBe(true);

            const reached = path.join(fixture.directory, 'pin-raced-fifo.reached');
            const resultPath = path.join(fixture.directory, 'pin-raced-fifo.result');
            const source = `
                import { createRequire, syncBuiltinESMExports } from 'node:module';

                const [sourcePath, destination, ownedAside, fifoSource, reachedPath, resultPath, keyHex] = process.argv.slice(1);
                const require = createRequire(import.meta.url);
                const fs = require('node:fs');
                const originalOpenSync = fs.openSync;
                const readOpenFlags = [];
                fs.openSync = function substituteBeforePinOpen(file, flags, ...args) {
                    if (file === destination && typeof flags === 'number' && (flags & 3) === fs.constants.O_RDONLY) {
                        readOpenFlags.push({ nonblocking: (flags & fs.constants.O_NONBLOCK) !== 0 });
                        if (readOpenFlags.length === 2) {
                            fs.renameSync(destination, ownedAside);
                            fs.renameSync(fifoSource, destination);
                            fs.writeFileSync(reachedPath, JSON.stringify({ readOpenFlags }), { mode: 0o600 });
                        }
                    }
                    return originalOpenSync(file, flags, ...args);
                };
                syncBuiltinESMExports();

                const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
                const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
                const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
                let thrown;
                let returned = false;
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
                    returned = true;
                } catch (error) {
                    thrown = error;
                } finally {
                    sourceDb.close();
                }
                const errorMessages = [];
                const seen = new Set();
                function collectErrors(error) {
                    if (error === undefined || error === null || seen.has(error)) return;
                    seen.add(error);
                    errorMessages.push(error instanceof Error ? error.message : String(error));
                    if (error instanceof AggregateError) {
                        for (const nested of error.errors) collectErrors(nested);
                    }
                    if (error instanceof Error) collectErrors(error.cause);
                }
                collectErrors(thrown);
                fs.writeFileSync(resultPath, JSON.stringify({ errorMessages, returned }), { mode: 0o600 });
            `;
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    source,
                    fixture.dbPath,
                    output,
                    ownedAside,
                    fifoSource,
                    reached,
                    resultPath,
                    FIXED_KEY.toString('hex'),
                ],
                { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
            );
            const observation = await observeBoundedChild(child, reached);
            const marker = JSON.parse(readFileSync(reached, 'utf8')) as { readOpenFlags: Array<{ nonblocking: boolean }> };
            const result = existsSync(resultPath)
                ? (JSON.parse(readFileSync(resultPath, 'utf8')) as { errorMessages: string[]; returned: boolean })
                : undefined;
            const fifoSurvivors = readdirSync(fixture.directory)
                .map((entry) => path.join(fixture.directory, entry))
                .filter((candidate) => {
                    const current = lstatSync(candidate, { bigint: true });
                    return current.isFIFO() && current.dev === fifoIdentity.dev && current.ino === fifoIdentity.ino;
                });
            const owned = lstatSync(ownedAside, { bigint: true });

            expect(fifoSurvivors).toHaveLength(1);
            expect({ regular: owned.isFile(), size: owned.size }).toEqual({ regular: true, size: 0n });
            expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
            expect(observation).toEqual({ markerReached: true, forced: null, code: 0, signal: null, stderr: '' });
            expect(marker).toEqual({ readOpenFlags: [{ nonblocking: true }, { nonblocking: true }] });
            expect(result?.returned).toBe(false);
            expect(result?.errorMessages).toContain(`database_lifecycle_ambiguous: managed database is not a physical file: ${output}`);
            expect(result?.errorMessages.some((message) => message.includes(fifoSurvivors[0] ?? ''))).toBe(true);
        },
        15000,
    );

    it.skipIf(!isSupportedPlatform())(
        'does not block when the lifecycle pin is replaced by a FIFO before identity reinspection',
        async () => {
            const { fixture } = seedExportFixture();
            fixture.db.pragma('wal_checkpoint(TRUNCATE)');
            const sourceBytes = readFileSync(fixture.dbPath);
            fixture.close();

            const output = path.join(fixture.directory, 'pin-reinspect-raced-fifo.db');
            const ownedAside = path.join(fixture.directory, 'pin-reinspect-owned-output.db');
            const fifoSource = path.join(fixture.directory, 'pin-reinspect-raced-fifo-source');
            const created = spawnSync('mkfifo', [fifoSource], { encoding: 'utf8' });
            if (created.error !== undefined) {
                throw created.error;
            }
            expect({ status: created.status, stderr: created.stderr }).toEqual({ status: 0, stderr: '' });
            const fifoIdentity = lstatSync(fifoSource, { bigint: true });
            expect(fifoIdentity.isFIFO()).toBe(true);

            const reached = path.join(fixture.directory, 'pin-reinspect-raced-fifo.reached');
            const resultPath = path.join(fixture.directory, 'pin-reinspect-raced-fifo.result');
            const source = `
                import { createRequire, syncBuiltinESMExports } from 'node:module';

                const [sourcePath, destination, ownedAside, fifoSource, reachedPath, resultPath, keyHex] = process.argv.slice(1);
                const require = createRequire(import.meta.url);
                const fs = require('node:fs');
                const originalOpenSync = fs.openSync;
                const originalFstatSync = fs.fstatSync;
                let pinDescriptor;
                let readOpenCount = 0;
                let substituted = false;
                fs.openSync = function observeIdentityReinspection(file, flags, ...args) {
                    if (file === destination && typeof flags === 'number' && (flags & 3) === fs.constants.O_RDONLY) {
                        readOpenCount += 1;
                        if (readOpenCount === 3) {
                            fs.writeFileSync(
                                reachedPath,
                                JSON.stringify({
                                    inspectionNonblocking: (flags & fs.constants.O_NONBLOCK) !== 0,
                                    pinFstatCompleted: substituted,
                                    readOpenCount,
                                }),
                                { mode: 0o600 },
                            );
                        }
                    }
                    const descriptor = originalOpenSync(file, flags, ...args);
                    if (file === destination && readOpenCount === 2) {
                        pinDescriptor = descriptor;
                    }
                    return descriptor;
                };
                fs.fstatSync = function substituteAfterPinFstat(descriptor, ...args) {
                    const stats = originalFstatSync(descriptor, ...args);
                    if (!substituted && descriptor === pinDescriptor) {
                        fs.renameSync(destination, ownedAside);
                        fs.renameSync(fifoSource, destination);
                        substituted = true;
                    }
                    return stats;
                };
                syncBuiltinESMExports();

                const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
                const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
                const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
                let thrown;
                let returned = false;
                try {
                    exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'));
                    returned = true;
                } catch (error) {
                    thrown = error;
                } finally {
                    sourceDb.close();
                }
                const errorMessages = [];
                const seen = new Set();
                function collectErrors(error) {
                    if (error === undefined || error === null || seen.has(error)) return;
                    seen.add(error);
                    errorMessages.push(error instanceof Error ? error.message : String(error));
                    if (error instanceof AggregateError) {
                        for (const nested of error.errors) collectErrors(nested);
                    }
                    if (error instanceof Error) collectErrors(error.cause);
                }
                collectErrors(thrown);
                fs.writeFileSync(resultPath, JSON.stringify({ errorMessages, returned }), { mode: 0o600 });
            `;
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    source,
                    fixture.dbPath,
                    output,
                    ownedAside,
                    fifoSource,
                    reached,
                    resultPath,
                    FIXED_KEY.toString('hex'),
                ],
                { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
            );
            const observation = await observeBoundedChild(child, reached);
            const marker = JSON.parse(readFileSync(reached, 'utf8')) as {
                inspectionNonblocking: boolean;
                pinFstatCompleted: boolean;
                readOpenCount: number;
            };
            const result = existsSync(resultPath)
                ? (JSON.parse(readFileSync(resultPath, 'utf8')) as { errorMessages: string[]; returned: boolean })
                : undefined;
            const fifoSurvivors = readdirSync(fixture.directory)
                .map((entry) => path.join(fixture.directory, entry))
                .filter((candidate) => {
                    const current = lstatSync(candidate, { bigint: true });
                    return current.isFIFO() && current.dev === fifoIdentity.dev && current.ino === fifoIdentity.ino;
                });
            const owned = lstatSync(ownedAside, { bigint: true });

            expect(fifoSurvivors).toHaveLength(1);
            expect({ regular: owned.isFile(), size: owned.size }).toEqual({ regular: true, size: 0n });
            expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
            expect(observation).toEqual({ markerReached: true, forced: null, code: 0, signal: null, stderr: '' });
            expect(marker).toEqual({ inspectionNonblocking: true, pinFstatCompleted: true, readOpenCount: 3 });
            expect(result?.returned).toBe(false);
            expect(result?.errorMessages).toContain(`database_lifecycle_ambiguous: managed database is not a physical file: ${output}`);
            expect(result?.errorMessages.some((message) => message.includes(fifoSurvivors[0] ?? ''))).toBe(true);
        },
        15000,
    );

    it('restores a non-regular destination substituted at the authorized force move', async () => {
        const { fixture } = seedExportFixture();
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        fixture.close();

        const output = path.join(fixture.directory, 'force-move-symlink.db');
        const authorizedBytes = Buffer.from('authorized force destination');
        writeFileSync(output, authorizedBytes);
        const retainedAuthorized = path.join(fixture.directory, 'force-move-retained-authorized');
        const unknownTarget = path.join(fixture.directory, 'force-move-unknown-target');
        const unknownTargetBytes = Buffer.from('unknown symlink target remains untouched');
        writeFileSync(unknownTarget, unknownTargetBytes);
        const reached = path.join(fixture.directory, 'force-move-symlink.reached');
        const source = `
            import { createRequire, syncBuiltinESMExports } from 'node:module';

            const [sourcePath, destination, retainedAuthorized, unknownTarget, reachedPath, keyHex] = process.argv.slice(1);
            const require = createRequire(import.meta.url);
            const fs = require('node:fs');
            const originalRenameSync = fs.renameSync;
            let substituted = false;
            let rollbackPath = '';
            fs.renameSync = function substituteNonRegularDestination(oldPath, newPath, ...args) {
                if (!substituted && oldPath === destination && typeof newPath === 'string' && newPath.endsWith('.rollback')) {
                    originalRenameSync(destination, retainedAuthorized);
                    fs.symlinkSync(unknownTarget, destination);
                    substituted = true;
                    rollbackPath = newPath;
                }
                return originalRenameSync(oldPath, newPath, ...args);
            };
            syncBuiltinESMExports();

            const { exportAll } = await import(${JSON.stringify(new URL('../../src/cli/commands/backup.ts', import.meta.url).href)});
            const { openKeyedDatabase } = await import(${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)});
            const sourceDb = openKeyedDatabase(sourcePath, Buffer.from(keyHex, 'hex'), { fileMustExist: true });
            let errorMessage = '';
            try {
                exportAll(sourceDb, destination, Buffer.from(keyHex, 'hex'), true);
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            } finally {
                sourceDb.close();
            }
            fs.writeFileSync(reachedPath, JSON.stringify({ substituted, rollbackPath, errorMessage }), { mode: 0o600 });
        `;
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                source,
                fixture.dbPath,
                output,
                retainedAuthorized,
                unknownTarget,
                reached,
                FIXED_KEY.toString('hex'),
            ],
            { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
        const state = JSON.parse(readFileSync(reached, 'utf8')) as {
            substituted: boolean;
            rollbackPath: string;
            errorMessage: string;
        };
        expect(state.substituted).toBe(true);
        expect(state.errorMessage).toContain('changed identity before it could be preserved');
        expect(lstatSync(output).isSymbolicLink()).toBe(true);
        expect(readlinkSync(output)).toBe(unknownTarget);
        expect(readFileSync(unknownTarget)).toEqual(unknownTargetBytes);
        expect(readFileSync(retainedAuthorized)).toEqual(authorizedBytes);
        expect(existsSync(state.rollbackPath)).toBe(false);
    }, 15000);

    it('refuses a plaintext full-export source', () => {
        const fixture = createTestDb('elepha-plaintext-full-export-');
        const output = path.join(fixture.directory, 'full-export.db');
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);

        expect(() => exportAll(fixture.db, output, FIXED_KEY)).toThrow(
            'Backup source is plaintext; refusing to create a plaintext temporary copy.',
        );
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        expect(existsSync(output)).toBe(false);
        expect(temporaryFilesFor(output)).toEqual([]);
    });

    it('refuses an encrypted full-export source under the wrong key', () => {
        const { fixture } = seedExportFixture();
        const output = path.join(fixture.directory, 'wrong-key-full-export.db');
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        const sourceBytes = readFileSync(fixture.dbPath);

        expect(() => exportAll(fixture.db, output, Buffer.alloc(FIXED_KEY.length, 255))).toThrow(
            expect.objectContaining({ code: 'SQLITE_NOTADB' }),
        );
        expect(readFileSync(fixture.dbPath)).toEqual(sourceBytes);
        expect(existsSync(output)).toBe(false);
        expect(temporaryFilesFor(output)).toEqual([]);
    });

    it('overwrites an existing destination for full and project exports without leaving internal artifacts', () => {
        const exporters = [
            (fixture: ReturnType<typeof seedExportFixture>, destination: string, force = false) =>
                exportAll(fixture.fixture.db, destination, FIXED_KEY, force),
            (fixture: ReturnType<typeof seedExportFixture>, destination: string, force = false) =>
                exportProject(fixture.fixture.db, fixture.project, destination, FIXED_KEY, force),
        ];

        for (const exportBackup of exporters) {
            const fixture = seedExportFixture();
            const output = path.join(fixture.fixture.directory, 'existing.db');
            const original = Buffer.from('keep this existing backup intact');
            writeFileSync(output, original);

            expect(() => exportBackup(fixture, output)).toThrow(`Backup destination already exists: ${output} (pass --force to overwrite)`);
            expect(readFileSync(output)).toEqual(original);

            exportBackup(fixture, output, true);
            expect(readFileSync(output)).not.toEqual(original);
            expect(statSync(output).mode & 0o777).toBe(0o600);
            expect(temporaryFilesFor(output)).toEqual([]);
        }
    });

    it('preserves an existing --force destination when a project export fails while building its keyed database', () => {
        const { fixture, project } = seedExportFixture();
        const output = path.join(fixture.directory, 'existing-project.db');
        const original = Buffer.from('keep the previous project backup');
        writeFileSync(output, original);
        fixture.db.exec('DROP TABLE session_rollups');

        expect(() => exportProject(fixture.db, project, output, FIXED_KEY, true)).toThrow(/no such table: session_rollups/);
        expect(readFileSync(output)).toEqual(original);
        expect(temporaryFilesFor(output)).toEqual([]);
    });

    it('aborts a busy full-export checkpoint without creating or replacing a destination', () => {
        const { fixture } = seedExportFixture();
        const output = path.join(fixture.directory, 'busy-full.db');
        const original = Buffer.from('keep the previous full backup');
        vi.spyOn(fixture.db, 'pragma').mockReturnValue([{ busy: 1 }] as never);

        expect(() => exportAll(fixture.db, output, FIXED_KEY)).toThrow(
            "Backup aborted: WAL checkpoint did not complete (the daemon may be writing) — run 'elepha pause' or retry.",
        );
        expect(existsSync(output)).toBe(false);

        writeFileSync(output, original);
        expect(() => exportAll(fixture.db, output, FIXED_KEY, true)).toThrow(/WAL checkpoint did not complete/);
        expect(readFileSync(output)).toEqual(original);
        expect(temporaryFilesFor(output)).toEqual([]);
    });

    it('checkpoints committed WAL frames before completing a full export', () => {
        const { fixture } = seedExportFixture();
        const output = path.join(fixture.directory, 'wal-complete.db');
        fixture.db.pragma('wal_checkpoint(TRUNCATE)');
        fixture.db.pragma('wal_autocheckpoint = 0');
        fixture.db.prepare('UPDATE sessions SET title = ? WHERE native_id = ?').run('committed in wal', 'primary-session');
        expect(statSync(`${fixture.dbPath}-wal`).size).toBeGreaterThan(0);

        exportAll(fixture.db, output, FIXED_KEY);

        const exported = openKeyedDatabase(output, FIXED_KEY, { readonly: true });
        try {
            expect(exported.prepare('SELECT title FROM sessions WHERE native_id = ?').get('primary-session')).toEqual({
                title: 'committed in wal',
            });
        } finally {
            exported.close();
        }
    });

    it('preserves an existing parent mode while hardening created backup directories and the file', () => {
        const { fixture } = seedExportFixture();
        const shared = path.join(fixture.directory, 'shared');
        mkdirSync(shared);
        chmodSync(shared, 0o755);
        const sharedOutput = path.join(shared, 'backup.db');
        const createdOutput = path.join(fixture.directory, 'created', 'nested', 'backup.db');

        exportAll(fixture.db, sharedOutput, FIXED_KEY);
        expect(statSync(shared).mode & 0o777).toBe(0o755);
        exportAll(fixture.db, createdOutput, FIXED_KEY);
        expect(statSync(path.dirname(createdOutput)).mode & 0o777).toBe(0o700);
        expect(statSync(path.dirname(path.dirname(createdOutput))).mode & 0o777).toBe(0o700);
        expect(statSync(createdOutput).mode & 0o777).toBe(0o600);
    }, 15000);

    it('refuses a symlink destination without touching its target', () => {
        const { fixture } = seedExportFixture();
        const target = path.join(fixture.directory, 'target.db');
        const destination = path.join(fixture.directory, 'linked-backup.db');
        const original = Buffer.from('do not overwrite this target');
        writeFileSync(target, original);
        symlinkSync(target, destination);

        expect(() => exportAll(fixture.db, destination, FIXED_KEY, true)).toThrow(
            `refusing to write a backup through a symlink: ${destination}`,
        );
        expect(readFileSync(target)).toEqual(original);
        expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    }, 15000);

    it('writes a full export to the default elepha backups directory', () => {
        const { fixture } = seedExportFixture();
        const expectedDirectory = path.join(fixture.directory, 'isolated-elepha-home', 'backups');
        const previousHome = process.env.ELEPHA_HOME;
        process.env.ELEPHA_HOME = path.join(fixture.directory, 'isolated-elepha-home');

        try {
            const written = defaultBackupPath();
            exportAll(fixture.db, written, FIXED_KEY);
            expect(path.dirname(written)).toBe(expectedDirectory);
            expect(statSync(written).mode & 0o777).toBe(0o600);
            expect(statSync(expectedDirectory).mode & 0o777).toBe(0o700);
        } finally {
            if (previousHome === undefined) {
                delete process.env.ELEPHA_HOME;
            } else {
                process.env.ELEPHA_HOME = previousHome;
            }
        }
    }, 15000);

    it('selects a consolidated project and writes its export through the fakeable wizard seam', async () => {
        const { fixture, project } = seedExportFixture();
        const output = path.join(fixture.directory, 'wizard-export.db');
        const { prompts, events } = fakePrompts(['project', repositoryRoot], output);
        const wizardOutput = ttyStream();
        let rendered = '';
        wizardOutput.on('data', (chunk: Buffer) => {
            rendered += chunk.toString('utf8');
            events.push('tagline');
        });
        const store = new MemoryStore(fixture.db);

        await expect(
            runBackupWizard({
                store,
                output: wizardOutput,
                prompts,
                defaultOutput: () => output,
                backupAll: async () => {
                    throw new Error('all memory was not selected');
                },
                backupProject: async (selected, destination) => exportProject(fixture.db, selected, destination, FIXED_KEY),
            }),
        ).resolves.toBe(0);

        const exported = openKeyedDatabase(output, FIXED_KEY, { readonly: true });
        try {
            expect(exported.prepare('SELECT id FROM projects ORDER BY id').all()).toEqual(project.projectIds.map((id) => ({ id })));
            expect(prompts.select).toHaveBeenNthCalledWith(1, {
                message: 'What should elepha back up?',
                options: [
                    { value: 'all', label: 'All memory' },
                    { value: 'project', label: 'A specific project' },
                ],
            });
            expect(prompts.select).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: 'Which project should elepha back up?' }));
            expect(rendered.split(ELEPHA_TAGLINE)).toHaveLength(2);
            expect(rendered).not.toContain(ELEPHA_WORDMARK);
            expect(events.slice(0, 2)).toEqual(['tagline', 'intro:Back up elepha memory']);
        } finally {
            exported.close();
        }
    });
});
