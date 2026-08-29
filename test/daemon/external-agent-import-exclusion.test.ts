import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

const FIXTURE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'codex',
    'rollout-codex-v0.148.0-alpha.9-external-agent-import.jsonl',
);
const NATIVE_ID = '01a00893-b887-70f0-80be-e49a1407aeb9';

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe('external-agent import exclusion', () => {
    let daemon: IngestionDaemon | undefined;
    let previousCodexHome: string | undefined;

    afterEach(async () => {
        await daemon?.stop();
        if (previousCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = previousCodexHome;
        }
    });

    it('reports a real imported rollout in the startup summary and creates no store rows', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-external-import-'));
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = path.join(root, '.codex');

        const sessionsRoot = path.join(process.env.CODEX_HOME, 'sessions');
        const sessionDir = path.join(sessionsRoot, '2026', '08', '16');
        mkdirSync(sessionDir, { recursive: true });
        const sessionFile = path.join(sessionDir, `rollout-2026-08-16T10-18-13-${NATIVE_ID}.jsonl`);
        copyFileSync(FIXTURE, sessionFile);

        // This is intentionally a real, long Codex session_meta line. If the
        // readability guard runs before the exclusion, its known 4 KiB bug will
        // emit a warning and this test will fail without fixing that separate bug.
        expect(readFileSync(FIXTURE, 'utf8').indexOf('\n')).toBeGreaterThan(4096);

        const logs: string[] = [];
        const db = openDb(path.join(root, 'elepha.db'));
        const store = new MemoryStore(db);
        store.consent.grant('/Users/dani/Sites/elepha-app/elepha');
        daemon = new IngestionDaemon({
            store,
            idleDebounceMs: 50,
            watchRoots: [sessionsRoot],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            log: (message) => logs.push(message),
        });
        daemon.start();

        await waitFor(() => logs.some((message) => message.startsWith('[elepha] startup sweep:')));

        const skipLogs = logs.filter((message) => message.startsWith('[elepha] skipped ') && message.includes(path.basename(sessionFile)));
        expect(skipLogs).toEqual([]);
        expect(logs).toContain('[elepha] startup sweep: scanned 1 file(s), ingested 0 turn(s), skipped 1 file(s) (excluded session: 1)');
        expect(
            logs.some((message) => message.includes(path.basename(sessionFile)) && message.includes('not readable as plain-text JSONL')),
        ).toBe(false);
        expect(store.findSession('codex', NATIVE_ID)).toBeUndefined();
        expect((db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
        expect((db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count).toBe(0);
    }, 15000);
});
