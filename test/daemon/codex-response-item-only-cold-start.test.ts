import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

const SOURCE_FIXTURE = path.join(
    __dirname,
    '..',
    'fixtures',
    'codex',
    'rollout-2026-08-11T16-42-22-019ff033-9dec-7f73-ba44-b76ac18116de-response-item-only.jsonl',
);

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('timed out waiting for cold-start sweep');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe('Codex response_item-only cold start', () => {
    let daemon: IngestionDaemon | undefined;
    let previousCodexHome: string | undefined;

    afterEach(async () => {
        await daemon?.stop();
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
    });

    it('ingests the trimmed real no-event_msg rollout with no existing cursor', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-codex-cold-start-'));
        const codexHome = path.join(root, '.codex');
        const sessionsRoot = path.join(codexHome, 'sessions');
        const rollout = path.join(sessionsRoot, '2026', '08', '11', path.basename(SOURCE_FIXTURE));
        mkdirSync(path.dirname(rollout), { recursive: true });
        copyFileSync(SOURCE_FIXTURE, rollout);
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = codexHome;

        const logs: string[] = [];
        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        store.consent.grant('/Users/test/demo-project');
        daemon = new IngestionDaemon({
            store,
            watchRoots: [sessionsRoot],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            log: (message) => logs.push(message),
        });
        daemon.start();

        await waitFor(() => logs.some((message) => message.startsWith('[elepha] startup sweep:')));

        const project = store.findProject('/Users/test/demo-project');
        expect(project, logs.join('\n')).toBeDefined();
        expect(store.listRecentMemories(project!.id, 10)).toHaveLength(1);
        expect(logs).toContain('[elepha] startup sweep: scanned 1 file(s), ingested 1 turn(s), skipped 0 file(s) (none)');
        expect(logs.some((message) => message.includes('parsed successfully but yielded zero turns'))).toBe(false);
    });
});
