import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { readHeartbeat } from '../../src/daemon/heartbeat.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openProviderTranscript } from '../../src/security/provider-transcript.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { SessionAdapter, SummarizationInput, SummarizationOutput, SummarizationProvider } from '../../src/types/index.js';

class StubSummarizer implements SummarizationProvider {
    calls: SummarizationInput[] = [];

    async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
        this.calls.push(input);
        return { decisions: [{ what: `handled: ${input.userMessage.slice(0, 20)}`, why: null }], pending_items: [], status: 'ok' };
    }
}

function ccTurnLines(
    cwd: string,
    sessionId: string,
    seq: number,
    userText: string,
    assistantText: string,
    entrypoint?: string,
    startedAt?: string,
): string {
    const base = startedAt === undefined ? Date.UTC(2026, 7, 1, 0, 0, seq * 2) : Date.parse(startedAt);
    const t = (offset: number) => new Date(base + offset * 1000).toISOString();
    const user = JSON.stringify({
        type: 'user',
        parentUuid: null,
        isSidechain: false,
        message: { role: 'user', content: userText },
        uuid: `u${seq}`,
        timestamp: t(0),
        cwd,
        sessionId,
        ...(entrypoint ? { entrypoint } : {}),
    });
    const assistant = JSON.stringify({
        type: 'assistant',
        parentUuid: `u${seq}`,
        message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] },
        uuid: `a${seq}`,
        timestamp: t(1),
        cwd,
        sessionId,
    });
    return `${user}\n${assistant}\n`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise((r) => setTimeout(r, 20));
    }
}

type DaemonScanSeam = {
    processing: Set<string>;
    scanFile(
        adapter: SessionAdapter,
        filePath: string,
        closeTrailingOnIdle: boolean,
    ): Promise<{ ingested: number; skipped?: { category: string } }>;
    enqueueScan(adapter: SessionAdapter, filePath: string, closeTrailingOnIdle: boolean): void;
};

function scanSeam(daemon: IngestionDaemon): DaemonScanSeam {
    return daemon as unknown as DaemonScanSeam;
}

describe('IngestionDaemon end-to-end', () => {
    let root: string;
    let daemons: IngestionDaemon[] = [];
    let prevConfigDir: string | undefined;

    afterEach(async () => {
        await Promise.all(daemons.map((d) => d.stop()));
        daemons = [];
        if (prevConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
        }
    });

    it('ingests an existing session on cold start, resumes cleanly across a restart without duplicating, and keeps tailing new turns', async () => {
        root = mkdtempSync(path.join(tmpdir(), 'elepha-daemon-'));
        // The adapters resolve their roots through CLAUDE_CONFIG_DIR/CODEX_HOME,
        // so pointing the env var at the temp tree is what makes matches() (and
        // therefore the whole watch path) see these fixtures at all.
        prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        const dbPath = path.join(root, 'elepha.db');
        const projectDir = path.join(root, '.claude', 'projects', 'demo-project');
        mkdirSync(projectDir, { recursive: true });

        const cwd = '/Users/test/elepha-daemon-demo-project';
        const sessionFile = path.join(projectDir, 'sess-1.jsonl');

        writeFileSync(sessionFile, ccTurnLines(cwd, 'sess-1', 0, 'first request', 'first reply'));

        const watchRoots = [path.join(root, '.claude', 'projects')];

        const heartbeatPath = path.join(root, 'daemon.heartbeat.json');

        const store1 = new MemoryStore(openDb(dbPath));
        store1.consent.grant(cwd);
        const summarizer1 = new StubSummarizer();
        const daemon1 = new IngestionDaemon({
            store: store1,
            summarizer: summarizer1,
            idleDebounceMs: 100,
            watchRoots,
            heartbeatPath,
            watcherUsePolling: true,
        });
        daemons.push(daemon1);
        daemon1.start();

        const project1 = await (async () => {
            await waitFor(() => store1.findProject(cwd) !== undefined);
            return store1.findProject(cwd)!;
        })();
        await waitFor(() => store1.listRecentMemories(project1.id, 10).length === 1);

        let memories = store1.listRecentMemories(project1.id, 10);
        expect(memories).toHaveLength(1);
        expect(memories[0]!.decisions[0]!.what).toContain('first request');

        await daemon1.stop();

        // Restart: fresh daemon + fresh MemoryStore instance over the same DB file.
        const store2 = new MemoryStore(openDb(dbPath));
        const summarizer2 = new StubSummarizer();
        const daemon2 = new IngestionDaemon({
            store: store2,
            summarizer: summarizer2,
            idleDebounceMs: 100,
            watchRoots,
            heartbeatPath,
            watcherUsePolling: true,
        });
        daemons.push(daemon2);
        daemon2.start();

        // Give the cold-start scan a moment; the already-ingested turn must not duplicate.
        await new Promise((r) => setTimeout(r, 300));
        const project2 = store2.findProject(cwd)!;
        expect(store2.listRecentMemories(project2.id, 10)).toHaveLength(1);
        expect(summarizer2.calls).toHaveLength(0); // nothing new to summarize on restart

        // Append a second turn while daemon2 is live-tailing.
        appendFileSync(sessionFile, ccTurnLines(cwd, 'sess-1', 1, 'second request', 'second reply'));
        await waitFor(() => store2.listRecentMemories(project2.id, 10).length === 2);

        memories = store2.listRecentMemories(project2.id, 10);
        expect(memories).toHaveLength(2);
        expect(memories.some((m) => m.decisions[0]?.what.includes('second request'))).toBe(true);
    }, 15000);

    it('serializes two daemon writers by native turn and resumes from the final complete line after restart', async () => {
        root = mkdtempSync(path.join(tmpdir(), 'elepha-daemon-concurrent-'));
        prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        const dbPath = path.join(root, 'elepha.db');
        const projectDir = path.join(root, '.claude', 'projects', 'demo-project');
        mkdirSync(projectDir, { recursive: true });

        const cwd = '/Users/test/elepha-daemon-concurrent-project';
        const nativeId = 'concurrent-session';
        const sessionFile = path.join(projectDir, `${nativeId}.jsonl`);
        writeFileSync(sessionFile, ccTurnLines(cwd, nativeId, 0, 'first request', 'first reply', undefined, '2026-08-01T00:00:00.000Z'));

        const storeA = new MemoryStore(openDb(dbPath));
        storeA.consent.grant(cwd);
        const initialDaemon = new IngestionDaemon({
            store: storeA,
            summarizer: new StubSummarizer(),
            adapters: [new ClaudeCodeAdapter()],
            watchRoots: [path.join(root, '.claude', 'projects')],
        });
        await expect(scanSeam(initialDaemon).scanFile(new ClaudeCodeAdapter(), sessionFile, true)).resolves.toMatchObject({ ingested: 1 });

        appendFileSync(
            sessionFile,
            ccTurnLines(cwd, nativeId, 1, 'boundary request', 'boundary reply', undefined, '2026-08-09T00:00:00.000Z'),
        );

        let releaseWriters!: () => void;
        const writersReleased = new Promise<void>((resolve) => {
            releaseWriters = resolve;
        });
        const blockingSummarizer = (): SummarizationProvider & { calls: SummarizationInput[] } => {
            const calls: SummarizationInput[] = [];
            return {
                calls,
                async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
                    calls.push(input);
                    await writersReleased;
                    return {
                        decisions: [{ what: `handled: ${input.userMessage}`, why: null }],
                        pending_items: [],
                        status: 'ok',
                    };
                },
            };
        };
        const summarizerA = blockingSummarizer();
        const summarizerB = blockingSummarizer();
        const storeB = new MemoryStore(openDb(dbPath));
        const errors: string[] = [];
        const daemonA = new IngestionDaemon({
            store: storeA,
            summarizer: summarizerA,
            adapters: [new ClaudeCodeAdapter()],
            watchRoots: [path.join(root, '.claude', 'projects')],
            logError: (message) => errors.push(message),
        });
        const daemonB = new IngestionDaemon({
            store: storeB,
            summarizer: summarizerB,
            adapters: [new ClaudeCodeAdapter()],
            watchRoots: [path.join(root, '.claude', 'projects')],
            logError: (message) => errors.push(message),
        });

        const scans = Promise.all([
            scanSeam(daemonA).scanFile(new ClaudeCodeAdapter(), sessionFile, true),
            scanSeam(daemonB).scanFile(new ClaudeCodeAdapter(), sessionFile, true),
        ]);
        await waitFor(() => summarizerA.calls.length === 1 && summarizerB.calls.length === 1);
        releaseWriters();
        const results = await scans;

        expect(results.map((result) => result.ingested).sort()).toEqual([0, 1]);
        expect(results.every((result) => result.skipped === undefined)).toBe(true);
        expect(errors).toEqual([]);
        expect(
            storeA.database
                .prepare(
                    `SELECT m.turn_index, COUNT(*) AS count
                     FROM memories m
                     JOIN sessions s ON s.id = m.session_id
                     WHERE s.tool = ? AND s.native_id = ?
                     GROUP BY m.turn_index
                     ORDER BY m.turn_index`,
                )
                .all('claude-code', nativeId),
        ).toEqual([
            { turn_index: 0, count: 1 },
            { turn_index: 1, count: 1 },
        ]);
        expect(
            storeA.database
                .prepare('SELECT segment_index FROM sessions WHERE tool = ? AND native_id = ? ORDER BY segment_index')
                .all('claude-code', nativeId),
        ).toEqual([{ segment_index: 0 }, { segment_index: 1 }]);
        expect(Number(storeA.findSession('claude-code', nativeId)?.cursor?.split('|')[0])).toBe(statSync(sessionFile).size);

        const restartStore = new MemoryStore(openDb(dbPath));
        const restartSummarizer = new StubSummarizer();
        const restartDaemon = new IngestionDaemon({
            store: restartStore,
            summarizer: restartSummarizer,
            adapters: [new ClaudeCodeAdapter()],
            watchRoots: [path.join(root, '.claude', 'projects')],
            logError: (message) => errors.push(message),
        });
        const restartScan = scanSeam(restartDaemon);

        await expect(restartScan.scanFile(new ClaudeCodeAdapter(), sessionFile, true)).resolves.toMatchObject({ ingested: 0 });
        expect(restartSummarizer.calls).toHaveLength(0);

        appendFileSync(sessionFile, ccTurnLines(cwd, nativeId, 2, 'later request', 'later reply', undefined, '2026-08-09T00:02:00.000Z'));
        await expect(restartScan.scanFile(new ClaudeCodeAdapter(), sessionFile, true)).resolves.toMatchObject({ ingested: 1 });

        expect(restartSummarizer.calls.map((call) => call.userMessage)).toEqual(['later request']);
        expect(
            restartStore.database
                .prepare(
                    `SELECT m.turn_index, COUNT(*) AS count
                     FROM memories m
                     JOIN sessions s ON s.id = m.session_id
                     WHERE s.tool = ? AND s.native_id = ?
                     GROUP BY m.turn_index
                     ORDER BY m.turn_index`,
                )
                .all('claude-code', nativeId),
        ).toEqual([
            { turn_index: 0, count: 1 },
            { turn_index: 1, count: 1 },
            { turn_index: 2, count: 1 },
        ]);
        expect(Number(restartStore.findSession('claude-code', nativeId)?.cursor?.split('|')[0])).toBe(statSync(sessionFile).size);
        expect(errors).toEqual([]);
    }, 15000);

    it('captures surface/kind on session creation from the first turn', async () => {
        root = mkdtempSync(path.join(tmpdir(), 'elepha-daemon-'));
        prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        const dbPath = path.join(root, 'elepha.db');
        const projectDir = path.join(root, '.claude', 'projects', 'demo-project');
        mkdirSync(projectDir, { recursive: true });

        const cwd = '/Users/test/elepha-daemon-surface-project';
        const nativeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        const sessionFile = path.join(projectDir, `${nativeId}.jsonl`);

        writeFileSync(sessionFile, ccTurnLines(cwd, nativeId, 0, 'first request', 'first reply', 'cli'));

        const watchRoots = [path.join(root, '.claude', 'projects')];
        const heartbeatPath = path.join(root, 'daemon.heartbeat.json');

        const store = new MemoryStore(openDb(dbPath));
        store.consent.grant(cwd);
        const summarizer = new StubSummarizer();
        const daemon = new IngestionDaemon({
            store,
            summarizer,
            idleDebounceMs: 100,
            watchRoots,
            heartbeatPath,
            watcherUsePolling: true,
        });
        daemons.push(daemon);
        daemon.start();

        await waitFor(() => store.findSession('claude-code', nativeId) !== undefined);

        const session = store.findSession('claude-code', nativeId);
        expect(session?.surface).toBe('cli');
        expect(session?.kind).toBe('main');
    }, 15000);

    it.each(['SIGTERM', 'SIGINT'] as const)('clears its heartbeat during graceful %s shutdown', async (signal) => {
        root = mkdtempSync(path.join(tmpdir(), 'elepha-daemon-signal-'));
        const heartbeatPath = path.join(root, 'daemon.heartbeat.json');
        const daemon = new IngestionDaemon({
            store: new MemoryStore(openDb(path.join(root, 'elepha.db'))),
            watchRoots: [root],
            heartbeatPath,
            watcherUsePolling: true,
        });
        daemons.push(daemon);
        daemon.start();

        expect(readHeartbeat(heartbeatPath)).toBeDefined();
        process.emit(signal);
        await waitFor(() => !existsSync(heartbeatPath));

        expect(readHeartbeat(heartbeatPath)).toBeUndefined();
    });

    it('rejects a parent symlink retargeted outside after the scan opens the transcript', async () => {
        root = mkdtempSync(path.join(tmpdir(), 'elepha-daemon-opened-containment-'));
        prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        const storeRoot = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects');
        const insideDirectory = path.join(storeRoot, 'inside');
        const outsideDirectory = path.join(root, 'outside');
        const alias = path.join(storeRoot, 'alias');
        const filePath = path.join(alias, 'session.jsonl');
        mkdirSync(insideDirectory, { recursive: true });
        mkdirSync(outsideDirectory);
        writeFileSync(path.join(insideDirectory, 'session.jsonl'), '{}\n');
        writeFileSync(path.join(outsideDirectory, 'session.jsonl'), '{}\n');
        symlinkSync(insideDirectory, alias, 'dir');

        const classifySession = vi.fn(async () => ({ kind: 'primary' as const }));
        const parseTurns = vi.fn(async function* (): AsyncIterable<never> {});
        const adapter: SessionAdapter = {
            tool: 'claude-code',
            watchGlobs: ['*.jsonl'],
            matches: () => true,
            nativeSessionId: () => 'session',
            classifySession,
            classifyEmptySession: async () => undefined,
            parseTurns,
        };
        const daemon = scanSeam(
            new IngestionDaemon({
                store: new MemoryStore(openDb(':memory:')),
                watchRoots: [storeRoot],
                openTranscript: (tool, candidate) =>
                    openProviderTranscript(tool, candidate, {
                        realpath: async (openedPath) => {
                            unlinkSync(alias);
                            symlinkSync(outsideDirectory, alias, 'dir');
                            return fsRealpath(openedPath);
                        },
                    }),
            }),
        );

        await expect(daemon.scanFile(adapter, filePath, false)).resolves.toMatchObject({
            ingested: 0,
            skipped: { category: 'outside watched store' },
        });
        expect(classifySession).not.toHaveBeenCalled();
        expect(parseTurns).not.toHaveBeenCalled();
    });

    it('re-arms an idle scan when a request collides with an in-flight scan', async () => {
        vi.useFakeTimers();
        try {
            const root = mkdtempSync(path.join(tmpdir(), 'elepha-daemon-retry-'));
            prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
            process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
            const projectDir = path.join(root, '.claude', 'projects', 'demo-project');
            mkdirSync(projectDir, { recursive: true });
            const targetDirectory = path.join(projectDir, 'target');
            const aliasDirectory = path.join(projectDir, 'alias');
            mkdirSync(targetDirectory);
            const file = path.join(targetDirectory, 'session.jsonl');
            const alias = path.join(aliasDirectory, 'session.jsonl');
            writeFileSync(file, '{}\n');
            symlinkSync(targetDirectory, aliasDirectory, 'dir');
            const adapter = new (class {
                readonly tool = 'claude-code' as const;
                // Required by the structural SessionAdapter fixture; scanFile only uses parseTurns on this path.
                //noinspection JSUnusedGlobalSymbols
                readonly watchGlobs = ['*.jsonl'];

                matches(): boolean {
                    return true;
                }

                // Required by SessionAdapter but unused by scanFile on this path.
                //noinspection JSUnusedGlobalSymbols
                nativeSessionId(): string {
                    return 'session';
                }

                // Required by SessionAdapter but unused by scanFile on this path.
                //noinspection JSUnusedGlobalSymbols
                async classifySession() {
                    return { kind: 'primary' as const };
                }

                // Required by SessionAdapter but unused by scanFile on this path.
                //noinspection JSUnusedGlobalSymbols
                async classifyEmptySession() {
                    return undefined;
                }

                async *parseTurns() {}
            })();
            const daemon = scanSeam(
                new IngestionDaemon({
                    store: new MemoryStore(openDb(':memory:')),
                    idleDebounceMs: 25,
                    watchRoots: [root],
                }),
            );
            const enqueueScan = vi.spyOn(daemon, 'enqueueScan').mockImplementation(() => {});
            const canonicalFile = realpathSync(file);
            daemon.processing.add(canonicalFile);

            await expect(daemon.scanFile(adapter, alias, false)).resolves.toEqual({ ingested: 0 });
            expect(enqueueScan).not.toHaveBeenCalled();

            daemon.processing.delete(canonicalFile);
            await vi.advanceTimersByTimeAsync(25);
            expect(enqueueScan).toHaveBeenCalledWith(adapter, alias, true);
        } finally {
            vi.useRealTimers();
        }
    });
});
