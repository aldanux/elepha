import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runPurgeOperation } from '../../src/cli/commands/purge.js';
import { PURGE_HERE_UNCONSENTED } from '../../src/cli/purge-wizard.js';
import { consentedProject } from '../../src/hooks/common.js';
import { listManagedBackups } from '../../src/storage/backup.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';
import { expectLiveMemoryCurrent } from '../helpers/live-memory.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const testScratchRoot = path.join(repositoryRoot, '.test-scratch');
const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const elephaCli = path.join(repositoryRoot, 'src', 'cli', 'index.ts');

function removeDirectory(directory: string): void {
    try {
        rmSync(directory, { recursive: true, force: true });
    } catch {
        // Cleanup is a courtesy; sandbox permissions must not fail the assertion.
    }
}

function runPurgeCliFrom(cwd: string, dbPath: string, ...args: string[]) {
    return spawnSync(process.execPath, [tsxCli, elephaCli, 'purge', ...args], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            ELEPHA_DB_PATH: dbPath,
            ELEPHA_ENV_FILE: path.join(path.dirname(dbPath), 'missing.env'),
            ELEPHA_HOME: path.join(path.dirname(dbPath), 'isolated-elepha-home'),
        },
    });
}

function runPurgeCli(dbPath: string, ...args: string[]) {
    return runPurgeCliFrom(repositoryRoot, dbPath, ...args);
}

function runTtyPurgeCli(dbPath: string, input: string, ...args: string[]) {
    const source = [
        "Object.defineProperty(process.stdout, 'isTTY', { value: true });",
        "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
        `process.argv = [process.execPath, 'purge', ...${JSON.stringify(args)}];`,
        `await import(${JSON.stringify(elephaCli)});`,
    ].join('\n');
    return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        input,
        env: {
            ...process.env,
            ELEPHA_DB_PATH: dbPath,
            ELEPHA_ENV_FILE: path.join(path.dirname(dbPath), 'missing.env'),
            ELEPHA_HOME: path.join(path.dirname(dbPath), 'isolated-elepha-home'),
        },
    });
}

function databaseRows(dbPath: string): Record<string, unknown[]> {
    const db = openUnmanagedDb(dbPath);
    try {
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all() as Array<{ name: string }>;
        return Object.fromEntries(
            tables.map(({ name }) => {
                const quotedName = name.replaceAll('"', '""');
                const primaryKey = (db.pragma(`table_info("${quotedName}")`) as Array<{ name: string; pk: number }>)
                    .filter((column) => column.pk > 0)
                    .sort((a, b) => a.pk - b.pk)
                    .map((column) => `"${column.name.replaceAll('"', '""')}"`);
                const orderBy = primaryKey.length > 0 ? primaryKey.join(', ') : 'rowid';
                return [name, db.prepare(`SELECT * FROM "${quotedName}" ORDER BY ${orderBy}`).all()];
            }),
        );
    } finally {
        db.close();
    }
}

describe('elepha purge orphan project scope', () => {
    it('previews read-only, deletes exactly orphaned and empty unrecoverable chats, cleans derived state and repeats harmlessly', () => {
        const f = createTestDb('purge-orphan-command-');
        const gone = seedProject(f, { path: path.join(f.directory, 'gone') });
        const orphan = seedSession(f, { project: gone, nativeId: 'orphan' });
        const memory = seedMemory(f, { project: gone, session: orphan, durableCapture: true, userMessage: 'deletedsearchneedle' });
        seedRollup(f, { project: gone, session: orphan });
        f.db
            .prepare(`INSERT INTO session_embeddings(session_id, project_id, source_hash, model, model_revision, dimensions, vector, computed_at)
            VALUES (?, ?, 'hash', 'fixture', '1', 1, ?, '2026-10-01')`)
            .run(orphan.id, gone.id, Buffer.alloc(4));
        f.db
            .prepare(`INSERT INTO turn_embeddings(memory_id, project_id, source_digest, text_hash, model, model_revision, dimensions, vector, computed_at)
            VALUES (?, ?, ?, 'hash', 'fixture', '1', 1, ?, '2026-10-01')`)
            .run(memory.id, gone.id, 'a'.repeat(64), Buffer.alloc(4));

        const current = seedProject(f, { path: path.join(f.directory, 'current') });
        mkdirSync(current.path);
        const empty = seedSession(f, { project: current, nativeId: 'empty-unrecoverable' });
        seedMemory(f, { project: current, session: empty, userMessage: '', assistantText: '', durableCapture: true });
        seedRollup(f, { project: current, session: empty });
        const recoverable = seedSession(f, {
            project: current,
            nativeId: 'recoverable',
            sourcePath: path.join(f.directory, 'provider.jsonl'),
        });
        writeFileSync(recoverable.source_path, 'original provider history');
        const retained = seedSession(f, { project: current, nativeId: 'useful-retained' });
        seedMemory(f, { project: current, session: retained, durableCapture: true, userMessage: 'preservedsearchneedle' });
        f.db
            .prepare('INSERT INTO standing_rules(ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)')
            .run('current-policy', current.id, 'preserved policy', '2026-10-01');

        const old = seedProject(f, { path: path.join(f.directory, 'old-folder') });
        const destination = path.join(f.directory, 'new-folder');
        mkdirSync(destination);
        f.db.prepare('UPDATE projects SET git_root = ? WHERE id = ?').run(destination, old.id);
        const relocated = seedSession(f, { project: old, nativeId: 'relocated' });
        seedMemory(f, { project: old, session: relocated, durableCapture: true });
        const mixed = seedSession(f, { project: current, nativeId: 'mixed' });
        f.db
            .prepare(`INSERT INTO sessions(tool, native_id, project_id, source_path, started_at, last_ingested_at, segment_index)
            VALUES ('codex', ?, ?, ?, ?, ?, 1)`)
            .run(mixed.native_id, gone.id, mixed.source_path, mixed.started_at, mixed.last_ingested_at);
        f.close();

        const before = readFileSync(f.dbPath);
        const preview = runPurgeCli(f.dbPath, '--orphan');
        expect(preview.status).toBe(0);
        expect(readFileSync(f.dbPath)).toEqual(before);
        expect(listManagedBackups(f.dbPath)).toEqual([]);
        const applied = runPurgeCli(f.dbPath, '--orphan', '--apply', '--skip-confirmation');
        expect(applied.status).toBe(0);
        const db = openUnmanagedDb(f.dbPath);
        try {
            const store = new MemoryStore(db);
            expect(store.findSession('codex', orphan.native_id)).toBeUndefined();
            expect(store.findSession('codex', empty.native_id)).toBeUndefined();
            for (const session of [recoverable, retained, relocated, mixed]) {
                expect(store.findSession('codex', session.native_id)).toBeDefined();
                expect(store.isTranscriptPurged('codex', session.native_id)).toBe(false);
            }
            expect(db.prepare('SELECT id FROM sessions WHERE native_id = ?').all(mixed.native_id)).toHaveLength(2);
            expect(store.isTranscriptCaptureBlocked('codex', orphan.native_id)).toBe(true);
            expect(store.isTranscriptCaptureBlocked('codex', empty.native_id)).toBe(true);
            expect(store.standingRules.list([current.id])).toHaveLength(1);
            for (const table of ['session_rollups', 'session_embeddings']) {
                expect(db.prepare(`SELECT 1 FROM ${table} WHERE session_id IN (?, ?)`).get(orphan.id, empty.id)).toBeUndefined();
            }
            for (const table of ['filtered_turns', 'turn_search_index', 'turn_embeddings']) {
                expect(db.prepare(`SELECT 1 FROM ${table} WHERE memory_id = ?`).get(memory.id)).toBeUndefined();
            }
            expect(db.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'deletedsearchneedle'").all()).toEqual(
                [],
            );
            expect(
                db.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'preservedsearchneedle'").all(),
            ).toHaveLength(1);
            expectLiveMemoryCurrent(db);
        } finally {
            db.close();
        }
        expect(readFileSync(recoverable.source_path, 'utf8')).toBe('original provider history');
        const after = databaseRows(f.dbPath);
        const backups = listManagedBackups(f.dbPath);
        expect(backups).toHaveLength(1);
        expect(runPurgeCli(f.dbPath, '--orphan', '--apply', '--skip-confirmation').status).toBe(0);
        expect(databaseRows(f.dbPath)).toEqual(after);
        expect(listManagedBackups(f.dbPath)).toEqual(backups);
    }, 15000);

    it('previews, confirms, backs up and deletes a rule-only project through the CLI', () => {
        const directory = withGrantableTestDir('purge-rule-only-cli-');
        const dbPath = path.join(directory, 'elepha.db');
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const project = store.upsertProject(path.join(directory, 'rules-project'));
        db.prepare('INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)').run(
            'cli-rule',
            project.id,
            'Only durable rule',
            '2026-09-20',
        );
        db.prepare(
            `INSERT INTO session_rules (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
             VALUES ('cli-chat-rule', 'codex', 'cli-chat', ?, ?, 'Only durable chat rule', '2026-09-20')`,
        ).run(project.path, project.id);
        db.close();
        const preview = runPurgeCli(dbPath, '--project', project.path);
        expect(preview.status).toBe(0);
        expect(preview.stdout).toContain('Standing rules: 1 rule(s).');
        expect(preview.stdout).toContain('Chat standing rules: 1 rule(s).');
        expect(preview.stdout).toContain('cli-chat-rule');
        expect(preview.stdout).toContain(
            `cli-rule (id 1, project ${project.id}, ${JSON.stringify(project.path)}, created 2026-09-20): "Only durable rule"`,
        );
        expect(databaseRows(dbPath).standing_rules).toHaveLength(1);
        const applied = runTtyPurgeCli(dbPath, 'y\n', '--project', project.path, '--apply');
        expect(applied.status).toBe(0);
        expect(applied.stdout).toContain('0 session(s) and 1 standing rule(s) and 1 chat standing rule(s)?');
        const [snapshot] = listManagedBackups(dbPath);
        expect(snapshot).toBeDefined();
        expect(databaseRows(snapshot!).standing_rules).toEqual([
            { id: 1, ulid: 'cli-rule', project_id: project.id, text: 'Only durable rule', created_at: '2026-09-20' },
        ]);
        expect(databaseRows(snapshot!).session_rules).toMatchObject([
            { ulid: 'cli-chat-rule', owner_project_id: project.id, text: 'Only durable chat rule' },
        ]);
        expect(applied.stdout).toContain('Deleted 1 standing rule(s).');
        expect(applied.stdout).toContain('Deleted 1 chat standing rule(s).');
        expect(databaseRows(dbPath).standing_rules).toEqual([]);
        expect(databaseRows(dbPath).session_rules).toEqual([]);
        expect(databaseRows(dbPath).projects).toEqual([]);
    });
    it('applies only surviving previewed ids when matching sessions appear during confirmation', async () => {
        const directory = withTempDir('elepha-purge-');
        const dbPath = path.join(directory, 'elepha.db');
        const previousDbPath = process.env.ELEPHA_DB_PATH;
        const previousElephaHome = process.env.ELEPHA_HOME;
        const previousExitCode = process.exitCode;
        process.env.ELEPHA_DB_PATH = dbPath;
        process.env.ELEPHA_HOME = path.join(directory, 'isolated-elepha-home');
        process.exitCode = undefined;
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const project = store.upsertProject(path.join(directory, 'selected-project'));
        const appliedSession = store.upsertSession('codex', 'applied-session', project.id, path.join(directory, 'applied.jsonl'));
        const alreadyGone = store.upsertSession('codex', 'already-gone', project.id, path.join(directory, 'gone.jsonl'));
        const retainedProject = store.upsertProject(path.join(directory, 'retained-project'));
        store.upsertSession('codex', 'retained-session', retainedProject.id, path.join(directory, 'retained.jsonl'));
        const logs: string[] = [];
        const errors: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message: string) => logs.push(message));
        const error = vi.spyOn(console, 'error').mockImplementation((message: string) => errors.push(message));
        let lateSessionId: number | undefined;

        try {
            await expect(
                runPurgeOperation(
                    store,
                    { projectIds: [project.id] },
                    {
                        applyRequested: true,
                        confirm: async (plan) => {
                            expect(plan.sessions.map((session) => session.id)).toEqual([appliedSession.id, alreadyGone.id]);
                            store.database.prepare('DELETE FROM sessions WHERE id = ?').run(alreadyGone.id);
                            lateSessionId = store.upsertSession(
                                'codex',
                                'late-matching-session',
                                project.id,
                                path.join(directory, 'late.jsonl'),
                            ).id;
                            return true;
                        },
                    },
                ),
            ).resolves.toBe(true);

            expect(store.findSession('codex', appliedSession.native_id)).toBeUndefined();
            expect(store.findSession('codex', alreadyGone.native_id)).toBeUndefined();
            expect(store.getProjectById(project.id)).toBeDefined();
            expect(store.findSession('codex', 'late-matching-session')?.id).toBe(lateSessionId);
            expect(logs).toContain("Deleted 1 session(s) across 1 project(s) from elepha's memory.");
            expect(errors.some((message) => message.includes('VERIFICATION FAILED'))).toBe(false);
            expect(process.exitCode).toBeUndefined();
        } finally {
            log.mockRestore();
            error.mockRestore();
            db.close();
            process.exitCode = previousExitCode;
            if (previousDbPath === undefined) delete process.env.ELEPHA_DB_PATH;
            else process.env.ELEPHA_DB_PATH = previousDbPath;
            if (previousElephaHome === undefined) delete process.env.ELEPHA_HOME;
            else process.env.ELEPHA_HOME = previousElephaHome;
            removeDirectory(directory);
        }
    });

    it('resolves orphan ids in the CLI, previews before writing, and applies only them', () => {
        const directory = withTempDir('elepha-purge-');
        const projectDirectory = mkdtempSync(path.join(testScratchRoot, 'purge-'));
        const dbPath = path.join(directory, 'elepha.db');
        // Keep temporary projects in-repo, with their own Git-discovery boundary
        // so they cannot be registered as the surrounding repository instead.
        vi.stubEnv('TMPDIR', withGrantableTestDir('purge-tmp-'));
        const tempPath = mkdtempSync(path.join(tmpdir(), 'elepha-purge-temp-project-'));
        const missingPath = path.join(projectDirectory, 'missing-project');
        const livePath = path.join(projectDirectory, 'live-project');
        mkdirSync(livePath);
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const temp = store.upsertProject(tempPath);
        expect(temp.path).toBe(tempPath);
        const missing = store.upsertProject(missingPath);
        const live = store.upsertProject(livePath);
        const tempSession = store.upsertSession('codex', 'temp-session', temp.id, path.join(directory, 'temp.jsonl'));
        const missingSession = store.upsertSession('codex', 'missing-session', missing.id, path.join(directory, 'missing.jsonl'));
        const liveSession = store.upsertSession('codex', 'live-session', live.id, path.join(directory, 'live.jsonl'));
        // These empty sessions remain recoverable from their provider files.
        writeFileSync(tempSession.source_path, 'provider history');
        writeFileSync(liveSession.source_path, 'provider history');
        db.close();

        try {
            const orphanDryRun = runPurgeCli(dbPath, '--orphan', '--details');
            expect(orphanDryRun.status).toBe(0);
            expect(orphanDryRun.stdout).toContain('elepha memory in these projects:');
            expect(orphanDryRun.stdout).not.toContain(`  ${tempPath}  (project entry will be removed — no sessions left)`);
            expect(orphanDryRun.stdout).toContain(`  ${missingPath}  (project entry will be removed — no sessions left)`);
            expect(orphanDryRun.stdout).not.toContain(`  [${tempSession.id}] project [${temp.id}]`);
            expect(orphanDryRun.stdout).toContain(`  [${missingSession.id}] project [${missing.id}]`);
            expect(orphanDryRun.stdout).toContain('segment 0');
            expect(orphanDryRun.stdout).not.toContain(`  [${liveSession.id}] project [${live.id}]`);
            expect(orphanDryRun.stdout).not.toContain('last ingested');
            expect(orphanDryRun.stdout).toContain('In total: 1 session(s), 0 turn(s).');
            let verified = openUnmanagedDb(dbPath);
            expect(new MemoryStore(verified).getProjectById(temp.id)).toBeDefined();
            verified.close();

            const refusedNoninteractive = runPurgeCli(dbPath, '--orphan', '--apply');
            expect(refusedNoninteractive.status).toBe(1);
            expect(listManagedBackups(dbPath)).toEqual([]);

            const orphanApply = runPurgeCli(dbPath, '--orphan', '--apply', '--skip-confirmation');
            expect(orphanApply.status).toBe(0);
            expect(orphanApply.stdout).toContain('Saved a backup of your memory database (keeping the last 5).');
            expect(orphanApply.stdout).toContain("Deleted 1 session(s) across 1 project(s) from elepha's memory.");
            expect(orphanApply.stdout).not.toContain("Delete elepha's memory");
            expect(orphanApply.stdout).not.toContain('Verified: nothing matching this scope remains.');
            verified = openUnmanagedDb(dbPath);
            const verifiedStore = new MemoryStore(verified);
            expect(verifiedStore.getProjectById(temp.id)).toBeDefined();
            expect(verifiedStore.getProjectById(missing.id)).toBeUndefined();
            expect(verifiedStore.getProjectById(live.id)).toBeDefined();
            expect(verifiedStore.listMemoriesForSession(liveSession.id)).toEqual([]);
            verified.close();
        } finally {
            removeDirectory(directory);
            removeDirectory(projectDirectory);
            removeDirectory(tempPath);
            vi.unstubAllEnvs();
        }
    }, 15000);

    it('reports and verifies durable-copy deletion through the CLI purge lifecycle', () => {
        const directory = withTempDir('elepha-purge-durable-');
        const dbPath = path.join(directory, 'elepha.db');
        const projectPath = path.join(directory, 'durable-project');
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const project = store.upsertProject(projectPath);
        const session = store.upsertSession('codex', 'durable-cli-purge', project.id, path.join(directory, 'durable.jsonl'));
        store.recordTurn(
            {
                tool: 'codex',
                sessionId: session.native_id,
                sourcePath: session.source_path,
                projectPath,
                turnIndex: 0,
                startedAt: '2026-08-01T00:00:00.000Z',
                endedAt: '2026-08-01T00:00:01.000Z',
                userMessage: 'clipurgeuniqueneedle',
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
        db.close();

        try {
            const result = runPurgeCli(dbPath, '--project', projectPath, '--apply');

            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toContain('Stored conversation copy: 1 filtered turn(s), ');
            const verified = openUnmanagedDb(dbPath);
            expect(verified.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
            expect(verified.prepare('SELECT COUNT(*) AS count FROM durable_capture_status').get()).toEqual({ count: 0 });
            expectLiveMemoryCurrent(verified);
            expect(
                verified.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'clipurgeuniqueneedle'").all(),
            ).toEqual([]);
            verified.close();
        } finally {
            removeDirectory(directory);
        }
    }, 15000);

    it('resolves only denied and unapproved projects as revoked, then preserves their denied consent after applying', () => {
        const directory = withTempDir('elepha-purge-');
        const projectDirectory = withGrantableTestDir('purge-revoked-');
        const dbPath = path.join(directory, 'elepha.db');
        const deniedRoot = path.join(projectDirectory, 'revoked-root');
        const revokedPath = path.join(deniedRoot, 'revoked-project');
        const activePath = path.join(deniedRoot, 'active-project');
        const pendingPath = path.join(projectDirectory, 'pending-project');
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const revoked = store.upsertProject(revokedPath);
        const active = store.upsertProject(activePath);
        const pending = store.upsertProject(pendingPath);
        store.upsertSession('codex', 'revoked-session', revoked.id, path.join(directory, 'revoked.jsonl'));
        store.upsertSession('codex', 'active-session', active.id, path.join(directory, 'active.jsonl'));
        store.upsertSession('codex', 'pending-session', pending.id, path.join(directory, 'pending.jsonl'));
        store.consent.revoke(deniedRoot);
        store.consent.grant(activePath);
        store.consent.recordPending(pendingPath);
        db.close();

        try {
            const dryRun = runPurgeCli(dbPath, '--revoked');
            expect(dryRun.status).toBe(0);
            expect(dryRun.stdout).toContain(revokedPath);
            expect(dryRun.stdout).not.toContain(activePath);
            expect(dryRun.stdout).not.toContain(pendingPath);

            const applied = runPurgeCli(dbPath, '--revoked', '--apply');
            expect(applied.status).toBe(0);
            const verified = openUnmanagedDb(dbPath);
            const verifiedStore = new MemoryStore(verified);
            expect(verifiedStore.getProjectById(revoked.id)).toBeUndefined();
            expect(verifiedStore.getProjectById(active.id)).toBeDefined();
            expect(verifiedStore.getProjectById(pending.id)).toBeDefined();
            expect(verifiedStore.consent.list('denied').map((root) => root.path)).toContain(deniedRoot);
            verified.close();
        } finally {
            removeDirectory(directory);
            removeDirectory(projectDirectory);
        }
    }, 15000);

    it('combines a project scope with --older-than without touching other projects or newer sessions', () => {
        const directory = withTempDir('elepha-purge-');
        const dbPath = path.join(directory, 'elepha.db');
        const selectedPath = path.join(directory, 'selected-project');
        const retainedPath = path.join(directory, 'retained-project');
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const selected = store.upsertProject(selectedPath);
        const retained = store.upsertProject(retainedPath);
        const selectedOld = store.upsertSession('codex', 'selected-old', selected.id, path.join(directory, 'selected-old.jsonl'));
        const selectedNew = store.upsertSession('codex', 'selected-new', selected.id, path.join(directory, 'selected-new.jsonl'));
        const retainedOld = store.upsertSession('codex', 'retained-old', retained.id, path.join(directory, 'retained-old.jsonl'));
        const setLastIngestedAt = db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?');
        setLastIngestedAt.run('2026-08-01T00:00:00.000Z', selectedOld.id);
        setLastIngestedAt.run('2026-08-20T00:00:00.000Z', selectedNew.id);
        setLastIngestedAt.run('2026-08-01T00:00:00.000Z', retainedOld.id);
        db.close();

        try {
            const result = runPurgeCli(dbPath, '--project', selectedPath, '--older-than', '2026-08-15T00:00:00.000Z', '--apply');
            expect(result.status).toBe(0);
            expect(result.stdout).toContain("Deleted 1 session(s) across 1 project(s) from elepha's memory.");

            const verified = openUnmanagedDb(dbPath);
            const verifiedStore = new MemoryStore(verified);
            expect(verifiedStore.findSession('codex', selectedOld.native_id)).toBeUndefined();
            expect(verifiedStore.findSession('codex', selectedNew.native_id)).toBeDefined();
            expect(verifiedStore.findSession('codex', retainedOld.native_id)).toBeDefined();
            verified.close();
        } finally {
            removeDirectory(directory);
        }
    }, 15000);

    it('--here rejects an unconsented parent and resolves a consented project from its subdirectory', () => {
        const directory = realpathSync(withTempDir('elepha-purge-'));
        const projectDirectory = realpathSync(withGrantableTestDir('purge-here-'));
        const dbPath = path.join(directory, 'elepha.db');
        const projectRoot = path.join(projectDirectory, 'project');
        const projectSubdirectory = path.join(projectRoot, 'src');
        const retainedRoot = path.join(projectDirectory, 'retained-project');
        mkdirSync(projectSubdirectory, { recursive: true });
        mkdirSync(retainedRoot);
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const project = store.upsertProject(projectRoot);
        const projectSubdirectoryRow = store.upsertProject(projectSubdirectory);
        const retained = store.upsertProject(retainedRoot);
        const projectSession = store.upsertSession('codex', 'project-session', project.id, path.join(directory, 'project.jsonl'));
        const projectSubdirectorySession = store.upsertSession(
            'codex',
            'project-subdirectory-session',
            projectSubdirectoryRow.id,
            path.join(directory, 'project-subdirectory.jsonl'),
        );
        const retainedSession = store.upsertSession('codex', 'retained-session', retained.id, path.join(directory, 'retained.jsonl'));
        store.consent.grant(projectRoot);
        store.consent.grant(retainedRoot);
        expect(consentedProject(db, projectSubdirectory)?.projectIds).toEqual([project.id, projectSubdirectoryRow.id]);
        db.close();

        try {
            for (const args of [['--here'], ['--here', '--newer-than', '7d', '--apply']]) {
                const result = runPurgeCliFrom(projectDirectory, dbPath, ...args);
                expect(result.status).toBe(1);
                expect(result.stderr).toContain(PURGE_HERE_UNCONSENTED);
            }

            let verified = openUnmanagedDb(dbPath);
            let verifiedStore = new MemoryStore(verified);
            expect(verifiedStore.findSession('codex', projectSession.native_id)).toBeDefined();
            expect(verifiedStore.findSession('codex', projectSubdirectorySession.native_id)).toBeDefined();
            expect(verifiedStore.findSession('codex', retainedSession.native_id)).toBeDefined();
            verified.close();

            const result = runPurgeCliFrom(projectSubdirectory, dbPath, '--here', '--apply');
            expect(result.status, result.stderr).toBe(0);

            verified = openUnmanagedDb(dbPath);
            verifiedStore = new MemoryStore(verified);
            expect(verifiedStore.findSession('codex', projectSession.native_id)).toBeUndefined();
            expect(verifiedStore.findSession('codex', projectSubdirectorySession.native_id)).toBeUndefined();
            expect(verifiedStore.findSession('codex', retainedSession.native_id)).toBeDefined();
            verified.close();
        } finally {
            removeDirectory(directory);
            removeDirectory(projectDirectory);
        }
    }, 15000);

    it('rejects invalid selector combinations without mutating any database row', () => {
        const directory = withTempDir('elepha-purge-');
        const dbPath = path.join(directory, 'elepha.db');
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const project = store.upsertProject(repositoryRoot);
        store.upsertSession('codex', 'retained-session', project.id, path.join(directory, 'retained.jsonl'));
        db.close();
        const before = databaseRows(dbPath);
        const cases = [
            {
                args: ['--orphan', '--all'],
                error: 'Specify only one scope: --project/--here, --external-agent-imports, --orphan, --revoked, or --all.',
            },
            {
                args: ['--revoked', '--all'],
                error: 'Specify only one scope: --project/--here, --external-agent-imports, --orphan, --revoked, or --all.',
            },
            {
                args: ['--project', repositoryRoot, '--here'],
                error: 'Specify only one of --project or --here.',
            },
            {
                args: ['--external-agent-imports', '--newer-than', '30d'],
                error: '--external-agent-imports cannot be combined with --newer-than or --older-than.',
            },
            {
                args: ['--external-agent-imports', '--older-than', '30d'],
                error: '--external-agent-imports cannot be combined with --newer-than or --older-than.',
            },
        ];

        try {
            for (const { args, error } of cases) {
                const result = runPurgeCli(dbPath, ...args);

                expect(result.status).toBe(1);
                expect(result.stderr).toContain(error);
                expect(databaseRows(dbPath)).toEqual(before);
            }
        } finally {
            removeDirectory(directory);
        }
    }, 15000);

    it('rejects empty project queries without mutating any database row', () => {
        const directory = withTempDir('elepha-purge-');
        const dbPath = path.join(directory, 'elepha.db');
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const project = store.upsertProject(repositoryRoot);
        store.upsertSession('codex', 'retained-session', project.id, path.join(directory, 'retained.jsonl'));
        db.close();
        const before = databaseRows(dbPath);

        try {
            for (const query of ['', '   ']) {
                const result = runPurgeCli(dbPath, '--project', query, '--apply', '--skip-confirmation');

                expect(result.status).toBe(1);
                expect(result.stderr).toContain('--project must not be empty.');
                expect(databaseRows(dbPath)).toEqual(before);
            }
        } finally {
            removeDirectory(directory);
        }
    }, 15000);

    it('errors without a scope or time filter in non-TTY mode', () => {
        const directory = withTempDir('elepha-purge-');
        const dbPath = path.join(directory, 'elepha.db');

        try {
            const result = runPurgeCli(dbPath);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain(
                'Specify one of --project <pathOrName>, --here, --newer-than/--older-than <durationOrDate>, --external-agent-imports, --orphan, --revoked, or --all.',
            );
        } finally {
            removeDirectory(directory);
        }
    }, 15000);

    it('asks a TTY to confirm, leaves memory untouched on no, and deletes on yes', () => {
        const directory = withTempDir('elepha-purge-');
        const dbPath = path.join(directory, 'elepha.db');
        const missingPath = path.join(directory, 'missing-project');
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const project = store.upsertProject(missingPath);
        store.upsertSession('codex', 'missing-session', project.id, path.join(directory, 'missing.jsonl'));
        db.close();

        try {
            const cancelled = runTtyPurgeCli(dbPath, 'n\n', '--orphan', '--apply');
            expect(cancelled.status).toBe(0);
            expect(cancelled.stdout).toContain(
                "Delete elepha's memory for these 1 session(s)? Your Claude Code / Codex history on disk is untouched. This cannot be undone (a backup is saved). [y/N] ",
            );
            expect(cancelled.stdout.indexOf('elepha memory in these projects:')).toBeLessThan(
                cancelled.stdout.indexOf("Delete elepha's memory"),
            );
            expect(cancelled.stdout).toContain('Cancelled — nothing was deleted.');
            let verified = openUnmanagedDb(dbPath);
            expect(new MemoryStore(verified).getProjectById(project.id)).toBeDefined();
            verified.close();

            const confirmed = runTtyPurgeCli(dbPath, 'yes\n', '--orphan', '--apply');
            expect(confirmed.status).toBe(0);
            expect(confirmed.stdout).toContain("Deleted 1 session(s) across 1 project(s) from elepha's memory.");
            verified = openUnmanagedDb(dbPath);
            expect(new MemoryStore(verified).getProjectById(project.id)).toBeUndefined();
            verified.close();

            verified = openUnmanagedDb(dbPath);
            const bypassedProject = new MemoryStore(verified).upsertProject(path.join(directory, 'second-missing-project'));
            new MemoryStore(verified).upsertSession(
                'codex',
                'second-missing-session',
                bypassedProject.id,
                path.join(directory, 'second-missing.jsonl'),
            );
            verified.close();

            const bypassed = runTtyPurgeCli(dbPath, '', '--orphan', '--apply', '--skip-confirmation');
            expect(bypassed.status).toBe(0);
            expect(bypassed.stdout).not.toContain("Delete elepha's memory");
            verified = openUnmanagedDb(dbPath);
            expect(new MemoryStore(verified).getProjectById(bypassedProject.id)).toBeUndefined();
            verified.close();
        } finally {
            removeDirectory(directory);
        }
    }, 15000);
});
