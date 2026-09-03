import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

function claudeTranscript(cwd: string, sessionId: string): string {
    return `${JSON.stringify({
        type: 'user',
        parentUuid: null,
        isSidechain: false,
        message: { role: 'user', content: 'Claude request' },
        uuid: 'user-1',
        timestamp: '2026-08-20T00:00:00.000Z',
        cwd,
        sessionId,
    })}\n${JSON.stringify({
        type: 'assistant',
        parentUuid: 'user-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Claude response' }] },
        uuid: 'assistant-1',
        timestamp: '2026-08-20T00:00:01.000Z',
        cwd,
        sessionId,
    })}\n`;
}

function codexTranscript(cwd: string, sessionId: string): string {
    return `${JSON.stringify({
        timestamp: '2026-08-20T00:00:00.000Z',
        type: 'session_meta',
        payload: { session_id: sessionId, cwd, originator: 'codex-tui', thread_source: 'user' },
    })}\n${JSON.stringify({
        timestamp: '2026-08-20T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex request' }] },
    })}\n${JSON.stringify({
        timestamp: '2026-08-20T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex response' }] },
    })}\n`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('timed out waiting for startup sweep');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe('per-tool capture toggle', () => {
    let daemon: IngestionDaemon | undefined;
    let previousClaudeConfigDir: string | undefined;
    let previousCodexHome: string | undefined;

    afterEach(async () => {
        await daemon?.stop();
        if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
    });

    it('skips Codex-store files while continuing to ingest Claude Code when Codex capture is disabled', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-capture-toggle-'));
        const claudeRoot = path.join(root, '.claude', 'projects');
        const codexRoot = path.join(root, '.codex', 'sessions');
        const claudeProject = '/Users/test/capture-toggle-claude';
        const codexProject = '/Users/test/capture-toggle-codex';
        const claudeSessionId = 'claude-capture-toggle';
        const codexSessionId = '11111111-2222-3333-4444-555555555555';
        const claudeFile = path.join(claudeRoot, 'capture-toggle', `${claudeSessionId}.jsonl`);
        const codexFile = path.join(codexRoot, '2026', '08', '20', `rollout-2026-08-20T00-00-00-${codexSessionId}.jsonl`);
        mkdirSync(path.dirname(claudeFile), { recursive: true });
        mkdirSync(path.dirname(codexFile), { recursive: true });
        writeFileSync(claudeFile, claudeTranscript(claudeProject, claudeSessionId));
        writeFileSync(codexFile, codexTranscript(codexProject, codexSessionId));

        previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        process.env.CODEX_HOME = path.join(root, '.codex');

        const logs: string[] = [];
        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        store.consent.grant(claudeProject);
        store.consent.grant(codexProject);
        daemon = new IngestionDaemon({
            store,
            watchRoots: [claudeRoot, codexRoot],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            log: (message) => logs.push(message),
            readConfig: () => ({
                config: { ...DEFAULT_MEMORY_CONFIG, captureClaudeCode: true, captureCodex: false, durableCapture: true },
            }),
        });
        daemon.start();

        await waitFor(() => logs.some((message) => message.startsWith('[elepha] startup sweep:')));

        expect(store.findSession('claude-code', claudeSessionId)).toBeDefined();
        expect(store.findSession('codex', codexSessionId)).toBeUndefined();
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 1 });
        expect(store.database.prepare('SELECT state FROM durable_capture_status').get()).toEqual({ state: 'complete' });
        expect(logs).not.toContain(`[elepha] skipped ${codexFile}: capture is disabled for codex`);
        expect(logs.some((message) => message.includes('capture disabled: 1'))).toBe(true);
    });
});
