import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('timed out waiting for startup sweep');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe('zero-turn skip reporting', () => {
    let daemon: IngestionDaemon | undefined;
    let previousCodexHome: string | undefined;

    afterEach(async () => {
        await daemon?.stop();
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
    });

    it('reports assistant content under an unrecognized transcript shape in the startup summary', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-zero-turn-alert-'));
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = root;
        const sessionsRoot = path.join(root, 'sessions', '2026', '08', '16');
        const project = '/Users/test/elepha-zero-turn-alert';
        mkdirSync(sessionsRoot, { recursive: true });
        const filePath = path.join(sessionsRoot, 'rollout-2026-08-16T00-00-00-019fc000-0000-7000-8000-000000000099.jsonl');
        writeFileSync(
            filePath,
            `${[
                JSON.stringify({ type: 'session_meta', payload: { id: '019fc000-0000-7000-8000-000000000099', cwd: project } }),
                JSON.stringify({
                    type: 'future_response_shape',
                    payload: { role: 'assistant', content: [{ type: 'output_text', text: 'assistant content' }] },
                }),
            ].join('\n')}\n`,
        );

        const logs: string[] = [];
        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        store.consent.grant(project);
        daemon = new IngestionDaemon({
            store,
            adapters: [new CodexAdapter((message) => logs.push(message))],
            watchRoots: [path.join(root, 'sessions')],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            log: (message) => logs.push(message),
        });
        daemon.start();

        await waitFor(() => logs.some((message) => message.startsWith('[elepha] startup sweep:')));

        expect(logs.some((message) => message.startsWith('[elepha] skipped ') && message.includes(path.basename(filePath)))).toBe(false);
        expect(logs).toContain('[elepha] startup sweep: scanned 1 file(s), ingested 0 turn(s), skipped 1 file(s) (zero parsed turns: 1)');
        expect(logs.some((message) => message.includes('empty sessions'))).toBe(false);
    });
});
