import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KimiCodeAdapter } from '../../src/adapters/kimi-code.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { RollupStore } from '../../src/storage/rollup-store.js';
import { createKimiFixture, kimiTurn, wireText } from '../fixtures/kimi-wire.js';
import { createTestDb } from '../helpers/db.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

interface ScanSeam {
    scanFile(adapter: KimiCodeAdapter, filePath: string, close: boolean): Promise<{ ingested: number; skipped?: { reason: string } }>;
    onFileEvent(filePath: string): void;
    enqueueScan(adapter: KimiCodeAdapter, filePath: string, close: boolean): void;
    scheduleIdleScan(adapter: KimiCodeAdapter, filePath: string): void;
}

function setup(records: object[] = [...kimiTurn(0), ...kimiTurn(1)]) {
    vi.stubEnv('KIMI_CODE_HOME', withGrantableTestDir('kimi-source-'));
    const projectPath = withGrantableTestDir('kimi-project-');
    const files = createKimiFixture(projectPath, records);
    const db = createTestDb('kimi-memory-');
    db.store.consent.grant(projectPath);
    const logs: string[] = [];
    const summarize = vi.fn(async ({ assistantText }: { userMessage: string; assistantText: string }) => ({
        decisions: [{ what: assistantText, why: null }],
        pending_items: [],
        status: 'ok' as const,
    }));
    const daemon = new IngestionDaemon({
        store: db.store,
        summarizer: { summarize },
        log: (message) => logs.push(message),
        readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } }),
    });
    const seam = daemon as unknown as ScanSeam;
    const scan = () => seam.scanFile(new KimiCodeAdapter(), files.wire, true);
    const memories = () => db.store.listMemoriesForSession(db.store.findSession('kimi', 'session-main')!.id);
    return { ...db, ...files, projectPath, scan, memories, seam, summarize, logs };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('Kimi reconciliation ingestion', () => {
    it('undo removes the tail and its durable/FTS content, then captures a replacement at the same index', async () => {
        const f = setup();
        expect(await f.scan()).toMatchObject({ ingested: 2 });
        const original = f.memories();
        writeFileSync(f.wire, wireText(kimiTurn(0)));
        expect(await f.scan()).toMatchObject({ ingested: 0 });
        expect(f.memories().map((row) => row.id)).toEqual([original[0]?.id]);
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM filtered_turns').get()).toEqual({ n: 1 });
        appendFileSync(
            f.wire,
            `${kimiTurn(1, 'Replacement answer')
                .map((event) => JSON.stringify(event))
                .join('\n')}\n`,
        );
        expect(await f.scan()).toMatchObject({ ingested: 1 });
        expect(f.memories().map((row) => row.decisions[0]?.what)).toEqual(['Answer 0', 'Replacement answer']);
        expect(await f.scan()).toMatchObject({ ingested: 0 });
        expect(f.summarize).toHaveBeenCalledTimes(3);
    });

    it('atomic resume replacement preserves identical memory identities and repairs changed content', async () => {
        const f = setup();
        await f.scan();
        const ids = f.memories().map((row) => row.id);
        writeFileSync(`${f.wire}.replacement`, readFileSync(f.wire));
        renameSync(`${f.wire}.replacement`, f.wire);
        expect(await f.scan()).toMatchObject({ ingested: 0 });
        expect(f.memories().map((row) => row.id)).toEqual(ids);
        writeFileSync(`${f.wire}.replacement`, wireText([...kimiTurn(0), ...kimiTurn(1, 'Changed answer')]));
        renameSync(`${f.wire}.replacement`, f.wire);
        expect(await f.scan()).toMatchObject({ ingested: 1 });
        expect(f.memories()[0]?.id).toBe(ids[0]);
        expect(f.memories()[1]?.decisions[0]?.what).toBe('Changed answer');
    });

    it('uses prompt completion for a mid-turn injection quote-back window', async () => {
        const body =
            'A sufficiently long injected memory paragraph describing local passive capture and the consent boundary across coding tools.';
        const f = setup([...kimiTurn(0, body), ...kimiTurn(1)]);
        f.store.recordInjection({
            tool: 'kimi',
            nativeSessionId: 'session-main',
            injectedAt: new Date(1500).toISOString(),
            injectionId: '01J00000000000000000000000',
            body,
        });
        expect(await f.scan()).toMatchObject({ ingested: 1 });
        expect(f.memories().map((row) => row.turn_index)).toEqual([1]);
        expect(f.summarize).toHaveBeenCalledExactlyOnceWith({ userMessage: 'Prompt 1', assistantText: 'Answer 1' });
    });

    it('does not capture failed prompts and routes state-only updates back to the main wire', async () => {
        const f = setup(kimiTurn(0, '', { failed: true }));
        expect(await f.scan()).toMatchObject({ ingested: 0 });
        expect(f.summarize).not.toHaveBeenCalled();
        const enqueue = vi.spyOn(f.seam, 'enqueueScan').mockImplementation(() => {});
        vi.spyOn(f.seam, 'scheduleIdleScan').mockImplementation(() => {});
        f.seam.onFileEvent(f.state);
        expect(enqueue).toHaveBeenCalledWith(expect.any(KimiCodeAdapter), f.wire, false);
    });

    it('does not write a stale source after replacement during awaited summarization', async () => {
        const f = setup(kimiTurn(0));
        f.summarize.mockImplementationOnce(async () => {
            writeFileSync(`${f.wire}.replacement`, wireText([]));
            renameSync(`${f.wire}.replacement`, f.wire);
            return { decisions: [], pending_items: [], status: 'ok' };
        });
        expect(await f.scan()).toMatchObject({ ingested: 0 });
        expect(f.store.findSession('kimi', 'session-main')).toBeUndefined();
    });
    it('feeds a real phase-2 resume hook output back through Kimi capture without re-ingesting its brief or echo', async () => {
        const f = setup(kimiTurn(0));
        await f.scan();
        const hook = await runUserPromptSubmit(
            JSON.stringify({
                session_id: 'session-hook',
                cwd: f.projectPath,
                prompt: [{ type: 'text', text: 'elepha:last' }],
                is_steer: false,
            }),
            'kimi',
            {
                dbPath: f.dbPath,
                now: () => 1500,
            },
        );
        expect(hook).toHaveProperty('output.message');
        if (!('output' in hook) || !('message' in hook.output) || typeof hook.output.message !== 'string') {
            throw new Error('Kimi resume hook did not inject a message');
        }
        const brief = hook.output.message;
        const injection = f.db.prepare("SELECT body FROM injections WHERE tool = 'kimi' AND native_session_id = 'session-hook'").get() as {
            body: string;
        };
        const sentinelTurn = kimiTurn(0, 'Echo from the injected context');
        sentinelTurn.splice(4, 0, {
            type: 'context.append_message',
            agentId: 'main',
            time: 1500,
            message: { role: 'user', origin: { kind: 'injection' }, content: [{ type: 'text', text: brief }] },
        });
        const files = createKimiFixture(f.projectPath, [...sentinelTurn, ...kimiTurn(1)], 'session-hook');
        expect(await f.seam.scanFile(new KimiCodeAdapter(), files.wire, true)).toMatchObject({ ingested: 1 });
        const stored = f.store.findSession('kimi', 'session-hook')!;
        expect(f.store.listMemoriesForSession(stored.id).map((row) => row.turn_index)).toEqual([1]);
        // Removing the sentinel cannot evade the same session's content-based guard.
        writeFileSync(files.wire, wireText([...kimiTurn(0, injection.body), ...kimiTurn(1)]));
        expect(await f.seam.scanFile(new KimiCodeAdapter(), files.wire, true)).toMatchObject({ ingested: 0 });
        expect(f.store.listMemoriesForSession(stored.id).map((row) => row.turn_index)).toEqual([1]);
    });

    it('retracts all turns on repair-to-empty and rejects a rollup prepared before that generation', async () => {
        const f = setup();
        await f.scan();
        const session = f.store.findSession('kimi', 'session-main')!;
        const rollups = new RollupStore(f.db);
        const pending = {
            sessionId: session.id,
            projectId: session.project_id,
            tool: 'kimi',
            title: 'Old title',
            summary: 'Retracted old answer',
            decisions: [],
            pendingItems: [],
            filesTouched: [],
            turnCount: 2,
            startedAt: new Date(1000).toISOString(),
            endedAt: new Date(2800).toISOString(),
            kind: 'primary',
            parentSessionId: null,
            summarizerStatus: 'ok',
            state: 'live' as const,
            throughTurnIndex: 1,
            expectedSourceGeneration: 0,
        };
        expect(rollups.write(pending, undefined)).toBe(true);
        writeFileSync(f.wire, wireText([]));
        expect(await f.scan()).toMatchObject({ ingested: 0 });
        expect(f.memories()).toEqual([]);
        expect(rollups.get(session.id)).toBeUndefined();
        expect(rollups.write(pending, undefined)).toBe(false);
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM filtered_turns').get()).toEqual({ n: 0 });
    });

    it('rolls back retraction if a derived-row mutation fails', async () => {
        const f = setup();
        await f.scan();
        const original = f.memories();
        f.db.exec(`CREATE TRIGGER reject_kimi_retraction BEFORE UPDATE ON sessions
            BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`);
        writeFileSync(f.wire, wireText(kimiTurn(0)));
        expect(await f.scan()).toMatchObject({ skipped: { reason: expect.stringContaining('fixture rollback') } });
        expect(f.memories()).toEqual(original);
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM filtered_turns').get()).toEqual({ n: 2 });
        f.db.exec('DROP TRIGGER reject_kimi_retraction');
        expect(await f.scan()).toMatchObject({ ingested: 0 });
        expect(f.memories()).toHaveLength(1);
    });

    it('does not re-ingest a fork prefix already stored for its parent', async () => {
        const f = setup(kimiTurn(0));
        await f.scan();
        const fork = createKimiFixture(
            f.projectPath,
            [...kimiTurn(0), { type: 'forked', time: 1900 }, ...kimiTurn(1)],
            'session-fork',
            true,
        );
        expect(await f.seam.scanFile(new KimiCodeAdapter(), fork.wire, true)).toMatchObject({ ingested: 1 });
        const stored = f.store.findSession('kimi', 'session-fork')!;
        expect(f.store.listMemoriesForSession(stored.id).map((row) => row.decisions[0]?.what)).toEqual(['Answer 1']);
        expect(await f.seam.scanFile(new KimiCodeAdapter(), fork.wire, true)).toMatchObject({ ingested: 0 });
    });

    it('rechecks consent after awaited summary work', async () => {
        const f = setup(kimiTurn(0));
        f.summarize.mockImplementationOnce(async () => {
            f.store.consent.revoke(f.projectPath);
            return { decisions: [], pending_items: [], status: 'ok' };
        });
        expect(await f.scan()).toMatchObject({ ingested: 0 });
        expect(f.store.findSession('kimi', 'session-main')).toBeUndefined();
        expect(f.store.isTranscriptIncognito('kimi', 'session-main')).toBe(true);
    });
});
