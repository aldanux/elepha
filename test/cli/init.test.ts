import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { type InitPrompts, runInit } from '../../src/cli/init.js';
import { ELEPHA_TAGLINE, ELEPHA_WORDMARK } from '../../src/config/constants.js';
import type { DiscoveryResult } from '../../src/discovery/session-projects.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const CANCELLED = Symbol('cancelled');

function ttyStream(): PassThrough {
    const stream = new PassThrough();
    Object.defineProperty(stream, 'isTTY', { value: true });
    return stream;
}

function fakePrompts(mode: 'folder' | 'individual' | typeof CANCELLED, selection: string[] | typeof CANCELLED) {
    const events: string[] = [];
    const output = new PassThrough();
    const prompts: InitPrompts = {
        intro: (title) => events.push(`intro:${title}`),
        note: (message) => events.push(`note:${message}`),
        spinner: () => ({ start: (message) => events.push(`start:${message}`), stop: () => events.push('stop') }),
        select: vi.fn(async () => mode),
        multiselect: vi.fn(async () => selection),
        isCancel: (value) => value === CANCELLED,
        cancel: (message) => events.push(`cancel:${message}`),
        outro: (message) => events.push(`outro:${message}`),
    };
    return { prompts, events, output };
}

function discovery(projects: Array<{ root: string; displayName: string; sessionCount: number }>): DiscoveryResult {
    return {
        detectedTools: ['claude-code', 'codex'],
        projects: projects.map((project) => ({
            ...project,
            tools: ['codex'],
            earliestSessionAt: '2026-08-01T00:00:00.000Z',
            latestSessionAt: '2026-08-02T00:00:00.000Z',
        })),
    };
}

function storedTurn(sessionId: string, projectPath: string, sourcePath: string, turnIndex = 0): ParsedTurn {
    return {
        tool: 'codex',
        sessionId,
        sourcePath,
        projectPath,
        turnIndex,
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-01T00:00:01.000Z',
        userMessage: 'Remember this',
        assistantText: 'Remembered',
        toolCalls: [],
        cursor: `${turnIndex + 1}|1`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

describe('elepha init', () => {
    it('renders consent entry without the init wordmark while running the shared picker', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-init-entry-'));
        const db = openDb(path.join(directory, 'elepha.db'));
        const init = fakePrompts(CANCELLED, []);
        const consent = fakePrompts(CANCELLED, []);
        let initOutput = '';
        let consentOutput = '';
        init.output.on('data', (chunk: Buffer) => {
            initOutput += chunk.toString('utf8');
        });
        consent.output.on('data', (chunk: Buffer) => {
            consentOutput += chunk.toString('utf8');
        });

        try {
            await expect(
                runInit({
                    input: ttyStream(),
                    output: init.output,
                    store: new MemoryStore(db),
                    prompts: init.prompts,
                    detectTools: async () => ['claude-code', 'codex'],
                    discover: async () => discovery([{ root: path.join(directory, 'project'), displayName: 'project', sessionCount: 1 }]),
                }),
            ).resolves.toBe(0);
            await expect(
                runInit({
                    input: ttyStream(),
                    output: consent.output,
                    entry: 'consent',
                    store: new MemoryStore(db),
                    prompts: consent.prompts,
                    detectTools: async () => ['claude-code', 'codex'],
                    discover: async () => discovery([{ root: path.join(directory, 'project'), displayName: 'project', sessionCount: 1 }]),
                }),
            ).resolves.toBe(0);

            expect(initOutput).toContain(ELEPHA_WORDMARK);
            expect(initOutput).toContain(ELEPHA_TAGLINE);
            expect(consentOutput).not.toContain(ELEPHA_WORDMARK);
            expect(consentOutput).toContain(ELEPHA_TAGLINE);
            expect(consent.prompts.select).toHaveBeenCalledOnce();
            expect(consent.prompts.select).toHaveBeenCalledWith({
                message: 'How should elepha remember your projects?',
                options: [
                    {
                        value: 'folder',
                        label: 'By folder — every project inside it, including new ones (recommended)',
                    },
                    { value: 'individual', label: 'By individual project — only the ones you pick' },
                ],
            });
            expect(consent.events).toContain('note:Tools detected: Claude Code, Codex');
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('approves top-level home folders, backfills them, and renders the folder checkbox flow', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-init-'));
        const db = openDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db);
        const home = homedir();
        const sites = path.join(home, 'Sites');
        const workspace = path.join(sites, 'elepha-init-fixture', 'workspace');
        const projectOne = path.join(workspace, 'one');
        const projectTwo = path.join(workspace, 'two');
        const phpstormProjects = path.join(home, 'PhpstormProjects');
        const orphan = path.join(phpstormProjects, 'elepha-init-fixture-orphan');
        const { prompts, events, output } = fakePrompts('folder', [sites, phpstormProjects]);
        const backfillApprovedRoots = vi.fn(async (roots: string[]) => roots.length * 3);
        const reconcile = vi.fn();

        try {
            await expect(
                runInit({
                    input: ttyStream(),
                    output,
                    store,
                    prompts,
                    daemon: { backfillApprovedRoots },
                    reconcile,
                    detectTools: async () => ['claude-code', 'codex'],
                    discover: async () =>
                        discovery([
                            { root: projectOne, displayName: 'one', sessionCount: 2 },
                            { root: projectTwo, displayName: 'two', sessionCount: 1 },
                            { root: orphan, displayName: 'elepha-init-fixture-orphan', sessionCount: 4 },
                        ]),
                }),
            ).resolves.toBe(0);

            expect(prompts.select).toHaveBeenCalledWith({
                message: 'How should elepha remember your projects?',
                options: [
                    {
                        value: 'folder',
                        label: 'By folder — every project inside it, including new ones (recommended)',
                    },
                    { value: 'individual', label: 'By individual project — only the ones you pick' },
                ],
            });
            expect(prompts.multiselect).toHaveBeenCalledWith({
                message: 'Which folders should elepha auto-sync?',
                options: [
                    {
                        value: phpstormProjects,
                        label: `Projects under ${phpstormProjects} (auto-sync)`,
                        hint: '1 projects · 4 sessions',
                    },
                    { value: sites, label: `Projects under ${sites} (auto-sync)`, hint: '2 projects · 3 sessions' },
                ],
                initialValues: [],
            });
            expect(backfillApprovedRoots).toHaveBeenCalledOnce();
            expect(backfillApprovedRoots).toHaveBeenCalledWith([phpstormProjects, sites]);
            expect(reconcile).toHaveBeenCalledWith(2);
            expect(store.consent.list('approved')).toEqual([
                expect.objectContaining({ path: phpstormProjects }),
                expect.objectContaining({ path: sites }),
            ]);
            expect(events).toContain('note:Tools detected: Claude Code, Codex');
            expect(events).toContain(
                "outro:elepha's memory: 3 projects (3 new) · 6 turns imported\n\nRun `elepha init` anytime to change what's remembered, or `elepha purge --revoked` to clear revoked projects from elepha's memory.",
            );
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('does not re-grant a selected approved folder or disturb its denied descendant', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-init-'));
        const db = openDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db);
        const folder = path.join(homedir(), 'Sites');
        const project = path.join(folder, `elepha-init-${path.basename(directory)}`, 'secret');
        const { prompts, events, output } = fakePrompts('folder', [folder]);
        const backfillApprovedRoots = vi.fn(async () => 1);
        store.consent.grant(folder);
        store.consent.revoke(project);
        const originalDecidedAt = '2026-08-01T00:00:00.000Z';
        db.prepare('UPDATE consent_roots SET decided_at = ? WHERE path = ?').run(originalDecidedAt, folder);
        const grant = vi.spyOn(store.consent, 'grant');

        try {
            await expect(
                runInit({
                    input: ttyStream(),
                    output,
                    store,
                    prompts,
                    daemon: { backfillApprovedRoots },
                    reconcile: vi.fn(),
                    discover: async () => discovery([{ root: project, displayName: 'project', sessionCount: 5 }]),
                }),
            ).resolves.toBe(0);

            expect(grant).not.toHaveBeenCalled();
            expect(backfillApprovedRoots).not.toHaveBeenCalled();
            expect(store.consent.list('denied')).toEqual([expect.objectContaining({ path: project, state: 'denied' })]);
            expect(store.consent.consentState(project)).toBe('denied');
            expect(store.consent.list('approved')).toEqual([
                expect.objectContaining({ path: folder, decided_at: originalDecidedAt, source: 'cli' }),
            ]);
            expect(events).toContain(
                "outro:elepha's memory: 1 project\n\nRun `elepha init` anytime to change what's remembered, or `elepha purge --revoked` to clear revoked projects from elepha's memory.",
            );
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('grants a nested denied project when the user explicitly selects it', async () => {
        const directory = withGrantableTestDir('elepha-init-');
        const db = openDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db);
        const folder = path.join(directory, 'folder');
        const project = path.join(folder, 'secret');
        store.consent.grant(folder);
        store.consent.revoke(project);
        const { prompts, output } = fakePrompts('individual', [project]);
        const backfillApprovedRoots = vi.fn(async () => 0);
        const grant = vi.spyOn(store.consent, 'grant');

        try {
            await expect(
                runInit({
                    input: ttyStream(),
                    output,
                    store,
                    prompts,
                    daemon: { backfillApprovedRoots },
                    reconcile: vi.fn(),
                    discover: async () => discovery([{ root: project, displayName: 'secret', sessionCount: 1 }]),
                }),
            ).resolves.toBe(0);

            expect(grant).toHaveBeenCalledOnce();
            expect(grant).toHaveBeenCalledWith(project);
            expect(store.consent.consentState(project)).toBe('approved');
            expect(backfillApprovedRoots).toHaveBeenCalledWith([project]);
        } finally {
            db.close();
        }
    });

    it('uses stored session totals for remembered projects and discovery totals for projects without sessions', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-init-counts-'));
        const db = openDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null });
        const folderRoot = path.join(homedir(), `elepha-init-counts-${path.basename(directory)}`);
        const remembered = path.join(folderRoot, 'remembered');
        const empty = path.join(folderRoot, 'empty');
        const rememberedProject = store.upsertProject(remembered);
        store.upsertProject(empty);
        store.upsertSession('codex', 'remembered-one', rememberedProject.id, path.join(directory, 'one.jsonl'));
        store.upsertSession('codex', 'remembered-two', rememberedProject.id, path.join(directory, 'two.jsonl'));
        const discovered = [
            { root: remembered, displayName: 'remembered', sessionCount: 255 },
            { root: empty, displayName: 'empty', sessionCount: 7 },
        ];
        const individual = fakePrompts('individual', CANCELLED);
        const folder = fakePrompts('folder', CANCELLED);

        try {
            await expect(
                runInit({
                    input: ttyStream(),
                    output: individual.output,
                    store,
                    prompts: individual.prompts,
                    reconcile: vi.fn(),
                    discover: async () => discovery(discovered),
                }),
            ).resolves.toBe(0);
            expect(individual.prompts.multiselect).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.arrayContaining([
                        expect.objectContaining({ value: remembered, hint: `consent pending · 2 sessions · ${remembered}` }),
                        expect.objectContaining({ value: empty, hint: `consent pending · 7 sessions · ${empty}` }),
                    ]),
                }),
            );

            await expect(
                runInit({
                    input: ttyStream(),
                    output: folder.output,
                    store,
                    prompts: folder.prompts,
                    reconcile: vi.fn(),
                    discover: async () => discovery(discovered),
                }),
            ).resolves.toBe(0);
            expect(folder.prompts.multiselect).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: [
                        expect.objectContaining({
                            value: folderRoot,
                            hint: '2 projects · 9 sessions',
                        }),
                    ],
                }),
            );
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('reports an already-paused individual project when its unchecked selection is confirmed unchanged', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-init-'));
        const db = openDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db);
        const project = path.join(directory, 'project');
        const { prompts, events, output } = fakePrompts('individual', []);
        store.consent.revoke(project);

        try {
            await expect(
                runInit({
                    input: ttyStream(),
                    output,
                    store,
                    prompts,
                    reconcile: vi.fn(),
                    discover: async () => discovery([{ root: project, displayName: 'project', sessionCount: 1 }]),
                }),
            ).resolves.toBe(0);

            const outro = events.find((event) => event.startsWith('outro:'));
            expect(outro).toContain('· 1 project paused');
            expect(outro).not.toContain('memory kept');
            expect(outro).toContain(
                "\n\nRun `elepha init` anytime to change what's remembered, or `elepha purge --revoked` to clear revoked projects from elepha's memory.",
            );
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('prechecks an approved individual root and denies it when unchecked without captured sessions', async () => {
        const directory = withGrantableTestDir('elepha-init-');
        const db = openDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db);
        const project = path.join(directory, 'project');
        store.consent.grant(project);
        const { prompts, output } = fakePrompts('individual', []);

        try {
            await expect(
                runInit({
                    input: ttyStream(),
                    output,
                    store,
                    prompts,
                    reconcile: vi.fn(),
                    discover: async () => discovery([{ root: project, displayName: 'project', sessionCount: 1 }]),
                }),
            ).resolves.toBe(0);

            expect(prompts.multiselect).toHaveBeenCalledWith(
                expect.objectContaining({ message: 'Which projects should elepha auto-sync?', initialValues: [project] }),
            );
            expect(store.consent.list()).toEqual([expect.objectContaining({ path: project, state: 'denied' })]);
        } finally {
            db.close();
        }
    });

    it('makes individual selection authoritative without deleting memory and preserves nested pauses in folder mode', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-init-'));
        const db = openDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db);
        const sites = path.join(homedir(), `elepha-init-root-${path.basename(directory)}`);
        const fixture = path.join(sites, 'fixture');
        const selectedProject = path.join(fixture, 'selected');
        const pausedProject = path.join(fixture, 'paused');
        const emptyProject = path.join(fixture, 'empty');
        store.consent.grant(sites);
        store.consent.grant(selectedProject);
        store.consent.grant(emptyProject);

        for (const [nativeId, projectPath] of [
            ['selected-session', selectedProject],
            ['paused-session', pausedProject],
        ] as const) {
            const project = store.upsertProject(projectPath);
            const sourcePath = path.join(directory, `${nativeId}.jsonl`);
            const session = store.upsertSession('codex', nativeId, project.id, sourcePath);
            store.recordTurn(storedTurn(nativeId, projectPath, sourcePath), session.id, project.id, {
                decisions: [],
                pending_items: [],
                status: 'ok',
            });
        }

        const counts = () => ({
            sessions: (db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count,
            turns: (db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count,
        });
        const before = counts();
        const { prompts, events, output } = fakePrompts('individual', [selectedProject, emptyProject]);

        try {
            await expect(
                runInit({
                    input: ttyStream(),
                    output,
                    store,
                    prompts,
                    reconcile: vi.fn(),
                    daemon: { backfillApprovedRoots: vi.fn(async () => 0) },
                    discover: async () =>
                        discovery([
                            { root: selectedProject, displayName: 'selected', sessionCount: 1 },
                            { root: pausedProject, displayName: 'paused', sessionCount: 1 },
                            { root: emptyProject, displayName: 'empty', sessionCount: 0 },
                        ]),
                }),
            ).resolves.toBe(0);

            expect(store.consent.list()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ path: sites, state: 'denied' }),
                    expect.objectContaining({ path: selectedProject, state: 'approved' }),
                    expect.objectContaining({ path: pausedProject, state: 'denied' }),
                    expect.objectContaining({ path: emptyProject, state: 'approved' }),
                ]),
            );
            expect(store.consent.consentState(selectedProject)).toBe('approved');
            expect(store.consent.consentState(pausedProject)).toBe('denied');
            expect(store.consent.consentState(emptyProject)).toBe('approved');
            expect(counts()).toEqual(before);
            expect(events).toContain(
                `outro:elepha's memory: 2 projects · 1 with no sessions yet · 1 project paused · auto-sync paused for 1 folder (${path.basename(sites)})\n\nRun \`elepha init\` anytime to change what's remembered, or \`elepha purge --revoked\` to clear revoked projects from elepha's memory.`,
            );

            const folder = fakePrompts('folder', [sites]);
            await expect(
                runInit({
                    input: ttyStream(),
                    output: folder.output,
                    store,
                    prompts: folder.prompts,
                    reconcile: vi.fn(),
                    daemon: { backfillApprovedRoots: vi.fn(async () => 0) },
                    discover: async () =>
                        discovery([
                            { root: selectedProject, displayName: 'selected', sessionCount: 1 },
                            { root: pausedProject, displayName: 'paused', sessionCount: 1 },
                        ]),
                }),
            ).resolves.toBe(0);

            expect(store.consent.list()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ path: sites, state: 'approved' }),
                    expect.objectContaining({ path: selectedProject, state: 'approved' }),
                    expect.objectContaining({ path: pausedProject, state: 'denied' }),
                ]),
            );
            expect(store.consent.consentState(pausedProject)).toBe('denied');
            expect(counts()).toEqual(before);
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('pauses an unchecked folder and all approved roots beneath it without purging stored sessions', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-init-'));
        const db = openDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db);
        const sites = path.join(homedir(), 'Sites');
        const fixture = path.join(sites, `elepha-init-${path.basename(directory)}`);
        const projectOne = path.join(fixture, 'one');
        const projectTwo = path.join(fixture, 'two');
        store.consent.grant(projectOne);
        store.consent.grant(projectTwo);
        const storedProject = store.upsertProject(projectOne);
        store.upsertSession('codex', 'captured-session', storedProject.id, path.join(directory, 'captured.jsonl'));
        const { prompts, events, output } = fakePrompts('folder', []);
        const planPurge = vi.spyOn(store, 'planPurge');

        try {
            await expect(
                runInit({
                    input: ttyStream(),
                    output,
                    store,
                    prompts,
                    reconcile: vi.fn(),
                    discover: async () =>
                        discovery([
                            { root: projectOne, displayName: 'one', sessionCount: 1 },
                            { root: projectTwo, displayName: 'two', sessionCount: 1 },
                        ]),
                }),
            ).resolves.toBe(0);

            expect(prompts.multiselect).toHaveBeenCalledWith(expect.objectContaining({ initialValues: [sites] }));
            expect(store.consent.list()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ path: sites, state: 'denied' }),
                    expect.objectContaining({ path: projectOne, state: 'denied' }),
                    expect.objectContaining({ path: projectTwo, state: 'denied' }),
                ]),
            );
            expect(store.findSession('codex', 'captured-session')).toBeDefined();
            expect(planPurge).not.toHaveBeenCalled();
            expect(events).toContain(
                "outro:elepha's memory: 0 projects · 2 projects paused\n\nRun `elepha init` anytime to change what's remembered, or `elepha purge --revoked` to clear revoked projects from elepha's memory.",
            );
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('aborts on Ctrl-C before consent changes', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-init-'));
        const db = openDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db);
        const { prompts, events, output } = fakePrompts(CANCELLED, []);

        try {
            await expect(
                runInit({
                    input: ttyStream(),
                    output,
                    store,
                    prompts,
                    discover: async () => discovery([{ root: path.join(directory, 'project'), displayName: 'project', sessionCount: 1 }]),
                }),
            ).resolves.toBe(0);
            expect(store.consent.list()).toEqual([]);
            expect(events).toContain('cancel:Operation cancelled. No changes were made.');
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('aborts on Ctrl-C from the checkbox prompt before consent changes', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-init-'));
        const db = openDb(path.join(directory, 'elepha.db'));
        const store = new MemoryStore(db);
        const { prompts, events, output } = fakePrompts('individual', CANCELLED);

        try {
            await expect(
                runInit({
                    input: ttyStream(),
                    output,
                    store,
                    prompts,
                    discover: async () => discovery([{ root: path.join(directory, 'project'), displayName: 'project', sessionCount: 1 }]),
                }),
            ).resolves.toBe(0);
            expect(store.consent.list()).toEqual([]);
            expect(events).toContain('cancel:Operation cancelled. No changes were made.');
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('refuses non-interactive input without changing consent', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-init-notty-'));
        const db = openDb(path.join(directory, 'elepha.db'));
        const error = new PassThrough();
        let rendered = '';
        error.on('data', (chunk: Buffer) => {
            rendered += chunk.toString('utf8');
        });
        try {
            await expect(runInit({ input: new PassThrough(), output: new PassThrough(), error, store: new MemoryStore(db) })).resolves.toBe(
                1,
            );
            expect(rendered).toContain('requires an interactive terminal');
            expect(new MemoryStore(db).consent.list()).toEqual([]);
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
