import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { RollupService } from '../../src/daemon/rollup-service.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { RollupStore } from '../../src/storage/rollup-store.js';
import { createTestDb, seedMemory, seedProject, seedSession } from '../helpers/db.js';
import { withTempDir } from '../helpers/tmp.js';

describe('Codex guardian ingestion exclusion', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('rechecks a sweep candidate after the stat await before classifying its transcript', async () => {
        const f = createTestDb('elepha-guardian-sweep-race-');
        const codexHome = path.join(f.directory, '.codex');
        vi.stubEnv('CODEX_HOME', codexHome);
        const source = path.join(codexHome, 'sessions', 'guardian.jsonl');
        mkdirSync(path.dirname(source), { recursive: true });
        writeFileSync(source, '{}\n');
        const project = seedProject(f);
        const session = seedSession(f, { project, sourcePath: source });
        seedMemory(f, { project, session });
        const list = f.store.listOpenSessions.bind(f.store);
        vi.spyOn(f.store, 'listOpenSessions').mockImplementation(() => {
            const candidates = list();
            expect(candidates).toHaveLength(1);
            queueMicrotask(() => f.db.prepare("UPDATE sessions SET kind = 'adjudicator' WHERE id = ?").run(session.id));
            return candidates;
        });
        const adapter = new CodexAdapter();
        const classify = vi.spyOn(adapter, 'classifySession');
        const parse = vi.spyOn(adapter, 'parseTurns');
        const rollup = vi.fn();
        const merge = vi.fn();
        const daemon = new IngestionDaemon({
            store: f.store,
            adapters: [adapter],
            watchRoots: [],
            rollupService: new RollupService({
                store: f.store,
                rollups: new RollupStore(f.db),
                provider: { rollup, merge },
                idleCloseMs: 0,
            }),
        });
        expect(await daemon.sweepIdleSessions(Date.now() + 1_000)).toBe(0);
        expect(classify).not.toHaveBeenCalled();
        expect(parse).not.toHaveBeenCalled();
        expect(rollup).not.toHaveBeenCalled();
        expect(f.db.prepare('SELECT * FROM session_rollups').all()).toEqual([]);
    });

    it('startup leaves an incomplete reclassified guardian untouched with all background derivations enabled', async () => {
        const f = createTestDb('elepha-guardian-background-');
        const codexHome = path.join(f.directory, '.codex');
        vi.stubEnv('CODEX_HOME', codexHome);
        const providerRoot = path.join(codexHome, 'sessions');
        mkdirSync(providerRoot, { recursive: true });
        const sourcePath = path.join(providerRoot, 'guardian.jsonl');
        writeFileSync(sourcePath, '{}\n');
        const project = seedProject(f);
        f.store.consent.grant(project.path);
        const session = seedSession(f, { project, nativeId: 'historical-guardian', sourcePath });
        seedMemory(f, { project, session });
        f.db.prepare("UPDATE sessions SET kind = 'adjudicator', first_prompt_search = NULL WHERE id = ?").run(session.id);
        const snapshot = () =>
            Object.fromEntries(
                [
                    'sessions',
                    'memories',
                    'filtered_turns',
                    'durable_capture_status',
                    'session_rollups',
                    'first_prompt_search_backfill_skips',
                ].map((table) => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]),
            );
        const before = snapshot();
        const adapter = new CodexAdapter();
        const parse = vi.spyOn(adapter, 'parseTurns');
        const rollup = vi.fn();
        const merge = vi.fn();
        const rollups = new RollupStore(f.db);
        const daemon = new IngestionDaemon({
            store: f.store,
            adapters: [adapter],
            watchRoots: [],
            heartbeatPath: path.join(f.directory, 'heartbeat.json'),
            updateCheck: () => undefined,
            readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } }),
            rollupService: new RollupService({ store: f.store, rollups, provider: { rollup, merge }, idleCloseMs: 0 }),
        });
        const background = daemon as unknown as {
            backfillDurableCapture(): Promise<void>;
            backfillFirstPromptSearch(): Promise<void>;
            sweepIdleSessions(): Promise<number>;
        };
        const checkpoint = () => {
            let resolve!: () => void;
            const promise = new Promise<void>((done) => {
                resolve = done;
            });
            return { promise, resolve };
        };
        const durableDone = checkpoint();
        const promptDone = checkpoint();
        const sweepDone = checkpoint();
        const durable = background.backfillDurableCapture.bind(daemon);
        const prompt = background.backfillFirstPromptSearch.bind(daemon);
        const sweep = background.sweepIdleSessions.bind(daemon);
        vi.spyOn(background, 'backfillDurableCapture').mockImplementation(async () => {
            try {
                await durable();
            } finally {
                durableDone.resolve();
            }
        });
        vi.spyOn(background, 'backfillFirstPromptSearch').mockImplementation(async () => {
            try {
                await prompt();
            } finally {
                promptDone.resolve();
            }
        });
        vi.spyOn(background, 'sweepIdleSessions').mockImplementation(async () => {
            try {
                return await sweep();
            } finally {
                sweepDone.resolve();
            }
        });
        daemon.start();
        try {
            await Promise.all([durableDone.promise, promptDone.promise, sweepDone.promise]);
            expect(parse).not.toHaveBeenCalled();
            expect(rollup).not.toHaveBeenCalled();
            expect(merge).not.toHaveBeenCalled();
            expect(snapshot()).toEqual(before);
        } finally {
            await daemon.stop();
        }
    });

    it('creates no guardian data while ingesting a genuine child with the same content', async () => {
        const root = withTempDir('elepha-guardian-exclusion-');
        const codexHome = path.join(root, '.codex');
        vi.stubEnv('CODEX_HOME', codexHome);
        const watchRoot = path.join(codexHome, 'sessions');
        mkdirSync(watchRoot, { recursive: true });
        const project = '/Users/test/guardian-exclusion';
        const guardianId = '11111111-1111-4111-8111-111111111111';
        const childId = '22222222-2222-4222-8222-222222222222';
        const makeFile = (id: string, metadata: Record<string, unknown>): string => {
            const file = path.join(watchRoot, `rollout-2026-09-15T00-00-00-${id}.jsonl`);
            const lines = [
                {
                    type: 'session_meta',
                    timestamp: '2026-09-15T00:00:00.000Z',
                    payload: { id, cwd: project, parent_thread_id: 'parent', ...metadata },
                },
                {
                    type: 'response_item',
                    timestamp: '2026-09-15T00:00:01.000Z',
                    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the local change.' }] },
                },
                {
                    type: 'response_item',
                    timestamp: '2026-09-15T00:00:02.000Z',
                    payload: {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'The local change is correct.' }],
                    },
                },
            ];
            writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
            return file;
        };
        const guardianFile = makeFile(guardianId, {
            thread_source: 'guardian_review',
            source: { subagent: { other: 'guardian' } },
        });
        const childFile = makeFile(childId, {
            thread_source: 'subagent',
            source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
            agent_path: '/root/review',
            agent_nickname: 'Locke',
        });
        const store = new MemoryStore(openUnmanagedDb(path.join(root, 'elepha.db')));
        store.consent.grant(project);
        const adapter = new CodexAdapter();
        const daemon = new IngestionDaemon({
            store,
            adapters: [adapter],
            watchRoots: [watchRoot],
            readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } }),
        });
        const scan = daemon as unknown as {
            scanFile(adapter: CodexAdapter, file: string, closeTrailingOnIdle: boolean): Promise<{ ingested: number }>;
        };

        try {
            expect(await scan.scanFile(adapter, guardianFile, true)).toMatchObject({ ingested: 0 });
            for (const table of ['sessions', 'memories', 'filtered_turns', 'session_embeddings']) {
                expect(store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
            }
            expect(store.findSession('codex', guardianId)).toBeUndefined();

            expect(await scan.scanFile(adapter, childFile, true)).toEqual({ ingested: 1 });
            expect(store.findSession('codex', childId)).toBeDefined();
            for (const table of ['sessions', 'memories', 'filtered_turns']) {
                expect(store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
            }
            expect(store.findSession('codex', guardianId)).toBeUndefined();
        } finally {
            store.database.close();
        }
    });
});
