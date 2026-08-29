import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { type BackupPrompts, runBackupWizard } from '../../src/cli/backup-wizard.js';
import { exportAll, exportProject, listFullBackups } from '../../src/cli/commands/backup.js';
import { ELEPHA_TAGLINE, ELEPHA_WORDMARK } from '../../src/config/constants.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const elephaCli = path.join(repositoryRoot, 'src', 'cli', 'index.ts');

function runBackupCli(dbPath: string, ...args: string[]) {
    return spawnSync(process.execPath, [tsxCli, elephaCli, 'backup', ...args], {
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

function temporaryFilesFor(destination: string): string[] {
    const prefix = `${path.basename(destination)}.`;
    return readdirSync(path.dirname(destination)).filter((entry) => entry.startsWith(prefix) && entry.endsWith('.tmp'));
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
        ['--all', (fixture: ReturnType<typeof seedExportFixture>, destination: string) => exportAll(fixture.fixture.db, destination, true)],
        [
            '--project',
            (fixture: ReturnType<typeof seedExportFixture>, destination: string) =>
                exportProject(fixture.fixture.db, fixture.project, destination, true),
        ],
    ])('refuses the active database as the %s destination directly and through a symlinked parent', (_scope, exportBackup) => {
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
    });

    it('writes a standalone database with both fragment rows and no other project data through --project', () => {
        const { fixture, project, other } = seedExportFixture();
        const output = path.join(fixture.directory, 'project-export.db');

        fixture.close();
        const result = runBackupCli(fixture.dbPath, '--project', 'elepha', '--out', output);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`Backup written to ${output}.`);
        const exported = new Database(output, { readonly: true });
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
            expect(statSync(output).mode & 0o777).toBe(0o600);
        } finally {
            exported.close();
        }
    });

    it('writes a full database copy with matching portable-table row counts through --all', () => {
        const { fixture } = seedExportFixture();
        const output = path.join(fixture.directory, 'full-export.db');

        fixture.close();
        const result = runBackupCli(fixture.dbPath, '--all', '--out', output);
        expect(result.status).toBe(0);
        const source = new Database(fixture.dbPath, { readonly: true });
        const exported = new Database(output, { readonly: true });
        try {
            expect(allTableCounts(exported)).toEqual(allTableCounts(source));
            expect(statSync(output).mode & 0o777).toBe(0o600);
        } finally {
            source.close();
            exported.close();
        }
    });

    it('atomically overwrites an existing destination for full and project exports', () => {
        const exporters = [
            (fixture: ReturnType<typeof seedExportFixture>, destination: string, force = false) =>
                exportAll(fixture.fixture.db, destination, force),
            (fixture: ReturnType<typeof seedExportFixture>, destination: string, force = false) =>
                exportProject(fixture.fixture.db, fixture.project, destination, force),
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

    it('preserves an existing --force destination when a project export fails while building its temporary database', () => {
        const { fixture, project } = seedExportFixture();
        const output = path.join(fixture.directory, 'existing-project.db');
        const original = Buffer.from('keep the previous project backup');
        writeFileSync(output, original);
        fixture.db.exec('DROP TABLE session_rollups');

        expect(() => exportProject(fixture.db, project, output, true)).toThrow(/no such table: session_rollups/);
        expect(readFileSync(output)).toEqual(original);
        expect(temporaryFilesFor(output)).toEqual([]);
    });

    it('aborts a busy full-export checkpoint without creating or replacing a destination', () => {
        const { fixture } = seedExportFixture();
        const output = path.join(fixture.directory, 'busy-full.db');
        const original = Buffer.from('keep the previous full backup');
        vi.spyOn(fixture.db, 'pragma').mockReturnValue([{ busy: 1 }] as never);

        expect(() => exportAll(fixture.db, output)).toThrow(
            "Backup aborted: WAL checkpoint did not complete (the daemon may be writing) — run 'elepha pause' or retry.",
        );
        expect(existsSync(output)).toBe(false);

        writeFileSync(output, original);
        expect(() => exportAll(fixture.db, output, true)).toThrow(/WAL checkpoint did not complete/);
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

        exportAll(fixture.db, output);

        const exported = new Database(output, { readonly: true });
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

        fixture.close();
        expect(runBackupCli(fixture.dbPath, '--all', '--out', sharedOutput).status).toBe(0);
        expect(statSync(shared).mode & 0o777).toBe(0o755);
        expect(runBackupCli(fixture.dbPath, '--all', '--out', createdOutput).status).toBe(0);
        expect(statSync(path.dirname(createdOutput)).mode & 0o777).toBe(0o700);
        expect(statSync(path.dirname(path.dirname(createdOutput))).mode & 0o777).toBe(0o700);
        expect(statSync(createdOutput).mode & 0o777).toBe(0o600);
    });

    it('refuses a symlink destination without touching its target', () => {
        const { fixture } = seedExportFixture();
        const target = path.join(fixture.directory, 'target.db');
        const destination = path.join(fixture.directory, 'linked-backup.db');
        const original = Buffer.from('do not overwrite this target');
        writeFileSync(target, original);
        symlinkSync(target, destination);

        fixture.close();
        const result = runBackupCli(fixture.dbPath, '--all', '--out', destination, '--force');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`refusing to write a backup through a symlink: ${destination}`);
        expect(readFileSync(target)).toEqual(original);
        expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    });

    it('writes a full export to the default elepha backups directory', () => {
        const { fixture } = seedExportFixture();
        const expectedDirectory = path.join(fixture.directory, 'isolated-elepha-home', 'backups');

        fixture.close();
        const result = runBackupCli(fixture.dbPath, '--all');
        expect(result.status, result.stderr).toBe(0);
        const written = result.stdout.match(/Backup written to (.+)\./)?.[1];
        expect(written).toBeDefined();
        expect(path.dirname(written ?? '')).toBe(expectedDirectory);
        expect(statSync(written ?? '').mode & 0o777).toBe(0o600);
        expect(statSync(expectedDirectory).mode & 0o777).toBe(0o700);
    });

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
                backupProject: async (selected, destination) => exportProject(fixture.db, selected, destination),
            }),
        ).resolves.toBe(0);

        const exported = new Database(output, { readonly: true });
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
