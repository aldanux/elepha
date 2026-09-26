import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runPurgeOperation } from '../../src/cli/commands/purge.js';
import { buildPurgeScope, type PurgePrompts, runPurgeWizard } from '../../src/cli/purge-wizard.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { fixtureGitEnv } from '../helpers/git.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

const CANCELLED = Symbol('cancelled');
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

function removeDirectory(directory: string): void {
    try {
        rmSync(directory, { recursive: true, force: true });
    } catch {
        // Cleanup is a courtesy; sandbox permissions must not fail the assertion.
    }
}

function ttyStream(): PassThrough {
    const stream = new PassThrough();
    Object.defineProperty(stream, 'isTTY', { value: true });
    return stream;
}

function fakePrompts(
    selections: Array<string | typeof CANCELLED>,
    confirmation: boolean | typeof CANCELLED,
): { prompts: PurgePrompts; events: string[] } {
    const events: string[] = [];
    return {
        prompts: {
            intro: (title) => events.push(`intro:${title}`),
            select: vi.fn(async () => selections.shift() ?? CANCELLED),
            text: vi.fn(async () => CANCELLED),
            confirm: vi.fn(async () => confirmation),
            isCancel: (value) => value === CANCELLED,
            cancel: (message) => events.push(`cancel:${message}`),
            outro: (message) => events.push(`outro:${message}`),
            spinner: () => ({ start: (message) => events.push(`start:${message}`), stop: () => events.push('stop') }),
        },
        events,
    };
}

describe('revoked purge scope', () => {
    it('retains durable rules after revoke and after a revoked-session purge', () => {
        const directory = withGrantableTestDir('purge-revoked-rules-');
        const db = openUnmanagedDb(':memory:');
        const store = new MemoryStore(db);
        const project = store.upsertProject(path.join(directory, 'project'));
        store.consent.grant(directory);
        store.upsertSession('codex', 'revoked-rules', project.id, '/tmp/revoked-rules.jsonl');
        db.prepare('INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)').run(
            'revoked-rule',
            project.id,
            'Keep after revoke',
            '2026-09-20',
        );
        store.consent.revoke(directory);
        expect(store.standingRules.list([project.id])).toHaveLength(1);
        const scope = buildPurgeScope(store, { revoked: true });
        expect(scope.deleteStandingRules).toBe(false);
        const applied = store.purge(scope);
        expect(applied.sessions).toHaveLength(1);
        expect(applied.standingRules).toEqual([]);
        expect(store.standingRules.list([project.id])).toHaveLength(1);
        expect(store.getProjectById(project.id)).toBeDefined();
        db.close();
    });

    it.each([
        [{ project: '/selected' }, true],
        [{ orphan: true }, true],
        [{ all: true }, true],
        [{ revoked: true }, false],
        [{ project: '/selected', olderThan: '2026-01-01' }, false],
        [{ orphan: true, newerThan: '2026-01-01' }, false],
        [{ all: true, olderThan: '2026-01-01' }, false],
    ] as const)('carries the whole-project rule intention for %j', (options, expected) => {
        const db = openUnmanagedDb(':memory:');
        expect(buildPurgeScope(new MemoryStore(db), options).deleteStandingRules).toBe(expected);
        db.close();
    });
    it.each([
        { parentState: 'approved', childState: 'denied', expectedSelected: true },
        { parentState: 'denied', childState: 'approved', expectedSelected: false },
    ] as const)(
        'selects by the deepest explicit decision for a $parentState parent and $childState child',
        ({ parentState, childState, expectedSelected }) => {
            const directory = withGrantableTestDir('purge-revoked-scope-');
            const db = openUnmanagedDb(path.join(directory, 'elepha.db'));
            const store = new MemoryStore(db);
            const parentPath = path.join(directory, 'workspace');
            const childPath = path.join(parentPath, 'private-app');
            const project = store.upsertProject(childPath);

            try {
                store.consent[parentState === 'approved' ? 'grant' : 'revoke'](parentPath);
                store.consent[childState === 'approved' ? 'grant' : 'revoke'](childPath);

                expect(store.consent.consentState(childPath)).toBe(childState);
                expect(buildPurgeScope(store, { revoked: true }).projectIds).toEqual(expectedSelected ? [project.id] : []);
            } finally {
                db.close();
                removeDirectory(directory);
            }
        },
    );

    it('keeps an empty revoked scope explicit when nothing is revoked', () => {
        const directory = withTempDir('elepha-purge-revoked-empty-');
        const db = openUnmanagedDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db);
        store.upsertProject(path.join(directory, 'pending-project'));

        try {
            expect(buildPurgeScope(store, { revoked: true }).projectIds).toEqual([]);
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe('elepha purge wizard', () => {
    it('confirms exact rule-only deletion through the interactive project branch', async () => {
        const directory = withGrantableTestDir('purge-wizard-rule-only-');
        const db = openUnmanagedDb(':memory:');
        const store = new MemoryStore(db);
        const project = store.upsertProject(directory);
        db.prepare('INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)').run(
            'wizard-rule',
            project.id,
            'A durable rule',
            '2026-09-20',
        );
        db.prepare(
            `INSERT INTO session_rules (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
             VALUES ('wizard-chat-rule', 'codex', 'wizard-chat', ?, ?, 'A durable chat rule', '2026-09-20')`,
        ).run(directory, project.id);
        const { prompts, events } = fakePrompts(['project', directory], true);
        await expect(
            runPurgeWizard({
                input: ttyStream(),
                output: ttyStream(),
                store,
                prompts,
                runPurge: async (scope, plan, confirm) => {
                    expect(scope.deleteStandingRules).toBe(true);
                    expect(plan.sessions).toEqual([]);
                    expect(plan.standingRules.map((rule) => rule.ulid)).toEqual(['wizard-rule']);
                    expect(plan.sessionRules.map((rule) => rule.ulid)).toEqual(['wizard-chat-rule']);
                    expect(await confirm(plan)).toBe(true);
                    store.applyPurgePlan(plan);
                    return true;
                },
                runExternalAgentImports: async () => false,
            }),
        ).resolves.toBe(0);
        expect(prompts.confirm).toHaveBeenCalledWith({
            message:
                "Delete elepha's memory for these 0 session(s) and 1 standing rule(s) and 1 chat standing rule(s)? Your Claude Code / Codex history on disk is untouched. A backup is saved first.",
            initialValue: false,
        });
        expect(events).toContain('outro:Purge complete.');
        expect(store.getProjectById(project.id)).toBeUndefined();
        db.close();
    });
    it('does not print a success outro when the destructive operation refuses to run', async () => {
        const { prompts, events } = fakePrompts(['all'], true);
        const plan = { sessions: [{ id: 1 }] };

        await expect(
            runPurgeWizard({
                input: ttyStream(),
                output: ttyStream(),
                store: {
                    consent: { list: () => [] },
                    listProjects: () => [],
                    planPurge: () => plan,
                } as unknown as MemoryStore,
                prompts,
                runPurge: async () => false,
                runExternalAgentImports: async () => true,
            }),
        ).resolves.toBe(1);

        expect(events.some((event) => event.startsWith('outro:'))).toBe(false);
    });

    it('previews the selected project, confirms through the fake seam, and applies through the existing purge engine', async () => {
        const directory = withTempDir('elepha-purge-wizard-');
        const dbPath = path.join(directory, 'elepha.db');
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const selectedPath = path.join(withTempDir('elepha-purge-selected-'), 'elepha');
        const fragmentPath = path.join(selectedPath, 'src');
        mkdirSync(fragmentPath, { recursive: true });
        execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q', selectedPath], { env: fixtureGitEnv() });
        const retainedPath = path.join(directory, 'non-live-project');
        const selectedProject = store.upsertProject(selectedPath);
        const fragmentProjectId = Number(
            db
                .prepare(
                    `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    fragmentPath,
                    'src',
                    selectedProject.git_root,
                    selectedProject.git_remote,
                    selectedProject.git_root_commit,
                    '2026-08-01T00:00:00.000Z',
                    '2026-08-01T00:00:00.000Z',
                ).lastInsertRowid,
        );
        const retainedProject = store.upsertProject(retainedPath);
        const selectedSession = store.upsertSession(
            'codex',
            'selected-session',
            selectedProject.id,
            path.join(directory, 'selected.jsonl'),
        );
        store.upsertSession('codex', 'second-selected-session', selectedProject.id, path.join(directory, 'second-selected.jsonl'));
        const fragmentSession = store.upsertSession('codex', 'fragment-session', fragmentProjectId, path.join(directory, 'fragment.jsonl'));
        const retainedSession = store.upsertSession(
            'codex',
            'retained-session',
            retainedProject.id,
            path.join(directory, 'retained.jsonl'),
        );
        const { prompts } = fakePrompts(['project', selectedPath], true);
        const output = ttyStream();
        const runPurge = vi.fn((scope, plan, confirm) => runPurgeOperation(store, scope, { applyRequested: true, plan, confirm }));
        const logs: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message: string) => logs.push(message));
        const previousDbPath = process.env.ELEPHA_DB_PATH;
        const previousElephaHome = process.env.ELEPHA_HOME;
        process.env.ELEPHA_DB_PATH = dbPath;
        process.env.ELEPHA_HOME = path.join(directory, 'isolated-elepha-home');
        store.consent.revoke(selectedPath);

        try {
            expect(new SessionReader(store.database).sessionCountsByProject()).toEqual(new Map());
            await expect(
                runPurgeWizard({
                    input: ttyStream(),
                    output,
                    store,
                    prompts,
                    runPurge,
                    runExternalAgentImports: async () => {
                        throw new Error('external-agent-imports was not selected');
                    },
                }),
            ).resolves.toBe(0);

            expect(prompts.select).toHaveBeenNthCalledWith(1, {
                message: 'What should elepha forget?',
                options: expect.arrayContaining([
                    { value: 'project', label: 'A project' },
                    { value: 'newer-than', label: 'Sessions ingested after a date or duration' },
                    { value: 'older-than', label: 'Sessions older than a date or duration' },
                    { value: 'external-agent-imports', label: 'External-agent imports' },
                    { value: 'orphan', label: 'Orphaned or temporary projects' },
                    { value: 'revoked', label: 'Revoked projects' },
                    { value: 'all', label: 'Everything' },
                ]),
            });
            expect(prompts.select).toHaveBeenNthCalledWith(2, {
                message: 'Which project should elepha forget?',
                options: [{ value: selectedPath, label: 'elepha (revoked)', hint: `${selectedPath} · 0 sessions` }],
            });
            expect(prompts.confirm).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('these 3 session(s)') }),
            );
            expect(logs).toEqual(expect.arrayContaining([expect.stringContaining('In total: 3 session(s), 0 turn(s).')]));

            expect(store.getProjectById(selectedProject.id)).toBeUndefined();
            expect(store.getProjectById(fragmentProjectId)).toBeUndefined();
            expect(store.getProjectById(retainedProject.id)).toBeDefined();
            expect(store.findSession('codex', selectedSession.native_id)).toBeUndefined();
            expect(store.findSession('codex', fragmentSession.native_id)).toBeUndefined();
            expect(store.findSession('codex', retainedSession.native_id)).toBeDefined();
            expect(runPurge.mock.calls[0]?.[0]).toEqual({
                projectIds: [selectedProject.id, fragmentProjectId],
                deleteStandingRules: true,
            });
            expect(store.planPurge({ projectPath: selectedPath }).sessions).toEqual([]);
        } finally {
            if (previousDbPath === undefined) {
                delete process.env.ELEPHA_DB_PATH;
            } else {
                process.env.ELEPHA_DB_PATH = previousDbPath;
            }
            if (previousElephaHome === undefined) {
                delete process.env.ELEPHA_HOME;
            } else {
                process.env.ELEPHA_HOME = previousElephaHome;
            }
            log.mockRestore();
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('uses ingestion-time vocabulary once for the newer-than scope', async () => {
        const { prompts } = fakePrompts(['newer-than'], true);

        await expect(
            runPurgeWizard({
                input: ttyStream(),
                output: ttyStream(),
                store: {} as MemoryStore,
                prompts,
                runPurge: async () => true,
                runExternalAgentImports: async () => true,
            }),
        ).resolves.toBe(0);

        expect(prompts.select).toHaveBeenCalledWith({
            message: 'What should elepha forget?',
            options: expect.arrayContaining([{ value: 'newer-than', label: 'Sessions ingested after a date or duration' }]),
        });
        expect(prompts.text).toHaveBeenCalledWith({
            message: 'Ingested since when?',
            placeholder: '7d, 24h, or 2026-08-01',
            validate: expect.any(Function),
        });
    });

    it('cancels at confirmation without changing the previewed rows', async () => {
        const directory = withTempDir('elepha-purge-wizard-');
        const db = openUnmanagedDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db);
        const projectPath = repositoryRoot;
        const project = store.upsertProject(projectPath);
        store.upsertSession('codex', 'session', project.id, path.join(directory, 'session.jsonl'));
        const { prompts, events } = fakePrompts(['project', projectPath], false);

        try {
            await expect(
                runPurgeWizard({
                    input: ttyStream(),
                    output: ttyStream(),
                    store,
                    prompts,
                    runPurge: (scope, plan, confirm) => runPurgeOperation(store, scope, { applyRequested: true, plan, confirm }),
                    runExternalAgentImports: async () => true,
                }),
            ).resolves.toBe(0);

            expect(events).toContain('cancel:Operation cancelled. No changes were made.');
            expect(store.getProjectById(project.id)).toBeDefined();
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
