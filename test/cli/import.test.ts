import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportAll, exportProject } from '../../src/cli/commands/backup.js';
import { IMPORTED_TABLES, reportImportError, runImportOperation } from '../../src/cli/commands/import.js';
import { codexSessionsRoot } from '../../src/config/paths.js';
import { detectShellSyntax, stripShellSyntax } from '../../src/security/sanitize.js';
import { writeBackup } from '../../src/storage/backup.js';
import { firstPromptSearch } from '../../src/storage/first-prompt-search.js';
import type { ProjectRow } from '../../src/storage/memory-store.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import { readProjectSessions } from '../../src/storage/session-read-model.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession, type TestDatabase } from '../helpers/db.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const elephaCli = path.join(repositoryRoot, 'src', 'cli', 'index.ts');
const previousCodexHome = process.env.CODEX_HOME;
let testCodexHome = '';

beforeAll(() => {
    testCodexHome = mkdtempSync(path.join(tmpdir(), 'elepha-import-codex-home-'));
    process.env.CODEX_HOME = testCodexHome;
});

afterAll(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(testCodexHome, { recursive: true, force: true });
});

function runImportCli(dbPath: string, ...args: string[]) {
    return spawnSync(process.execPath, [tsxCli, elephaCli, 'import', ...args], {
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

function runTtyImportCli(dbPath: string, input: string, ...args: string[]) {
    const source = [
        "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
        "Object.defineProperty(process.stdout, 'isTTY', { value: true });",
        `process.argv = [process.execPath, 'import', ...${JSON.stringify(args)}];`,
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

function notRunning() {
    return { state: 'NOT RUNNING', healthy: false };
}

function canonicalDirectory(directory: string): string {
    mkdirSync(directory, { recursive: true });
    return realpathSync(directory);
}

function setProjectIdentity(fixture: TestDatabase, project: ProjectRow, remote: string, rootCommit: string): ProjectRow {
    fixture.db
        .prepare('UPDATE projects SET git_remote = ?, git_root_commit = ?, git_root = ? WHERE id = ?')
        .run(remote, rootCommit, project.path, project.id);
    return fixture.db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as ProjectRow;
}

function addFragment(fixture: TestDatabase, project: ProjectRow, fragmentPath: string): ProjectRow {
    const id = Number(
        fixture.db
            .prepare(
                `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                fragmentPath,
                path.basename(fragmentPath),
                project.git_root,
                project.git_remote,
                project.git_root_commit,
                project.first_seen_at,
                project.last_seen_at,
            ).lastInsertRowid,
    );
    return fixture.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
}

function addSession(fixture: TestDatabase, project: ProjectRow, nativeId: string, marker: string, transcriptCwd = project.path) {
    const sourcePath = path.join(codexSessionsRoot(), 'elepha-import-test', path.basename(fixture.directory), `${marker}.jsonl`);
    mkdirSync(transcriptCwd, { recursive: true });
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(
        sourcePath,
        `${JSON.stringify({ timestamp: '2026-08-02T00:00:00.000Z', type: 'session_meta', payload: { cwd: transcriptCwd } })}\n`,
    );
    const session = seedSession(fixture, {
        project,
        nativeId,
        sourcePath,
        title: `${marker} title`,
        lastIngestedAt: `2026-08-${marker === 'local' ? '01' : '02'}T00:00:00.000Z`,
    });
    seedMemory(fixture, {
        project,
        session,
        decisions: [{ what: `${marker} decision`, why: `${marker} reason` }],
        pendingItems: [`${marker} pending`],
        filesTouched: [`/${marker}.ts`],
    });
    seedRollup(fixture, {
        project,
        session,
        decisions: [{ what: `${marker} rollup`, why: `${marker} reason`, turnIndex: 0 }],
        filesTouched: [`/${marker}.ts`],
    });
    fixture.db.prepare('UPDATE session_rollups SET kind = ? WHERE session_id = ?').run('primary', session.id);
    return session;
}

function fullBackup(fixture: TestDatabase, active: TestDatabase): string {
    active.store.consent.grant(fixture.directory);
    const destination = path.join(fixture.directory, 'backup.db');
    exportAll(fixture.db, destination);
    return destination;
}

function rows(dbPath: string, table: (typeof IMPORTED_TABLES)[number]): unknown[] {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    } finally {
        db.close();
    }
}

function row(dbPath: string, table: string, where: string, values: unknown[]): Record<string, unknown> | undefined {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...values) as Record<string, unknown> | undefined;
    } finally {
        db.close();
    }
}

function tableCount(dbPath: string, table: string): number {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    } finally {
        db.close();
    }
}

function memoryCountForNativeSession(dbPath: string, tool: string, nativeId: string): number {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return Number(
            (
                db
                    .prepare(
                        `SELECT COUNT(*) AS count
                         FROM memories
                         JOIN sessions ON sessions.id = memories.session_id
                         WHERE sessions.tool = ? AND sessions.native_id = ?`,
                    )
                    .get(tool, nativeId) as { count: number }
            ).count,
        );
    } finally {
        db.close();
    }
}

function portableRows(dbPath: string): Record<(typeof IMPORTED_TABLES)[number], unknown[]> {
    return Object.fromEntries(IMPORTED_TABLES.map((table) => [table, rows(dbPath, table)])) as Record<
        (typeof IMPORTED_TABLES)[number],
        unknown[]
    >;
}

function mutateActiveDatabase(dbPath: string, mutation: (db: Database.Database) => void): Buffer {
    const db = new Database(dbPath, { fileMustExist: true });
    try {
        mutation(db);
    } finally {
        db.close();
    }
    return readFileSync(dbPath);
}

describe('elepha import', () => {
    it('accepts --overwrite for matching sessions and rejects the retired --replace flag', () => {
        const active = createTestDb('elepha-import-overwrite-cli-active-');
        const backupSource = createTestDb('elepha-import-overwrite-cli-source-');
        const localProjectPath = canonicalDirectory(path.join(active.directory, 'local-repo'));
        const localProject = setProjectIdentity(
            active,
            seedProject(active, { path: localProjectPath }),
            'git@example.com:team/repo.git',
            'root-commit',
        );
        addSession(active, localProject, 'shared-session', 'local');
        const backupProject = setProjectIdentity(
            backupSource,
            seedProject(backupSource, { path: path.join(backupSource.directory, 'backup-repo') }),
            'git@example.com:team/repo.git',
            'root-commit',
        );
        addSession(backupSource, backupProject, 'shared-session', 'backup', localProject.path);
        active.store.consent.grant(localProject.path);
        const backup = fullBackup(backupSource, active);
        active.close();
        backupSource.close();

        const overwritten = runImportCli(active.dbPath, '--overwrite', backup, '--skip-confirmation');
        expect(overwritten.status, overwritten.stderr).toBe(0);
        expect(overwritten.stdout).toContain('0 added, 1 overwritten, 0 skipped');
        expect(row(active.dbPath, 'sessions', 'native_id = ?', ['shared-session'])?.title).toBe('backup title');

        const retired = runImportCli(active.dbPath, '--replace', backup, '--skip-confirmation');
        expect(retired.status).toBe(1);
        expect(retired.stderr).toContain("unknown option '--replace'");
    });

    it('sanitizes and caps first_prompt_search when adding a new session', async () => {
        const active = createTestDb('elepha-import-first-prompt-active-');
        const backupSource = createTestDb('elepha-import-first-prompt-source-');
        const session = addSession(backupSource, seedProject(backupSource), 'new-session', 'new');
        const candidateFirstPrompt = `remember $(whoami) \`danger\` ${'x'.repeat(10_000)}`;
        backupSource.db.prepare('UPDATE sessions SET first_prompt_search = ? WHERE id = ?').run(candidateFirstPrompt, session.id);
        const backup = fullBackup(backupSource, active);
        active.close();
        backupSource.close();

        await expect(runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning })).resolves.toMatchObject({
            cancelled: false,
            added: 1,
        });

        expect(row(active.dbPath, 'sessions', 'native_id = ?', ['new-session'])?.first_prompt_search).toBe(
            firstPromptSearch(candidateFirstPrompt),
        );
    });

    it('imports an older export without first_prompt_search and stores NULL', async () => {
        const active = createTestDb('elepha-import-legacy-active-');
        const backupSource = createTestDb('elepha-import-legacy-source-');
        addSession(backupSource, seedProject(backupSource), 'legacy-session', 'legacy');
        const backup = fullBackup(backupSource, active);
        const legacyBackup = new Database(backup);
        legacyBackup.exec('ALTER TABLE sessions DROP COLUMN first_prompt_search');
        legacyBackup.close();
        active.close();
        backupSource.close();

        await expect(runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning })).resolves.toMatchObject({
            cancelled: false,
            added: 1,
        });
        expect(row(active.dbPath, 'sessions', 'native_id = ?', ['legacy-session'])?.first_prompt_search).toBeNull();
    });

    it('reapplies the Rule 3 choke points to imported sessions, memories, and rollups', async () => {
        const active = createTestDb('elepha-import-sanitize-active-');
        const backupSource = createTestDb('elepha-import-sanitize-source-');
        const project = seedProject(backupSource);
        const session = addSession(backupSource, project, 'dirty-session', 'dirty');
        const dirtyRollupDecisions = JSON.stringify([
            {
                what: 'rollup decision `$(evil)\x1b[31m\x07',
                why: 'rollup why $' + '{evil}',
                turnIndex: 7,
                at: '2026-08-02T07:00:00.000Z',
                provenance: 'preserve me',
            },
        ]);
        const dirtyRollupPendingItems = JSON.stringify(['rollup pending `$(evil)\x1b[31m\x07']);
        const dirtyFilesTouched = '["/literal/$(keep)/`file`.ts"]';
        backupSource.db
            .prepare('UPDATE sessions SET title = ?, custom_title = ? WHERE id = ?')
            .run('title `$(evil)\x1b[31m\x07', 'custom $' + '{evil}\x1b]0;bad\x07', session.id);
        backupSource.db
            .prepare('UPDATE memories SET decisions = ?, pending_items = ? WHERE session_id = ?')
            .run(
                JSON.stringify([{ what: 'decision `$(evil)\x1b[31m\x07', why: 'why $' + '{evil}' }]),
                JSON.stringify(['pending `$(evil)\x1b[31m\x07']),
                session.id,
            );
        backupSource.db
            .prepare(
                'UPDATE session_rollups SET title = ?, summary = ?, decisions = ?, pending_items = ?, files_touched = ? WHERE session_id = ?',
            )
            .run(
                'rollup title `$(evil)\x1b[31m\x07',
                'rollup summary $' + '{evil}\x1b]0;bad\x07',
                dirtyRollupDecisions,
                dirtyRollupPendingItems,
                dirtyFilesTouched,
                session.id,
            );

        const malformedSession = addSession(backupSource, project, 'malformed-rollup', 'malformed');
        const malformedDecisions = '{broken: `$(evil)\x1b[31m\x07';
        const malformedPendingItems = '[pending $' + '{evil}\x1b]0;bad\x07';
        backupSource.db
            .prepare('UPDATE session_rollups SET decisions = ?, pending_items = ? WHERE session_id = ?')
            .run(malformedDecisions, malformedPendingItems, malformedSession.id);
        const backup = fullBackup(backupSource, active);
        active.close();
        backupSource.close();

        await expect(runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning })).resolves.toMatchObject({
            cancelled: false,
            added: 2,
        });

        const importedSession = row(active.dbPath, 'sessions', 'native_id = ?', ['dirty-session']);
        const importedMemory = row(active.dbPath, 'memories', 'session_id = ?', [importedSession?.id]);
        const importedRollup = row(active.dbPath, 'session_rollups', 'session_id = ?', [importedSession?.id]);
        for (const value of [importedSession?.title, importedSession?.custom_title]) {
            expect(detectShellSyntax(value as string)).toBe(false);
        }
        const decisions = JSON.parse(importedMemory?.decisions as string) as Array<{ what: string; why: string | null }>;
        const pendingItems = JSON.parse(importedMemory?.pending_items as string) as string[];
        for (const decision of decisions) {
            expect(detectShellSyntax(decision.what)).toBe(false);
            if (decision.why !== null) expect(detectShellSyntax(decision.why)).toBe(false);
        }
        expect(pendingItems.every((item) => !detectShellSyntax(item))).toBe(true);

        for (const value of [importedRollup?.title, importedRollup?.summary]) {
            expect(detectShellSyntax(value as string)).toBe(false);
        }
        const rollupDecisions = JSON.parse(importedRollup?.decisions as string) as Array<{
            what: string;
            why: string;
            turnIndex: number;
            at: string;
            provenance: string;
        }>;
        expect(rollupDecisions).toMatchObject([{ turnIndex: 7, at: '2026-08-02T07:00:00.000Z', provenance: 'preserve me' }]);
        expect(rollupDecisions.every((decision) => !detectShellSyntax(decision.what) && !detectShellSyntax(decision.why))).toBe(true);
        expect((JSON.parse(importedRollup?.pending_items as string) as string[]).every((item) => !detectShellSyntax(item))).toBe(true);
        expect(importedRollup?.files_touched).toBe(dirtyFilesTouched);

        const importedMalformedSession = row(active.dbPath, 'sessions', 'native_id = ?', ['malformed-rollup']);
        const importedMalformedRollup = row(active.dbPath, 'session_rollups', 'session_id = ?', [importedMalformedSession?.id]);
        expect(importedMalformedRollup?.decisions).toBe(stripShellSyntax(malformedDecisions));
        expect(importedMalformedRollup?.pending_items).toBe(stripShellSyntax(malformedPendingItems));
    });

    it('skips an out-of-store session and its memories while importing an in-store session', async () => {
        const active = createTestDb('elepha-import-store-active-');
        const backupSource = createTestDb('elepha-import-store-source-');
        const project = seedProject(backupSource);
        const imported = addSession(backupSource, project, 'inside-store', 'inside');
        const outside = seedSession(backupSource, {
            project,
            nativeId: 'outside-store',
            sourcePath: path.join(backupSource.directory, 'outside.jsonl'),
        });
        seedMemory(backupSource, {
            project,
            session: outside,
            decisions: [{ what: 'outside decision', why: 'must not import' }],
        });
        const backup = fullBackup(backupSource, active);
        active.close();
        backupSource.close();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await expect(runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning })).resolves.toMatchObject({
                cancelled: false,
                added: 1,
                skipped: 1,
            });
            expect(error).toHaveBeenCalledWith('1 skipped (transcript outside provider store)');
        } finally {
            error.mockRestore();
        }

        expect(row(active.dbPath, 'sessions', 'native_id = ?', [imported.native_id])).toBeDefined();
        expect(row(active.dbPath, 'sessions', 'native_id = ?', [outside.native_id])).toBeUndefined();
        expect(tableCount(active.dbPath, 'memories')).toBe(1);
    });

    it('rejects a non-string imported source path before provider-store containment', async () => {
        const active = createTestDb('elepha-import-non-string-path-active-');
        const backupSource = createTestDb('elepha-import-non-string-path-source-');
        const session = addSession(backupSource, seedProject(backupSource), 'non-string-path', 'non-string');
        backupSource.db.prepare('UPDATE sessions SET source_path = ? WHERE id = ?').run(Buffer.from('/not/a/string'), session.id);
        const backup = fullBackup(backupSource, active);
        active.close();
        backupSource.close();

        await expect(runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning })).resolves.toMatchObject({
            cancelled: false,
            added: 0,
            skipped: 1,
        });
        expect(row(active.dbPath, 'sessions', 'native_id = ?', [session.native_id])).toBeUndefined();
    });

    it.each([
        { mode: 'safe', overwrite: false },
        { mode: 'overwrite', overwrite: true },
    ])('keeps an active incognito veto authoritative in $mode mode', async ({ overwrite }) => {
        const active = createTestDb('elepha-import-incognito-active-');
        const backupSource = createTestDb('elepha-import-incognito-source-');
        const vetoedNativeId = 'incognito-session';
        const unrelatedNativeId = 'unrelated-session';
        const tombstone = {
            tool: 'codex',
            native_id: vetoedNativeId,
            tombstoned_at: '2026-08-26T00:00:00.000Z',
        };
        active.db
            .prepare('INSERT INTO incognito_transcripts (tool, native_id, tombstoned_at) VALUES (@tool, @native_id, @tombstoned_at)')
            .run(tombstone);
        const project = seedProject(backupSource);
        addSession(backupSource, project, vetoedNativeId, 'vetoed');
        addSession(backupSource, project, unrelatedNativeId, 'unrelated');
        const backup = fullBackup(backupSource, active);
        active.close();
        backupSource.close();
        let vetoedDisposition: string | undefined;
        let incognitoCount = -1;
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await expect(
                runImportOperation(backup, overwrite, {
                    dbPath: active.dbPath,
                    daemonHealth: notRunning,
                    confirm: async (plan) => {
                        vetoedDisposition = plan.sessions.find((session) => session.row.native_id === vetoedNativeId)?.disposition;
                        incognitoCount = plan.counts.incognito;
                        return true;
                    },
                }),
            ).resolves.toMatchObject({ cancelled: false, added: 1, overwritten: 0, skipped: 1 });
            expect(log).toHaveBeenCalledWith(expect.stringContaining('1 skipped (incognito)'));
        } finally {
            log.mockRestore();
        }

        expect(vetoedDisposition).toBe('incognito');
        expect(incognitoCount).toBe(1);
        expect(row(active.dbPath, 'sessions', 'tool = ? AND native_id = ?', ['codex', vetoedNativeId])).toBeUndefined();
        expect(memoryCountForNativeSession(active.dbPath, 'codex', vetoedNativeId)).toBe(0);
        expect(row(active.dbPath, 'sessions', 'tool = ? AND native_id = ?', ['codex', unrelatedNativeId])).toBeDefined();
        expect(memoryCountForNativeSession(active.dbPath, 'codex', unrelatedNativeId)).toBe(1);
        expect(row(active.dbPath, 'incognito_transcripts', 'tool = ? AND native_id = ?', ['codex', vetoedNativeId])).toEqual(tombstone);
    });

    it('aborts when consent for a planned new session is revoked before apply', async () => {
        const active = createTestDb('elepha-import-recheck-new-active-');
        const backupSource = createTestDb('elepha-import-recheck-new-source-');
        const cwd = canonicalDirectory(path.join(active.directory, 'approved-project'));
        const nativeId = 'new-revoked-during-confirmation';
        addSession(backupSource, seedProject(backupSource, { path: cwd }), nativeId, 'new-revoked', cwd);
        active.store.consent.grant(cwd);
        const backup = path.join(backupSource.directory, 'backup.db');
        exportAll(backupSource.db, backup);
        active.close();
        backupSource.close();

        let beforeApplyBytes: Buffer | undefined;
        const error = await runImportOperation(backup, false, {
            dbPath: active.dbPath,
            daemonHealth: notRunning,
            confirm: async (plan) => {
                expect(plan.sessions.find((session) => session.row.native_id === nativeId)?.disposition).toBe('new');
                beforeApplyBytes = mutateActiveDatabase(active.dbPath, (db) => {
                    db.prepare("UPDATE consent_roots SET state = 'denied' WHERE path = ?").run(cwd);
                });
                return true;
            },
        }).then(
            () => undefined,
            (cause: unknown) => cause,
        );

        expect(error).toEqual(
            expect.objectContaining({
                message: expect.stringMatching(new RegExp(`${nativeId}.*Nothing was imported.*Re-run elepha import`, 's')),
            }),
        );
        const previousExitCode = process.exitCode;
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            reportImportError(error);
            expect(process.exitCode).toBe(1);
            expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(nativeId));
        } finally {
            process.exitCode = previousExitCode;
            errorLog.mockRestore();
        }

        expect(beforeApplyBytes).toBeDefined();
        expect(readFileSync(active.dbPath)).toEqual(beforeApplyBytes);
        expect(row(active.dbPath, 'sessions', 'native_id = ?', [nativeId])).toBeUndefined();
        expect(tableCount(active.dbPath, 'memories')).toBe(0);
        expect(tableCount(active.dbPath, 'session_rollups')).toBe(0);
        expect(tableCount(active.dbPath, 'incognito_transcripts')).toBe(0);
    });

    it('aborts an overwrite when consent for a planned existing session is revoked before apply', async () => {
        const active = createTestDb('elepha-import-recheck-existing-active-');
        const backupSource = createTestDb('elepha-import-recheck-existing-source-');
        const cwd = canonicalDirectory(path.join(active.directory, 'approved-project'));
        const nativeId = 'existing-revoked-during-confirmation';
        const localProject = seedProject(active, { path: cwd });
        const localSession = addSession(active, localProject, nativeId, 'local-existing', cwd);
        addSession(backupSource, seedProject(backupSource, { path: cwd }), nativeId, 'backup-existing', cwd);
        active.store.consent.grant(cwd);
        const backup = path.join(backupSource.directory, 'backup.db');
        exportAll(backupSource.db, backup);
        const portableBefore = portableRows(active.dbPath);
        active.close();
        backupSource.close();

        let beforeApplyBytes: Buffer | undefined;
        await expect(
            runImportOperation(backup, true, {
                dbPath: active.dbPath,
                daemonHealth: notRunning,
                confirm: async (plan) => {
                    expect(plan.sessions.find((session) => session.row.native_id === nativeId)?.disposition).toBe('existing');
                    beforeApplyBytes = mutateActiveDatabase(active.dbPath, (db) => {
                        db.prepare("UPDATE consent_roots SET state = 'denied' WHERE path = ?").run(cwd);
                    });
                    return true;
                },
            }),
        ).rejects.toThrow(new RegExp(`${nativeId}.*Nothing was imported.*Re-run elepha import`, 's'));

        expect(beforeApplyBytes).toBeDefined();
        expect(readFileSync(active.dbPath)).toEqual(beforeApplyBytes);
        expect(portableRows(active.dbPath)).toEqual(portableBefore);
        expect(row(active.dbPath, 'sessions', 'id = ?', [localSession.id])?.title).toBe('local-existing title');
        expect(memoryCountForNativeSession(active.dbPath, 'codex', nativeId)).toBe(1);
        expect(row(active.dbPath, 'session_rollups', 'session_id = ?', [localSession.id])).toBeDefined();
    });

    it.each([
        { veto: 'purged', table: 'purged_transcripts', timestampColumn: 'purged_at' },
        { veto: 'incognito', table: 'incognito_transcripts', timestampColumn: 'tombstoned_at' },
    ] as const)('aborts when a planned new session becomes $veto before apply', async ({ table, timestampColumn, veto }) => {
        const active = createTestDb(`elepha-import-recheck-${veto}-active-`);
        const backupSource = createTestDb(`elepha-import-recheck-${veto}-source-`);
        const cwd = canonicalDirectory(path.join(active.directory, 'approved-project'));
        const nativeId = `${veto}-during-confirmation`;
        addSession(backupSource, seedProject(backupSource, { path: cwd }), nativeId, veto, cwd);
        active.store.consent.grant(cwd);
        const backup = path.join(backupSource.directory, 'backup.db');
        exportAll(backupSource.db, backup);
        active.close();
        backupSource.close();

        let beforeApplyBytes: Buffer | undefined;
        await expect(
            runImportOperation(backup, false, {
                dbPath: active.dbPath,
                daemonHealth: notRunning,
                confirm: async (plan) => {
                    expect(plan.sessions.find((session) => session.row.native_id === nativeId)?.disposition).toBe('new');
                    beforeApplyBytes = mutateActiveDatabase(active.dbPath, (db) => {
                        db.prepare(`INSERT INTO ${table} (tool, native_id, ${timestampColumn}) VALUES (?, ?, ?)`).run(
                            'codex',
                            nativeId,
                            '2026-08-28T00:00:00.000Z',
                        );
                    });
                    return true;
                },
            }),
        ).rejects.toThrow(new RegExp(`${nativeId}.*Nothing was imported.*Re-run elepha import`, 's'));

        expect(beforeApplyBytes).toBeDefined();
        expect(readFileSync(active.dbPath)).toEqual(beforeApplyBytes);
        expect(row(active.dbPath, 'sessions', 'native_id = ?', [nativeId])).toBeUndefined();
        expect(tableCount(active.dbPath, 'memories')).toBe(0);
        expect(tableCount(active.dbPath, 'session_rollups')).toBe(0);
        expect(tableCount(active.dbPath, table)).toBe(1);
    });

    it('preserves import counts and output when every planned authorization is unchanged', async () => {
        const active = createTestDb('elepha-import-recheck-unchanged-active-');
        const backupSource = createTestDb('elepha-import-recheck-unchanged-source-');
        const cwd = canonicalDirectory(path.join(active.directory, 'approved-project'));
        addSession(backupSource, seedProject(backupSource, { path: cwd }), 'unchanged-session', 'unchanged', cwd);
        active.store.consent.grant(cwd);
        const backup = path.join(backupSource.directory, 'backup.db');
        exportAll(backupSource.db, backup);
        active.close();
        backupSource.close();
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await expect(
                runImportOperation(backup, false, {
                    dbPath: active.dbPath,
                    daemonHealth: notRunning,
                    confirm: async (plan) => {
                        expect(plan.counts).toEqual({
                            new: 1,
                            existing: 0,
                            purged: 0,
                            incognito: 0,
                            unconsented: 0,
                            outsideStore: 0,
                        });
                        return true;
                    },
                }),
            ).resolves.toMatchObject({ cancelled: false, added: 1, overwritten: 0, skipped: 0 });
            expect(log).toHaveBeenCalledWith(
                '1 new, 0 skipped (already present), 0 skipped (purged), 0 skipped (incognito), 0 skipped (unconsented)',
            );
            expect(log).toHaveBeenCalledWith(
                expect.stringMatching(/^Imported: 1 added, 0 overwritten, 0 skipped\. 0 skipped \(unconsented\)\. Snapshot: /),
            );
        } finally {
            log.mockRestore();
        }
    });

    it('rejects forged approved-project identity when the local transcript cwd is unconsented, while importing an approved control', async () => {
        const active = createTestDb('elepha-import-consent-active-');
        const approvedRoot = canonicalDirectory(path.join(active.directory, 'approved-project'));
        const localProject = setProjectIdentity(
            active,
            seedProject(active, { path: approvedRoot }),
            'git@example.com:team/approved.git',
            'approved-root-commit',
        );
        active.store.consent.grant(approvedRoot);

        const unconsentedSource = createTestDb('elepha-import-consent-unapproved-source-');
        const unconsentedCwd = path.join(unconsentedSource.directory, 'unapproved-project');
        mkdirSync(unconsentedCwd, { recursive: true });
        const forgedUnconsentedProject = setProjectIdentity(
            unconsentedSource,
            seedProject(unconsentedSource, { path: unconsentedCwd }),
            localProject.git_remote ?? '',
            localProject.git_root_commit ?? '',
        );
        addSession(unconsentedSource, forgedUnconsentedProject, 'forged-unconsented', 'forged-unconsented', unconsentedCwd);
        const unconsentedBackup = path.join(unconsentedSource.directory, 'backup.db');
        exportAll(unconsentedSource.db, unconsentedBackup);

        const approvedSource = createTestDb('elepha-import-consent-approved-source-');
        const forgedApprovedProject = setProjectIdentity(
            approvedSource,
            seedProject(approvedSource),
            localProject.git_remote ?? '',
            localProject.git_root_commit ?? '',
        );
        addSession(approvedSource, forgedApprovedProject, 'approved-control', 'approved-control', approvedRoot);
        const approvedBackup = path.join(approvedSource.directory, 'backup.db');
        exportAll(approvedSource.db, approvedBackup);

        active.close();
        unconsentedSource.close();
        approvedSource.close();
        let unconsentedDisposition: string | undefined;
        let unconsentedCount = -1;
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await expect(
                runImportOperation(unconsentedBackup, false, {
                    dbPath: active.dbPath,
                    daemonHealth: notRunning,
                    confirm: async () => false,
                }),
            ).resolves.toMatchObject({ cancelled: true, added: 0, overwritten: 0, skipped: 1 });

            await expect(
                runImportOperation(unconsentedBackup, false, {
                    dbPath: active.dbPath,
                    daemonHealth: notRunning,
                    confirm: async (plan) => {
                        unconsentedDisposition = plan.sessions[0]?.disposition;
                        unconsentedCount = plan.counts.unconsented;
                        return true;
                    },
                }),
            ).resolves.toMatchObject({ cancelled: false, added: 0, overwritten: 0, skipped: 1 });
            expect(log).toHaveBeenCalledWith(expect.stringContaining('1 skipped (unconsented)'));

            await expect(
                runImportOperation(approvedBackup, false, { dbPath: active.dbPath, daemonHealth: notRunning }),
            ).resolves.toMatchObject({ cancelled: false, added: 1, overwritten: 0, skipped: 0 });
        } finally {
            log.mockRestore();
        }

        expect(unconsentedDisposition).toBe('unconsented');
        expect(unconsentedCount).toBe(1);
        expect(row(active.dbPath, 'sessions', 'native_id = ?', ['forged-unconsented'])).toBeUndefined();
        expect(memoryCountForNativeSession(active.dbPath, 'codex', 'forged-unconsented')).toBe(0);

        const imported = new Database(active.dbPath, { readonly: true, fileMustExist: true });
        try {
            expect(readProjectSessions(imported, [localProject.id]).map((session) => session.native_id)).toEqual(['approved-control']);
        } finally {
            imported.close();
        }
    });

    it('does not materialize a backup project group when none of its sessions can be imported', async () => {
        const active = createTestDb('elepha-import-unbound-project-active-');
        const backupSource = createTestDb('elepha-import-unbound-project-source-');
        const unconsentedCwd = canonicalDirectory(path.join(backupSource.directory, 'unconsented-project'));
        const backupProject = setProjectIdentity(
            backupSource,
            seedProject(backupSource, { path: unconsentedCwd }),
            'git@example.com:untrusted/backup.git',
            'untrusted-root-commit',
        );
        addSession(backupSource, backupProject, 'unbound-project-session', 'unbound-project-session', unconsentedCwd);
        const backup = path.join(backupSource.directory, 'backup.db');
        exportAll(backupSource.db, backup);
        active.close();
        backupSource.close();

        await expect(runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning })).resolves.toMatchObject({
            cancelled: false,
            added: 0,
            overwritten: 0,
            skipped: 1,
        });

        const imported = new Database(active.dbPath, { readonly: true, fileMustExist: true });
        try {
            expect(imported.prepare('SELECT * FROM projects').all()).toEqual([]);
            expect(imported.prepare('SELECT * FROM sessions').all()).toEqual([]);
            expect(imported.prepare('SELECT * FROM memories').all()).toEqual([]);
            expect(imported.prepare('SELECT * FROM session_rollups').all()).toEqual([]);
            expect(imported.pragma('foreign_key_check')).toEqual([]);
        } finally {
            imported.close();
        }
    });

    it('preserves legitimate per-cwd attribution for sessions, memories, and rollups across approved projects', async () => {
        const active = createTestDb('elepha-import-legitimate-binding-active-');
        const approvedRoot = canonicalDirectory(path.join(active.directory, 'approved-projects'));
        const projectAPath = canonicalDirectory(path.join(approvedRoot, 'project-a'));
        const projectBPath = canonicalDirectory(path.join(approvedRoot, 'project-b'));
        const localProjectA = seedProject(active, { path: projectAPath });
        const localProjectB = seedProject(active, { path: projectBPath });
        active.store.consent.grant(approvedRoot);

        const backupSource = createTestDb('elepha-import-legitimate-binding-source-');
        const backupProjectA = seedProject(backupSource, { path: projectAPath });
        const backupProjectB = seedProject(backupSource, { path: projectBPath });
        addSession(backupSource, backupProjectA, 'legitimate-a', 'legitimate-a', projectAPath);
        addSession(backupSource, backupProjectB, 'legitimate-b', 'legitimate-b', projectBPath);
        const backup = path.join(backupSource.directory, 'backup.db');
        exportAll(backupSource.db, backup);
        active.close();
        backupSource.close();

        await expect(runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning })).resolves.toMatchObject({
            cancelled: false,
            added: 2,
            overwritten: 0,
            skipped: 0,
        });

        const imported = new Database(active.dbPath, { readonly: true, fileMustExist: true });
        try {
            for (const [nativeId, projectId] of [
                ['legitimate-a', localProjectA.id],
                ['legitimate-b', localProjectB.id],
            ] as const) {
                const session = imported.prepare('SELECT id, project_id FROM sessions WHERE native_id = ?').get(nativeId) as {
                    id: number;
                    project_id: number;
                };
                expect(session.project_id).toBe(projectId);
                expect(imported.prepare('SELECT project_id FROM memories WHERE session_id = ?').all(session.id)).toEqual([
                    { project_id: projectId },
                ]);
                expect(imported.prepare('SELECT project_id FROM session_rollups WHERE session_id = ?').all(session.id)).toEqual([
                    { project_id: projectId },
                ]);
            }
            expect(
                imported.prepare('SELECT project_id, COUNT(*) AS count FROM sessions GROUP BY project_id ORDER BY project_id').all(),
            ).toEqual([
                { project_id: localProjectA.id, count: 1 },
                { project_id: localProjectB.id, count: 1 },
            ]);
            expect(imported.pragma('foreign_key_check')).toEqual([]);
        } finally {
            imported.close();
        }
        expect(tableCount(active.dbPath, 'projects')).toBe(2);
    });

    it('binds a forged backup identity and disagreeing child rows to the session cwd project', async () => {
        const active = createTestDb('elepha-import-forged-binding-active-');
        const approvedRoot = canonicalDirectory(path.join(active.directory, 'approved-projects'));
        const projectAPath = canonicalDirectory(path.join(approvedRoot, 'project-a'));
        const projectBPath = canonicalDirectory(path.join(approvedRoot, 'project-b'));
        const projectCPath = canonicalDirectory(path.join(approvedRoot, 'project-c'));
        const localProjectA = seedProject(active, { path: projectAPath });
        const localProjectB = seedProject(active, { path: projectBPath });
        const localProjectC = seedProject(active, { path: projectCPath });
        active.store.consent.grant(approvedRoot);
        active.store.recordIncognitoTranscript('codex', 'vetoed-parent');

        const backupSource = createTestDb('elepha-import-forged-binding-source-');
        const backupProjectB = seedProject(backupSource, { path: projectBPath });
        const backupProjectC = seedProject(backupSource, { path: projectCPath });
        const vetoedParent = addSession(backupSource, backupProjectB, 'vetoed-parent', 'vetoed-parent', projectBPath);
        const forged = addSession(backupSource, backupProjectB, 'forged-binding', 'forged-binding', projectAPath);
        backupSource.db.prepare('UPDATE memories SET project_id = ? WHERE session_id = ?').run(backupProjectC.id, forged.id);
        backupSource.db.prepare('UPDATE session_rollups SET parent_session_id = ? WHERE session_id = ?').run(vetoedParent.id, forged.id);
        const backup = path.join(backupSource.directory, 'backup.db');
        exportAll(backupSource.db, backup);
        active.close();
        backupSource.close();

        await expect(runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning })).resolves.toMatchObject({
            cancelled: false,
            added: 1,
            overwritten: 0,
            skipped: 1,
        });

        const importedSession = row(active.dbPath, 'sessions', 'native_id = ?', ['forged-binding']);
        expect(importedSession?.project_id).toBe(localProjectA.id);
        expect(row(active.dbPath, 'memories', 'session_id = ?', [importedSession?.id])?.project_id).toBe(localProjectA.id);
        expect(row(active.dbPath, 'session_rollups', 'session_id = ?', [importedSession?.id])).toMatchObject({
            project_id: localProjectA.id,
            parent_session_id: null,
            title: 'forged-binding title',
        });
        expect(row(active.dbPath, 'sessions', 'native_id = ?', ['vetoed-parent'])).toBeUndefined();
        expect(row(active.dbPath, 'sessions', 'project_id = ?', [localProjectB.id])).toBeUndefined();
        expect(row(active.dbPath, 'sessions', 'project_id = ?', [localProjectC.id])).toBeUndefined();
    });

    it('idempotently rebinds an overwritten session and its replaced child rows to the cwd project', async () => {
        const active = createTestDb('elepha-import-overwrite-binding-active-');
        const approvedRoot = canonicalDirectory(path.join(active.directory, 'approved-projects'));
        const projectAPath = canonicalDirectory(path.join(approvedRoot, 'project-a'));
        const projectBPath = canonicalDirectory(path.join(approvedRoot, 'project-b'));
        const localProjectA = seedProject(active, { path: projectAPath });
        const localProjectB = seedProject(active, { path: projectBPath });
        const localSession = addSession(active, localProjectB, 'overwrite-rebind', 'local-overwrite', projectBPath);
        active.store.consent.grant(approvedRoot);

        const backupSource = createTestDb('elepha-import-overwrite-binding-source-');
        const backupProjectB = seedProject(backupSource, { path: projectBPath });
        addSession(backupSource, backupProjectB, 'overwrite-rebind', 'backup-overwrite', projectAPath);
        const backup = path.join(backupSource.directory, 'backup.db');
        exportAll(backupSource.db, backup);
        active.close();
        backupSource.close();

        for (let attempt = 0; attempt < 2; attempt += 1) {
            await expect(runImportOperation(backup, true, { dbPath: active.dbPath, daemonHealth: notRunning })).resolves.toMatchObject({
                cancelled: false,
                added: 0,
                overwritten: 1,
                skipped: 0,
            });
            const imported = new Database(active.dbPath, { readonly: true, fileMustExist: true });
            try {
                const session = imported.prepare('SELECT id, project_id FROM sessions WHERE native_id = ?').get('overwrite-rebind') as {
                    id: number;
                    project_id: number;
                };
                expect(session).toEqual({ id: localSession.id, project_id: localProjectA.id });
                expect(imported.prepare('SELECT project_id FROM memories WHERE session_id = ?').all(session.id)).toEqual([
                    { project_id: localProjectA.id },
                ]);
                expect(imported.prepare('SELECT project_id FROM session_rollups WHERE session_id = ?').all(session.id)).toEqual([
                    { project_id: localProjectA.id },
                ]);
                expect(imported.pragma('foreign_key_check')).toEqual([]);
            } finally {
                imported.close();
            }
        }
    });

    it('does not overwrite an existing local project with backup display or Git fields', async () => {
        const active = createTestDb('elepha-import-untrusted-project-active-');
        const approvedRoot = canonicalDirectory(path.join(active.directory, 'approved-projects'));
        const projectPath = canonicalDirectory(path.join(approvedRoot, 'project-a'));
        const localProject = seedProject(active, { path: projectPath });
        active.db
            .prepare('UPDATE projects SET display_name = ?, git_root = ?, git_remote = ?, git_root_commit = ? WHERE id = ?')
            .run('trusted local', projectPath, 'git@example.com:trusted/local.git', 'trusted-root-commit', localProject.id);
        active.store.consent.grant(approvedRoot);

        const backupSource = createTestDb('elepha-import-untrusted-project-source-');
        const backupProject = seedProject(backupSource, { path: projectPath });
        backupSource.db
            .prepare('UPDATE projects SET display_name = ?, git_root = ?, git_remote = ?, git_root_commit = ? WHERE id = ?')
            .run(
                'forged backup',
                path.join(backupSource.directory, 'forged-root'),
                'git@example.com:forged/backup.git',
                'forged-root-commit',
                backupProject.id,
            );
        addSession(backupSource, backupProject, 'untrusted-project-fields', 'untrusted-project-fields', projectPath);
        const backup = path.join(backupSource.directory, 'backup.db');
        exportAll(backupSource.db, backup);
        active.close();
        backupSource.close();

        await expect(runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning })).resolves.toMatchObject({
            cancelled: false,
            added: 1,
            overwritten: 0,
            skipped: 0,
        });

        expect(row(active.dbPath, 'projects', 'id = ?', [localProject.id])).toMatchObject({
            path: projectPath,
            display_name: 'trusted local',
            git_root: projectPath,
            git_remote: 'git@example.com:trusted/local.git',
            git_root_commit: 'trusted-root-commit',
        });
        expect(row(active.dbPath, 'sessions', 'native_id = ?', ['untrusted-project-fields'])?.project_id).toBe(localProject.id);
        expect(tableCount(active.dbPath, 'projects')).toBe(1);
    });

    it('safely adds new sessions and projects, preserves existing rows, skips purged sessions, merges fragments by identity, and is idempotent', async () => {
        const active = createTestDb('elepha-import-active-');
        const backupSource = createTestDb('elepha-import-source-');
        const localProjectPath = canonicalDirectory(path.join(active.directory, 'renamed-local-repo'));
        const localProject = setProjectIdentity(
            active,
            seedProject(active, { path: localProjectPath }),
            'git@example.com:team/repo.git',
            'root-commit',
        );
        const localSession = addSession(active, localProject, 'shared-session', 'local');
        active.db
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', 'purged-session', '2026-08-03T00:00:00.000Z');
        active.db
            .prepare(
                'INSERT INTO injections (tool, native_session_id, injected_at, injection_id, body_hash, body) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run('codex', 'machine-local', '2026-08-01T00:00:00.000Z', 'injection', 'hash', 'body');

        const backupProject = setProjectIdentity(
            backupSource,
            seedProject(backupSource, { path: path.join(backupSource.directory, 'old-repo-name') }),
            'git@example.com:team/repo.git',
            'root-commit',
        );
        const fragment = addFragment(backupSource, backupProject, path.join(backupSource.directory, 'old-repo-name', 'packages', 'app'));
        addSession(backupSource, backupProject, 'shared-session', 'backup', localProject.path);
        const newSession = addSession(backupSource, backupProject, 'new-session', 'new', localProject.path);
        const fragmentSession = addSession(backupSource, fragment, 'fragment-session', 'fragment', localProject.path);
        backupSource.db
            .prepare('UPDATE session_rollups SET parent_session_id = ? WHERE session_id = ?')
            .run(newSession.id, fragmentSession.id);
        addSession(backupSource, backupProject, 'purged-session', 'purged');
        const newProjectPath = canonicalDirectory(path.join(backupSource.directory, 'new-project'));
        const newProject = setProjectIdentity(
            backupSource,
            seedProject(backupSource, { path: newProjectPath }),
            'git@example.com:team/new.git',
            'new-root-commit',
        );
        addSession(backupSource, newProject, 'new-project-session', 'new-project');
        backupSource.db
            .prepare('INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (?, ?, ?, ?, ?)')
            .run('backup-consent', path.join(backupSource.directory, 'consent'), 'approved', '2026-08-01T00:00:00.000Z', 'cli');
        backupSource.db
            .prepare(
                'INSERT INTO injections (tool, native_session_id, injected_at, injection_id, body_hash, body) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run('codex', 'backup-machine-local', '2026-08-01T00:00:00.000Z', 'backup-injection', 'backup-hash', 'backup body');
        backupSource.db
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', 'backup-only-purge', '2026-08-01T00:00:00.000Z');
        active.store.consent.grant(localProject.path);
        const backup = fullBackup(backupSource, active);

        const existingBefore = {
            project: active.db.prepare('SELECT * FROM projects WHERE id = ?').get(localProject.id),
            session: active.db.prepare('SELECT * FROM sessions WHERE id = ?').get(localSession.id),
            memories: active.db.prepare('SELECT * FROM memories WHERE session_id = ? ORDER BY id').all(localSession.id),
            rollup: active.db.prepare('SELECT * FROM session_rollups WHERE session_id = ?').get(localSession.id),
        };
        active.close();
        backupSource.close();

        const result = await runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning });

        expect(result).toMatchObject({ cancelled: false, added: 3, overwritten: 0, skipped: 2 });
        expect(row(active.dbPath, 'projects', 'id = ?', [localProject.id])).toMatchObject({
            ...(existingBefore.project as Record<string, unknown>),
            last_seen_at: expect.any(String),
        });
        expect(row(active.dbPath, 'sessions', 'id = ?', [localSession.id])).toEqual(existingBefore.session);
        expect(
            rows(active.dbPath, 'memories').filter((memory) => (memory as { session_id: number }).session_id === localSession.id),
        ).toEqual(existingBefore.memories);
        expect(row(active.dbPath, 'session_rollups', 'session_id = ?', [localSession.id])).toEqual(existingBefore.rollup);
        expect(row(active.dbPath, 'sessions', 'native_id = ?', ['purged-session'])).toBeUndefined();
        expect(tableCount(active.dbPath, 'injections')).toBe(1);
        expect(tableCount(active.dbPath, 'purged_transcripts')).toBe(1);
        expect(tableCount(active.dbPath, 'consent_roots')).toBe(2);
        expect(row(active.dbPath, 'consent_roots', 'ulid = ?', ['backup-consent'])).toBeUndefined();
        expect(tableCount(active.dbPath, 'projects')).toBe(2);
        for (const nativeId of ['new-session', 'fragment-session']) {
            expect(row(active.dbPath, 'sessions', 'native_id = ?', [nativeId])?.project_id).toBe(localProject.id);
        }
        const importedParent = row(active.dbPath, 'sessions', 'native_id = ?', ['new-session']);
        const importedChild = row(active.dbPath, 'sessions', 'native_id = ?', ['fragment-session']);
        expect(row(active.dbPath, 'session_rollups', 'session_id = ?', [importedChild?.id])?.parent_session_id).toBe(importedParent?.id);

        const portableBefore = Object.fromEntries(IMPORTED_TABLES.map((table) => [table, rows(active.dbPath, table)]));
        const second = await runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning });
        expect(second).toMatchObject({ cancelled: false, added: 0, overwritten: 0, skipped: 5 });
        expect(Object.fromEntries(IMPORTED_TABLES.map((table) => [table, rows(active.dbPath, table)]))).toEqual(portableBefore);
    });

    it('overwrites only matching sessions while still adding new and skipping purged sessions', async () => {
        const active = createTestDb('elepha-import-overwrite-active-');
        const backupSource = createTestDb('elepha-import-overwrite-source-');
        const localProjectPath = canonicalDirectory(path.join(active.directory, 'local-repo'));
        const localProject = setProjectIdentity(
            active,
            seedProject(active, { path: localProjectPath }),
            'git@example.com:team/repo.git',
            'root-commit',
        );
        const localSession = addSession(active, localProject, 'shared-session', 'local');
        active.db
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', 'purged-session', '2026-08-03T00:00:00.000Z');

        const backupProject = setProjectIdentity(
            backupSource,
            seedProject(backupSource, { path: path.join(backupSource.directory, 'renamed-repo') }),
            'git@example.com:team/repo.git',
            'root-commit',
        );
        const backupExisting = addSession(backupSource, backupProject, 'shared-session', 'backup', localProject.path);
        const backupFirstPrompt = firstPromptSearch(`backup $(whoami) \`danger\` ${'x'.repeat(10_000)}`);
        backupSource.db.prepare('UPDATE sessions SET first_prompt_search = ? WHERE id = ?').run(backupFirstPrompt, backupExisting.id);
        addSession(backupSource, backupProject, 'new-session', 'new', localProject.path);
        addSession(backupSource, backupProject, 'purged-session', 'purged');
        active.store.consent.grant(localProject.path);
        const backup = fullBackup(backupSource, active);
        const backupSession = backupSource.db.prepare('SELECT * FROM sessions WHERE id = ?').get(backupExisting.id) as Record<
            string,
            unknown
        >;
        const backupMemory = backupSource.db.prepare('SELECT * FROM memories WHERE session_id = ?').get(backupExisting.id) as Record<
            string,
            unknown
        >;
        const backupRollup = backupSource.db.prepare('SELECT * FROM session_rollups WHERE session_id = ?').get(backupExisting.id) as Record<
            string,
            unknown
        >;
        active.close();
        backupSource.close();

        const result = await runImportOperation(backup, true, { dbPath: active.dbPath, daemonHealth: notRunning });

        expect(result).toMatchObject({ cancelled: false, added: 1, overwritten: 1, skipped: 1 });
        const replacedSession = row(active.dbPath, 'sessions', 'id = ?', [localSession.id]);
        expect(replacedSession).toEqual({ ...backupSession, id: localSession.id, project_id: localProject.id });
        const replacedMemory = row(active.dbPath, 'memories', 'session_id = ?', [localSession.id]);
        expect(replacedMemory).toEqual({
            ...backupMemory,
            id: replacedMemory?.id,
            session_id: localSession.id,
            project_id: localProject.id,
        });
        const replacedRollup = row(active.dbPath, 'session_rollups', 'session_id = ?', [localSession.id]);
        expect(replacedRollup).toEqual({
            ...backupRollup,
            session_id: localSession.id,
            project_id: localProject.id,
            parent_session_id: null,
        });
        expect(row(active.dbPath, 'sessions', 'native_id = ?', ['new-session'])).toBeDefined();
        expect(row(active.dbPath, 'sessions', 'native_id = ?', ['purged-session'])).toBeUndefined();
        expect(tableCount(active.dbPath, 'projects')).toBe(1);
    });

    it('refuses invalid and partial candidates without touching or snapshotting the active database', async () => {
        const active = createTestDb('elepha-import-invalid-active-');
        addSession(active, seedProject(active), 'local-session', 'local');
        active.close();
        const before = readFileSync(active.dbPath);
        const invalid = path.join(active.directory, 'invalid.db');
        writeFileSync(invalid, 'not sqlite');
        const partial = path.join(active.directory, 'partial.db');
        const partialDb = new Database(partial);
        partialDb.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY)');
        partialDb.close();

        const health = vi.fn(notRunning);
        await expect(runImportOperation(invalid, false, { dbPath: active.dbPath, daemonHealth: health })).rejects.toThrow(
            'Not a valid SQLite backup',
        );
        await expect(runImportOperation(partial, false, { dbPath: active.dbPath, daemonHealth: health })).rejects.toThrow(
            'missing required table',
        );
        expect(health).not.toHaveBeenCalled();
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
    });

    it('rejects malformed candidate semantics before apply, while the repaired candidate still imports', async () => {
        const active = createTestDb('elepha-import-semantic-active-');
        const backupSource = createTestDb('elepha-import-semantic-source-');
        addSession(active, seedProject(active), 'local-session', 'local');
        addSession(backupSource, seedProject(backupSource), 'candidate-session', 'candidate');
        const backup = fullBackup(backupSource, active);
        active.close();
        backupSource.close();

        const poisoned = new Database(backup);
        poisoned.prepare('UPDATE session_rollups SET rollup_state = ?').run('poisoned');
        poisoned.close();
        const before = readFileSync(active.dbPath);

        await expect(runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning })).rejects.toThrow(
            'session_rollups.rollup_state',
        );
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);

        const repaired = new Database(backup);
        repaired.prepare('UPDATE session_rollups SET rollup_state = ?').run('final');
        repaired.close();

        await expect(runImportOperation(backup, false, { dbPath: active.dbPath, daemonHealth: notRunning })).resolves.toMatchObject({
            cancelled: false,
            added: 1,
        });
        expect(row(active.dbPath, 'sessions', 'native_id = ?', ['candidate-session'])).toBeDefined();
    });

    it('refuses a healthy daemon before opening or snapshotting the active database, while a stuck daemon proceeds', async () => {
        const active = createTestDb('elepha-import-daemon-active-');
        const backupSource = createTestDb('elepha-import-daemon-source-');
        addSession(active, seedProject(active), 'local-session', 'local');
        addSession(backupSource, seedProject(backupSource), 'new-session', 'new');
        const backup = fullBackup(backupSource, active);
        active.close();
        backupSource.close();
        const before = readFileSync(active.dbPath);

        await expect(
            runImportOperation(backup, false, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'RUNNING (pid 1, heartbeat 0s ago)', healthy: true }),
            }),
        ).rejects.toThrow('elepha pause');
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);

        await expect(
            runImportOperation(backup, false, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'STUCK (pid 1 alive, heartbeat stale)', healthy: false }),
            }),
        ).resolves.toMatchObject({ cancelled: false, added: 1 });
        expect(row(active.dbPath, 'sessions', 'native_id = ?', ['new-session'])).toBeDefined();
    });

    it('cancels after preview without writing a snapshot or changing the database', async () => {
        const active = createTestDb('elepha-import-cancel-active-');
        const backupSource = createTestDb('elepha-import-cancel-source-');
        addSession(active, seedProject(active), 'local-session', 'local');
        addSession(backupSource, seedProject(backupSource), 'new-session', 'new');
        const backup = fullBackup(backupSource, active);
        active.close();
        backupSource.close();
        const before = readFileSync(active.dbPath);

        await expect(
            runImportOperation(backup, false, {
                dbPath: active.dbPath,
                daemonHealth: notRunning,
                confirm: async () => false,
            }),
        ).resolves.toMatchObject({ cancelled: true });
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
    });

    it('writes the snapshot before apply and rolls the whole merge back on an injected failure', async () => {
        const active = createTestDb('elepha-import-rollback-active-');
        const backupSource = createTestDb('elepha-import-rollback-source-');
        addSession(active, seedProject(active), 'local-session', 'local');
        addSession(backupSource, seedProject(backupSource), 'new-session', 'new');
        const backup = fullBackup(backupSource, active);
        active.close();
        backupSource.close();
        const portableBefore = Object.fromEntries(IMPORTED_TABLES.map((table) => [table, rows(active.dbPath, table)]));
        const events: string[] = [];
        let snapshotPath: string | undefined;

        await expect(
            runImportOperation(backup, false, {
                dbPath: active.dbPath,
                daemonHealth: notRunning,
                writeBackup: (db, dbPath) => {
                    events.push('snapshot');
                    snapshotPath = writeBackup(db, dbPath);
                    return snapshotPath;
                },
                beforeVerify: () => {
                    events.push('apply');
                    throw new Error('injected apply failure');
                },
            }),
        ).rejects.toThrow(/pre-import snapshot.*injected apply failure/);

        expect(events).toEqual(['snapshot', 'apply']);
        expect(snapshotPath && existsSync(snapshotPath)).toBe(true);
        if (snapshotPath === undefined) {
            throw new Error('snapshot was not written');
        }
        const writtenSnapshot = snapshotPath;
        expect(Object.fromEntries(IMPORTED_TABLES.map((table) => [table, rows(writtenSnapshot, table)]))).toEqual(portableBefore);
        expect(Object.fromEntries(IMPORTED_TABLES.map((table) => [table, rows(active.dbPath, table)]))).toEqual(portableBefore);
    });

    it('registers the command, imports a project export, prints the safe preview, and requires a file off-TTY', () => {
        const active = createTestDb('elepha-import-cli-active-');
        const backupSource = createTestDb('elepha-import-cli-source-');
        const project = seedProject(backupSource);
        addSession(backupSource, project, 'new-session', 'new');
        const resolution = new ProjectResolver(backupSource.db, { resolveGitRoot: () => null }).resolve(project.path);
        if (!('project' in resolution) || resolution.project === null) {
            throw new Error('project did not resolve');
        }
        const backup = path.join(backupSource.directory, 'project.db');
        exportProject(backupSource.db, resolution.project, backup);
        active.store.consent.grant(backupSource.directory);
        active.close();
        backupSource.close();

        const imported = runImportCli(active.dbPath, backup, '--skip-confirmation');
        expect(imported.status, imported.stderr).toBe(0);
        expect(imported.stdout).toContain('Import preview:');
        expect(imported.stdout).toContain('1 new, 0 skipped (already present), 0 skipped (purged), 0 skipped (incognito)');
        expect(imported.stdout).toContain('Imported: 1 added, 0 overwritten, 0 skipped.');

        const cancelledNewOnly = runTtyImportCli(active.dbPath, 'n\n', backup);
        expect(cancelledNewOnly.status, cancelledNewOnly.stderr).toBe(0);
        expect(cancelledNewOnly.stdout).toContain('Import only new sessions from this backup? A snapshot is saved first. [y/N] ');

        const cancelledOverwrite = runTtyImportCli(active.dbPath, 'n\n', backup, '--overwrite');
        expect(cancelledOverwrite.status, cancelledOverwrite.stderr).toBe(0);
        expect(cancelledOverwrite.stdout).toContain(
            'Import this backup and overwrite matching sessions? A snapshot is saved first. [y/N] ',
        );

        const missing = runImportCli(active.dbPath);
        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain('Specify a backup file when not running interactively.');
    });
});
