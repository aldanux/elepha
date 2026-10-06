import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmdirSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRestoreOperation } from '../../src/cli/commands/restore.js';
import { CONSENT_CONTRACT_DISCLOSURE, SEMANTIC_SEARCH_DISCLOSURE } from '../../src/cli/consent-disclosure.js';
import { runInit } from '../../src/cli/init.js';
import {
    INIT_APPLY_PENDING_ERROR,
    type InitApplyJournal,
    initApplyJournalPath,
    newInitApplyJournal,
    publishInitApplyJournal,
} from '../../src/config/init-apply-journal.js';
import { elephaPaths } from '../../src/config/paths.js';
import { setSetting, unsetSetting } from '../../src/config/settings.js';
import type { BackfillReport } from '../../src/daemon/index.js';
import { generateEmbeddings } from '../../src/embeddings/generate.js';
import { embeddingConfiguration } from '../../src/embeddings/provider-config.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { TURN_EMBEDDINGS_TABLE } from '../../src/storage/turn-embeddings.js';
import { TURN_SEARCH_INDEX_TABLE } from '../../src/storage/turn-search-index.js';
import type { ToolName } from '../../src/types/index.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedSession, type TestDatabase } from '../helpers/db.js';
import { CANCELLED, discovery, fakePrompts, ttyStream } from '../helpers/init-prompts.js';
import { withTempDir } from '../helpers/tmp.js';

// Failure injection around the one batched config write: 'fail-before' throws
// without touching the file, 'fail-after' replaces it and then throws.
const configWrite = vi.hoisted(() => ({ plan: [] as Array<'fail-before' | 'fail-after' | 'ok'> }));
vi.mock(import('../../src/config/settings.js'), async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        setSettings: (...args: Parameters<typeof actual.setSettings>) => {
            const step = configWrite.plan.shift();
            if (step === 'fail-before') {
                throw new Error('simulated config write failure before replacement');
            }
            actual.setSettings(...args);
            if (step === 'fail-after') {
                throw new Error('simulated failure after config replacement');
            }
        },
    };
});

// Stands in for a process that dies after the consent commit, before it can
// remove its journal.
const journalRelease = vi.hoisted(() => ({ failures: 0 }));
vi.mock(import('../../src/config/init-apply-journal.js'), async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        releaseInitApplyJournal: (...args: Parameters<typeof actual.releaseInitApplyJournal>) => {
            if (journalRelease.failures > 0) {
                journalRelease.failures -= 1;
                throw new Error('simulated crash before journal removal');
            }
            actual.releaseInitApplyJournal(...args);
        },
    };
});

afterEach(() => {
    configWrite.plan = [];
    journalRelease.failures = 0;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

const ALL_TOOLS: ToolName[] = ['claude-code', 'codex', 'opencode'];

interface Fixture extends TestDatabase {
    configPath: string;
    journalPath: string;
    alpha: string;
    beta: string;
    gamma: string;
    backfill: ReturnType<typeof vi.fn<(roots: string[]) => Promise<BackfillReport>>>;
    reconcile: ReturnType<typeof vi.fn<(approvedRoots: number) => 'active' | undefined>>;
    prepareSemanticSearch: ReturnType<typeof vi.fn<() => Promise<void>>>;
    writeConfig(config: Record<string, unknown>): void;
    config(): Record<string, unknown>;
    state(): { config: string | undefined; consent: unknown; journal: string | undefined };
    run(prompts: ReturnType<typeof fakePrompts>, overrides?: Partial<Parameters<typeof runInit>[0]>): Promise<number>;
}

function fixture(): Fixture {
    const f = createTestDb('init-apply-');
    // Folder grouping and folder-repo discovery are home-relative; keep both
    // inside the fixture so no real directory is scanned or grouped.
    vi.stubEnv('HOME', f.directory);
    const elephaHome = path.join(f.directory, 'elepha-home');
    mkdirSync(elephaHome);
    vi.stubEnv('ELEPHA_HOME', elephaHome);
    const alpha = path.join(f.directory, 'work', 'alpha');
    const beta = path.join(f.directory, 'work', 'beta');
    const gamma = path.join(f.directory, 'elsewhere', 'gamma');
    for (const directory of [alpha, beta, gamma]) {
        mkdirSync(directory, { recursive: true });
    }
    const configPath = elephaPaths().config;
    const journalPath = initApplyJournalPath(configPath);
    const backfill = vi.fn(async (roots: string[]): Promise<BackfillReport> => ({ ingested: roots.length * 2, incomplete: [] }));
    const reconcile = vi.fn((_approvedRoots: number): 'active' | undefined => 'active');
    const prepareSemanticSearch = vi.fn(async () => {});
    return {
        ...f,
        configPath,
        journalPath,
        alpha: realpathSync(alpha),
        beta: realpathSync(beta),
        gamma: realpathSync(gamma),
        backfill,
        reconcile,
        prepareSemanticSearch,
        writeConfig: (config) => writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 }),
        config: () => JSON.parse(readFileSync(configPath, 'utf8')),
        state: () => ({
            config: existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined,
            consent: f.store.consent.list(),
            journal: existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : undefined,
        }),
        run: (prompts, overrides = {}) =>
            runInit({
                input: ttyStream(),
                output: prompts.output,
                store: f.store,
                configPath,
                prompts: prompts.prompts,
                daemon: { backfillApprovedRootsReport: backfill },
                reconcile,
                prepareSemanticSearch,
                detectTools: async () => ALL_TOOLS,
                discover: async () =>
                    discovery([
                        { root: alpha, displayName: 'alpha', sessionCount: 1 },
                        { root: beta, displayName: 'beta', sessionCount: 1 },
                    ]),
                ...overrides,
            }),
    };
}

// Approved alpha with real session and turn vectors, plus semantic search on.
async function seedAlphaWithVectors(f: Fixture): Promise<() => unknown[]> {
    f.writeConfig({ 'memory-plus': true });
    const project = seedProject(f, { path: f.alpha });
    seedConsentRoot(f, { path: f.alpha });
    const session = seedSession(f, { project, title: 'History to retain' });
    seedMemory(f, { session, project, durableCapture: true });
    const provider = {
        configuration: embeddingConfiguration(true)!,
        embed: vi.fn(async () => Array(384).fill(0.25)),
        dispose: vi.fn(async () => {}),
    };
    await generateEmbeddings(f.db, { configPath: f.configPath, createProvider: async () => provider });
    f.db
        .prepare(
            `INSERT INTO ${TURN_EMBEDDINGS_TABLE}
               (memory_id, project_id, source_digest, text_hash, model, model_revision, dimensions, vector, computed_at)
             SELECT t.memory_id, m.project_id, t.source_digest, 'text-hash', 'model', 'revision', 2, ?, '2026-09-27T00:00:00.000Z'
             FROM ${TURN_SEARCH_INDEX_TABLE} t JOIN memories m ON m.id = t.memory_id`,
        )
        .run(Buffer.alloc(8));
    const vectors = () => [
        ...f.db.prepare('SELECT * FROM session_embeddings').all(),
        ...f.db.prepare(`SELECT * FROM ${TURN_EMBEDDINGS_TABLE}`).all(),
    ];
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM session_embeddings').get()).toEqual({ count: 1 });
    expect(f.db.prepare(`SELECT COUNT(*) AS count FROM ${TURN_EMBEDDINGS_TABLE}`).get()).toEqual({ count: 1 });
    return vectors;
}

// The plan every failure test applies: narrow capture, pause alpha, approve beta.
function pauseAlphaApproveBeta(f: Fixture) {
    return fakePrompts('individual', [f.beta], [['claude-code']], { search: 'semantic' });
}

function searchInitialValue(prompts: ReturnType<typeof fakePrompts>): unknown {
    const call = vi
        .mocked(prompts.prompts.select)
        .mock.calls.find(([options]) => options.options.some((option) => option.value === 'semantic'));
    return call?.[0].initialValue;
}

function reviewNote(prompts: ReturnType<typeof fakePrompts>): string {
    return prompts.events.find((event) => event.startsWith('note:') && event.includes(CONSENT_CONTRACT_DISCLOSURE)) ?? '';
}

function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', '']);
    return child.pid ?? 999_999;
}

function writeJournal(f: Fixture, journal: InitApplyJournal, mode = 0o600): void {
    writeFileSync(f.journalPath, `${JSON.stringify(journal)}\n`, { mode });
    chmodSync(f.journalPath, mode);
}

describe('staged elepha init', () => {
    it.each(['tools', 'mode', 'roots', 'search', 'review', 'no projects'] as const)(
        'changes nothing when the run stops at %s',
        async (stage) => {
            const f = fixture();
            f.writeConfig({ 'capture-codex': true, 'update-check': false, 'memory-plus': false });
            seedConsentRoot(f, { path: f.alpha });
            const before = f.state();
            // Every stage before the stop point stages a real change: tools
            // narrowed, alpha deselected, beta selected, semantic search chosen.
            const prompts = fakePrompts(
                stage === 'mode' ? CANCELLED : 'individual',
                stage === 'roots' ? CANCELLED : [f.beta],
                [stage === 'tools' ? CANCELLED : ['claude-code']],
                { search: stage === 'search' ? CANCELLED : 'semantic', confirm: stage !== 'review' },
            );

            await expect(f.run(prompts, stage === 'no projects' ? { discover: async () => discovery([]) } : {})).resolves.toBe(0);

            expect(f.state()).toEqual(before);
            expect(f.prepareSemanticSearch).not.toHaveBeenCalled();
            expect(f.backfill).not.toHaveBeenCalled();
            expect(f.reconcile).not.toHaveBeenCalled();
        },
    );

    it('applies exactly the confirmed first-run choices, prepares search only after confirmation, then reruns as a no-op', async () => {
        const f = fixture();
        const first = fakePrompts('individual', [f.beta], [['claude-code']], { search: 'semantic' });

        await expect(f.run(first)).resolves.toBe(0);

        expect(searchInitialValue(first)).toBe('semantic');
        expect(reviewNote(first)).toContain(SEMANTIC_SEARCH_DISCLOSURE);
        expect(reviewNote(first)).toContain(f.beta);
        expect(f.prepareSemanticSearch).toHaveBeenCalledOnce();
        expect(vi.mocked(first.prompts.confirm).mock.invocationCallOrder[0]).toBeLessThan(
            f.prepareSemanticSearch.mock.invocationCallOrder[0] ?? 0,
        );
        expect(f.config()).toEqual({
            'capture-claude-code': true,
            'capture-codex': false,
            'capture-opencode': false,
            'memory-plus': true,
        });
        expect(f.store.consent.list()).toEqual([expect.objectContaining({ path: f.beta, state: 'approved' })]);
        expect(f.backfill).toHaveBeenCalledExactlyOnceWith([f.beta]);
        expect(f.reconcile).toHaveBeenCalledExactlyOnceWith(1);
        expect(existsSync(f.journalPath)).toBe(false);

        const before = f.state();
        const stat = statSync(f.configPath);
        const rerun = fakePrompts('individual', [f.beta], [], { search: 'semantic' });

        await expect(f.run(rerun)).resolves.toBe(0);

        expect(searchInitialValue(rerun)).toBe('semantic');
        expect(rerun.prompts.confirm).not.toHaveBeenCalled();
        expect(f.state()).toEqual(before);
        expect(statSync(f.configPath)).toMatchObject({ ino: stat.ino, mtimeMs: stat.mtimeMs });
        expect(f.prepareSemanticSearch).toHaveBeenCalledOnce();
        expect(f.backfill).toHaveBeenCalledOnce();
        expect(f.reconcile).toHaveBeenCalledOnce();
    });

    it('keeps undiscovered grants and undetected tool settings, and revokes only the roots shown in the plan', async () => {
        const f = fixture();
        f.writeConfig({ 'capture-opencode': false, 'update-check': false });
        seedConsentRoot(f, { path: f.alpha });
        const gammaGrant = seedConsentRoot(f, { path: f.gamma });
        const prompts = fakePrompts('individual', [f.beta], [], { search: 'term' });

        await expect(f.run(prompts, { detectTools: async () => ['claude-code', 'codex'] })).resolves.toBe(0);

        const note = reviewNote(prompts);
        expect(note).toContain(f.alpha);
        expect(note).not.toContain(f.gamma);
        expect(f.store.consent.list()).toEqual([
            expect.objectContaining({ path: f.gamma, state: 'approved', decided_at: gammaGrant.decided_at }),
            expect.objectContaining({ path: f.alpha, state: 'denied' }),
            expect.objectContaining({ path: f.beta, state: 'approved' }),
        ]);
        expect(f.config()).toEqual({
            'capture-opencode': false,
            'update-check': false,
            'capture-claude-code': true,
            'capture-codex': true,
            'memory-plus': false,
        });
        expect(f.prepareSemanticSearch).not.toHaveBeenCalled();
    });

    it('leaves previous settings and consent effective when semantic setup fails after confirmation', async () => {
        const f = fixture();
        f.writeConfig({ 'memory-plus': false, 'capture-codex': true });
        seedConsentRoot(f, { path: f.alpha });
        f.prepareSemanticSearch.mockRejectedValueOnce(new Error('model download interrupted'));
        const before = f.state();
        const prompts = fakePrompts('individual', [f.alpha, f.beta], [], { search: 'semantic' });

        await expect(f.run(prompts)).resolves.toBe(1);

        expect(searchInitialValue(prompts)).toBe('term');
        expect(f.prepareSemanticSearch).toHaveBeenCalledOnce();
        expect(f.state()).toEqual(before);
        expect(f.backfill).not.toHaveBeenCalled();
        expect(f.reconcile).not.toHaveBeenCalled();
    });

    it('turns semantic search off for term-only without deleting stored vectors or the local runtime', async () => {
        const f = fixture();
        const vectors = await seedAlphaWithVectors(f);
        const storedVectors = vectors();
        const runtimeManifest = path.join(elephaPaths().memoryPlus, 'package.json');
        mkdirSync(path.dirname(runtimeManifest), { recursive: true });
        writeFileSync(runtimeManifest, '{"private":true}');
        const prompts = fakePrompts('individual', [f.alpha], [], { search: 'term' });

        await expect(f.run(prompts)).resolves.toBe(0);

        expect(searchInitialValue(prompts)).toBe('semantic');
        expect(f.config()['memory-plus']).toBe(false);
        expect(vectors()).toEqual(storedVectors);
        expect(existsSync(runtimeManifest)).toBe(true);
        expect(f.prepareSemanticSearch).not.toHaveBeenCalled();
    });

    it.each(['consent', 'settings', 'physical path', 'directory identity'] as const)(
        'refuses the plan when %s changed after the preview',
        async (change) => {
            const f = fixture();
            f.writeConfig({ 'memory-plus': false });
            const elsewhere = path.join(f.directory, 'moved-target');
            mkdirSync(elsewhere);
            const prompts = fakePrompts('individual', [f.beta], [], {
                search: 'term',
                onConfirm: () => {
                    if (change === 'consent') {
                        f.store.consent.grant(f.gamma);
                    } else if (change === 'settings') {
                        f.writeConfig({ 'memory-plus': true });
                    } else if (change === 'physical path') {
                        renameSync(f.beta, `${f.beta}-old`);
                        symlinkSync(elsewhere, f.beta);
                    } else {
                        rmdirSync(f.beta);
                        mkdirSync(path.join(f.directory, 'placeholder'));
                        mkdirSync(f.beta);
                    }
                },
            });

            await expect(f.run(prompts)).resolves.toBe(1);

            // The concurrent edit itself stays; only the refused plan is not applied.
            expect(f.config()).toEqual({ 'memory-plus': change === 'settings' });
            expect(f.store.consent.list().filter((root) => root.path === f.beta || root.path === realpathSync(elsewhere))).toEqual([]);
            expect(existsSync(f.journalPath)).toBe(false);
            expect(f.backfill).not.toHaveBeenCalled();
            expect(f.reconcile).not.toHaveBeenCalled();
        },
    );

    it('lets elepha consent change roots without prompting for or altering search mode', async () => {
        const f = fixture();
        f.writeConfig({ 'memory-plus': true });
        const prompts = fakePrompts('individual', [f.beta], [], { search: 'term' });

        await expect(f.run(prompts, { entry: 'consent' })).resolves.toBe(0);

        expect(searchInitialValue(prompts)).toBeUndefined();
        expect(prompts.prompts.select).toHaveBeenCalledOnce();
        expect(f.config()).toEqual({ 'memory-plus': true });
        expect(f.store.consent.consentState(f.beta)).toBe('approved');
        expect(f.prepareSemanticSearch).not.toHaveBeenCalled();
    });
});

describe('init apply failure boundary', () => {
    it('keeps config, consent and vectors intact when the config file cannot be replaced', async () => {
        const f = fixture();
        const vectors = await seedAlphaWithVectors(f);
        const storedVectors = vectors();
        // A real writer failure before replacement: config.json points into a
        // directory where no temporary file can be created.
        const lockedDirectory = path.join(f.directory, 'locked-config');
        mkdirSync(lockedDirectory);
        const lockedConfig = path.join(lockedDirectory, 'config.json');
        renameSync(f.configPath, lockedConfig);
        symlinkSync(lockedConfig, f.configPath);
        chmodSync(lockedDirectory, 0o500);
        const before = f.state();

        try {
            await expect(f.run(pauseAlphaApproveBeta(f))).resolves.toBe(1);
        } finally {
            chmodSync(lockedDirectory, 0o700);
        }

        expect(f.state()).toEqual(before);
        expect(vectors()).toEqual(storedVectors);
        expect(f.backfill).not.toHaveBeenCalled();
        expect(f.reconcile).not.toHaveBeenCalled();
    });

    it('undoes its own config write when a failure follows the replacement', async () => {
        const f = fixture();
        const vectors = await seedAlphaWithVectors(f);
        const storedVectors = vectors();
        const consentBefore = f.store.consent.list();
        configWrite.plan = ['fail-after'];

        await expect(f.run(pauseAlphaApproveBeta(f))).resolves.toBe(1);

        expect(f.config()).toEqual({ 'memory-plus': true });
        expect(f.store.consent.list()).toEqual(consentBefore);
        expect(vectors()).toEqual(storedVectors);
        expect(existsSync(f.journalPath)).toBe(false);
        expect(f.backfill).not.toHaveBeenCalled();
    });

    it('rolls back vectors deleted by a revoke when the consent transaction fails after it', async () => {
        const f = fixture();
        const vectors = await seedAlphaWithVectors(f);
        const storedVectors = vectors();
        const consentBefore = f.store.consent.list();
        // Revokes run first inside the transaction and delete alpha's vectors;
        // the later grant fails, so the whole transaction must roll back.
        vi.spyOn(f.store.consent, 'grant').mockImplementationOnce(() => {
            expect(vectors()).toEqual([]);
            throw new Error('simulated consent write failure');
        });

        await expect(f.run(pauseAlphaApproveBeta(f))).resolves.toBe(1);

        expect(vectors()).toEqual(storedVectors);
        expect(f.store.consent.list()).toEqual(consentBefore);
        expect(f.config()).toEqual({ 'memory-plus': true });
        expect(existsSync(f.journalPath)).toBe(false);
        expect(f.backfill).not.toHaveBeenCalled();
    });
});

describe('init apply recovery', () => {
    // Leaves exactly what a process killed between the config write and the
    // consent commit leaves: the journal, the new config.json, untouched consent.
    async function interruptAfterConfigWrite(f: Fixture): Promise<void> {
        configWrite.plan = ['fail-after', 'fail-before'];
        await expect(f.run(pauseAlphaApproveBeta(f))).resolves.toBe(1);
        expect(existsSync(f.journalPath)).toBe(true);
        expect(f.config()).toMatchObject({ 'capture-claude-code': true, 'capture-codex': false });
    }

    // Leaves what a process killed after the consent commit leaves: committed
    // consent, the new config.json and a journal that was never removed.
    async function interruptAfterCommit(f: Fixture): Promise<void> {
        journalRelease.failures = 1;
        await expect(f.run(pauseAlphaApproveBeta(f))).resolves.toBe(0);
        expect(existsSync(f.journalPath)).toBe(true);
        expect(f.store.consent.consentState(f.beta)).toBe('approved');
        f.backfill.mockClear();
    }

    it('undoes an apply interrupted before its consent commit without touching consent or vectors', async () => {
        const f = fixture();
        const vectors = await seedAlphaWithVectors(f);
        const storedVectors = vectors();
        const consentBefore = f.store.consent.list();
        await interruptAfterConfigWrite(f);

        const next = fakePrompts('folder', [], [], { search: 'term' });
        await expect(f.run(next)).resolves.toBe(1);

        expect(next.prompts.multiselect).not.toHaveBeenCalled();
        expect(f.config()).toEqual({ 'memory-plus': true });
        expect(f.store.consent.list()).toEqual(consentBefore);
        expect(vectors()).toEqual(storedVectors);
        expect(existsSync(f.journalPath)).toBe(false);
        expect(f.backfill).not.toHaveBeenCalled();
    });

    it('finishes an apply interrupted after its consent commit and runs its backfill', async () => {
        const f = fixture();
        f.writeConfig({ 'memory-plus': true });
        seedConsentRoot(f, { path: f.alpha });
        await interruptAfterCommit(f);
        const configAfterCommit = f.config();

        const next = fakePrompts('folder', []);
        await expect(f.run(next)).resolves.toBe(0);

        expect(next.prompts.multiselect).not.toHaveBeenCalled();
        expect(existsSync(f.journalPath)).toBe(false);
        expect(f.config()).toEqual(configAfterCommit);
        expect(f.store.consent.consentState(f.alpha)).toBe('denied');
        expect(f.backfill).toHaveBeenCalledExactlyOnceWith([f.beta]);
    });

    it('keeps a setting changed after the interruption instead of reverting it', async () => {
        const f = fixture();
        f.writeConfig({ 'memory-plus': true });
        seedConsentRoot(f, { path: f.alpha });
        await interruptAfterConfigWrite(f);
        // A direct edit after the crash: the guarded writers would refuse.
        f.writeConfig({ ...f.config(), 'capture-codex': true });

        await expect(f.run(fakePrompts('folder', []))).resolves.toBe(1);

        expect(f.config()).toEqual({ 'memory-plus': true, 'capture-codex': true });
        expect(existsSync(f.journalPath)).toBe(false);
    });

    it.each(['re-granted paused root', 'revoked new grant'] as const)(
        'never overwrites a consent decision made after the interruption (%s)',
        async (change) => {
            const f = fixture();
            f.writeConfig({ 'memory-plus': true });
            seedConsentRoot(f, { path: f.alpha });
            await interruptAfterCommit(f);
            if (change === 're-granted paused root') {
                f.store.consent.grant(f.alpha);
            } else {
                f.store.consent.revoke(f.beta);
            }
            const consentBefore = f.store.consent.list();
            const configBefore = f.config();

            await expect(f.run(fakePrompts('folder', []))).resolves.toBe(1);

            expect(f.store.consent.list()).toEqual(consentBefore);
            expect(f.config()).toEqual(configBefore);
            expect(existsSync(f.journalPath)).toBe(false);
            expect(f.backfill).not.toHaveBeenCalled();
        },
    );

    it.each(['resolves elsewhere', 'was recreated at the same path'] as const)(
        'keeps consent but reports instead of backfilling a root that %s after the interruption',
        async (change) => {
            const f = fixture();
            f.writeConfig({ 'memory-plus': true });
            await interruptAfterCommit(f);
            if (change === 'resolves elsewhere') {
                const elsewhere = path.join(f.directory, 'moved-target');
                mkdirSync(elsewhere);
                renameSync(f.beta, `${f.beta}-old`);
                symlinkSync(elsewhere, f.beta);
            } else {
                rmdirSync(f.beta);
                // Hold the freed inode so the new directory cannot reuse it.
                mkdirSync(path.join(f.directory, 'placeholder'));
                mkdirSync(f.beta);
            }
            const next = fakePrompts('folder', []);

            await expect(f.run(next)).resolves.toBe(1);

            expect(f.backfill).not.toHaveBeenCalled();
            expect(f.store.consent.list()).toEqual([expect.objectContaining({ path: f.beta, state: 'approved' })]);
            expect(existsSync(f.journalPath)).toBe(false);
            const outro = next.events.find((event) => event.startsWith('outro:')) ?? '';
            expect(outro).toContain(`elepha consent grant ${JSON.stringify(f.beta)}`);
        },
    );

    it('backfills the roots that remain valid and reports the one that disappeared', async () => {
        const f = fixture();
        f.writeConfig({ 'memory-plus': true });
        const delta = path.join(f.directory, 'work', 'delta');
        mkdirSync(delta);
        const canonicalDelta = realpathSync(delta);
        const discover = async () =>
            discovery([
                { root: f.alpha, displayName: 'alpha', sessionCount: 1 },
                { root: f.beta, displayName: 'beta', sessionCount: 1 },
                { root: canonicalDelta, displayName: 'delta', sessionCount: 1 },
            ]);
        journalRelease.failures = 1;
        await expect(f.run(fakePrompts('individual', [f.beta, canonicalDelta], [], { search: 'term' }), { discover })).resolves.toBe(0);
        expect(existsSync(f.journalPath)).toBe(true);
        f.backfill.mockClear();
        rmdirSync(canonicalDelta);
        const next = fakePrompts('folder', []);

        await expect(f.run(next, { discover })).resolves.toBe(1);

        expect(f.backfill).toHaveBeenCalledExactlyOnceWith([f.beta]);
        expect(f.store.consent.consentState(f.beta)).toBe('approved');
        expect(f.store.consent.list().find((root) => root.path === canonicalDelta)).toMatchObject({ state: 'approved' });
        const outro = next.events.find((event) => event.startsWith('outro:')) ?? '';
        expect(outro).toContain(`elepha consent grant ${JSON.stringify(canonicalDelta)}`);
        expect(outro).not.toContain(`elepha consent grant ${JSON.stringify(f.beta)}`);
    });

    it('refuses to act while another live process owns the journal', async () => {
        const f = fixture();
        f.writeConfig({ 'memory-plus': false });
        seedConsentRoot(f, { path: f.alpha });
        writeJournal(f, {
            ...newInitApplyJournal(f.configPath, { 'memory-plus': { previous: false, target: true } }, [], []),
            pid: process.ppid,
        });
        const before = f.state();

        await expect(f.run(pauseAlphaApproveBeta(f))).resolves.toBe(1);

        expect(f.state()).toEqual(before);
        expect(f.backfill).not.toHaveBeenCalled();
    });

    it('cannot replace the journal of an apply that started while this preview was open', async () => {
        const f = fixture();
        f.writeConfig({ 'memory-plus': false });
        seedConsentRoot(f, { path: f.alpha });
        let other = '';
        const prompts = fakePrompts('individual', [f.beta], [['claude-code']], {
            search: 'term',
            onConfirm: () => {
                publishInitApplyJournal({
                    ...newInitApplyJournal(f.configPath, { 'memory-plus': { previous: false, target: true } }, [], []),
                    pid: process.ppid,
                });
                other = readFileSync(f.journalPath, 'utf8');
            },
        });
        const consentBefore = f.store.consent.list();

        await expect(f.run(prompts)).resolves.toBe(1);

        expect(readFileSync(f.journalPath, 'utf8')).toBe(other);
        expect(f.config()).toEqual({ 'memory-plus': false });
        expect(f.store.consent.list()).toEqual(consentBefore);
    });

    it.each(['foreign setting key', 'relative root', 'shared file mode', 'symlinked journal', 'other configuration'] as const)(
        'refuses a journal with a %s instead of acting on it',
        async (tamper) => {
            const f = fixture();
            f.writeConfig({ 'memory-plus': false });
            seedConsentRoot(f, { path: f.alpha });
            const valid: InitApplyJournal = {
                ...newInitApplyJournal(
                    f.configPath,
                    { 'memory-plus': { previous: false, target: true } },
                    [{ root: f.beta, previous: null, target: 'approved', identity: null }],
                    [f.beta],
                ),
                pid: deadPid(),
            };
            if (tamper === 'foreign setting key') {
                writeJournal(f, { ...valid, settings: { ...valid.settings, 'update-check': { previous: null, target: false } } as never });
            } else if (tamper === 'relative root') {
                writeJournal(f, {
                    ...valid,
                    consent: [{ root: 'work/beta', previous: null, target: 'approved', identity: null }],
                    backfillRoots: [],
                });
            } else if (tamper === 'shared file mode') {
                writeJournal(f, valid, 0o644);
            } else if (tamper === 'symlinked journal') {
                const elsewhere = path.join(f.directory, 'journal-target.json');
                writeFileSync(elsewhere, JSON.stringify(valid), { mode: 0o600 });
                symlinkSync(elsewhere, f.journalPath);
            } else {
                writeJournal(f, { ...valid, configPath: path.join(f.directory, 'other', 'config.json') });
            }
            const before = f.state();

            await expect(f.run(pauseAlphaApproveBeta(f))).resolves.toBe(1);

            expect(f.state()).toEqual(before);
            expect(f.backfill).not.toHaveBeenCalled();
        },
    );

    it('makes guarded config writers and restore refuse while a journal is pending', async () => {
        const f = fixture();
        f.writeConfig({ 'memory-plus': false });
        writeJournal(f, { ...newInitApplyJournal(f.configPath, {}, [], []), pid: deadPid() });
        const before = f.state();

        expect(() => setSetting('memory-plus', 'true', f.configPath)).toThrow(INIT_APPLY_PENDING_ERROR);
        expect(() => unsetSetting('memory-plus', f.configPath)).toThrow(INIT_APPLY_PENDING_ERROR);
        await expect(runRestoreOperation(f.dbPath, { dbPath: f.dbPath })).rejects.toThrow(INIT_APPLY_PENDING_ERROR);

        expect(f.state()).toEqual(before);
    });

    it('never replays onboarding intent carried inside a restored backup', async () => {
        const f = fixture();
        f.writeConfig({ 'memory-plus': false });
        seedConsentRoot(f, { path: f.alpha });
        // A candidate database carrying the database-resident intent an earlier
        // build stored: settings and consent rows that would re-authorize roots.
        const candidate = createTestDb('init-apply-candidate-');
        candidate.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
            'init_apply_pending',
            JSON.stringify({
                settings: { 'memory-plus': 'true' },
                previousConsent: [{ root: f.gamma, previous: null }],
                backfillRoots: [f.gamma],
                startedAt: '2026-09-30T00:00:00.000Z',
            }),
        );
        candidate.db.pragma('wal_checkpoint(TRUNCATE)');
        const backup = path.join(candidate.directory, 'full.db');
        copyFileSync(candidate.dbPath, backup);
        candidate.close();
        vi.stubEnv('TMPDIR', withTempDir('iar-'));
        f.close();

        await runRestoreOperation(backup, { dbPath: f.dbPath, daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }) });

        const restored = new MemoryStore(openUnmanagedDb(f.dbPath));
        try {
            const consentBefore = restored.consent.list();
            const configBefore = readFileSync(f.configPath, 'utf8');
            const prompts = fakePrompts(CANCELLED, []);

            await expect(f.run(prompts, { store: restored })).resolves.toBe(0);

            expect(prompts.prompts.multiselect).toHaveBeenCalled();
            expect(restored.consent.list()).toEqual(consentBefore);
            expect(restored.consent.consentState(f.gamma)).toBe('pending');
            expect(readFileSync(f.configPath, 'utf8')).toBe(configBefore);
            expect(existsSync(f.journalPath)).toBe(false);
            expect(f.backfill).not.toHaveBeenCalled();
        } finally {
            restored.database.close();
        }
    });
});

describe('init post-commit reporting', () => {
    it.each(['failed backfill', 'incomplete backfill', 'service'] as const)(
        'keeps committed choices and reports a retryable gap after a %s',
        async (job) => {
            const f = fixture();
            f.writeConfig({ 'memory-plus': false });
            if (job === 'failed backfill') {
                f.backfill.mockRejectedValueOnce(new Error('transcript store unreadable'));
            } else if (job === 'incomplete backfill') {
                f.backfill.mockResolvedValueOnce({
                    ingested: 3,
                    incomplete: [{ source: '/transcripts/broken.jsonl', category: 'unreadable content', reason: 'first line is not JSON' }],
                });
            } else {
                f.reconcile.mockImplementationOnce(() => {
                    throw new Error('launchctl bootstrap failed');
                });
            }
            const prompts = fakePrompts('individual', [f.beta], [], { search: 'term' });

            await expect(f.run(prompts)).resolves.toBe(1);

            expect(f.store.consent.consentState(f.beta)).toBe('approved');
            expect(f.config()['memory-plus']).toBe(false);
            expect(existsSync(f.journalPath)).toBe(false);
            expect(prompts.events.some((event) => event.startsWith('cancel:'))).toBe(false);
            const outro = prompts.events.find((event) => event.startsWith('outro:')) ?? '';
            if (job === 'service') {
                expect(outro).toContain('launchctl bootstrap failed');
            } else {
                expect(outro).toContain(job === 'failed backfill' ? 'transcript store unreadable' : '/transcripts/broken.jsonl');
                expect(outro).toContain(`elepha consent grant ${JSON.stringify(f.beta)}`);
            }
        },
    );

    it('treats an empty history as a complete backfill', async () => {
        const f = fixture();
        f.backfill.mockResolvedValueOnce({ ingested: 0, incomplete: [] });
        const prompts = fakePrompts('individual', [f.beta], [], { search: 'term' });

        await expect(f.run(prompts)).resolves.toBe(0);

        expect(f.store.consent.consentState(f.beta)).toBe('approved');
    });
});

describe('init backfill of real transcripts', () => {
    // A real Claude Code transcript under a fixture CLAUDE_CONFIG_DIR, read by
    // the production daemon and adapter that init constructs itself.
    function claudeLines(cwd: string, sessionId: string, userText = 'Remember this request'): string[] {
        return [
            JSON.stringify({
                type: 'user',
                parentUuid: null,
                isSidechain: false,
                message: { role: 'user', content: userText },
                uuid: `${sessionId}-user`,
                timestamp: '2026-08-25T00:00:00.000Z',
                cwd,
                sessionId,
            }),
            JSON.stringify({
                type: 'assistant',
                parentUuid: `${sessionId}-user`,
                message: { role: 'assistant', content: [{ type: 'text', text: 'Remembered response' }] },
                uuid: `${sessionId}-assistant`,
                timestamp: '2026-08-25T00:00:01.000Z',
                cwd,
                sessionId,
            }),
        ];
    }

    function transcriptStore(f: Fixture) {
        const claudeDir = path.join(f.directory, '.claude');
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
        vi.stubEnv('CODEX_HOME', path.join(f.directory, '.codex'));
        const projects = path.join(claudeDir, 'projects', 'fixture');
        mkdirSync(projects, { recursive: true });
        return (sessionId: string, lines: string[]): string => {
            const file = path.join(projects, `${sessionId}.jsonl`);
            writeFileSync(file, `${lines.join('\n')}\n`);
            return file;
        };
    }

    const memories = (f: Fixture) => (f.db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count;

    it('keeps the valid turns of a transcript with a malformed record and reports it incomplete', async () => {
        const f = fixture();
        const write = transcriptStore(f);
        const [user, assistant] = claudeLines(f.beta, 'mixed-session');
        const transcript = write('mixed-session', [user ?? '', '{"type":"user","message":', assistant ?? '']);
        const prompts = fakePrompts('individual', [f.beta], [], { search: 'term' });

        await expect(f.run(prompts, { daemon: undefined })).resolves.toBe(1);

        expect(memories(f)).toBe(1);
        expect(f.store.consent.consentState(f.beta)).toBe('approved');
        const outro = prompts.events.find((event) => event.startsWith('outro:')) ?? '';
        expect(outro).toContain(transcript);
        expect(outro).toContain('malformed records');
        expect(outro).toContain(`elepha consent grant ${JSON.stringify(f.beta)}`);
    });

    it('does not report intentional exclusions as incomplete', async () => {
        const f = fixture();
        const write = transcriptStore(f);
        write('valid-session', claudeLines(f.beta, 'valid-session'));
        // A later session whose only turn carries elepha's own injected context,
        // and a session from a root the user did not approve.
        write(
            'injected-session',
            claudeLines(f.beta, 'injected-session', `Hi\n[[elepha:brief:${'0'.repeat(26)}]]\nold brief\n[[/elepha]]`),
        );
        write('unapproved-session', claudeLines(f.alpha, 'unapproved-session'));
        const prompts = fakePrompts('individual', [f.beta], [], { search: 'term' });

        await expect(f.run(prompts, { daemon: undefined })).resolves.toBe(0);

        expect(memories(f)).toBe(1);
        expect(prompts.events.find((event) => event.startsWith('outro:'))).not.toContain('Incomplete');
    });
});
