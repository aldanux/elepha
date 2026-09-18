import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { OPEN_TURN_SUMMARY_GRACE_MS } from '../../src/config/constants.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { SessionAdapter, SummarizationInput, SummarizationOutput, SummarizationProvider } from '../../src/types/index.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

class RecordingSummarizer implements SummarizationProvider {
    readonly calls: SummarizationInput[] = [];

    async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
        this.calls.push(input);
        return { decisions: [{ what: 'Captured failed EOF', why: null }], pending_items: ['Retry later'], status: 'ok' };
    }
}

class BlockingSummarizer implements SummarizationProvider {
    readonly calls: SummarizationInput[] = [];
    readonly started: Promise<void>;
    private resolveStarted!: () => void;
    private readonly result: Promise<SummarizationOutput>;
    private resolveResult!: (result: SummarizationOutput) => void;

    constructor() {
        this.started = new Promise((resolve) => {
            this.resolveStarted = resolve;
        });
        this.result = new Promise((resolve) => {
            this.resolveResult = resolve;
        });
    }

    async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
        this.calls.push(input);
        this.resolveStarted();
        return this.result;
    }

    release(): void {
        this.resolveResult({ decisions: [{ what: 'Stale summary', why: null }], pending_items: [], status: 'ok' });
    }
}

type ScanSeam = {
    scanFile(
        adapter: SessionAdapter,
        filePath: string,
        closeTrailingOnIdle: boolean,
    ): Promise<{ ingested: number; skipped?: { category: string } }>;
};

type FileEventSeam = { onFileEvent(filePath: string): void };

function scan(daemon: IngestionDaemon): ScanSeam {
    return daemon as unknown as ScanSeam;
}

function fileEvent(daemon: IngestionDaemon): FileEventSeam {
    return daemon as unknown as FileEventSeam;
}

function line(timestamp: string, type: string, payload: object): string {
    return JSON.stringify({ timestamp, type, payload });
}

function failedTranscript(cwd: string, sessionId: string): string {
    return `${[
        line('2026-09-18T08:46:00.000Z', 'session_meta', { id: sessionId, cwd, originator: 'codex-desktop' }),
        line('2026-09-18T08:46:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'provider-attempt-1' }),
        line('2026-09-18T08:46:02.000Z', 'response_item', {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Investigate the issue.' }],
        }),
        line('2026-09-18T08:46:03.000Z', 'response_item', {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'Partial investigation.' }],
        }),
        line('2026-09-18T08:47:17.715Z', 'event_msg', {
            type: 'task_complete',
            turn_id: 'provider-attempt-1',
            last_agent_message: null,
            error: { message: 'Selected model is at capacity.', codex_error_info: 'server_overloaded' },
        }),
    ].join('\n')}\n`;
}

function successfulRetry(): string {
    return `${[
        line('2026-09-18T09:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 'provider-attempt-2' }),
        line('2026-09-18T09:00:01.000Z', 'response_item', {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'Recovered final answer.' }],
        }),
        line('2026-09-18T09:00:02.000Z', 'event_msg', {
            type: 'task_complete',
            turn_id: 'provider-attempt-2',
            last_agent_message: 'Recovered final answer.',
        }),
    ].join('\n')}\n`;
}

function userOnlyFailedTranscript(cwd: string, sessionId: string): string {
    return `${[
        line('2026-09-18T08:46:00.000Z', 'session_meta', { id: sessionId, cwd, originator: 'codex-desktop' }),
        line('2026-09-18T08:46:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'provider-attempt-1' }),
        line('2026-09-18T08:46:02.000Z', 'response_item', {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Investigate the issue.' }],
        }),
        line('2026-09-18T08:47:17.715Z', 'event_msg', {
            type: 'task_complete',
            turn_id: 'provider-attempt-1',
            last_agent_message: null,
            error: { message: 'Selected model is at capacity.', codex_error_info: 'server_overloaded' },
        }),
    ].join('\n')}\n`;
}

describe('daemon failed-EOF open-turn staging', () => {
    const daemons: IngestionDaemon[] = [];
    let previousCodexHome: string | undefined;

    afterEach(async () => {
        await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
    });

    it('debounces synthesis, survives restart, and replaces staging with one late canonical retry', async () => {
        const root = withTempDir('elepha-open-turn-daemon-');
        const projectPath = withGrantableTestDir('elepha-open-turn-project-');
        const sessionId = '11111111-1111-4111-8111-111111111111';
        const codexHome = path.join(root, '.codex');
        const sessionsRoot = path.join(codexHome, 'sessions');
        const transcript = path.join(sessionsRoot, '2026', '09', '18', `rollout-2026-09-18T08-46-00-${sessionId}.jsonl`);
        mkdirSync(path.dirname(transcript), { recursive: true });
        writeFileSync(transcript, failedTranscript(projectPath, sessionId));
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = codexHome;

        const dbPath = path.join(root, 'elepha.db');
        const store1 = new MemoryStore(openUnmanagedDb(dbPath));
        store1.consent.grant(projectPath);
        const summarizer1 = new RecordingSummarizer();
        let now = Date.parse('2026-09-18T08:48:00.000Z');
        const daemon1 = new IngestionDaemon({
            store: store1,
            summarizer: summarizer1,
            watchRoots: [sessionsRoot],
            now: () => now,
            readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } }),
        });
        daemons.push(daemon1);
        const adapter = new CodexAdapter();

        const beforeGrace = await scan(daemon1).scanFile(adapter, transcript, true);
        expect(beforeGrace).toMatchObject({ ingested: 0 });
        expect(beforeGrace.skipped).toBeUndefined();
        expect(summarizer1.calls).toHaveLength(0);
        expect(store1.findOpenTurn('codex', sessionId)).toMatchObject({ staged_at: null });
        expect(store1.getSessionCursor('codex', sessionId)).toBeUndefined();

        now = Date.parse('2026-09-18T08:47:17.715Z') + OPEN_TURN_SUMMARY_GRACE_MS + 1;
        await scan(daemon1).scanFile(adapter, transcript, true);
        await scan(daemon1).scanFile(adapter, transcript, true);
        expect(summarizer1.calls).toHaveLength(1);
        expect(store1.findOpenTurn('codex', sessionId)?.staged_at).not.toBeNull();
        expect(store1.getSessionCursor('codex', sessionId)).toBeUndefined();
        expect(store1.listRecentMemories(store1.findProject(projectPath)!.id, 10)).toEqual([]);

        await daemon1.stop();
        const store2 = new MemoryStore(openUnmanagedDb(dbPath));
        const summarizer2 = new RecordingSummarizer();
        const daemon2 = new IngestionDaemon({
            store: store2,
            summarizer: summarizer2,
            watchRoots: [sessionsRoot],
            now: () => now,
            readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } }),
        });
        daemons.push(daemon2);

        await scan(daemon2).scanFile(adapter, transcript, true);
        expect(summarizer2.calls).toHaveLength(0);
        appendFileSync(transcript, successfulRetry());
        const finalized = await scan(daemon2).scanFile(adapter, transcript, true);

        expect(finalized).toMatchObject({ ingested: 1 });
        expect(summarizer2.calls).toHaveLength(1);
        expect(store2.findOpenTurn('codex', sessionId)).toBeUndefined();
        expect(store2.listRecentMemories(store2.findProject(projectPath)!.id, 10)).toHaveLength(1);
        expect(store2.findSession('codex', sessionId)?.cursor).toBeDefined();
    });

    it('hides same-stat rewrites immediately and rejects an in-flight stale summary after a file event', async () => {
        const root = withTempDir('elepha-open-turn-barrier-');
        const projectPath = withGrantableTestDir('elepha-open-turn-barrier-project-');
        const sessionId = '22222222-2222-4222-8222-222222222222';
        const codexHome = path.join(root, '.codex');
        const sessionsRoot = path.join(codexHome, 'sessions');
        const transcript = path.join(sessionsRoot, '2026', '09', '18', `rollout-2026-09-18T08-46-00-${sessionId}.jsonl`);
        mkdirSync(path.dirname(transcript), { recursive: true });
        writeFileSync(transcript, failedTranscript(projectPath, sessionId));
        const fixedMtime = new Date('2026-09-18T08:47:18.000Z');
        utimesSync(transcript, fixedMtime, fixedMtime);
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = codexHome;

        const store = new MemoryStore(openUnmanagedDb(path.join(root, 'elepha.db')));
        store.consent.grant(projectPath);
        const now = Date.parse('2026-09-18T08:47:17.715Z') + OPEN_TURN_SUMMARY_GRACE_MS + 1;
        const firstDaemon = new IngestionDaemon({
            store,
            summarizer: new RecordingSummarizer(),
            watchRoots: [sessionsRoot],
            now: () => now,
            readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } }),
        });
        daemons.push(firstDaemon);
        const adapter = new CodexAdapter();
        await scan(firstDaemon).scanFile(adapter, transcript, true);
        const storedSession = store.findSession('codex', sessionId)!;
        expect(new SessionReader(store.database).incompleteLastObservedFor({ id: storedSession.id })).toBeDefined();
        await firstDaemon.stop();

        const blocking = new BlockingSummarizer();
        const secondDaemon = new IngestionDaemon({
            store,
            summarizer: blocking,
            watchRoots: [sessionsRoot],
            now: () => now,
            readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } }),
        });
        daemons.push(secondDaemon);
        const originalStat = statSync(transcript);
        writeFileSync(transcript, failedTranscript(projectPath, sessionId).replace('Partial investigation.', 'Changed investigation.'));
        utimesSync(transcript, originalStat.atime, originalStat.mtime);
        expect(statSync(transcript)).toMatchObject({
            dev: originalStat.dev,
            ino: originalStat.ino,
            size: originalStat.size,
            mtimeMs: originalStat.mtimeMs,
        });

        const inFlight = scan(secondDaemon).scanFile(adapter, transcript, true);
        await blocking.started;
        expect(new SessionReader(store.database).incompleteLastObservedFor({ id: storedSession.id })).toBeUndefined();

        const changedStat = statSync(transcript);
        writeFileSync(transcript, failedTranscript(projectPath, sessionId).replace('Partial investigation.', 'Altered investigation.'));
        utimesSync(transcript, changedStat.atime, changedStat.mtime);
        fileEvent(secondDaemon).onFileEvent(transcript);
        const invalidated = store.findOpenTurn('codex', sessionId)!;
        expect(invalidated.validated_epoch).not.toBe(invalidated.validation_epoch);
        expect(new SessionReader(store.database).incompleteLastObservedFor({ id: storedSession.id })).toBeUndefined();

        blocking.release();
        await inFlight;
        expect(store.findOpenTurn('codex', sessionId)?.staged_at).toBeNull();
    });

    it('advances the cursor and removes staging when a user-only failed turn is aborted', async () => {
        const root = withTempDir('elepha-open-turn-abort-');
        const projectPath = withGrantableTestDir('elepha-open-turn-abort-project-');
        const sessionId = '33333333-3333-4333-8333-333333333333';
        const codexHome = path.join(root, '.codex');
        const sessionsRoot = path.join(codexHome, 'sessions');
        const transcript = path.join(sessionsRoot, '2026', '09', '18', `rollout-2026-09-18T08-46-00-${sessionId}.jsonl`);
        mkdirSync(path.dirname(transcript), { recursive: true });
        writeFileSync(transcript, userOnlyFailedTranscript(projectPath, sessionId));
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = codexHome;

        const store = new MemoryStore(openUnmanagedDb(path.join(root, 'elepha.db')));
        store.consent.grant(projectPath);
        const summarizer = new RecordingSummarizer();
        const now = Date.parse('2026-09-18T08:47:17.715Z') + OPEN_TURN_SUMMARY_GRACE_MS + 1;
        const daemon = new IngestionDaemon({
            store,
            summarizer,
            watchRoots: [sessionsRoot],
            now: () => now,
            readConfig: () => ({ config: DEFAULT_MEMORY_CONFIG }),
        });
        daemons.push(daemon);
        const adapter = new CodexAdapter();

        await scan(daemon).scanFile(adapter, transcript, true);
        expect(store.findOpenTurn('codex', sessionId)?.staged_at).not.toBeNull();
        appendFileSync(
            transcript,
            `${line('2026-09-18T08:48:00.000Z', 'event_msg', {
                type: 'turn_aborted',
                turn_id: 'provider-attempt-1',
                reason: 'interrupted',
            })}\n`,
        );

        await scan(daemon).scanFile(adapter, transcript, true);
        expect(store.findOpenTurn('codex', sessionId)).toBeUndefined();
        expect(store.getSessionCursor('codex', sessionId)).toBeDefined();
        expect(store.listRecentMemories(store.findProject(projectPath)!.id, 10)).toEqual([]);
        expect(summarizer.calls).toHaveLength(1);
    });
});
