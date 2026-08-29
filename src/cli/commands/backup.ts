import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Command } from 'commander';
import { PRIVATE_FILE_MODE, USER_BACKUPS_DIR_NAME } from '../../config/constants.js';
import { canonicalizeExisting, elephaHome, normalizeForCompare } from '../../config/paths.js';
import { defaultDbPath, openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { ProjectResolver, type ProjectSet } from '../../storage/project-resolver.js';
import { ensureCreatedDirsPrivate, listRegularFiles, setPrivateFileMode } from '../../util/fs.js';
import { runBackupWizard } from '../backup-wizard.js';

const EXPORTED_TABLES = ['projects', 'sessions', 'memories', 'session_rollups'] as const;

interface BackupCommandOptions {
    all: boolean;
    force: boolean;
    project?: string;
    out?: string;
}

interface SchemaRow {
    type: 'table' | 'index';
    name: string;
    sql: string;
}

export interface FullBackup {
    path: string;
    mtimeMs: number;
    bytes: number;
}

/** Registers portable, user-requested database exports. Safety snapshots remain in storage/backup.ts. */
export function registerBackup(program: Command): void {
    program
        .command('backup')
        .description('Export elepha memory to a portable SQLite file')
        .option('--all', 'export the whole elepha database')
        .option('--project <pathOrName>', 'export one consolidated project set')
        .option('--out <path>', 'write to this file or directory instead of ~/.elepha/backups')
        .option('--force', 'overwrite an existing backup destination')
        .action(async (opts: BackupCommandOptions) => {
            const scopes = [opts.all, opts.project !== undefined].filter(Boolean).length;
            if (scopes > 1) {
                console.error('Specify only one of --all or --project <pathOrName>.');
                process.exitCode = 1;
                return;
            }
            if (scopes === 0 && !process.stdin.isTTY) {
                console.error('Specify --all or --project <pathOrName>.');
                process.exitCode = 1;
                return;
            }

            const dbPath = defaultDbPath();
            const db = openDb(dbPath);
            const store = new MemoryStore(db);
            const defaultOutput = (project?: ProjectSet) => {
                const generated = defaultBackupPath(project);
                return opts.out === undefined ? generated : resolveOutput(opts.out, generated);
            };
            try {
                if (scopes === 0) {
                    process.exitCode = await runBackupWizard({
                        store,
                        defaultOutput,
                        backupAll: async (output) => exportAll(db, resolveOutput(output, defaultOutput()), opts.force),
                        backupProject: async (project, output) =>
                            exportProject(db, project, resolveOutput(output, defaultOutput(project)), opts.force),
                    });
                    return;
                }

                if (opts.all) {
                    const written = exportAll(db, resolveOutput(opts.out, defaultOutput()), opts.force);
                    console.log(`Backup written to ${written}.`);
                    return;
                }

                const resolution = new ProjectResolver(db).resolve(opts.project ?? '');
                if (!('project' in resolution) || resolution.project === null) {
                    console.error(`No project matching "${opts.project}".`);
                    process.exitCode = 1;
                    return;
                }
                if ('ambiguous' in resolution) {
                    console.error(`Project "${opts.project}" is ambiguous. Use a more specific path or name.`);
                    process.exitCode = 1;
                    return;
                }
                const written = exportProject(
                    db,
                    resolution.project,
                    resolveOutput(opts.out, defaultOutput(resolution.project)),
                    opts.force,
                );
                console.log(`Backup written to ${written}.`);
            } finally {
                db.close();
            }
        });
}

function backupDirectory(): string {
    return path.join(elephaHome(), USER_BACKUPS_DIR_NAME);
}

/** Lists complete database exports only; project exports are not valid restore candidates. */
export function listFullBackups(): FullBackup[] {
    return listRegularFiles(backupDirectory())
        .filter((file) => /^elepha-full-.*\.db$/.test(path.basename(file)))
        .map((file) => {
            const stats = statSync(file);
            return { path: file, mtimeMs: stats.mtimeMs, bytes: stats.size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || path.basename(b.path).localeCompare(path.basename(a.path)));
}

function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function projectSlug(project: ProjectSet): string {
    const source = project.displayName || project.paths[0] || 'project';
    const slug = source
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'project';
}

export function defaultBackupPath(project?: ProjectSet): string {
    const filename = project ? `elepha-${projectSlug(project)}-${timestamp()}.db` : `elepha-full-${timestamp()}.db`;
    return path.join(backupDirectory(), filename);
}

/** Existing directories stay directories; a trailing separator also creates a directory. Other values are file paths. */
export function resolveOutput(output: string | undefined, defaultPath: string): string {
    if (output === undefined) {
        return defaultPath;
    }
    const resolved = path.resolve(output);
    if ((existsSync(resolved) && statSync(resolved).isDirectory()) || output.endsWith(path.sep)) {
        return path.join(resolved, path.basename(defaultPath));
    }
    return resolved;
}

/** Full exports retain the source database bytes after a WAL checkpoint, unlike pruned safety snapshots. */
export function exportAll(db: Database.Database, destination: string, force = false): string {
    if (db.name === ':memory:') {
        throw new Error('A full backup requires an on-disk database.');
    }
    refuseActiveDatabaseDestination(db.name, destination);
    prepareDestination(destination, force);
    const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: unknown }>;
    if (checkpoint?.busy !== 0) {
        throw new Error("Backup aborted: WAL checkpoint did not complete (the daemon may be writing) — run 'elepha pause' or retry.");
    }
    replaceDestination(destination, (temporary) => copyFileSync(db.name, temporary));
    return destination;
}

/** Exports exactly one resolved ProjectSet and the four portable tables that reference it. */
export function exportProject(source: Database.Database, project: ProjectSet, destination: string, force = false): string {
    refuseActiveDatabaseDestination(source.name, destination);
    prepareDestination(destination, force);
    replaceDestination(destination, (temporary) => {
        const target = new Database(temporary);
        setPrivateFileMode(temporary, PRIVATE_FILE_MODE);
        try {
            target.pragma('foreign_keys = ON');
            const exportSnapshot = source.transaction(() => {
                createExportSchema(source, target);
                copyProjectRows(source, target, project.projectIds);
            });
            exportSnapshot();
        } finally {
            target.close();
        }
    });
    return destination;
}

function refuseActiveDatabaseDestination(activeDatabase: string, destination: string): void {
    if (activeDatabase === ':memory:') {
        return;
    }
    const canonicalDestination = path.join(canonicalizeExisting(path.dirname(destination)), path.basename(destination));
    if (normalizeForCompare(canonicalDestination) === normalizeForCompare(canonicalizeExisting(activeDatabase))) {
        throw new Error('Backup destination must not be the active database.');
    }
}

/** Rejects unsafe destinations before creating a backup file. */
function prepareDestination(destination: string, force: boolean): void {
    let destinationInfo: ReturnType<typeof lstatSync> | undefined;
    try {
        destinationInfo = lstatSync(destination);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
    if (destinationInfo?.isSymbolicLink()) {
        throw new Error(`refusing to write a backup through a symlink: ${destination}`);
    }
    if (destinationInfo !== undefined && !force) {
        throw new Error(`Backup destination already exists: ${destination} (pass --force to overwrite)`);
    }
    ensureCreatedDirsPrivate(path.dirname(destination));
}

function replaceDestination(destination: string, writeTemporary: (temporary: string) => void): void {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeTemporary(temporary);
        setPrivateFileMode(temporary, PRIVATE_FILE_MODE);
        renameSync(temporary, destination);
    } catch (error: unknown) {
        try {
            unlinkSync(temporary);
        } catch (cleanupError: unknown) {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw cleanupError;
            }
        }
        throw error;
    }
}

function createExportSchema(source: Database.Database, target: Database.Database): void {
    const placeholders = EXPORTED_TABLES.map(() => '?').join(', ');
    const schema = source
        .prepare(
            `SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND tbl_name IN (${placeholders}) AND sql IS NOT NULL`,
        )
        .all(...EXPORTED_TABLES) as SchemaRow[];
    for (const entry of schema.filter((entry) => entry.type === 'table')) {
        target.exec(entry.sql);
    }
    for (const entry of schema.filter((entry) => entry.type === 'index')) {
        target.exec(entry.sql);
    }
}

function copyProjectRows(source: Database.Database, target: Database.Database, projectIds: number[]): void {
    const ids = projectIds.map(() => '?').join(', ');
    const sessionIds = source.prepare(`SELECT id FROM sessions WHERE project_id IN (${ids})`).all(...projectIds) as Array<{ id: number }>;
    const sessionPlaceholders = sessionIds.map(() => '?').join(', ');
    const targetTransaction = target.transaction(() => {
        copyRows(source, target, 'projects', `SELECT * FROM projects WHERE id IN (${ids})`, projectIds);
        copyRows(source, target, 'sessions', `SELECT * FROM sessions WHERE project_id IN (${ids})`, projectIds);
        if (sessionIds.length > 0) {
            const values = sessionIds.map((session) => session.id);
            copyRows(source, target, 'memories', `SELECT * FROM memories WHERE session_id IN (${sessionPlaceholders})`, values);
            copyRows(
                source,
                target,
                'session_rollups',
                `SELECT * FROM session_rollups WHERE session_id IN (${sessionPlaceholders})`,
                values,
            );
        }
    });
    targetTransaction();
}

function copyRows(
    source: Database.Database,
    target: Database.Database,
    table: (typeof EXPORTED_TABLES)[number],
    sql: string,
    values: number[],
): void {
    const rows = source.prepare(sql).all(...values) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
        return;
    }
    const columns = Object.keys(rows[0] ?? {});
    const statement = target.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    for (const row of rows) {
        statement.run(...columns.map((column) => row[column]));
    }
}
