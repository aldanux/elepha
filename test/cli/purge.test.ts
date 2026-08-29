import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runPurgeOperation } from '../../src/cli/commands/purge.js';
import { PURGE_HERE_UNCONSENTED } from '../../src/cli/purge-wizard.js';
import { consentedProject } from '../../src/hooks/common.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

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
    const db = openDb(dbPath);
    try {
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all() as Array<{ name: string }>;
        return Object.fromEntries(
            tables.map(({ name }) => {
                const quotedName = name.replaceAll('"', '""');
                return [name, db.prepare(`SELECT * FROM "${quotedName}" ORDER BY rowid`).all()];
            }),
        );
    } finally {
        db.close();
    }
}

describe('elepha purge orphan project scope', () => {
    it('applies only surviving previewed ids when matching sessions appear during confirmation', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-'));
        const dbPath = path.join(directory, 'elepha.db');
        const previousDbPath = process.env.ELEPHA_DB_PATH;
        const previousElephaHome = process.env.ELEPHA_HOME;
        const previousExitCode = process.exitCode;
        process.env.ELEPHA_DB_PATH = dbPath;
        process.env.ELEPHA_HOME = path.join(directory, 'isolated-elepha-home');
        process.exitCode = undefined;
        const db = openDb(dbPath);
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
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-'));
        const projectDirectory = mkdtempSync(path.join(testScratchRoot, 'purge-'));
        const dbPath = path.join(directory, 'elepha.db');
        const tempPath = path.join(directory, 'temp-project');
        const missingPath = path.join(projectDirectory, 'missing-project');
        const livePath = path.join(projectDirectory, 'live-project');
        mkdirSync(tempPath);
        mkdirSync(livePath);
        const db = openDb(dbPath);
        const store = new MemoryStore(db);
        const temp = store.upsertProject(tempPath);
        const missing = store.upsertProject(missingPath);
        const live = store.upsertProject(livePath);
        const tempSession = store.upsertSession('codex', 'temp-session', temp.id, path.join(directory, 'temp.jsonl'));
        const missingSession = store.upsertSession('codex', 'missing-session', missing.id, path.join(directory, 'missing.jsonl'));
        const liveSession = store.upsertSession('codex', 'live-session', live.id, path.join(directory, 'live.jsonl'));
        db.close();

        try {
            const orphanDryRun = runPurgeCli(dbPath, '--orphan');
            expect(orphanDryRun.status).toBe(0);
            expect(orphanDryRun.stdout).toContain('elepha memory in these projects:');
            expect(orphanDryRun.stdout).toContain(`  ${tempPath}  (project entry will be removed — no sessions left)`);
            expect(orphanDryRun.stdout).toContain(`  ${missingPath}  (project entry will be removed — no sessions left)`);
            expect(orphanDryRun.stdout).not.toContain(`[${tempSession.id}]`);
            expect(orphanDryRun.stdout).not.toContain(`[${missingSession.id}]`);
            expect(orphanDryRun.stdout).not.toContain(`[${liveSession.id}]`);
            expect(orphanDryRun.stdout).not.toContain('last ingested');
            expect(orphanDryRun.stdout).toContain('In total: 2 session(s), 0 turn(s).');
            expect(orphanDryRun.stdout).toContain(
                "This is a preview — nothing was deleted. This clears elepha's memory only — your original AI coding session history on disk is untouched. Re-run with --apply to delete (a backup is saved first).",
            );
            let verified = openDb(dbPath);
            expect(new MemoryStore(verified).getProjectById(temp.id)).toBeDefined();
            verified.close();

            const orphanApply = runPurgeCli(dbPath, '--orphan', '--apply');
            expect(orphanApply.status).toBe(0);
            expect(orphanApply.stdout).toContain('Saved a backup of your memory database (keeping the last 5).');
            expect(orphanApply.stdout).toContain("Deleted 2 session(s) across 2 project(s) from elepha's memory.");
            expect(orphanApply.stdout).not.toContain('Delete these');
            expect(orphanApply.stdout).not.toContain('Verified: nothing matching this scope remains.');
            verified = openDb(dbPath);
            const verifiedStore = new MemoryStore(verified);
            expect(verifiedStore.getProjectById(temp.id)).toBeUndefined();
            expect(verifiedStore.getProjectById(missing.id)).toBeUndefined();
            expect(verifiedStore.getProjectById(live.id)).toBeDefined();
            expect(verifiedStore.listMemoriesForSession(liveSession.id)).toEqual([]);
            verified.close();
        } finally {
            removeDirectory(directory);
            removeDirectory(projectDirectory);
        }
    });

    it('resolves only denied and unapproved projects as revoked, then preserves their denied consent after applying', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-'));
        const projectDirectory = withGrantableTestDir('purge-revoked-');
        const dbPath = path.join(directory, 'elepha.db');
        const deniedRoot = path.join(projectDirectory, 'revoked-root');
        const revokedPath = path.join(deniedRoot, 'revoked-project');
        const activePath = path.join(deniedRoot, 'active-project');
        const pendingPath = path.join(projectDirectory, 'pending-project');
        const db = openDb(dbPath);
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
            const verified = openDb(dbPath);
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
    });

    it('combines a project scope with --older-than without touching other projects or newer sessions', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-'));
        const dbPath = path.join(directory, 'elepha.db');
        const selectedPath = path.join(directory, 'selected-project');
        const retainedPath = path.join(directory, 'retained-project');
        const db = openDb(dbPath);
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

            const verified = openDb(dbPath);
            const verifiedStore = new MemoryStore(verified);
            expect(verifiedStore.findSession('codex', selectedOld.native_id)).toBeUndefined();
            expect(verifiedStore.findSession('codex', selectedNew.native_id)).toBeDefined();
            expect(verifiedStore.findSession('codex', retainedOld.native_id)).toBeDefined();
            verified.close();
        } finally {
            removeDirectory(directory);
        }
    });

    it('--here rejects an unconsented parent and resolves a consented project from its subdirectory', () => {
        const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'elepha-purge-')));
        const projectDirectory = realpathSync(withGrantableTestDir('purge-here-'));
        const dbPath = path.join(directory, 'elepha.db');
        const projectRoot = path.join(projectDirectory, 'project');
        const projectSubdirectory = path.join(projectRoot, 'src');
        const retainedRoot = path.join(projectDirectory, 'retained-project');
        mkdirSync(projectSubdirectory, { recursive: true });
        mkdirSync(retainedRoot);
        const db = openDb(dbPath);
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

            let verified = openDb(dbPath);
            let verifiedStore = new MemoryStore(verified);
            expect(verifiedStore.findSession('codex', projectSession.native_id)).toBeDefined();
            expect(verifiedStore.findSession('codex', projectSubdirectorySession.native_id)).toBeDefined();
            expect(verifiedStore.findSession('codex', retainedSession.native_id)).toBeDefined();
            verified.close();

            const result = runPurgeCliFrom(projectSubdirectory, dbPath, '--here', '--apply');
            expect(result.status, result.stderr).toBe(0);

            verified = openDb(dbPath);
            verifiedStore = new MemoryStore(verified);
            expect(verifiedStore.findSession('codex', projectSession.native_id)).toBeUndefined();
            expect(verifiedStore.findSession('codex', projectSubdirectorySession.native_id)).toBeUndefined();
            expect(verifiedStore.findSession('codex', retainedSession.native_id)).toBeDefined();
            verified.close();
        } finally {
            removeDirectory(directory);
            removeDirectory(projectDirectory);
        }
    });

    it('rejects invalid selector combinations without mutating any database row', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-'));
        const dbPath = path.join(directory, 'elepha.db');
        const db = openDb(dbPath);
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
    });

    it('rejects empty project queries without mutating any database row', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-'));
        const dbPath = path.join(directory, 'elepha.db');
        const db = openDb(dbPath);
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
    });

    it('errors without a scope or time filter in non-TTY mode', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-'));
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
    });

    it('asks a TTY to confirm, leaves memory untouched on no, and deletes on yes', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-'));
        const dbPath = path.join(directory, 'elepha.db');
        const missingPath = path.join(directory, 'missing-project');
        const db = openDb(dbPath);
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
            let verified = openDb(dbPath);
            expect(new MemoryStore(verified).getProjectById(project.id)).toBeDefined();
            verified.close();

            const confirmed = runTtyPurgeCli(dbPath, 'yes\n', '--orphan', '--apply');
            expect(confirmed.status).toBe(0);
            expect(confirmed.stdout).toContain("Deleted 1 session(s) across 1 project(s) from elepha's memory.");
            verified = openDb(dbPath);
            expect(new MemoryStore(verified).getProjectById(project.id)).toBeUndefined();
            verified.close();

            verified = openDb(dbPath);
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
            expect(bypassed.stdout).not.toContain('Delete these');
            verified = openDb(dbPath);
            expect(new MemoryStore(verified).getProjectById(bypassedProject.id)).toBeUndefined();
            verified.close();
        } finally {
            removeDirectory(directory);
        }
    });
});
