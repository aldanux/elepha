import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { wrap } from '../../src/security/sentinel.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn, SessionAdapter, SummarizationInput, SummarizationOutput, SummarizationProvider } from '../../src/types/index.js';
import { withTempDir } from '../helpers/tmp.js';

class CountingSummarizer implements SummarizationProvider {
    calls: SummarizationInput[] = [];

    async summarize(input: SummarizationInput): Promise<SummarizationOutput> {
        this.calls.push(input);
        return { decisions: [], pending_items: [], status: 'ok' };
    }
}

type DaemonSeam = {
    scanFile(adapter: SessionAdapter, filePath: string, closeTrailingOnIdle: boolean): Promise<{ ingested: number }>;
    persistTurn(adapter: SessionAdapter, turn: ParsedTurn): Promise<boolean>;
};

const PROJECT = '/Users/test/rule4-project';
const SESSION = '019ff033-9dec-7f73-ba44-b76ac18116de';

function claudeTranscript(body: string): string {
    return [
        { type: 'user', timestamp: '2026-08-17T10:00:00.000Z', cwd: PROJECT, sessionId: SESSION, message: { role: 'user', content: body } },
        {
            type: 'assistant',
            timestamp: '2026-08-17T10:00:01.000Z',
            cwd: PROJECT,
            sessionId: SESSION,
            message: { role: 'assistant', content: [{ type: 'text', text: 'Acknowledged.' }] },
        },
    ]
        .map((line) => JSON.stringify(line))
        .join('\n')
        .concat('\n');
}

function codexTranscript(body: string, additionalContext?: string): string {
    return [
        {
            type: 'session_meta',
            timestamp: '2026-08-17T10:00:00.000Z',
            payload: { session_id: SESSION, cwd: PROJECT, originator: 'codex-tui', thread_source: 'user' },
        },
        ...(additionalContext
            ? [
                  {
                      type: 'response_item',
                      timestamp: '2026-08-17T10:00:00.500Z',
                      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: additionalContext }] },
                  },
              ]
            : []),
        {
            type: 'response_item',
            timestamp: '2026-08-17T10:00:01.000Z',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] },
        },
        {
            type: 'response_item',
            timestamp: '2026-08-17T10:00:02.000Z',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Acknowledged.' }] },
        },
    ]
        .map((line) => JSON.stringify(line))
        .join('\n')
        .concat('\n');
}

describe('Rule 4 self-ingestion guard', () => {
    let previousClaudeConfig: string | undefined;
    let previousCodexHome: string | undefined;

    afterEach(() => {
        if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
    });

    it.each([
        ['claude-code', ClaudeCodeAdapter, claudeTranscript],
        ['codex', CodexAdapter, codexTranscript],
    ] as const)('drops sentinel content for %s, logs once, and advances its cursor', async (_tool, Adapter, transcript) => {
        const root = withTempDir('elepha-rule4-');
        previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        process.env.CODEX_HOME = path.join(root, '.codex');
        const isClaude = Adapter === ClaudeCodeAdapter;
        const watchRoot = isClaude ? path.join(root, '.claude', 'projects') : path.join(root, '.codex', 'sessions');
        const file = isClaude
            ? path.join(watchRoot, 'project', `${SESSION}.jsonl`)
            : path.join(watchRoot, '2026', '08', '17', `rollout-2026-08-17T10-00-00-${SESSION}.jsonl`);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, transcript(wrap('brief', '01J00000000000000000000000', 'Do not re-ingest this context.')));

        const logs: string[] = [];
        const store = new MemoryStore(openUnmanagedDb(path.join(root, 'elepha.db')));
        store.consent.grant(PROJECT);
        const adapter = new Adapter((message) => logs.push(message));
        const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [watchRoot], log: (message) => logs.push(message) });

        expect(await (daemon as unknown as DaemonSeam).scanFile(adapter, file, true)).toEqual({ ingested: 0 });
        const project = store.findProject(PROJECT)!;
        expect(store.listRecentMemories(project.id, 10)).toHaveLength(0);
        expect(store.getSessionCursor(adapter.tool, adapter.nativeSessionId(file))).toContain('|1|');
        expect(
            logs.filter(
                (message) => message === `[elepha] dropped turn 0 of ${adapter.nativeSessionId(file)}: self-injected content (sentinel)`,
            ),
        ).toHaveLength(1);
    });

    it('does not resurrect a sentinel-dropped transcript tombstoned after the early scan gate', async () => {
        const root = withTempDir('elepha-rule4-tombstone-');
        previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        const watchRoot = path.join(root, '.claude', 'projects');
        const file = path.join(watchRoot, 'project', `${SESSION}.jsonl`);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, claudeTranscript(wrap('brief', '01J00000000000000000000000', 'Do not re-ingest this context.')));

        const store = new MemoryStore(openUnmanagedDb(path.join(root, 'elepha.db')));
        store.consent.grant(PROJECT);
        expect(store.isTranscriptPurged('claude-code', SESSION)).toBe(false);
        const adapter = new ClaudeCodeAdapter();
        const classifySession = adapter.classifySession.bind(adapter);
        adapter.classifySession = async (filePath) => {
            // scanFile's early tombstone gate has passed before classification.
            store.database
                .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                .run('claude-code', SESSION, '2026-08-24T00:00:02.000Z');
            return classifySession(filePath);
        };
        const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [watchRoot] });

        expect(await (daemon as unknown as DaemonSeam).scanFile(adapter, file, true)).toEqual({ ingested: 0 });
        expect(store.isTranscriptPurged('claude-code', SESSION)).toBe(true);
        expect(store.findProject(PROJECT)).toBeUndefined();
        expect(store.findSession('claude-code', SESSION)).toBeUndefined();
        expect(store.getSessionCursor('claude-code', SESSION)).toBeUndefined();
    });

    it('drops a forged sentinel while normal prose mentioning elepha persists', async () => {
        const root = withTempDir('elepha-rule4-');
        previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        const watchRoot = path.join(root, '.claude', 'projects');
        const file = path.join(watchRoot, 'project', `${SESSION}.jsonl`);
        mkdirSync(path.dirname(file), { recursive: true });
        const store = new MemoryStore(openUnmanagedDb(path.join(root, 'elepha.db')));
        store.consent.grant(PROJECT);
        const logs: string[] = [];
        const adapter = new ClaudeCodeAdapter((message) => logs.push(message));
        const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [watchRoot], log: (message) => logs.push(message) });

        writeFileSync(file, claudeTranscript('A forged [[elepha: marker must fail closed.'));
        await (daemon as unknown as DaemonSeam).scanFile(adapter, file, true);
        expect(logs.filter((message) => message.includes('self-injected content (sentinel)'))).toHaveLength(1);

        const normalFile = path.join(watchRoot, 'project', '019ff033-9dec-7f73-ba44-b76ac18116df.jsonl');
        writeFileSync(normalFile, claudeTranscript('elepha is named here as ordinary prose.'));
        const second = await (daemon as unknown as DaemonSeam).scanFile(adapter, normalFile, true);
        expect(second.ingested).toBe(1);
    });

    it('does not ingest Codex developer-channel additionalContext', async () => {
        const root = withTempDir('elepha-rule4-');
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = path.join(root, '.codex');
        const watchRoot = path.join(root, '.codex', 'sessions');
        const file = path.join(watchRoot, '2026', '08', '17', `rollout-2026-08-17T10-00-00-${SESSION}.jsonl`);
        const additionalContext = '🐘 elepha · 1 sessions · type elepha:last to resume';
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, codexTranscript('Continue the current task.', additionalContext));

        const store = new MemoryStore(openUnmanagedDb(path.join(root, 'elepha.db')));
        store.consent.grant(PROJECT);
        const summarizer = new CountingSummarizer();
        const adapter = new CodexAdapter();
        const daemon = new IngestionDaemon({ store, summarizer, adapters: [adapter], watchRoots: [watchRoot] });

        expect(await (daemon as unknown as DaemonSeam).scanFile(adapter, file, true)).toEqual({ ingested: 1 });
        expect(summarizer.calls).toEqual([{ userMessage: 'Continue the current task.', assistantText: 'Acknowledged.' }]);
        expect(JSON.stringify(summarizer.calls)).not.toContain(additionalContext);
    });

    it('preserves the Codex lifecycle across incremental cursors before a later Elepha MCP call', async () => {
        const root = withTempDir('elepha-rule4-codex-lifecycle-');
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = path.join(root, '.codex');
        const watchRoot = path.join(root, '.codex', 'sessions');
        const file = path.join(watchRoot, '2026', '09', '17', `rollout-2026-09-17T10-00-00-${SESSION}.jsonl`);
        mkdirSync(path.dirname(file), { recursive: true });
        const currentStart = {
            timestamp: '2026-09-17T10:00:04.000Z',
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'provider-turn-2' },
        };
        const initial = [
            {
                timestamp: '2026-09-17T10:00:00.000Z',
                type: 'session_meta',
                payload: { id: SESSION, cwd: PROJECT, originator: 'codex-desktop' },
            },
            {
                timestamp: '2026-09-17T10:00:00.100Z',
                type: 'event_msg',
                payload: { type: 'task_started', turn_id: 'provider-turn-1' },
            },
            {
                timestamp: '2026-09-17T10:00:00.200Z',
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Finish ordinary work.' }] },
            },
            {
                timestamp: '2026-09-17T10:00:01.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    phase: 'final_answer',
                    content: [{ type: 'output_text', text: 'Ordinary work is complete.' }],
                },
            },
            {
                timestamp: '2026-09-17T10:00:02.000Z',
                type: 'event_msg',
                payload: { type: 'task_complete', turn_id: 'provider-turn-1' },
            },
            currentStart,
            {
                timestamp: '2026-09-17T10:00:04.100Z',
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Recover the decision.' }] },
            },
            {
                timestamp: '2026-09-17T10:00:04.200Z',
                type: 'turn_context',
                payload: { cwd: PROJECT },
            },
        ];
        writeFileSync(file, `${initial.map((line) => JSON.stringify(line)).join('\n')}\n`);

        const store = new MemoryStore(openUnmanagedDb(path.join(root, 'elepha.db')));
        store.consent.grant(PROJECT);
        const summarizer = new CountingSummarizer();
        const adapter = new CodexAdapter();
        const daemon = new IngestionDaemon({ store, summarizer, adapters: [adapter], watchRoots: [watchRoot] });
        const scan = daemon as unknown as DaemonSeam;

        expect(await scan.scanFile(adapter, file, false)).toEqual({ ingested: 1 });
        expect(store.database.prepare('SELECT turn_index FROM memories').all()).toEqual([{ turn_index: 0 }]);
        const cursorAfterBoundary = store.getSessionCursor('codex', SESSION)!;
        const cursorOffset = Number(cursorAfterBoundary.split('|')[0]);
        expect(readFileSync(file).subarray(cursorOffset).toString('utf8').startsWith(JSON.stringify(currentStart))).toBe(true);
        expect(summarizer.calls).toHaveLength(1);

        const ordinaryWork = [
            {
                timestamp: '2026-09-17T10:00:05.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    phase: 'commentary',
                    content: [{ type: 'output_text', text: 'I will inspect the local evidence.' }],
                },
            },
            {
                timestamp: '2026-09-17T10:00:06.000Z',
                type: 'response_item',
                payload: { type: 'custom_tool_call', name: 'exec', input: '{}', call_id: 'ordinary-exec' },
            },
            {
                timestamp: '2026-09-17T10:00:07.000Z',
                type: 'response_item',
                payload: { type: 'custom_tool_call_output', call_id: 'ordinary-exec', output: 'ordinary output' },
            },
        ];
        appendFileSync(file, `${ordinaryWork.map((line) => JSON.stringify(line)).join('\n')}\n`);

        expect((await scan.scanFile(adapter, file, true)).ingested).toBe(0);
        expect(store.database.prepare('SELECT turn_index FROM memories').all()).toEqual([{ turn_index: 0 }]);
        expect(store.getSessionCursor('codex', SESSION)).toBe(cursorAfterBoundary);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').get()).toEqual({ count: 0 });
        expect(summarizer.calls).toHaveLength(1);

        const completion = [
            {
                timestamp: '2026-09-17T10:00:08.000Z',
                type: 'response_item',
                payload: { type: 'custom_tool_call', name: 'exec', input: '{}', call_id: 'elepha-exec' },
            },
            {
                timestamp: '2026-09-17T10:00:09.000Z',
                type: 'event_msg',
                payload: {
                    type: 'item_completed',
                    turn_id: 'provider-turn-2',
                    item: {
                        type: 'McpToolCall',
                        id: 'elepha-call-1',
                        server: 'elepha',
                        tool: 'recall',
                        status: 'completed',
                        result: { content: [{ type: 'text', text: 'verified receipt body' }] },
                    },
                },
            },
            {
                timestamp: '2026-09-17T10:00:10.000Z',
                type: 'response_item',
                payload: { type: 'custom_tool_call_output', call_id: 'elepha-exec', output: 'outer output' },
            },
            {
                timestamp: '2026-09-17T10:00:11.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    phase: 'final_answer',
                    content: [{ type: 'output_text', text: 'The recovered decision.' }],
                },
            },
            {
                timestamp: '2026-09-17T10:00:12.000Z',
                type: 'event_msg',
                payload: { type: 'task_complete', turn_id: 'provider-turn-2' },
            },
        ];
        appendFileSync(file, `${completion.map((line) => JSON.stringify(line)).join('\n')}\n`);

        expect(await scan.scanFile(adapter, file, true)).toEqual({ ingested: 0 });
        expect(store.database.prepare('SELECT turn_index FROM memories').all()).toEqual([{ turn_index: 0 }]);
        expect(store.database.prepare('SELECT call_id, body FROM mcp_receipts').all()).toEqual([
            { call_id: 'elepha-call-1', body: 'verified receipt body' },
        ]);
        expect(store.getSessionCursor('codex', SESSION)).toContain('|2|');
        expect(summarizer.calls).toHaveLength(1);
    });

    it('keeps one Codex turn open across an unsuccessful provider attempt and automatic retry', async () => {
        const root = withTempDir('elepha-codex-provider-retry-');
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = path.join(root, '.codex');
        const watchRoot = path.join(root, '.codex', 'sessions');
        const file = path.join(watchRoot, '2026', '09', '18', `rollout-2026-09-18T08-00-00-${SESSION}.jsonl`);
        mkdirSync(path.dirname(file), { recursive: true });
        const initial = [
            {
                timestamp: '2026-09-18T08:46:00.000Z',
                type: 'session_meta',
                payload: { id: SESSION, cwd: PROJECT, originator: 'codex-desktop' },
            },
            {
                timestamp: '2026-09-18T08:46:01.000Z',
                type: 'event_msg',
                payload: { type: 'task_started', turn_id: 'provider-attempt-1' },
            },
            {
                timestamp: '2026-09-18T08:46:02.000Z',
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Complete the investigation.' }] },
            },
            {
                timestamp: '2026-09-18T08:46:02.100Z',
                type: 'turn_context',
                payload: { turn_id: 'provider-attempt-1', cwd: PROJECT },
            },
            {
                timestamp: '2026-09-18T08:46:03.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    phase: 'commentary',
                    content: [{ type: 'output_text', text: 'I found the first half.' }],
                },
            },
            {
                timestamp: '2026-09-18T08:46:04.000Z',
                type: 'response_item',
                payload: { type: 'custom_tool_call', name: 'exec', input: '{}', call_id: 'attempt-1-tool' },
            },
            {
                timestamp: '2026-09-18T08:46:05.000Z',
                type: 'response_item',
                payload: { type: 'custom_tool_call_output', call_id: 'attempt-1-tool', output: 'first result' },
            },
        ];
        writeFileSync(file, `${initial.map((line) => JSON.stringify(line)).join('\n')}\n`);

        const store = new MemoryStore(openUnmanagedDb(path.join(root, 'elepha.db')));
        store.consent.grant(PROJECT);
        const summarizer = new CountingSummarizer();
        const adapter = new CodexAdapter();
        const daemon = new IngestionDaemon({
            store,
            summarizer,
            adapters: [adapter],
            watchRoots: [watchRoot],
            now: () => Date.parse('2026-09-18T08:48:00.000Z'),
        });
        const scan = daemon as unknown as DaemonSeam;

        expect((await scan.scanFile(adapter, file, true)).ingested).toBe(0);
        expect(store.findSession('codex', SESSION)).toBeUndefined();
        const stableCursor = store.getSessionCursor('codex', SESSION);
        expect(stableCursor).toBeUndefined();
        expect(summarizer.calls).toHaveLength(0);

        appendFileSync(
            file,
            `${JSON.stringify({
                timestamp: '2026-09-18T08:47:17.715Z',
                type: 'event_msg',
                payload: {
                    type: 'task_complete',
                    turn_id: 'provider-attempt-1',
                    last_agent_message: null,
                    error: {
                        message: 'Selected model is at capacity. Please try a different model.',
                        codex_error_info: 'server_overloaded',
                    },
                    completed_at: 1789721237,
                    duration_ms: 76_000,
                },
            })}\n`,
        );

        expect((await scan.scanFile(adapter, file, true)).ingested).toBe(0);
        expect(store.findSession('codex', SESSION)).toMatchObject({
            cursor: null,
            last_turn_at: null,
            rendered_chars: 0,
            rendered_turns: 0,
        });
        expect(store.getSessionCursor('codex', SESSION)).toBe(stableCursor);
        expect(store.database.prepare('SELECT turn_index FROM memories').all()).toEqual([]);
        expect(store.findOpenTurn('codex', SESSION)).toMatchObject({ staged_at: null });
        expect(summarizer.calls).toHaveLength(0);

        const retry = [
            {
                timestamp: '2026-09-18T08:47:59.427Z',
                type: 'event_msg',
                payload: { type: 'task_started', turn_id: 'provider-attempt-2' },
            },
            {
                timestamp: '2026-09-18T08:47:59.442Z',
                type: 'turn_context',
                payload: { turn_id: 'provider-attempt-2', cwd: PROJECT },
            },
            {
                timestamp: '2026-09-18T08:48:15.468Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    phase: 'commentary',
                    content: [{ type: 'output_text', text: 'The automatic retry continued the investigation.' }],
                },
            },
            {
                timestamp: '2026-09-18T08:48:16.909Z',
                type: 'response_item',
                payload: { type: 'custom_tool_call', name: 'exec', input: '{}', call_id: 'attempt-2-tool' },
            },
            {
                timestamp: '2026-09-18T08:48:17.057Z',
                type: 'response_item',
                payload: { type: 'custom_tool_call_output', call_id: 'attempt-2-tool', output: 'second result' },
            },
        ];
        appendFileSync(file, `${retry.map((line) => JSON.stringify(line)).join('\n')}\n`);

        expect((await scan.scanFile(adapter, file, true)).ingested).toBe(0);
        expect(store.findSession('codex', SESSION)).toMatchObject({
            cursor: null,
            last_turn_at: null,
            rendered_chars: 0,
            rendered_turns: 0,
        });
        expect(store.getSessionCursor('codex', SESSION)).toBe(stableCursor);
        expect(store.database.prepare('SELECT turn_index FROM memories').all()).toEqual([]);
        expect(store.findOpenTurn('codex', SESSION)).toBeUndefined();
        expect(summarizer.calls).toHaveLength(0);

        const successfulCompletion = [
            {
                timestamp: '2026-09-18T08:49:00.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    phase: 'final_answer',
                    content: [{ type: 'output_text', text: 'The complete investigation is ready.' }],
                },
            },
            {
                timestamp: '2026-09-18T08:49:01.000Z',
                type: 'event_msg',
                payload: {
                    type: 'task_complete',
                    turn_id: 'provider-attempt-2',
                    last_agent_message: 'The complete investigation is ready.',
                    completed_at: 1789721341,
                    duration_ms: 62_000,
                },
            },
        ];
        appendFileSync(file, `${successfulCompletion.map((line) => JSON.stringify(line)).join('\n')}\n`);

        expect(await scan.scanFile(adapter, file, true)).toEqual({ ingested: 1 });
        expect(store.database.prepare('SELECT turn_index FROM memories').all()).toEqual([{ turn_index: 0 }]);
        expect(summarizer.calls).toHaveLength(1);
        expect(summarizer.calls[0]?.userMessage).toBe('Complete the investigation.');
        expect(summarizer.calls[0]?.assistantText).toContain('I found the first half.');
        expect(summarizer.calls[0]?.assistantText).toContain('The automatic retry continued the investigation.');
        expect(summarizer.calls[0]?.assistantText).toContain('The complete investigation is ready.');

        expect((await scan.scanFile(adapter, file, true)).ingested).toBe(0);
        expect(store.database.prepare('SELECT turn_index FROM memories').all()).toEqual([{ turn_index: 0 }]);
        expect(summarizer.calls).toHaveLength(1);
    });

    it.each(['claude-code', 'codex'] as const)(
        'drops an eligible near-verbatim quote for %s before summary or memory persistence and advances the existing cursor',
        async (tool) => {
            const store = new MemoryStore(openUnmanagedDb(':memory:'));
            store.consent.grant(PROJECT);
            const project = store.upsertProject(PROJECT);
            const session = store.upsertSession(tool, SESSION, project.id, '/tmp/rule4.jsonl');
            const body = 'The selected architecture keeps transcript capture passive and local across tools.';
            store.recordInjection({
                tool,
                nativeSessionId: SESSION,
                injectedAt: '2026-08-17T10:01:00.500Z',
                injectionId: '01J00000000000000000000000',
                body,
            });
            const summarizer = new CountingSummarizer();
            const logs: string[] = [];
            const daemon = new IngestionDaemon({ store, summarizer, log: (message) => logs.push(message) });
            const turn: ParsedTurn = {
                tool,
                sessionId: SESSION,
                sourcePath: '/tmp/rule4.jsonl',
                projectPath: PROJECT,
                turnIndex: 1,
                startedAt: '2026-08-17T10:01:00.000Z',
                endedAt: '2026-08-17T10:01:01.000Z',
                userMessage: `Please follow this: ${body}`,
                assistantText: 'Acknowledged.',
                toolCalls: [],
                cursor: '200|2|fingerprint',
                hasExternalContent: false,
                resumeMarkerBefore: false,
            };

            expect(
                await (daemon as unknown as DaemonSeam).persistTurn(
                    tool === 'claude-code' ? new ClaudeCodeAdapter() : new CodexAdapter(),
                    turn,
                ),
            ).toBe(false);
            expect(summarizer.calls).toHaveLength(0);
            expect(store.listRecentMemories(project.id, 10)).toHaveLength(0);
            expect(store.getSessionCursor(tool, SESSION)).toBe('200|2|fingerprint');
            expect(
                logs.filter(
                    (message) =>
                        message ===
                        `[elepha] dropped turn 1 of ${SESSION}: self-injected content (quote-back) tool=${tool} session_id=${SESSION}`,
                ),
            ).toHaveLength(1);
            expect(store.findSession(tool, SESSION)?.id).toBe(session.id);
        },
    );

    it('does not suppress same-turn content from another tool, another session, or a nearby nonmatch', async () => {
        const store = new MemoryStore(openUnmanagedDb(':memory:'));
        store.consent.grant(PROJECT);
        const exactBody = 'The selected architecture keeps transcript capture passive and local across tools.';
        const scopedInjection = {
            injectedAt: '2026-08-17T10:01:00.500Z',
            injectionId: '01J00000000000000000000000',
            body: exactBody,
        };
        expect(
            store.recordInjection({
                ...scopedInjection,
                tool: 'codex',
                nativeSessionId: SESSION,
            }),
        ).toBe(true);
        expect(
            store.recordInjection({
                ...scopedInjection,
                tool: 'claude-code',
                nativeSessionId: 'other-session',
            }),
        ).toBe(true);
        expect(
            store.recordInjection({
                ...scopedInjection,
                tool: 'claude-code',
                nativeSessionId: SESSION,
                body: 'The nearby architecture keeps browser cleanup manual and remote across unrelated teams.',
            }),
        ).toBe(true);
        expect(
            store.recordInjection({
                ...scopedInjection,
                tool: 'claude-code',
                nativeSessionId: SESSION,
                injectedAt: '2026-08-17T10:01:02.000Z',
            }),
        ).toBe(true);
        const summarizer = new CountingSummarizer();
        const daemon = new IngestionDaemon({ store, summarizer });
        const turn: ParsedTurn = {
            tool: 'claude-code',
            sessionId: SESSION,
            sourcePath: '/tmp/rule4-control.jsonl',
            projectPath: PROJECT,
            turnIndex: 0,
            startedAt: '2026-08-17T10:01:00.000Z',
            endedAt: '2026-08-17T10:01:01.000Z',
            userMessage: `A different scoped injection said: ${exactBody}`,
            assistantText: 'Continue with the nearby but nonmatching value.',
            toolCalls: [],
            cursor: '100|1|control',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        };

        expect(await (daemon as unknown as DaemonSeam).persistTurn(new ClaudeCodeAdapter(), turn)).toBe(true);
        expect(summarizer.calls).toHaveLength(1);
        expect(store.findSession('claude-code', SESSION)).toBeDefined();
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
    });
});
