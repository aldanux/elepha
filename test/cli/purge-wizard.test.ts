import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runPurgeOperation } from '../../src/cli/commands/purge.js';
import { buildPurgeScope, type PurgePrompts, runPurgeWizard } from '../../src/cli/purge-wizard.js';
import { ELEPHA_TAGLINE, ELEPHA_WORDMARK } from '../../src/config/constants.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

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
    it.each([
        { parentState: 'approved', childState: 'denied', expectedSelected: true },
        { parentState: 'denied', childState: 'approved', expectedSelected: false },
    ] as const)(
        'selects by the deepest explicit decision for a $parentState parent and $childState child',
        ({ parentState, childState, expectedSelected }) => {
            const directory = withGrantableTestDir('purge-revoked-scope-');
            const db = openDb(path.join(directory, 'elepha.db'));
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
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-revoked-empty-'));
        const db = openDb(path.join(directory, 'elepha.db'));
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

        expect(events).not.toContain('outro:Purge complete.');
    });

    it('previews the selected project, confirms through the fake seam, and applies through the existing purge engine', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-wizard-'));
        const dbPath = path.join(directory, 'elepha.db');
        const db = openDb(dbPath);
        const store = new MemoryStore(db);
        const selectedPath = repositoryRoot;
        const fragmentPath = path.join(repositoryRoot, 'src');
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
        const { prompts, events } = fakePrompts(['project', selectedPath], true);
        const output = ttyStream();
        let rendered = '';
        output.on('data', (chunk: Buffer) => {
            rendered += chunk.toString('utf8');
            events.push('tagline');
        });
        const runPurge = vi.fn((scope, plan, confirm) => runPurgeOperation(store, scope, { applyRequested: true, plan, confirm }));
        const logs: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message: string) => logs.push(message));
        const previousDbPath = process.env.ELEPHA_DB_PATH;
        const previousElephaHome = process.env.ELEPHA_HOME;
        process.env.ELEPHA_DB_PATH = dbPath;
        process.env.ELEPHA_HOME = path.join(directory, 'isolated-elepha-home');
        store.consent.revoke(selectedPath);

        try {
            expect(store.sessionCountsByProject()).toEqual(
                new Map([
                    [selectedProject.id, 2],
                    [fragmentProjectId, 1],
                    [retainedProject.id, 1],
                ]),
            );
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
                options: [{ value: selectedPath, label: 'elepha (revoked)', hint: `${selectedPath} · 3 sessions` }],
            });
            expect(prompts.confirm).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('these 3 session(s)') }),
            );
            expect(rendered.split(ELEPHA_TAGLINE)).toHaveLength(2);
            expect(rendered).not.toContain(ELEPHA_WORDMARK);
            expect(events.slice(0, 2)).toEqual(['tagline', 'intro:Purge elepha memory']);
            expect(events).toEqual(
                expect.arrayContaining(['intro:Purge elepha memory', 'start:Preparing purge preview…', 'stop', 'outro:Purge complete.']),
            );
            expect(logs).toEqual(expect.arrayContaining([expect.stringContaining('In total: 3 session(s), 0 turn(s).')]));

            expect(store.getProjectById(selectedProject.id)).toBeUndefined();
            expect(store.getProjectById(fragmentProjectId)).toBeUndefined();
            expect(store.getProjectById(retainedProject.id)).toBeDefined();
            expect(store.findSession('codex', selectedSession.native_id)).toBeUndefined();
            expect(store.findSession('codex', fragmentSession.native_id)).toBeUndefined();
            expect(store.findSession('codex', retainedSession.native_id)).toBeDefined();
            expect(runPurge.mock.calls[0]?.[0]).toEqual({ projectIds: [selectedProject.id, fragmentProjectId] });
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
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-purge-wizard-'));
        const db = openDb(path.join(directory, 'elepha.db'));
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
