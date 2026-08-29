import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERSIZED_TRANSCRIPT_RECORD_REASON } from '../../src/adapters/base.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { MAX_TRANSCRIPT_RECORD_BYTES } from '../../src/config/constants.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import type { RollupService } from '../../src/daemon/rollup-service.js';
import { type ServedSession, SessionReader } from '../../src/serving/session-reader.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { SessionAdapter } from '../../src/types/index.js';
import { withTempDir } from '../helpers/tmp.js';

vi.mock('../../src/config/constants.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/config/constants.js')>();
    return { ...actual, MAX_TRANSCRIPT_RECORD_BYTES: 512 };
});

type DaemonScanSeam = {
    scanFile(
        adapter: SessionAdapter,
        filePath: string,
        closeTrailingOnIdle: boolean,
    ): Promise<{ ingested: number; skipped?: { category: string; reason: string } }>;
};

function countRows(store: MemoryStore, table: 'projects' | 'sessions' | 'memories'): number {
    return (store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function codexMetadata(cwd: string, nativeId: string): string {
    return `${JSON.stringify({
        timestamp: '2026-08-26T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: nativeId, cwd, originator: 'codex-tui' },
    })}\n`;
}

function codexPreamble(cwd: string, nativeId: string): string {
    return `${codexMetadata(cwd, nativeId)}${JSON.stringify({
        timestamp: '2026-08-26T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'safe request', turn_id: 'turn-1' },
    })}\n`;
}

function servedSession(nativeId: string, sourcePath: string): ServedSession {
    return {
        id: 1,
        tool: 'codex',
        native_id: nativeId,
        segment_index: 0,
        project_id: 1,
        source_path: sourcePath,
        started_at: '2026-08-26T00:00:00.000Z',
        last_ingested_at: '2026-08-26T00:00:01.000Z',
        surface: 'cli',
        git_branch: null,
        git_commit_count: null,
        last_turn_at: '2026-08-26T00:00:01.000Z',
        rendered_chars: null,
        rendered_turns: null,
        title: null,
        custom_title: null,
        first_prompt_search: null,
        rollup_title: null,
        rollup_decisions: null,
        rollup_state: null,
        turn_count: 1,
        has_files_touched: 0,
        has_external_content: 0,
    };
}

afterEach(() => vi.unstubAllEnvs());

describe('untrusted transcript record bounds', () => {
    it('caches an unchanged oversized skip, then retries and ingests the repaired file', async () => {
        const root = withTempDir('elepha-untrusted-record-');
        const codexHome = path.join(root, '.codex');
        const transcriptRoot = path.join(codexHome, 'sessions', '2026', '08', '26');
        vi.stubEnv('CODEX_HOME', codexHome);
        const cwd = '/Users/test/untrusted-record-project';
        const oversizedId = '019fd000-0000-7000-8000-000000000001';
        const validId = '019fd000-0000-7000-8000-000000000002';
        const oversizedFile = path.join(transcriptRoot, `rollout-2026-08-26T00-00-00-${oversizedId}.jsonl`);
        const validFile = path.join(transcriptRoot, `rollout-2026-08-26T00-01-00-${validId}.jsonl`);
        const metadata = codexMetadata(cwd, oversizedId);
        mkdirSync(transcriptRoot, { recursive: true });
        writeFileSync(oversizedFile, metadata);
        truncateSync(oversizedFile, Buffer.byteLength(metadata) + MAX_TRANSCRIPT_RECORD_BYTES + 1);
        writeFileSync(
            validFile,
            `${codexPreamble(cwd, validId)}${JSON.stringify({
                timestamp: '2026-08-26T00:00:02.000Z',
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'safe response' }] },
            })}\n`,
        );

        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        store.consent.grant(cwd);
        const logs: string[] = [];
        const adapter = new CodexAdapter();
        const classifySession = vi.spyOn(adapter, 'classifySession');
        const parseTurns = vi.spyOn(adapter, 'parseTurns');
        const daemon = new IngestionDaemon({
            store,
            adapters: [adapter],
            watchRoots: [transcriptRoot],
            log: (message) => logs.push(message),
        });
        const scan = daemon as unknown as DaemonScanSeam;

        await expect(scan.scanFile(adapter, oversizedFile, true)).resolves.toEqual({
            ingested: 0,
            skipped: { category: 'oversized record', reason: OVERSIZED_TRANSCRIPT_RECORD_REASON },
        });
        expect(store.getSessionCursor('codex', oversizedId)).toBeUndefined();
        expect(countRows(store, 'projects')).toBe(0);
        expect(countRows(store, 'sessions')).toBe(0);
        expect(countRows(store, 'memories')).toBe(0);
        expect(logs).toEqual(expect.arrayContaining([expect.stringContaining(OVERSIZED_TRANSCRIPT_RECORD_REASON)]));
        expect(classifySession).toHaveBeenCalledTimes(1);
        expect(parseTurns).not.toHaveBeenCalled();

        await expect(scan.scanFile(adapter, oversizedFile, true)).resolves.toEqual({
            ingested: 0,
            skipped: { category: 'oversized record', reason: OVERSIZED_TRANSCRIPT_RECORD_REASON },
        });
        expect(classifySession).toHaveBeenCalledTimes(1);
        expect(parseTurns).not.toHaveBeenCalled();
        expect(store.getSessionCursor('codex', oversizedId)).toBeUndefined();
        expect(countRows(store, 'projects')).toBe(0);
        expect(countRows(store, 'sessions')).toBe(0);
        expect(countRows(store, 'memories')).toBe(0);

        const reader = new SessionReader(store.database, { codex: adapter, 'claude-code': adapter });
        await expect(reader.turns(servedSession(oversizedId, oversizedFile), undefined, new Set([0]))).resolves.toEqual({
            reason: 'transcript_unreadable',
        });
        classifySession.mockClear();
        parseTurns.mockClear();

        writeFileSync(
            oversizedFile,
            `${codexPreamble(cwd, oversizedId)}${JSON.stringify({
                timestamp: '2026-08-26T00:00:02.000Z',
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'repaired response' }] },
            })}\n`,
        );
        await expect(scan.scanFile(adapter, oversizedFile, true)).resolves.toMatchObject({ ingested: 1 });
        expect(classifySession).toHaveBeenCalledTimes(1);
        expect(parseTurns).toHaveBeenCalledTimes(1);
        expect(store.getSessionCursor('codex', oversizedId)).toBeDefined();
        expect(countRows(store, 'projects')).toBe(1);
        expect(countRows(store, 'sessions')).toBe(1);
        expect(countRows(store, 'memories')).toBe(1);

        await expect(scan.scanFile(adapter, validFile, true)).resolves.toMatchObject({ ingested: 1 });
        expect(store.getSessionCursor('codex', validId)).toBeDefined();
        expect(countRows(store, 'projects')).toBe(1);
        expect(countRows(store, 'sessions')).toBe(2);
        expect(countRows(store, 'memories')).toBe(2);

        writeFileSync(oversizedFile, metadata);
        truncateSync(oversizedFile, Buffer.byteLength(metadata) + MAX_TRANSCRIPT_RECORD_BYTES + 1);
        classifySession.mockClear();
        const sweepLogs: string[] = [];
        const rollupService = {
            isIdle: () => true,
            rollupSession: vi.fn(async () => undefined),
        } as unknown as RollupService;
        const restartedDaemon = new IngestionDaemon({
            store,
            adapters: [adapter],
            watchRoots: [transcriptRoot],
            rollupService,
            log: (message) => sweepLogs.push(message),
        });

        await expect(restartedDaemon.sweepIdleSessions()).resolves.toBe(1);
        expect(sweepLogs).toEqual(expect.arrayContaining([expect.stringContaining(OVERSIZED_TRANSCRIPT_RECORD_REASON)]));
        const classificationsAfterSweep = classifySession.mock.calls.length;
        await expect((restartedDaemon as unknown as DaemonScanSeam).scanFile(adapter, oversizedFile, true)).resolves.toEqual({
            ingested: 0,
            skipped: { category: 'oversized record', reason: OVERSIZED_TRANSCRIPT_RECORD_REASON },
        });
        expect(classifySession).toHaveBeenCalledTimes(classificationsAfterSweep);
    }, 15_000);
});
