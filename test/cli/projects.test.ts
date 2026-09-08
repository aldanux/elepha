import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { registerProjects } from '../../src/cli/commands/projects.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { DISPLAY_VERBATIM_INSTRUCTIONS } from '../../src/serving/instructions.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { UNTITLED_EPISODE } from '../../src/storage/session-title.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

function infoPayload(cwd: string, sessionId: string): string {
    return JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'elepha:info',
        turn_id: 'turn-1',
        model: 'gpt-5.6',
        permission_mode: 'default',
        transcript_path: null,
    });
}

function injectedBody(result: Awaited<ReturnType<typeof runUserPromptSubmit>>): string {
    if (!('output' in result)) {
        throw new Error(`command did not emit: ${result.reason}`);
    }
    const context = (result.output.hookSpecificOutput as Record<string, string>).additionalContext;
    return context.split('\n').slice(1, -1).join('\n');
}

describe('elepha projects', () => {
    it('reports the same substantive count as elepha:info for mixed sessions', async () => {
        const projectRoot = withGrantableTestDir('projects-substantive-');
        const dbPath = `${withGrantableTestDir('projects-db-')}/elepha.db`;
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const project = store.upsertProject(projectRoot);
        store.consent.grant(projectRoot);
        const insertSession = db.prepare(
            `INSERT INTO sessions
                (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at, last_turn_at, title, custom_title)
             VALUES ('codex', 'mixed-session', ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const [segment, title, customTitle] of [
            [0, null, 'Named by user'],
            [1, 'Real title', null],
            [2, '', null],
            [3, UNTITLED_EPISODE, null],
        ] as const) {
            const timestamp = `2026-09-01T00:00:0${segment}.000Z`;
            insertSession.run(
                segment,
                project.id,
                path.join(projectRoot, `${segment}.jsonl`),
                timestamp,
                timestamp,
                timestamp,
                title,
                customTitle,
            );
        }
        db.close();
        vi.stubEnv('ELEPHA_DB_PATH', dbPath);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
        const program = new Command();
        registerProjects(program);

        try {
            await program.parseAsync(['node', 'elepha', 'projects']);
            expect(output).toEqual([`${projectRoot} (2 sessions)`]);
            const info = await runUserPromptSubmit(infoPayload(projectRoot, 'mixed-session'), 'codex', {
                dbPath,
                daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
                readUpdateAvailable: () => undefined,
            });
            expect(injectedBody(info)).toBe(`${DISPLAY_VERBATIM_INSTRUCTIONS}\n🐘 elepha · capture: ON · sessions: 2 here / 2 total`);
        } finally {
            log.mockRestore();
            vi.unstubAllEnvs();
        }
    });

    it('shows no sessions yet when a project has only non-substantive sessions', async () => {
        const projectRoot = withGrantableTestDir('projects-non-substantive-');
        const dbPath = `${withGrantableTestDir('projects-db-')}/elepha.db`;
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const project = store.upsertProject(projectRoot);
        store.consent.grant(projectRoot);
        const insertSession = db.prepare(
            `INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at, title)
             VALUES ('codex', 'empty-session', ?, ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ?)`,
        );
        insertSession.run(0, project.id, path.join(projectRoot, 'empty.jsonl'), '');
        insertSession.run(1, project.id, path.join(projectRoot, 'untitled.jsonl'), UNTITLED_EPISODE);
        db.close();
        vi.stubEnv('ELEPHA_DB_PATH', dbPath);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
        const program = new Command();
        registerProjects(program);

        try {
            await program.parseAsync(['node', 'elepha', 'projects']);
            expect(output).toEqual([`${projectRoot} (no sessions yet)`]);
        } finally {
            log.mockRestore();
            vi.unstubAllEnvs();
        }
    });

    it('shows a live checkout when captured sessions also retain its missing former path', async () => {
        const root = withGrantableTestDir('projects-moved-');
        const former = path.join(root, 'former', 'project');
        const current = path.join(root, 'current', 'project');
        mkdirSync(current, { recursive: true });
        const dbPath = `${withGrantableTestDir('projects-db-')}/elepha.db`;
        const db = openUnmanagedDb(dbPath);
        const remote = 'git@example.test:team/project.git';
        const insertProject = db.prepare(
            `INSERT INTO projects (path, display_name, git_root, git_remote, first_seen_at, last_seen_at)
             VALUES (?, 'project', ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
        );
        const formerProject = Number(insertProject.run(former, former, remote).lastInsertRowid);
        insertProject.run(current, former, remote);
        db.prepare(
            `INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at, title)
             VALUES ('codex', 'moved-session', ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'Moved session')`,
        ).run(formerProject, path.join(former, 'session.jsonl'));
        new MemoryStore(db).consent.grant(current);
        db.close();
        vi.stubEnv('ELEPHA_DB_PATH', dbPath);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
        const program = new Command();
        registerProjects(program);

        try {
            await program.parseAsync(['node', 'elepha', 'projects']);
            expect(output).toEqual([`${current} (1 session)`]);
        } finally {
            log.mockRestore();
            vi.unstubAllEnvs();
        }
    });

    it('keeps an existing temporary root canonical when its project set also has a non-temporary member', async () => {
        const root = withGrantableTestDir('projects-temp-root-');
        const temporaryRoot = tmpdir();
        const nonTemporaryMember = path.join(root, 'live', 'project');
        mkdirSync(nonTemporaryMember, { recursive: true });
        const dbPath = `${withGrantableTestDir('projects-db-')}/elepha.db`;
        const db = openUnmanagedDb(dbPath);
        const remote = 'git@example.test:team/temporary-project.git';
        const insertProject = db.prepare(
            `INSERT INTO projects (path, display_name, git_root, git_remote, first_seen_at, last_seen_at)
             VALUES (?, 'temporary-project', ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
        );
        const temporaryProject = Number(insertProject.run(temporaryRoot, temporaryRoot, remote).lastInsertRowid);
        insertProject.run(nonTemporaryMember, temporaryRoot, remote);
        db.prepare(
            `INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at, title)
             VALUES ('codex', 'temporary-session', ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'Temporary session')`,
        ).run(temporaryProject, path.join(temporaryRoot, 'session.jsonl'));
        db.close();
        vi.stubEnv('ELEPHA_DB_PATH', dbPath);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));

        try {
            const defaultProgram = new Command();
            registerProjects(defaultProgram);
            await defaultProgram.parseAsync(['node', 'elepha', 'projects']);
            expect(output).toEqual([]);

            const allProgram = new Command();
            registerProjects(allProgram);
            await allProgram.parseAsync(['node', 'elepha', 'projects', '--all']);
            expect(output).toHaveLength(1);
            expect(output[0]).toContain(temporaryRoot);
            expect(output[0]).toContain('(temp)');
            expect(output[0]).toContain('(1 session)');
        } finally {
            log.mockRestore();
            vi.unstubAllEnvs();
        }
    });

    it('lists approved roots without sessions while omitting pending and denied roots', async () => {
        const approved = withGrantableTestDir('projects-approved-');
        const pending = withGrantableTestDir('projects-pending-');
        const denied = withGrantableTestDir('projects-denied-');
        const dbPath = `${withGrantableTestDir('projects-db-')}/elepha.db`;
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        store.consent.grant(approved);
        store.consent.recordPending(pending);
        store.consent.revoke(denied);
        db.close();
        vi.stubEnv('ELEPHA_DB_PATH', dbPath);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
        const program = new Command();
        registerProjects(program);

        try {
            await program.parseAsync(['node', 'elepha', 'projects']);
            expect(output).toEqual([`${approved} (no sessions yet)`]);
        } finally {
            log.mockRestore();
            vi.unstubAllEnvs();
        }
    });

    it('lists approved repositories discovered below a folder grant even when they have no sessions', async () => {
        const fixture = withGrantableTestDir('projects-approved-folder-');
        const approvedFolder = path.join(fixture, 'workspace');
        const approvedProject = path.join(approvedFolder, 'project-without-sessions');
        mkdirSync(path.join(approvedProject, '.git'), { recursive: true });
        const dbPath = `${withGrantableTestDir('projects-db-')}/elepha.db`;
        const db = openUnmanagedDb(dbPath);
        new MemoryStore(db).consent.grant(approvedFolder);
        db.close();
        vi.stubEnv('ELEPHA_DB_PATH', dbPath);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
        const program = new Command();
        registerProjects(program);

        try {
            await program.parseAsync(['node', 'elepha', 'projects']);
            expect(output).toEqual([`${approvedProject} (no sessions yet)`]);
        } finally {
            log.mockRestore();
            vi.unstubAllEnvs();
        }
    });
});
