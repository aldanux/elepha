import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import type { ProjectRow } from '../../src/storage/memory-store.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const elephaCli = path.join(repositoryRoot, 'src', 'cli', 'index.ts');

function runRekeyCli(dbPath: string, apply = true) {
    return spawnSync(process.execPath, [tsxCli, elephaCli, 'rekey-projects', ...(apply ? ['--apply'] : [])], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            ELEPHA_DB_PATH: dbPath,
            ELEPHA_ENV_FILE: path.join(path.dirname(dbPath), 'missing.env'),
            ELEPHA_HOME: path.join(path.dirname(dbPath), 'elepha-home'),
        },
    });
}

describe('elepha rekey-projects --apply', () => {
    it('backs up first, merges cwd rows, and leaves the repository root as the stored project path', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-rekey-projects-'));
        const dbPath = path.join(directory, 'elepha.db');
        const repo = path.join(directory, 'repo');
        const subdirectory = path.join(repo, 'packages', 'app');
        mkdirSync(subdirectory, { recursive: true });
        const gitInit = spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' });
        expect(gitInit.status).toBe(0);
        const gitRoot = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();

        const db = openDb(dbPath);
        const now = new Date().toISOString();
        const root = db
            .prepare(
                'INSERT INTO projects (path, display_name, git_root, git_remote, first_seen_at, last_seen_at) VALUES (?, ?, NULL, NULL, ?, ?)',
            )
            .run(repo, 'repo', now, now);
        const child = db
            .prepare(
                'INSERT INTO projects (path, display_name, git_root, git_remote, first_seen_at, last_seen_at) VALUES (?, ?, NULL, NULL, ?, ?)',
            )
            .run(subdirectory, 'app', now, now);
        db.prepare(
            "INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at, trailing_files) VALUES ('codex', 'root-session', 0, ?, ?, ?, ?, '[]')",
        ).run(Number(root.lastInsertRowid), path.join(repo, 'root.jsonl'), now, now);
        const childSession = db
            .prepare(
                "INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at, trailing_files) VALUES ('codex', 'child-session', 0, ?, ?, ?, ?, '[]')",
            )
            .run(Number(child.lastInsertRowid), path.join(subdirectory, 'child.jsonl'), now, now);
        db.prepare(
            `INSERT INTO session_rollups
             (session_id, project_id, tool, title, summary, decisions, pending_items, files_touched, turn_count, started_at, ended_at, kind, parent_session_id, summarizer_status, rollup_state, rolled_up_through_turn_index, computed_at, rollup_version)
             VALUES (?, ?, 'codex', 'child', '', '[]', '[]', '[]', 0, ?, ?, 'primary', NULL, 'ok', 'final', -1, ?, 1)`,
        ).run(Number(childSession.lastInsertRowid), Number(child.lastInsertRowid), now, now, now);
        db.close();

        try {
            const result = runRekeyCli(dbPath);

            expect(result.status).toBe(0);
            expect(result.stdout).toContain(`Backed up ${dbPath} to `);
            expect(readdirSync(directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(true);

            const verified = openDb(dbPath);
            const projects = verified.prepare('SELECT * FROM projects').all() as ProjectRow[];
            expect(projects).toEqual([expect.objectContaining({ path: gitRoot, display_name: 'repo', git_root: gitRoot })]);
            expect(verified.prepare('SELECT project_id FROM sessions ORDER BY native_id').all()).toEqual([
                { project_id: projects[0]!.id },
                { project_id: projects[0]!.id },
            ]);
            expect(verified.prepare('SELECT project_id FROM session_rollups').all()).toEqual([{ project_id: projects[0]!.id }]);
            verified.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }, 15000);

    it('leaves project rows untouched during the default dry run', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-rekey-dry-run-'));
        const dbPath = path.join(directory, 'elepha.db');
        const repo = path.join(directory, 'repo');
        const subdirectory = path.join(repo, 'packages', 'app');
        mkdirSync(subdirectory, { recursive: true });
        expect(spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' }).status).toBe(0);

        const db = openDb(dbPath);
        const now = new Date().toISOString();
        db.prepare(
            'INSERT INTO projects (path, display_name, git_root, git_remote, first_seen_at, last_seen_at) VALUES (?, ?, NULL, NULL, ?, ?)',
        ).run(repo, 'repo', now, now);
        db.prepare(
            'INSERT INTO projects (path, display_name, git_root, git_remote, first_seen_at, last_seen_at) VALUES (?, ?, NULL, NULL, ?, ?)',
        ).run(subdirectory, 'app', now, now);
        db.close();

        try {
            const result = runRekeyCli(dbPath, false);

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('=== PROJECT RE-KEY DRY RUN (nothing written) ===');
            expect(readdirSync(directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
            const verified = openDb(dbPath);
            expect(verified.prepare('SELECT id FROM projects').all()).toHaveLength(2);
            verified.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }, 15000);

    it('refuses apply while a daemon heartbeat is healthy without writing a backup or merge', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-rekey-daemon-running-'));
        const dbPath = path.join(directory, 'elepha.db');
        const repo = path.join(directory, 'repo');
        const subdirectory = path.join(repo, 'packages', 'app');
        mkdirSync(subdirectory, { recursive: true });
        expect(spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' }).status).toBe(0);

        const db = openDb(dbPath);
        const now = new Date().toISOString();
        for (const project of [repo, subdirectory]) {
            db.prepare(
                'INSERT INTO projects (path, display_name, git_root, git_remote, first_seen_at, last_seen_at) VALUES (?, ?, NULL, NULL, ?, ?)',
            ).run(project, path.basename(project), now, now);
        }
        db.close();
        const elephaHome = path.join(directory, 'elepha-home');
        mkdirSync(elephaHome);
        writeFileSync(path.join(elephaHome, 'daemon.heartbeat.json'), JSON.stringify({ pid: process.pid, startedAt: now, updatedAt: now }));

        try {
            const result = runRekeyCli(dbPath);

            expect(result.status).toBe(1);
            expect(result.stderr).toContain('Refusing rekey-projects --apply while the daemon is running');
            expect(readdirSync(directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
            const verified = openDb(dbPath);
            expect(verified.prepare('SELECT id FROM projects').all()).toHaveLength(2);
            verified.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }, 15000);
});
