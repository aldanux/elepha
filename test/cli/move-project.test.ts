import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it, vi } from 'vitest';
import { SessionReader } from '../../src/serving/session-reader.js';
import { MemoryStore, type ProjectRow } from '../../src/storage/memory-store.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import { SessionRulesStore } from '../../src/storage/session-rules-store.js';
import { TURN_EMBEDDINGS_TABLE } from '../../src/storage/turn-embeddings.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession, type TestDatabase } from '../helpers/db.js';
import { fixtureGitEnv } from '../helpers/git.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

function runMove(fixture: TestDatabase, from: string, to: string, apply = true) {
    return spawnSync(
        process.execPath,
        [path.join(repositoryRoot, 'bin', 'elepha.js'), 'move-project', '--from', from, '--to', to, ...(apply ? ['--apply'] : [])],
        {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                ELEPHA_DB_PATH: fixture.dbPath,
                ELEPHA_HOME: path.join(fixture.directory, 'elepha-home'),
                ELEPHA_ENV_FILE: path.join(fixture.directory, 'missing.env'),
            },
        },
    );
}

function snapshot(db: Database.Database): Record<string, Array<Record<string, unknown>>> {
    const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>;
    return Object.fromEntries(
        tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>]),
    );
}

function seedChat(fixture: TestDatabase, project: ProjectRow, nativeId: string) {
    fixture.store.consent.grant(project.path);
    const session = seedSession(fixture, {
        project,
        nativeId,
        sourcePath: path.join(project.path, 'original.jsonl'),
        surface: 'cli',
        gitBranch: 'main',
    });
    const memory = seedMemory(fixture, {
        project,
        session,
        userMessage: `${nativeId} relocateneedle request`,
        assistantText: `Keep the ${nativeId} implementation`,
        decisions: [{ what: `Keep ${nativeId}`, why: 'Required behavior' }],
        cursor: `${nativeId}-cursor`,
        durableCapture: true,
    });
    seedRollup(fixture, { session, project, decisions: [{ what: `Keep ${nativeId}`, why: 'Required behavior' }] });
    return { session, memory };
}

async function assertUsable(fixture: TestDatabase, folder: string, sessionIds: number[]): Promise<void> {
    const resolution = new ProjectResolver(fixture.db).resolveConsented(folder, fixture.store.consent);
    if (!('project' in resolution) || !resolution.project) throw new Error('destination memory is not authorized');
    const reader = new SessionReader(fixture.db);
    const sessions = reader.sessionsFor(resolution.project);
    const recall = reader.storedContentRecallFor(sessions, ['"relocateneedle"'], 10, () => true);
    for (const id of sessionIds) {
        const session = sessions.find((candidate) => candidate.id === id);
        if (!session) throw new Error('relocated chat is not readable from destination');
        expect(existsSync(session.source_path)).toBe(false);
        expect((await reader.render(session)).episode?.text).toContain('relocateneedle');
        expect(recall.matches.has(id)).toBe(true);
    }
}

describe('elepha move-project', () => {
    it('previews without writes, then relocates missing-folder memory with usable retained reads/search and a harmless repeat', async () => {
        const fixture = createTestDb('move-missing-');
        const oldFolder = path.join(fixture.directory, 'old');
        const newFolder = path.join(fixture.directory, 'new');
        mkdirSync(newFolder);
        const project = seedProject(fixture, { path: oldFolder });
        expect(spawnSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '--quiet', newFolder], { env: fixtureGitEnv() }).status).toBe(
            0,
        );
        fixture.db.prepare('UPDATE projects SET git_root = ? WHERE id = ?').run(oldFolder, project.id);
        const chat = seedChat(fixture, project, 'missing-folder-chat');
        fixture.store.consent.grant(newFolder);
        fixture.store.setSqliteSourceCursor('opencode', chat.session.source_path, { watermark: 42, cursorId: 'source-cursor' });
        fixture.store.shownSessionLists.replace('codex', chat.session.native_id, [chat.session.id]);
        fixture.store.recordInjection({
            tool: 'codex',
            nativeSessionId: chat.session.native_id,
            injectedAt: '2026-10-06',
            injectionId: 'original-injection',
            body: 'Prior context',
        });
        const before = snapshot(fixture.db);
        expect(existsSync(oldFolder)).toBe(false);

        const preview = runMove(fixture, `${oldFolder}/.`, `${newFolder}/`, false);
        expect(preview.status, preview.stderr).toBe(0);
        expect(snapshot(fixture.db)).toEqual(before);
        expect(readdirSync(fixture.directory).filter((file) => file.includes('.bak-'))).toEqual([]);

        const applied = runMove(fixture, oldFolder, newFolder);
        expect(applied.status, applied.stderr).toBe(0);
        const after = snapshot(fixture.db);
        expect(after).toEqual({
            ...before,
            projects: before.projects!.map((row) => ({ ...row, path: newFolder, display_name: 'new', git_root: newFolder })),
        });
        expect(readdirSync(fixture.directory).filter((file) => file.includes('.bak-'))).toHaveLength(1);
        await assertUsable(fixture, newFolder, [chat.session.id]);

        const repeated = runMove(fixture, oldFolder, newFolder);
        expect(repeated.status, repeated.stderr).toBe(0);
        expect(snapshot(fixture.db)).toEqual(after);
        expect(readdirSync(fixture.directory).filter((file) => file.includes('.bak-'))).toHaveLength(1);
        await assertUsable(fixture, newFolder, [chat.session.id]);
    }, 15000);

    it('consolidates only selected owners, preserving all project dependents, rules, caches and separate same-remote checkouts', async () => {
        const fixture = createTestDb('move-consolidate-');
        const oldFolder = path.join(fixture.directory, 'old');
        const newFolder = path.join(fixture.directory, 'new');
        mkdirSync(newFolder);
        const source = seedProject(fixture, { path: `${oldFolder}/.` });
        const destination = seedProject(fixture, { path: newFolder });
        const separate = seedProject(fixture, { path: path.join(fixture.directory, 'separate') });
        const child = seedProject(fixture, { path: path.join(oldFolder, 'child') });
        const chats = [source, destination, separate, child].map((project) => seedChat(fixture, project, `chat-${project.id}`));
        fixture.db.prepare('UPDATE projects SET git_remote = ?').run('https://example.com/shared.git');
        for (const [index, project] of [source, destination, separate, child].entries()) {
            const { session, memory } = chats[index]!;
            fixture.db
                .prepare('INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)')
                .run(`rule-${index}`, project.id, `Preserve instruction ${index}`, '2026-10-06');
            fixture.db
                .prepare(`INSERT INTO session_rules (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
                VALUES (?, 'codex', ?, ?, ?, ?, '2026-10-06')`)
                .run(
                    `chat-rule-${index}`,
                    session.native_id,
                    project.id === source.id ? oldFolder : project.path,
                    project.id,
                    `Keep chat instruction ${index}`,
                );
            fixture.db
                .prepare(`INSERT INTO open_turns
                (tool, native_session_id, session_id, project_id, source_generation, turn_index, candidate_cursor, source_path, source_dev, source_ino, source_size, source_mtime_ms, source_revision, source_digest, failed_at, observed_at, receipt_coverage)
                VALUES ('codex', ?, ?, ?, 0, 1, 'next-cursor', ?, '1', '2', 1, 1, 'revision', 'digest', '2026-10-06', '2026-10-06', 'complete')`)
                .run(session.native_id, session.id, project.id, session.source_path);
            fixture.db
                .prepare(`INSERT INTO session_embeddings (session_id, rollup_session_id, project_id, source_hash, model, model_revision, dimensions, vector, computed_at)
                VALUES (?, ?, ?, 'hash', 'model', 'revision', 1, ?, '2026-10-06')`)
                .run(session.id, session.id, project.id, Buffer.alloc(4));
            fixture.db
                .prepare(`INSERT INTO ${TURN_EMBEDDINGS_TABLE} (memory_id, project_id, source_digest, text_hash, model, model_revision, dimensions, vector, computed_at)
                VALUES (?, ?, 'digest', 'hash', 'model', 'revision', 1, ?, '2026-10-06')`)
                .run(memory.id, project.id, Buffer.alloc(4));
        }
        const before = snapshot(fixture.db);
        const result = runMove(fixture, oldFolder, newFolder);
        expect(result.status, result.stderr).toBe(0);

        // Discover every real project foreign key so an unaccounted cascade cannot hide behind a curated table list.
        const expected: ReturnType<typeof snapshot> = { ...before, projects: before.projects!.filter((row) => row.id !== source.id) };
        for (const table of Object.keys(before)) {
            const foreignKeys = fixture.db.pragma(`foreign_key_list("${table}")`) as Array<{ table: string; from: string }>;
            for (const foreignKey of foreignKeys.filter((key) => key.table === 'projects')) {
                expect(before[table]!.some((row) => row[foreignKey.from] === source.id)).toBe(true);
                expected[table] = before[table]!.map((row) => ({
                    ...row,
                    [foreignKey.from]: row[foreignKey.from] === source.id ? destination.id : row[foreignKey.from],
                }));
            }
        }
        expected.projects = expected.projects!.map((row) =>
            row.id === destination.id
                ? {
                      ...row,
                      first_seen_at: [source.first_seen_at, destination.first_seen_at].sort()[0],
                      last_seen_at: [source.last_seen_at, destination.last_seen_at].sort().at(-1),
                  }
                : row,
        );
        expected.session_rules = expected.session_rules!.map((row) =>
            row.checkout_anchor === oldFolder ? { ...row, checkout_anchor: newFolder } : row,
        );
        const after = snapshot(fixture.db);
        expect(after).toEqual(expected);
        expect(fixture.db.pragma('foreign_key_check')).toEqual([]);
        await assertUsable(
            fixture,
            newFolder,
            chats.slice(0, 2).map(({ session }) => session.id),
        );
        expect(
            new SessionRulesStore(fixture.db).list({
                identity: { tool: 'codex', nativeSessionId: chats[0]!.session.native_id, checkoutAnchor: newFolder },
                projectIds: [destination.id],
            }),
        ).toEqual([expect.objectContaining({ ulid: 'chat-rule-0', owner_project_id: destination.id, text: 'Keep chat instruction 0' })]);
    }, 15000);

    it('keeps source and destination capture activity during a planned relocation without changing saved memory or unrelated projects', async () => {
        const fixture = createTestDb('move-activity-');
        const oldFolder = path.join(fixture.directory, 'old');
        const newFolder = path.join(fixture.directory, 'new');
        mkdirSync(newFolder);
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime('2026-10-06T01:00:00.000Z');
            const source = seedProject(fixture, { path: oldFolder });
            const destination = seedProject(fixture, { path: newFolder });
            const separate = seedProject(fixture, { path: path.join(fixture.directory, 'separate') });
            const chats = [source, destination, separate].map((project) => seedChat(fixture, project, `activity-${project.id}`));
            const plan = fixture.store.planMoveProject(oldFolder, newFolder);

            vi.setSystemTime('2026-10-06T01:00:01.000Z');
            const activeDestination = fixture.store.upsertProject(newFolder);
            vi.setSystemTime('2026-10-06T01:00:02.000Z');
            const activeSource = fixture.store.upsertProject(oldFolder);
            expect(activeDestination.last_seen_at).not.toBe(plan.destination?.last_seen_at);
            expect(activeSource.last_seen_at).not.toBe(plan.source?.last_seen_at);
            const before = snapshot(fixture.db);

            fixture.store.applyProjectMove(plan);

            expect(snapshot(fixture.db)).toEqual(
                Object.fromEntries(
                    Object.entries(before).map(([table, rows]) => [
                        table,
                        rows
                            .filter((row) => table !== 'projects' || row.id !== source.id)
                            .map((row) =>
                                table === 'projects' && row.id === destination.id
                                    ? { ...row, last_seen_at: activeSource.last_seen_at }
                                    : row.project_id === source.id
                                      ? { ...row, project_id: destination.id }
                                      : row,
                            ),
                    ]),
                ),
            );
            await assertUsable(
                fixture,
                newFolder,
                chats.slice(0, 2).map(({ session }) => session.id),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses unapproved or denied destinations and rule conflicts, and rolls back a transactional failure', async () => {
        const fixture = createTestDb('move-refusal-');
        const oldFolder = path.join(fixture.directory, 'old');
        const newFolder = path.join(fixture.directory, 'new');
        mkdirSync(newFolder);
        const source = seedProject(fixture, { path: oldFolder });
        const destination = seedProject(fixture, { path: newFolder });
        const chat = seedChat(fixture, source, 'preserve-chat');
        const pending = snapshot(fixture.db);
        expect(runMove(fixture, oldFolder, newFolder).status).toBe(1);
        expect(snapshot(fixture.db)).toEqual(pending);
        fixture.store.consent.revoke(newFolder);
        const denied = snapshot(fixture.db);
        expect(runMove(fixture, oldFolder, newFolder).status).toBe(1);
        expect(snapshot(fixture.db)).toEqual(denied);
        expect(readdirSync(fixture.directory).filter((file) => file.includes('.bak-'))).toEqual([]);

        fixture.store.consent.grant(newFolder);
        for (const project of [source, destination]) {
            fixture.db
                .prepare('INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)')
                .run(`conflict-${project.id}`, project.id, 'Keep the same rule', '2026-10-06');
        }
        const conflicting = snapshot(fixture.db);
        expect(runMove(fixture, oldFolder, newFolder).status).toBe(1);
        expect(snapshot(fixture.db)).toEqual(conflicting);
        fixture.db.prepare('UPDATE standing_rules SET text = ? WHERE project_id = ?').run('Keep another rule', destination.id);
        fixture.db.exec(
            `CREATE TRIGGER fail_relocation BEFORE UPDATE OF path ON projects BEGIN SELECT RAISE(ABORT, 'injected relocation failure'); END;`,
        );
        const beforeFailure = snapshot(fixture.db);
        const failed = runMove(fixture, oldFolder, newFolder);
        expect(failed.status).toBe(1);
        expect(failed.stderr).toContain('injected relocation failure');
        expect(snapshot(fixture.db)).toEqual(beforeFailure);
        await assertUsable(fixture, oldFolder, [chat.session.id]);
    }, 15000);

    it('revalidates the frozen associations and current consent before mutation', () => {
        const fixture = createTestDb('move-frozen-');
        const oldFolder = path.join(fixture.directory, 'old');
        const newFolder = path.join(fixture.directory, 'new');
        mkdirSync(newFolder);
        const source = seedProject(fixture, { path: oldFolder });
        seedChat(fixture, source, 'frozen-chat');
        fixture.store.consent.grant(newFolder);
        const store = new MemoryStore(fixture.db);
        const plan = store.planMoveProject(oldFolder, newFolder);
        fixture.store.consent.revoke(newFolder);
        const revoked = snapshot(fixture.db);
        expect(() => store.applyProjectMove(plan)).toThrow(/not authorized/);
        expect(snapshot(fixture.db)).toEqual(revoked);
        fixture.store.consent.grant(newFolder);
        seedProject(fixture, { path: newFolder });
        const changed = snapshot(fixture.db);
        expect(() => store.applyProjectMove(plan)).toThrow(/saved project changed/);
        expect(snapshot(fixture.db)).toEqual(changed);
    });
});
