import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableMemoryPlus, MEMORY_PLUS_API_NOTICE, MEMORY_PLUS_CONFIRM, MEMORY_PLUS_LOCAL_NOTICE } from '../../src/cli/commands/enable.js';
import * as cliProgress from '../../src/cli/progress.js';
import { getSetting, setSetting } from '../../src/config/settings.js';
import { generateEmbeddings } from '../../src/embeddings/generate.js';
import {
    createEmbeddingProvider,
    EMBEDDING_API_MODEL,
    EMBEDDING_LOCAL_REVISION,
    type EmbeddingProvider,
    embeddingConfiguration,
} from '../../src/embeddings/provider-config.js';
import { embeddingSourceHash } from '../../src/embeddings/source.js';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import { semanticRecall } from '../../src/serving/semantic-recall.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import {
    EMBEDDING_CONSENT_COLUMNS,
    EMBEDDING_PROJECT_AUTHORIZATION_COLUMNS,
    EMBEDDING_SOURCE_CHANGED,
    EmbeddingStore,
    lockedEmbedding,
} from '../../src/storage/embedding-store.js';
import {
    enableParanoidMode,
    lockMemory,
    registerParanoidDatabase,
    unlockMemory,
    withMemoryReadGeneration,
} from '../../src/storage/paranoid-gate.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';
import { withTempDir } from '../helpers/tmp.js';

function scan(store: EmbeddingStore, projectIds: number[]) {
    const vectors: import('../../src/storage/embedding-store.js').StoredEmbedding[] = [];
    store.scan(projectIds, (vector) => vectors.push(vector));
    return vectors;
}

function fixture() {
    const f = createTestDb('embedding-');
    const project = seedProject(f);
    seedConsentRoot(f, { path: project.path });
    const session = seedSession(f, { project, title: 'Encrypted memory' });
    const configPath = path.join(f.directory, 'config.json');
    const store = new EmbeddingStore(f.db, configPath);
    return { ...f, project, session, configPath, embeddings: store };
}

function fakeProvider(): EmbeddingProvider {
    const configuration = embeddingConfiguration(true, {})!;
    return {
        configuration,
        embed: vi.fn(async () => Array(configuration.dimensions).fill(0.25)),
        dispose: vi.fn(async () => {}),
    };
}

function generation(f: ReturnType<typeof fixture>) {
    return withMemoryReadGeneration(f.db, lockedEmbedding, (token) => token);
}

function saveVector(f: ReturnType<typeof fixture>) {
    setSetting('memory-plus', 'true', f.configPath);
    const source = f.embeddings.source(f.session.id)!;
    f.embeddings.write(source, fakeProvider().configuration, Array(384).fill(0.25), generation(f));
    return source;
}

afterEach(() => vi.restoreAllMocks());

describe('"Memory-Plus" opt-in and provider boundary', () => {
    it.each([{}, { OPENAI_API_KEY: 'present' }])('does no provider or storage work while disabled (%j)', async (environment) => {
        const f = fixture();
        const factory = vi.fn();
        expect(getSetting('memory-plus', environment, f.configPath)).toEqual({
            key: 'memory-plus',
            value: false,
            source: 'default',
        });
        expect(embeddingConfiguration(false, environment)).toBeUndefined();
        expect(await createEmbeddingProvider(false, environment)).toBeUndefined();
        await expect(generateEmbeddings(f.db, { configPath: f.configPath, environment, createProvider: factory })).rejects.toThrow(
            '"Memory-Plus" is off',
        );
        expect(factory).not.toHaveBeenCalled();
        expect(f.embeddings.source.bind(f.embeddings, f.session.id)).toThrow('"Memory-Plus" is off');
        expect(f.db.prepare('SELECT * FROM session_embeddings').all()).toEqual([]);
        expect(existsSync(f.configPath)).toBe(false);
    });

    it('selects local without a key and OpenAI only with an enabled flag and a nonempty key', () => {
        expect(embeddingConfiguration(true, {})?.provider).toBe('local');
        expect(embeddingConfiguration(true, { OPENAI_API_KEY: '  ' })?.provider).toBe('local');
        expect(embeddingConfiguration(true, { OPENAI_API_KEY: 'key' })?.provider).toBe('openai');
        const f = fixture();
        setSetting('memory-plus', 'on', f.configPath);
        expect(getSetting('memory-plus', {}, f.configPath).value).toBe(true);
    });

    it.each([{}, { OPENAI_API_KEY: 'key' }])('decline leaves no config or provider work (%j)', async (environment) => {
        const configPath = path.join(withTempDir('enable-decline-'), 'config.json');
        const createProvider = vi.fn();
        const installDependency = vi.fn();
        const confirm = vi.fn(async () => false);
        const log = vi.fn();
        expect(await enableMemoryPlus({ configPath, environment, createProvider, installDependency, confirm, log })).toBe(false);
        expect(confirm).toHaveBeenCalledWith(MEMORY_PLUS_CONFIRM);
        expect(log).toHaveBeenCalledWith(environment.OPENAI_API_KEY ? MEMORY_PLUS_API_NOTICE : MEMORY_PLUS_LOCAL_NOTICE);
        expect(createProvider).not.toHaveBeenCalled();
        expect(installDependency).not.toHaveBeenCalled();
        expect(existsSync(configPath)).toBe(false);
    });

    it.each([false, true])('leaves "Memory-Plus" off when package installation fails (previously enabled: %s)', async (enabled) => {
        const f = fixture();
        if (enabled) setSetting('memory-plus', 'true', f.configPath);
        const createProvider = vi.fn();
        const installDependency = vi.fn(async () => {
            throw new Error('npm install failed');
        });
        await expect(
            enableMemoryPlus({
                configPath: f.configPath,
                environment: {},
                confirm: async () => true,
                installDependency,
                createProvider,
                log: vi.fn(),
            }),
        ).rejects.toThrow('npm install failed');
        expect(getSetting('memory-plus', {}, f.configPath).value).toBe(false);
        expect(createProvider).not.toHaveBeenCalled();
    });

    it('does not install local dependencies for the API provider', async () => {
        const f = fixture();
        const installDependency = vi.fn();
        await enableMemoryPlus({
            configPath: f.configPath,
            openDatabase: async () => openUnmanagedDb(f.dbPath),
            environment: { OPENAI_API_KEY: 'key' },
            confirm: async () => true,
            installDependency,
            createProvider: async () => fakeProvider(),
            log: vi.fn(),
        });
        expect(installDependency).not.toHaveBeenCalled();
        expect(getSetting('memory-plus', {}, f.configPath).value).toBe(true);
    });

    it('enables only after a successful probe, is rerunnable and leaves failure disabled', async () => {
        const f = fixture();
        const provider = fakeProvider();
        const createProvider = vi.fn(async () => provider);
        const options = {
            configPath: f.configPath,
            openDatabase: async () => openUnmanagedDb(f.dbPath),
            environment: {},
            createProvider,
            installDependency: vi.fn(async () => {}),
            confirm: async () => true,
            log: vi.fn(),
        };
        vi.mocked(provider.embed).mockImplementationOnce(async () => {
            expect(getSetting('memory-plus', {}, f.configPath).value).toBe(false);
            return Array(384).fill(0.25);
        });
        await enableMemoryPlus(options);
        expect(options.installDependency).toHaveBeenCalledOnce();
        expect(options.installDependency.mock.invocationCallOrder[0]).toBeLessThan(createProvider.mock.invocationCallOrder[0]!);
        expect(getSetting('memory-plus', {}, f.configPath).value).toBe(true);
        vi.mocked(provider.embed).mockResolvedValue(Array(384).fill(0.25));
        await expect(enableMemoryPlus(options)).resolves.toBe(true);
        vi.mocked(provider.embed).mockRejectedValue(new Error('download failed'));
        await expect(enableMemoryPlus(options)).rejects.toThrow('download failed');
        expect(getSetting('memory-plus', {}, f.configPath).value).toBe(false);
        expect(provider.dispose).toHaveBeenCalled();
    });

    it('runs every slow enable step behind the same loader elepha install uses, and indexes pre-existing eligible history', async () => {
        const f = fixture();
        const second = seedSession(f, { project: f.project, nativeId: 'older-history', title: 'Multilingual recall' });
        const excluded = seedProject(f, { path: path.join(f.directory, 'not-granted') });
        seedSession(f, { project: excluded, nativeId: 'private', title: 'Not permitted' });
        const provider = fakeProvider();
        const log = vi.fn();
        const phases: { done: number; fail: number }[] = [];
        vi.spyOn(cliProgress, 'startCliProgress').mockImplementation(() => {
            const phase = { done: 0, fail: 0 };
            phases.push(phase);
            return {
                done: () => {
                    phase.done += 1;
                },
                fail: () => {
                    phase.fail += 1;
                },
            };
        });
        await expect(
            enableMemoryPlus({
                configPath: f.configPath,
                environment: {},
                openDatabase: async () => openUnmanagedDb(f.dbPath),
                confirm: async () => true,
                installDependency: vi.fn(),
                createProvider: async () => provider,
                log,
            }),
        ).resolves.toBe(true);

        for (const session of [f.session, second]) {
            expect(f.embeddings.current(f.embeddings.source(session.id)!, provider.configuration, generation(f))).toBe(true);
        }
        expect(scan(f.embeddings, [f.project.id])).toHaveLength(2);
        expect(f.db.prepare('SELECT COUNT(*) AS count FROM session_embeddings').get()).toEqual({ count: 2 });
        // Runtime install, probe and backfill each own one loader that resolves
        // successfully; no phase is left spinning and none reports a failure.
        expect(phases).toEqual([
            { done: 1, fail: 0 },
            { done: 1, fail: 0 },
            { done: 1, fail: 0 },
        ]);
        // The counts are a result, so they are printed rather than folded into a
        // loader line the terminal erases; per-session progress is not.
        expect(log).toHaveBeenCalledWith(expect.stringContaining('2 sessions indexed'));
        expect(log.mock.calls.flat().join('\n')).not.toContain('Indexing:');
        expect(log.mock.calls.flat().join('\n')).not.toContain('elepha embeddings');
    });

    it('fails the loader for the step that failed and leaves no phase spinning', async () => {
        const f = fixture();
        const phases: string[] = [];
        vi.spyOn(cliProgress, 'startCliProgress').mockImplementation(() => ({
            done: () => phases.push('done'),
            fail: () => phases.push('fail'),
        }));
        await expect(
            enableMemoryPlus({
                configPath: f.configPath,
                environment: {},
                confirm: async () => true,
                installDependency: vi.fn(async () => {
                    throw new Error('npm install failed');
                }),
                createProvider: vi.fn(),
                log: vi.fn(),
            }),
        ).rejects.toThrow('npm install failed');
        expect(phases).toEqual(['fail']);
    });

    it('retains the enabled setting and completed vectors when initial backfill fails partway', async () => {
        const f = fixture();
        const second = seedSession(f, { project: f.project, nativeId: 'newest-history', title: 'Indexed before failure' });
        const provider = fakeProvider();
        vi.mocked(provider.embed)
            .mockResolvedValueOnce(Array(384).fill(0.25))
            .mockResolvedValueOnce(Array(384).fill(0.25))
            .mockRejectedValueOnce(new Error('provider interrupted'));
        await expect(
            enableMemoryPlus({
                configPath: f.configPath,
                environment: {},
                openDatabase: async () => openUnmanagedDb(f.dbPath),
                confirm: async () => true,
                installDependency: vi.fn(),
                createProvider: async () => provider,
                log: vi.fn(),
            }),
        ).rejects.toThrow(/remains enabled.*provider interrupted.*elepha embeddings/);
        expect(getSetting('memory-plus', {}, f.configPath).value).toBe(true);
        expect(f.embeddings.current(f.embeddings.source(second.id)!, provider.configuration, generation(f))).toBe(true);
        expect(f.embeddings.current(f.embeddings.source(f.session.id)!, provider.configuration, generation(f))).toBe(false);
        expect(provider.dispose).toHaveBeenCalledTimes(2);
    });
});

describe('derived vector storage and manual generation', () => {
    it.each([{}, { OPENAI_API_KEY: 'test-key' }])(
        'rebuilds old equal-pooling vectors on an ordinary generation pass (%j)',
        async (environment) => {
            const f = fixture();
            setSetting('memory-plus', 'true', f.configPath);
            const configuration = embeddingConfiguration(true, environment)!;
            // Historical persisted format: keep this marker independent of the current revision.
            const oldModel = {
                ...configuration,
                revision:
                    configuration.provider === 'local'
                        ? `${EMBEDDING_LOCAL_REVISION}:q8:mean-chunks-v1`
                        : `${EMBEDDING_API_MODEL}:mean-chunks-v1`,
            };
            const source = f.embeddings.source(f.session.id)!;
            const oldVector = Array.from({ length: configuration.dimensions }, (_, index) => Number(index === 0));
            const newVector = Array.from({ length: configuration.dimensions }, (_, index) => Number(index === 1));
            f.embeddings.write(source, oldModel, oldVector, generation(f));
            expect(f.embeddings.current(source, oldModel, generation(f))).toBe(true);
            expect(f.embeddings.current(source, configuration, generation(f))).toBe(false);
            const provider: EmbeddingProvider = { configuration, embed: vi.fn(async () => newVector), dispose: vi.fn(async () => {}) };
            const options = { configPath: f.configPath, createProvider: async () => provider };
            expect((await semanticRecall(f.db, [f.project.id], 'memory', options)).candidates).toEqual([]);
            vi.mocked(provider.embed).mockClear();
            expect(await generateEmbeddings(f.db, options)).toEqual({
                generated: 1,
                current: 0,
                ineligibleOrEmpty: 0,
                sourceChanged: 0,
                failed: 0,
            });
            expect(provider.embed).toHaveBeenCalledExactlyOnceWith(source.text, expect.any(Function));
            expect(scan(f.embeddings, [f.project.id])).toEqual([
                {
                    sessionId: f.session.id,
                    model: configuration.model,
                    revision: configuration.revision,
                    dimensions: configuration.dimensions,
                    vector: newVector,
                },
            ]);
            expect(f.embeddings.current(source, oldModel, generation(f))).toBe(false);
            expect(await generateEmbeddings(f.db, options)).toMatchObject({ generated: 0, current: 1 });
            expect(provider.embed).toHaveBeenCalledOnce();
            expect((await semanticRecall(f.db, [f.project.id], 'memory', options)).candidates).toEqual([
                { sessionId: f.session.id, similarity: 1 },
            ]);
        },
    );

    it('embeds only sanitized durable metadata, reuses current vectors, and supports rebuilding', async () => {
        const f = fixture();
        seedMemory(f, {
            project: f.project,
            session: f.session,
            userMessage: 'permitted first prompt',
            assistantText: 'RAW ASSISTANT MUST NOT BE EMBEDDED',
        });
        seedRollup(f, {
            project: f.project,
            session: f.session,
            decisions: [{ what: 'Use SQLite', why: 'Local encryption' }],
            instructions: [{ what: 'Always run the full gates', why: 'Protect the release contract' }],
        });
        f.db
            .prepare('UPDATE session_rollups SET summary = ?, pending_items = ? WHERE session_id = ?')
            .run('safe `title`', '["next task"]', f.session.id);
        setSetting('memory-plus', 'true', f.configPath);
        const provider = fakeProvider();
        const options = { configPath: f.configPath, createProvider: async () => provider };
        expect(await generateEmbeddings(f.db, options)).toEqual({
            generated: 1,
            current: 0,
            ineligibleOrEmpty: 0,
            sourceChanged: 0,
            failed: 0,
        });
        const input = vi.mocked(provider.embed).mock.calls[0][0];
        expect(input).toContain('permitted first prompt');
        expect(input).toContain('Local encryption');
        expect(input).toContain('Always run the full gates');
        expect(input).toContain('Protect the release contract');
        expect(input).toContain('next task');
        expect(input).not.toContain('RAW ASSISTANT');
        expect(detectShellSyntax(input)).toBe(false);
        const row = f.db.prepare('SELECT * FROM session_embeddings').get() as {
            source_hash: string;
            vector: Buffer;
            model_revision: string;
        };
        expect(row.source_hash).toBe(embeddingSourceHash(input));
        expect(row.vector.length).toBe(384 * 4);
        expect(row.model_revision).toContain(provider.configuration.revision);
        expect(await generateEmbeddings(f.db, options)).toEqual({
            generated: 0,
            current: 1,
            ineligibleOrEmpty: 0,
            sourceChanged: 0,
            failed: 0,
        });
        expect(provider.embed).toHaveBeenCalledTimes(1);
        expect((await generateEmbeddings(f.db, { ...options, rebuild: true })).generated).toBe(1);
        f.db.exec('DELETE FROM session_embeddings');
        expect((await generateEmbeddings(f.db, options)).generated).toBe(1);
        expect(f.store.findSession('codex', f.session.native_id)).toBeDefined();
        expect(f.db.prepare('SELECT COUNT(*) AS count FROM session_rollups').get()).toEqual({ count: 1 });
    });

    it.each(['title', 'rollup'] as const)('reports a changing %s and drains older sessions across passes', async (field) => {
        const f = fixture();
        const newer = seedSession(f, { project: f.project, nativeId: 'active', title: 'Active session' });
        seedRollup(f, { project: f.project, session: newer });
        setSetting('memory-plus', 'true', f.configPath);
        const provider = fakeProvider();
        const report = vi.fn();
        const progress = vi.fn();
        let changes = 0;
        vi.mocked(provider.embed).mockImplementation(async (text, beforeUse) => {
            if (text.includes('Active session')) {
                const query =
                    field === 'title'
                        ? 'UPDATE sessions SET title = ? WHERE id = ?'
                        : 'UPDATE session_rollups SET summary = ? WHERE session_id = ?';
                f.db.prepare(query).run(`Active session ${++changes}`, newer.id);
                beforeUse();
            }
            return Array(384).fill(0.25);
        });
        const options = { configPath: f.configPath, createProvider: async () => provider, report, progress };
        expect(await generateEmbeddings(f.db, options)).toMatchObject({ generated: 1, sourceChanged: 1, failed: 0 });
        expect(f.embeddings.current(f.embeddings.source(f.session.id)!, provider.configuration, generation(f))).toBe(true);
        expect(await generateEmbeddings(f.db, options)).toMatchObject({ generated: 0, current: 1, sourceChanged: 1, failed: 0 });
        expect(report).toHaveBeenCalledTimes(2);
        expect(report.mock.calls.every(([message]) => message.includes(`Session ${newer.id}`) && message.includes('retry next pass'))).toBe(
            true,
        );
        expect(progress).toHaveBeenCalledTimes(4);
        vi.mocked(provider.embed).mockResolvedValue(Array(384).fill(0.25));
        expect(await generateEmbeddings(f.db, options)).toMatchObject({ generated: 1, current: 1, sourceChanged: 0, failed: 0 });
    });

    it('reports repeated malformed sources without inference and resumes automatically after repair', async () => {
        const f = fixture();
        const newer = seedSession(f, { project: f.project, nativeId: 'malformed', title: 'Malformed session' });
        seedRollup(f, { project: f.project, session: newer });
        f.db.prepare('UPDATE session_rollups SET decisions = ? WHERE session_id = ?').run('{broken private data', newer.id);
        setSetting('memory-plus', 'true', f.configPath);
        const provider = fakeProvider();
        const createProvider = vi.fn(async () => provider);
        const report = vi.fn();
        const options = { configPath: f.configPath, createProvider, report };
        expect(await generateEmbeddings(f.db, options)).toMatchObject({ generated: 1, failed: 1, sourceChanged: 0 });
        expect(await generateEmbeddings(f.db, options)).toMatchObject({ generated: 0, current: 1, failed: 1 });
        expect(provider.embed).toHaveBeenCalledOnce();
        expect(report).toHaveBeenCalledTimes(2);
        expect(report.mock.calls.every(([message]) => message.includes(`Session ${newer.id}`) && message.includes('decisions'))).toBe(true);
        expect(report.mock.calls.flat().join(' ')).not.toContain('private data');
        f.db.prepare('UPDATE session_rollups SET decisions = ? WHERE session_id = ?').run('[]', newer.id);
        expect(await generateEmbeddings(f.db, options)).toMatchObject({ generated: 1, current: 1, failed: 0 });
        expect(provider.embed).toHaveBeenCalledTimes(2);
        seedRollup(f, { project: f.project, session: f.session });
        f.db.prepare('UPDATE session_rollups SET decisions = ?').run('null');
        createProvider.mockClear();
        for (let pass = 0; pass < 2; pass++) {
            expect(await generateEmbeddings(f.db, options)).toMatchObject({ generated: 0, failed: 2 });
        }
        expect(createProvider).not.toHaveBeenCalled();
        expect(provider.embed).toHaveBeenCalledTimes(2);
    });

    it('reports every empty or ineligible session and advances progress without creating a provider', async () => {
        const f = fixture();
        f.db.prepare('UPDATE sessions SET title = NULL WHERE id = ?').run(f.session.id);
        const other = seedProject(f, { path: path.join(f.directory, 'unconsented') });
        const ineligible = seedSession(f, { project: other, nativeId: 'unconsented', title: 'Unconsented' });
        setSetting('memory-plus', 'true', f.configPath);
        const createProvider = vi.fn();
        const report = vi.fn();
        const progress = vi.fn();
        expect(await generateEmbeddings(f.db, { configPath: f.configPath, createProvider, report, progress })).toMatchObject({
            generated: 0,
            ineligibleOrEmpty: 2,
            failed: 0,
            sourceChanged: 0,
        });
        expect(createProvider).not.toHaveBeenCalled();
        expect(report.mock.calls.map(([message]) => message)).toEqual([
            expect.stringContaining(`Session ${ineligible.id}`),
            expect.stringContaining(`Session ${f.session.id}`),
        ]);
        expect(progress).toHaveBeenCalledTimes(2);
    });

    it.each(['title', 'first_prompt_search'])('rejects stale %s source hashes and model revisions', (column) => {
        const f = fixture();
        const source = saveVector(f);
        const model = fakeProvider().configuration;
        expect(f.embeddings.current(source, model, generation(f))).toBe(true);
        expect(f.embeddings.current(source, { ...model, revision: 'new' }, generation(f))).toBe(false);
        f.db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run('Changed content', f.session.id);
        const changed = f.embeddings.source(f.session.id)!;
        expect(changed.hash).not.toBe(source.hash);
        expect(f.embeddings.current(changed, model, generation(f))).toBe(false);
        expect(() => f.embeddings.write(source, model, Array(384).fill(0.2), generation(f))).toThrow('source or authorization changed');
    });

    it('invalidates changed rollup instructions and cascades rollup deletion without removing the session', () => {
        const f = fixture();
        seedRollup(f, { project: f.project, session: f.session, instructions: [{ what: 'Run focused tests' }] });
        const source = saveVector(f);
        f.db
            .prepare('UPDATE session_rollups SET instructions = ? WHERE session_id = ?')
            .run('[{"what":"Run the full suite"}]', f.session.id);
        const changed = f.embeddings.source(f.session.id)!;
        expect(changed.hash).not.toBe(source.hash);
        expect(f.embeddings.current(changed, fakeProvider().configuration, generation(f))).toBe(false);
        f.db.prepare('DELETE FROM session_rollups WHERE session_id = ?').run(f.session.id);
        expect(f.db.prepare('SELECT * FROM session_embeddings').all()).toEqual([]);
        expect(f.store.findSession('codex', f.session.native_id)).toBeDefined();
    });

    it.each(['revoke', 'remove', 'incognito', 'session-delete', 'project-delete'] as const)('removes vectors on %s', (action) => {
        const f = fixture();
        saveVector(f);
        if (action === 'revoke') f.store.consent.revoke(f.project.path);
        else if (action === 'remove') f.store.consent.remove(f.store.consent.list()[0].ulid);
        else if (action === 'incognito') f.store.recordIncognitoTranscript(f.session.tool, f.session.native_id);
        else {
            f.db.prepare('DELETE FROM sessions WHERE id = ?').run(f.session.id);
            if (action === 'project-delete') f.db.prepare('DELETE FROM projects WHERE id = ?').run(f.project.id);
        }
        expect(f.db.prepare('SELECT * FROM session_embeddings').all()).toEqual([]);
        if (action === 'revoke' || action === 'remove') expect(f.store.findSession('codex', f.session.native_id)).toBeDefined();
    });

    it.each(['revoke', 'delete', 'incognito', 'change', 'disable', 'lock', 'lock-unlock'] as const)(
        'does not persist work after %s during awaited inference',
        async (action) => {
            const f = fixture();
            setSetting('memory-plus', 'true', f.configPath);
            registerParanoidDatabase(f.db, f.dbPath, randomBytes(32));
            enableParanoidMode(f.db, 'passphrase');
            unlockMemory(f.db, 'passphrase');
            if (['revoke', 'disable', 'lock', 'lock-unlock'].includes(action)) {
                seedSession(f, { project: f.project, nativeId: 'newest-security', title: 'Newest security source' });
            }
            const provider = fakeProvider();
            vi.mocked(provider.embed).mockImplementation(async () => {
                if (action === 'revoke') f.store.consent.revoke(f.project.path);
                if (action === 'incognito') f.store.recordIncognitoTranscript(f.session.tool, f.session.native_id);
                if (action === 'delete') f.db.prepare('DELETE FROM sessions WHERE id = ?').run(f.session.id);
                if (action === 'change') f.db.prepare('UPDATE sessions SET title = ?').run('Changed');
                if (action === 'disable') setSetting('memory-plus', 'false', f.configPath);
                if (action === 'lock' || action === 'lock-unlock') lockMemory(f.db);
                if (action === 'lock-unlock') unlockMemory(f.db, 'passphrase');
                return Array(384).fill(0.25);
            });
            const generating = generateEmbeddings(f.db, { configPath: f.configPath, createProvider: async () => provider });
            if (action === 'change') {
                await expect(generating).resolves.toMatchObject({ generated: 0, sourceChanged: 1 });
            } else {
                await expect(generating).rejects.toThrow();
            }
            expect(f.db.prepare('SELECT * FROM session_embeddings').all()).toEqual([]);
            expect(provider.embed).toHaveBeenCalledOnce();
            expect(provider.dispose).toHaveBeenCalled();
        },
    );

    it.each([
        {
            table: 'consent_roots',
            selected: EMBEDDING_CONSENT_COLUMNS,
            authorization: ['id', 'ulid', 'path', 'state', 'decided_at', 'source'],
            excluded: ['nudged_at'],
        },
        {
            table: 'projects',
            selected: EMBEDDING_PROJECT_AUTHORIZATION_COLUMNS,
            authorization: ['id', 'path', 'git_root', 'git_remote', 'git_root_commit'],
            excluded: ['display_name', 'first_seen_at', 'last_seen_at'],
        },
    ])('pins the authorization projection and classifies every $table column', ({ table, selected, authorization, excluded }) => {
        const f = fixture();
        expect(selected).toEqual(authorization);
        const columns = (f.db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(({ name }) => name);
        expect(columns.sort(), 'Schema changes require an explicit embedding authorization classification').toEqual(
            [...selected, ...excluded].sort(),
        );
    });

    it('uses only consent decision columns for the generation snapshot', () => {
        const f = fixture();
        saveVector(f);
        const token = generation(f);
        const before = f.embeddings.generationConsent(token);
        expect(Object.keys(JSON.parse(before)[0])).toEqual(EMBEDDING_CONSENT_COLUMNS);
        f.db.prepare('UPDATE consent_roots SET nudged_at = ?').run('2099-01-01T00:00:00.000Z');
        f.db.prepare('UPDATE projects SET last_seen_at = ?').run('2099-01-01T00:00:00.000Z');
        expect(f.embeddings.generationConsent(token)).toBe(before);
        f.store.consent.revoke(f.project.path);
        expect(f.embeddings.generationConsent(token)).not.toBe(before);
    });

    describe.each(['scan', 'source'] as const)('%s authorization checkpoints', (operation) => {
        it.each([
            ['projects', 'display_name'],
            ['projects', 'first_seen_at'],
            ['consent_roots', 'nudged_at'],
        ])('ignores %s.%s metadata changes', (table, column) => {
            const f = fixture();
            const source = saveVector(f);
            const vectors = scan(f.embeddings, [f.project.id]);
            const stored = f.db.prepare('SELECT * FROM session_embeddings').all();
            const original = ProjectResolver.prototype.listConsentedStored;
            const checkpoint = vi.spyOn(ProjectResolver.prototype, 'listConsentedStored').mockImplementationOnce(function (
                this: ProjectResolver,
                consent,
            ) {
                const projects = original.call(this, consent);
                f.db.prepare(`UPDATE ${table} SET ${column} = ?`).run('2099-01-01T00:00:00.000Z');
                return projects;
            });
            expect(operation === 'scan' ? scan(f.embeddings, [f.project.id]) : f.embeddings.source(f.session.id)).toEqual(
                operation === 'scan' ? vectors : source,
            );
            expect(checkpoint).toHaveBeenCalledOnce();
            expect(f.db.prepare('SELECT * FROM session_embeddings').all()).toEqual(stored);
        });

        it.each(['git_root', 'git_remote', 'git_root_commit'])('rejects eligibility loss through %s grouping', (column) => {
            const f = fixture();
            const denied = seedProject(f, { path: path.join(f.directory, 'denied') });
            seedConsentRoot(f, { path: denied.path, state: 'denied' });
            f.db.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(denied.path, denied.id);
            saveVector(f);
            const original = ProjectResolver.prototype.listConsentedStored;
            vi.spyOn(ProjectResolver.prototype, 'listConsentedStored').mockImplementationOnce(function (this: ProjectResolver, consent) {
                const projects = original.call(this, consent);
                f.db.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(denied.path, f.project.id);
                expect(original.call(new ProjectResolver(f.db), consent).flatMap((project) => project.projectIds)).not.toContain(
                    f.project.id,
                );
                return projects;
            });
            expect(() => (operation === 'scan' ? scan(f.embeddings, [f.project.id]) : f.embeddings.source(f.session.id))).toThrow(
                EMBEDDING_SOURCE_CHANGED,
            );
        });

        it.each(['target', 'unrelated'] as const)('ignores a last_seen_at-only update to the %s project', (target) => {
            const f = fixture();
            const other = seedProject(f, { path: path.join(f.directory, 'other') });
            const source = saveVector(f);
            const vectors = scan(f.embeddings, [f.project.id]);
            const stored = f.db.prepare('SELECT * FROM session_embeddings').all();
            const projectId = target === 'target' ? f.project.id : other.id;
            const before = f.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
            const original = ProjectResolver.prototype.listConsentedStored;
            const checkpoint = vi.spyOn(ProjectResolver.prototype, 'listConsentedStored').mockImplementationOnce(function (
                this: ProjectResolver,
                consent,
            ) {
                const projects = original.call(this, consent);
                f.db.prepare('UPDATE projects SET last_seen_at = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', projectId);
                return projects;
            });

            expect(operation === 'scan' ? scan(f.embeddings, [f.project.id]) : f.embeddings.source(f.session.id)).toEqual(
                operation === 'scan' ? vectors : source,
            );
            expect(checkpoint).toHaveBeenCalledOnce();
            expect(f.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)).toEqual({
                ...(before as object),
                last_seen_at: '2099-01-01T00:00:00.000Z',
            });
            expect(f.embeddings.source(f.session.id)).toEqual(source);
            expect(f.db.prepare('SELECT * FROM session_embeddings').all()).toEqual(stored);
            expect(scan(f.embeddings, [f.project.id])).toEqual(vectors);
        });

        it.each(['revoke', 'add-root', 'remove-root', 'path-change', 'unconsented'] as const)(
            'rejects %s between authorization checks',
            (action) => {
                const f = fixture();
                saveVector(f);
                const original = ProjectResolver.prototype.listConsentedStored;
                const checkpoint = vi.spyOn(ProjectResolver.prototype, 'listConsentedStored').mockImplementationOnce(function (
                    this: ProjectResolver,
                    consent,
                ) {
                    const projects = original.call(this, consent);
                    if (action === 'revoke') f.store.consent.revoke(f.project.path);
                    if (action === 'add-root') seedConsentRoot(f, { path: path.join(f.directory, 'other') });
                    if (action === 'remove-root') f.store.consent.remove(f.store.consent.list()[0].ulid);
                    if (action === 'path-change' || action === 'unconsented') {
                        const changedPath =
                            action === 'path-change' ? path.join(f.project.path, 'child') : path.join(f.directory, 'unconsented');
                        f.db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(changedPath, f.project.id);
                        expect(f.store.consent.isConsented(changedPath)).toBe(action === 'path-change');
                    }
                    return projects;
                });

                expect(() => (operation === 'scan' ? scan(f.embeddings, [f.project.id]) : f.embeddings.source(f.session.id))).toThrow(
                    EMBEDDING_SOURCE_CHANGED,
                );
                expect(checkpoint).toHaveBeenCalled();
            },
        );
    });

    it('rejects consent changes while resolving eligible project IDs', () => {
        const f = fixture();
        const source = saveVector(f);
        const original = ProjectResolver.prototype.listConsentedStored;
        let changed = false;
        vi.spyOn(ProjectResolver.prototype, 'listConsentedStored').mockImplementation(function (this: ProjectResolver, consent) {
            const projects = original.call(this, consent);
            if (!changed) {
                changed = true;
                f.store.consent.revoke(f.project.path);
            }
            return projects;
        });
        expect(() => f.embeddings.source(f.session.id)).toThrow('source or authorization changed');
        expect(() => f.embeddings.write(source, fakeProvider().configuration, Array(384).fill(0.25), generation(f))).toThrow();
        expect(f.db.prepare('SELECT * FROM session_embeddings').all()).toEqual([]);
    });

    it('rejects revocation between the pre-write check and writer acquisition', () => {
        const f = fixture();
        const source = saveVector(f);
        const original = ProjectResolver.prototype.listConsentedStored;
        let reads = 0;
        vi.spyOn(ProjectResolver.prototype, 'listConsentedStored').mockImplementation(function (this: ProjectResolver, consent) {
            const projects = original.call(this, consent);
            if (++reads === 2) f.store.consent.revoke(f.project.path);
            return projects;
        });
        expect(() => f.embeddings.write(source, fakeProvider().configuration, Array(384).fill(0.25), generation(f))).toThrow(
            'source or authorization changed',
        );
        expect(f.db.prepare('SELECT * FROM session_embeddings').all()).toEqual([]);
    });

    it('refuses a locked job before creating a provider', async () => {
        const f = fixture();
        setSetting('memory-plus', 'true', f.configPath);
        registerParanoidDatabase(f.db, f.dbPath, randomBytes(32));
        enableParanoidMode(f.db, 'passphrase');
        const createProvider = vi.fn();
        await expect(generateEmbeddings(f.db, { configPath: f.configPath, createProvider })).rejects.toThrow('memory is locked');
        expect(createProvider).not.toHaveBeenCalled();
    });
});
