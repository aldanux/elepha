import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { wrap } from '../../src/security/sentinel.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn, SessionAdapter, SummarizationInput, SummarizationOutput, SummarizationProvider } from '../../src/types/index.js';

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
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-rule4-'));
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
        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
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
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-rule4-tombstone-'));
        previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        const watchRoot = path.join(root, '.claude', 'projects');
        const file = path.join(watchRoot, 'project', `${SESSION}.jsonl`);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, claudeTranscript(wrap('brief', '01J00000000000000000000000', 'Do not re-ingest this context.')));

        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
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
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-rule4-'));
        previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        const watchRoot = path.join(root, '.claude', 'projects');
        const file = path.join(watchRoot, 'project', `${SESSION}.jsonl`);
        mkdirSync(path.dirname(file), { recursive: true });
        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
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
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-rule4-'));
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = path.join(root, '.codex');
        const watchRoot = path.join(root, '.codex', 'sessions');
        const file = path.join(watchRoot, '2026', '08', '17', `rollout-2026-08-17T10-00-00-${SESSION}.jsonl`);
        const additionalContext = '🐘 elepha · 1 sessions · type elepha:last to resume';
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, codexTranscript('Continue the current task.', additionalContext));

        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        store.consent.grant(PROJECT);
        const summarizer = new CountingSummarizer();
        const adapter = new CodexAdapter();
        const daemon = new IngestionDaemon({ store, summarizer, adapters: [adapter], watchRoots: [watchRoot] });

        expect(await (daemon as unknown as DaemonSeam).scanFile(adapter, file, true)).toEqual({ ingested: 1 });
        expect(summarizer.calls).toEqual([{ userMessage: 'Continue the current task.', assistantText: 'Acknowledged.' }]);
        expect(JSON.stringify(summarizer.calls)).not.toContain(additionalContext);
    });

    it.each(['claude-code', 'codex'] as const)(
        'drops an eligible near-verbatim quote for %s before summary or memory persistence and advances the existing cursor',
        async (tool) => {
            const store = new MemoryStore(openDb(':memory:'));
            store.consent.grant(PROJECT);
            const project = store.upsertProject(PROJECT);
            const session = store.upsertSession(tool, SESSION, project.id, '/tmp/rule4.jsonl');
            const body = 'The selected architecture keeps transcript capture passive and local across tools.';
            store.recordInjection({
                tool,
                nativeSessionId: SESSION,
                injectedAt: '2026-08-17T10:00:00.000Z',
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
});
