import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkerOptions } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disableMemoryPlus } from '../../src/cli/commands/disable.js';
import { EMBEDDING_REFRESH_INTERVAL_MS } from '../../src/config/constants.js';
import { setSetting } from '../../src/config/settings.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { memoryPlusPackagePath } from '../../src/embeddings/dependency.js';
import { generateEmbeddings } from '../../src/embeddings/generate.js';
import * as providerConfig from '../../src/embeddings/provider-config.js';
import { embeddingConfiguration } from '../../src/embeddings/provider-config.js';
import * as refresh from '../../src/embeddings/refresh.js';
import { EmbeddingStore, lockedEmbedding } from '../../src/storage/embedding-store.js';
import { withMemoryReadGeneration } from '../../src/storage/paranoid-gate.js';
import { createTestDb, seedConsentRoot, seedProject, seedRollup, seedSession } from '../helpers/db.js';

const thread = vi.hoisted(() => ({
    created: vi.fn(),
    entered: () => {},
    gate: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
}));

// Exercise the built, shipped worker with the real provider and generator. Only
// the optional model runtime is synthetic. Keep lifecycle files in the fixture.
vi.mock('node:worker_threads', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:worker_threads')>();
    return {
        ...actual,
        Worker: class extends actual.Worker {
            constructor(url: URL, options: WorkerOptions) {
                thread.created(url);
                const symbol = 'dev.elepha.internal.database-lifecycle-test-directory';
                const directory = (globalThis as Record<symbol, unknown>)[Symbol.for(symbol)];
                const preload = `globalThis[Symbol.for(${JSON.stringify(symbol)})] = ${JSON.stringify(directory)};`;
                super(new URL('../../dist/embeddings/refresh-worker.js', import.meta.url), {
                    ...options,
                    execArgv: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`],
                    workerData: { ...options.workerData, testGate: thread.gate },
                });
                this.on('message', (message) => {
                    if (message === 'embedding-entered') thread.entered();
                });
            }
        },
    };
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    thread.created.mockClear();
});

function fixture() {
    const f = createTestDb('automatic-embeddings-');
    vi.stubEnv('ELEPHA_HOME', f.directory);
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(f.directory, '.claude'));
    const project = seedProject(f);
    seedConsentRoot(f, { path: project.path });
    const session = seedSession(f, { project, title: 'Existing semantic history' });
    const model = embeddingConfiguration(true)!;
    const embeddings = new EmbeddingStore(f.db);
    const watchRoot = path.join(f.directory, '.claude', 'projects');
    mkdirSync(watchRoot, { recursive: true });
    const errors: string[] = [];
    const logs: string[] = [];
    const daemon = new IngestionDaemon({
        store: f.store,
        watchRoots: [watchRoot],
        heartbeatPath: path.join(f.directory, 'heartbeat.json'),
        daemonLogPaths: { stdout: path.join(f.directory, 'stdout.log'), stderr: path.join(f.directory, 'stderr.log') },
        updateCheck: () => {},
        watcherUsePolling: true,
        idleDebounceMs: 1,
        maxConcurrentSummaries: 1,
        log: (message) => logs.push(message),
        logError: (message) => errors.push(message),
    });
    const current = (id = session.id) =>
        withMemoryReadGeneration(f.db, lockedEmbedding, (generation) => embeddings.current(embeddings.source(id)!, model, generation));
    thread.gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const gate = new Int32Array(thread.gate);
    const entered = new Promise<void>((resolve) => {
        thread.entered = resolve;
    });
    const release = () => {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
    };
    const runtimeRoot = memoryPlusPackagePath();
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(path.join(runtimeRoot, 'package.json'), JSON.stringify({ main: './runtime.cjs' }));
    writeFileSync(
        path.join(runtimeRoot, 'runtime.cjs'),
        `
        const { parentPort, workerData } = require('node:worker_threads');
        module.exports = { env: {}, pipeline: async () => Object.assign(async () => {
            parentPort.postMessage('embedding-entered');
            const gate = new Int32Array(workerData.testGate);
            Atomics.wait(gate, 0, 0);
            return { data: Array(384).fill(0.25) };
        }, { tokenizer: { encode: () => [1] }, dispose: async () => {} }) };
    `,
    );
    return { ...f, project, session, watchRoot, daemon, errors, logs, current, entered, release };
}

describe('automatic daemon embedding refresh', () => {
    it('observes disable during an active worker, retains completed vectors and starts no subsequent passes', async () => {
        const f = fixture();
        setSetting('memory-plus', 'true');
        //noinspection JSUnusedGlobalSymbols (embed & dispose)
        const provider = {
            configuration: embeddingConfiguration(true)!,
            embed: async () => Array(384).fill(0.25),
            dispose: async () => {},
        };
        await generateEmbeddings(f.db, { createProvider: async () => provider });
        const vectors = f.db.prepare('SELECT * FROM session_embeddings').all();
        const pending = seedSession(f, { project: f.project, nativeId: 'pending', title: 'Not indexed yet' });
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        f.daemon.start();
        try {
            await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS);
            await f.entered;
            disableMemoryPlus({ log: () => {} });
            f.release();
            // The in-flight native call can finish, but the generator's use-time
            // setting check prevents its write and stops the rest of the pass.
            await vi.waitFor(() => expect(f.errors).toHaveLength(1));
            expect(f.errors[0]).toContain('Memory-Plus is off');
            expect(f.db.prepare('SELECT * FROM session_embeddings').all()).toEqual(vectors);
            expect(f.db.prepare('SELECT session_id FROM session_embeddings WHERE session_id = ?').get(pending.id)).toBeUndefined();
            await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS * 2);
            expect(thread.created).toHaveBeenCalledOnce();
            expect(f.errors).toHaveLength(1);
            expect(f.db.prepare('SELECT * FROM session_embeddings').all()).toEqual(vectors);
        } finally {
            f.release();
            await f.daemon.stop();
        }
    });

    it('does no provider creation while disabled, rechecks each tick, and cancels its timer on stop', async () => {
        const f = fixture();
        const createProvider = vi.spyOn(providerConfig, 'createEmbeddingProvider').mockResolvedValue({
            configuration: embeddingConfiguration(true)!,
            embed: async () => Array(384).fill(0.25),
            dispose: async () => {},
        });
        // Keep generation real while replacing the thread boundary so this test
        // can spy on provider creation; the concurrency test uses a real thread.
        const start = vi.spyOn(refresh, 'startEmbeddingRefresh').mockImplementation(() => ({
            done: generateEmbeddings(f.db),
            stop: () => {},
        }));
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        f.daemon.start();
        try {
            await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS * 2);
            expect(createProvider).not.toHaveBeenCalled();
            expect(start).not.toHaveBeenCalled();
            expect(thread.created).not.toHaveBeenCalled();
            setSetting('memory-plus', 'true');
            await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS);
            expect(createProvider).toHaveBeenCalledOnce();
            setSetting('memory-plus', 'false');
            await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS);
            expect(createProvider).toHaveBeenCalledOnce();
            await f.daemon.stop();
            setSetting('memory-plus', 'true');
            await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS);
            expect(createProvider).toHaveBeenCalledOnce();
        } finally {
            await f.daemon.stop();
        }
    });

    it('captures a watched turn while a synchronous model call is blocked in the periodic worker, without overlapping passes', async () => {
        const f = fixture();
        setSetting('memory-plus', 'true');
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        f.daemon.start();
        try {
            await vi.waitFor(() => expect(f.logs.some((line) => line.startsWith('[elepha] startup sweep:'))).toBe(true));
            await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS);
            await f.entered;
            expect(f.current()).toBe(false);
            await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS * 2);
            expect(thread.created).toHaveBeenCalledOnce();

            const file = path.join(f.watchRoot, 'project', 'live-session.jsonl');
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(
                file,
                `${[
                    {
                        type: 'user',
                        uuid: 'u1',
                        parentUuid: null,
                        isSidechain: false,
                        cwd: f.project.path,
                        sessionId: 'live-session',
                        timestamp: '2026-09-14T00:00:00Z',
                        message: { role: 'user', content: 'Capture while embedding is blocked' },
                    },
                    {
                        type: 'assistant',
                        uuid: 'a1',
                        parentUuid: 'u1',
                        cwd: f.project.path,
                        sessionId: 'live-session',
                        timestamp: '2026-09-14T00:00:01Z',
                        message: { role: 'assistant', content: [{ type: 'text', text: 'Captured response' }] },
                    },
                ]
                    .map((row) => JSON.stringify(row))
                    .join('\n')}\n`,
            );
            await vi.waitFor(() => expect(f.logs.some((line) => line.includes('captured turn'))).toBe(true));
            const captured = f.store.findSession('claude-code', 'live-session');
            expect(captured).toBeDefined();
            expect(f.db.prepare('SELECT turn_index FROM memories WHERE session_id = ?').all(captured!.id)).toEqual([{ turn_index: 0 }]);
            expect(f.current()).toBe(false);
            expect(Atomics.load(new Int32Array(thread.gate), 0)).toBe(0);

            f.release();
            await vi.waitFor(() => expect(f.logs.some((line) => line.startsWith('[elepha] automatic indexing:'))).toBe(true));
            expect(f.current()).toBe(true);
            // The next pass handles sessions captured after the previous pass began
            // and metadata made stale since then, using the real source-hash logic.
            f.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Updated history', f.session.id);
            expect(f.current()).toBe(false);
            await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS);
            await vi.waitFor(() => expect(f.logs.filter((line) => line.startsWith('[elepha] automatic indexing:'))).toHaveLength(2));
            expect(f.current()).toBe(true);
            expect(f.current(captured!.id)).toBe(true);
            expect(f.errors).toEqual([]);
        } finally {
            f.release();
            await f.daemon.stop();
        }
    }, 15000);

    it('streams malformed-session diagnostics and partial counts from successive workers while draining older history', async () => {
        const f = fixture();
        const malformed = seedSession(f, { project: f.project, nativeId: 'malformed', title: 'Malformed source' });
        seedRollup(f, { project: f.project, session: malformed });
        f.db.prepare('UPDATE session_rollups SET decisions = ? WHERE session_id = ?').run('{broken', malformed.id);
        setSetting('memory-plus', 'true');
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        f.release();
        f.daemon.start();
        try {
            for (let pass = 1; pass <= 2; pass++) {
                await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS);
                await vi.waitFor(() => expect(f.logs.filter((line) => line.startsWith('[elepha] automatic indexing:'))).toHaveLength(pass));
                expect(f.current()).toBe(true);
                expect(f.errors).toHaveLength(pass);
                expect(f.errors[pass - 1]).toContain(`Session ${malformed.id}`);
                expect(f.errors[pass - 1]).toContain('decisions');
                expect(f.logs.filter((line) => line.startsWith('[elepha] automatic indexing:'))[pass - 1]).toContain('1 malformed');
            }
            expect(thread.created).toHaveBeenCalledTimes(2);
        } finally {
            await f.daemon.stop();
        }
    });

    it('reports failures, retries on the next interval, and closes the worker cooperatively on shutdown', async () => {
        const f = fixture();
        setSetting('memory-plus', 'true');
        const runtime = path.join(memoryPlusPackagePath(), 'runtime.cjs');
        writeFileSync(runtime, 'throw new Error("test model unavailable");');
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        f.daemon.start();
        try {
            await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS);
            await vi.waitFor(() => expect(f.errors).toHaveLength(1));
            expect(f.errors[0]).toContain('will retry next pass');
            writeFileSync(
                runtime,
                `const { parentPort, workerData } = require('node:worker_threads');
                module.exports = { env: {}, pipeline: async () => Object.assign(async () => {
                    parentPort.postMessage('embedding-entered');
                    Atomics.wait(new Int32Array(workerData.testGate), 0, 0);
                    return { data: Array(384).fill(0.25) };
                }, { tokenizer: { encode: () => [1] }, dispose: async () => {} }) };`,
            );
            await vi.advanceTimersByTimeAsync(EMBEDDING_REFRESH_INTERVAL_MS);
            await f.entered;
            expect(thread.created).toHaveBeenCalledTimes(2);
            const stopping = f.daemon.stop();
            f.release();
            await stopping;
            expect(f.current()).toBe(false);
            expect(f.errors).toHaveLength(1);
        } finally {
            f.release();
            await f.daemon.stop();
        }
    }, 15000);
});
