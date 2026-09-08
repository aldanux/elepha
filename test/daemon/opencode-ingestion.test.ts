import { mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { opencodeDbPath, opencodeStoreRoot } from '../../src/config/paths.js';
import { IngestionDaemon, watchRoots } from '../../src/daemon/index.js';
import { RollupService } from '../../src/daemon/rollup-service.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { SQLITE_SOURCE_WATERMARK_SCHEMA } from '../../src/storage/db.js';
import { RollupStore } from '../../src/storage/rollup-store.js';
import type { RollupProvider } from '../../src/summarizer/rollup-provider.js';
import { addOpencodeSession, appendOpencodeTurn, createOpencodeFixture } from '../fixtures/opencode-db.js';
import { createTestDb } from '../helpers/db.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

interface OpencodeDaemonSeam {
    scanOpencodeDb(databasePath: string): Promise<{ ingested: number; skipped?: { category: string; reason: string } }>;
    onFileEvent(filePath: string): void;
    enqueueOpencodeScan(databasePath: string): void;
}

function daemonSeam(daemon: IngestionDaemon): OpencodeDaemonSeam {
    return daemon as unknown as OpencodeDaemonSeam;
}

function enabledConfig() {
    return { config: { ...DEFAULT_MEMORY_CONFIG, captureOpencode: true } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('timed out waiting for OpenCode daemon state');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const rollupProvider: RollupProvider = {
    async rollup() {
        return {
            output: {
                title: 'OpenCode rollup',
                summary: 'OpenCode session summary',
                decisions: [],
                pending_items: [],
                droppedDecisions: 0,
            },
            status: 'ok',
        };
    },
    async merge() {
        return {
            output: {
                title: 'OpenCode rollup',
                summary: 'OpenCode session summary',
                decisions: [],
                pending_items: [],
                droppedDecisions: 0,
            },
            status: 'ok',
        };
    },
};

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('OpenCode daemon ingestion', () => {
    it('captures OpenCode sessions by default', async () => {
        const sourceRoot = withGrantableTestDir('elepha-opencode-disabled-source-');
        const projectPath = withGrantableTestDir('elepha-opencode-disabled-project-');
        vi.stubEnv('XDG_DATA_HOME', sourceRoot);
        createOpencodeFixture(opencodeDbPath(), projectPath);
        const fixture = createTestDb('elepha-opencode-disabled-store-');
        fixture.store.consent.grant(projectPath);
        const logs: string[] = [];
        const daemon = new IngestionDaemon({
            store: fixture.store,
            watchRoots: [opencodeStoreRoot()],
            heartbeatPath: pathFor(fixture.directory, 'daemon.heartbeat.json'),
            daemonLogPaths: {
                stdout: pathFor(fixture.directory, 'daemon.stdout.log'),
                stderr: pathFor(fixture.directory, 'daemon.stderr.log'),
            },
            watcherUsePolling: true,
            readConfig: () => ({ config: { captureClaudeCode: true, captureCodex: true } }),
            updateCheck: () => undefined,
            log: (message) => logs.push(message),
        });
        try {
            daemon.start();
            await waitFor(() => logs.some((message) => message.startsWith('[elepha] startup sweep:')));

            expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE tool = 'opencode'").get()).toEqual({ count: 1 });
            expect(logs.some((message) => message.includes('capture disabled'))).toBe(false);
        } finally {
            await daemon.stop();
        }
    });

    it('ingests consented sessions with per-session classification, rollups, incremental cursors, and a loss-safe watermark', async () => {
        const sourceRoot = withGrantableTestDir('elepha-opencode-enabled-source-');
        const projectPath = withGrantableTestDir('elepha-opencode-enabled-project-');
        const unapprovedProject = withGrantableTestDir('elepha-opencode-unapproved-project-');
        const deniedProject = withGrantableTestDir('elepha-opencode-denied-project-');
        vi.stubEnv('XDG_DATA_HOME', sourceRoot);
        createOpencodeFixture(opencodeDbPath(), projectPath);
        appendOpencodeTurn(opencodeDbPath(), {
            sessionId: 'ses_sub',
            turnIndex: 0,
            timeCreated: 500,
            timeUpdated: 100,
            userMessage: 'Subagent prompt',
            assistantText: 'Subagent answer',
        });
        addOpencodeSession(opencodeDbPath(), {
            sessionId: 'ses_unapproved',
            directory: unapprovedProject,
            title: 'Unapproved session',
            timeUpdated: 250,
        });
        appendOpencodeTurn(opencodeDbPath(), {
            sessionId: 'ses_unapproved',
            turnIndex: 0,
            timeCreated: 3_000,
            timeUpdated: 250,
            userMessage: 'Private prompt',
            assistantText: 'Private answer',
        });
        addOpencodeSession(opencodeDbPath(), {
            sessionId: 'ses_denied',
            directory: deniedProject,
            title: 'Denied session',
            timeUpdated: 275,
        });
        appendOpencodeTurn(opencodeDbPath(), {
            sessionId: 'ses_denied',
            turnIndex: 0,
            timeCreated: 3_500,
            timeUpdated: 275,
            userMessage: 'Denied prompt',
            assistantText: 'Denied answer',
        });
        addOpencodeSession(opencodeDbPath(), {
            sessionId: 'ses_sentinel',
            directory: projectPath,
            title: 'Sentinel session',
            timeUpdated: 290,
        });
        appendOpencodeTurn(opencodeDbPath(), {
            sessionId: 'ses_sentinel',
            turnIndex: 0,
            timeCreated: 3_750,
            timeUpdated: 290,
            userMessage: 'Quoted [[elepha:brief:01JTEST]] context',
            assistantText: 'Must stay inert',
        });

        const fixture = createTestDb('elepha-opencode-enabled-store-');
        fixture.store.consent.grant(projectPath);
        fixture.store.consent.revoke(deniedProject);
        const rollups = new RollupStore(fixture.db);
        const daemon = new IngestionDaemon({
            store: fixture.store,
            readConfig: enabledConfig,
            rollupService: new RollupService({ store: fixture.store, rollups, provider: rollupProvider }),
        });
        const scan = daemonSeam(daemon);

        await expect(scan.scanOpencodeDb(opencodeDbPath())).resolves.toMatchObject({ ingested: 3 });
        const primary = fixture.store.findSession('opencode', 'ses_primary');
        const subagent = fixture.store.findSession('opencode', 'ses_sub');
        const sentinel = fixture.store.findSession('opencode', 'ses_sentinel');
        expect(primary).toMatchObject({ kind: 'main', title: 'Primary title', surface: null, git_branch: null });
        expect(subagent).toMatchObject({ kind: 'subagent', title: 'Sub-session', surface: null, git_branch: null });
        expect(fixture.store.findSession('opencode', 'ses_unapproved')).toBeUndefined();
        expect(fixture.store.findSession('opencode', 'ses_denied')).toBeUndefined();
        expect(fixture.store.findProject(unapprovedProject)).toBeUndefined();
        expect(fixture.store.isTranscriptIncognito('opencode', 'ses_denied')).toBe(true);
        expect(fixture.store.listMemoriesForSession(primary!.id)).toHaveLength(2);
        expect(fixture.store.listMemoriesForSession(subagent!.id)).toHaveLength(1);
        expect(fixture.store.listMemoriesForSession(sentinel!.id)).toHaveLength(0);
        expect(fixture.store.getSessionCursor('opencode', 'ses_sentinel')).toContain('ses_sentinel_msg_0_assistant');
        expect(rollups.get(primary!.id)).toBeDefined();
        expect(rollups.get(subagent!.id)).toBeDefined();
        expect(fixture.store.getSqliteSourceWatermark('opencode', opencodeDbPath())).toBe(290);

        const reader = new SessionReader(fixture.db);
        const rendered = await reader.render(reader.sessionById(primary!.id)!);
        expect(rendered.episode?.text).toContain('First prompt');
        expect(rendered.episode?.text).toContain('Second answer');

        await expect(scan.scanOpencodeDb(opencodeDbPath())).resolves.toMatchObject({ ingested: 0 });
        appendOpencodeTurn(opencodeDbPath(), {
            sessionId: 'ses_primary',
            turnIndex: 2,
            timeCreated: 4_000,
            timeUpdated: 300,
            userMessage: 'Incremental prompt',
            assistantText: 'Incremental answer',
        });
        await expect(scan.scanOpencodeDb(opencodeDbPath())).resolves.toMatchObject({ ingested: 1 });
        expect(fixture.store.listMemoriesForSession(primary!.id)).toHaveLength(3);
        expect(fixture.store.listMemoriesForSession(subagent!.id)).toHaveLength(1);
        expect(fixture.store.getSessionCursor('opencode', 'ses_primary')).toContain('ses_primary_msg_2_assistant');
        expect(fixture.store.getSqliteSourceWatermark('opencode', opencodeDbPath())).toBe(300);

        fixture.db
            .prepare(
                `DELETE FROM ${SQLITE_SOURCE_WATERMARK_SCHEMA.table}
                 WHERE ${SQLITE_SOURCE_WATERMARK_SCHEMA.tool} = ? AND ${SQLITE_SOURCE_WATERMARK_SCHEMA.sourcePath} = ?`,
            )
            .run('opencode', opencodeDbPath());
        await expect(scan.scanOpencodeDb(opencodeDbPath())).resolves.toMatchObject({ ingested: 0 });
        expect(fixture.store.listMemoriesForSession(primary!.id)).toHaveLength(3);
        expect(fixture.store.listMemoriesForSession(subagent!.id)).toHaveLength(1);
    });

    it('coalesces database, WAL, and SHM events into one scan of the canonical database path', async () => {
        vi.useFakeTimers();
        const sourceRoot = withGrantableTestDir('elepha-opencode-events-source-');
        const projectPath = withGrantableTestDir('elepha-opencode-events-project-');
        vi.stubEnv('XDG_DATA_HOME', sourceRoot);
        createOpencodeFixture(opencodeDbPath(), projectPath);
        const fixture = createTestDb('elepha-opencode-events-store-');
        const daemon = new IngestionDaemon({ store: fixture.store, readConfig: enabledConfig, idleDebounceMs: 25 });
        const seam = daemonSeam(daemon);
        const enqueue = vi.spyOn(seam, 'enqueueOpencodeScan').mockImplementation(() => {});

        seam.onFileEvent(opencodeDbPath());
        seam.onFileEvent(`${opencodeDbPath()}-wal`);
        seam.onFileEvent(`${opencodeDbPath()}-shm`);
        await vi.advanceTimersByTimeAsync(25);

        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledWith(opencodeDbPath());
    });

    it('watches the OpenCode root only when the store exists', () => {
        const sourceRoot = withGrantableTestDir('elepha-opencode-watch-root-');
        vi.stubEnv('XDG_DATA_HOME', sourceRoot);

        expect(watchRoots()).not.toContain(opencodeStoreRoot());
        mkdirSync(opencodeStoreRoot(), { recursive: true });
        expect(watchRoots()).toContain(opencodeStoreRoot());
    });
});

function pathFor(directory: string, basename: string): string {
    return `${directory}/${basename}`;
}
