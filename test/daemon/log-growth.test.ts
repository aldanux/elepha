import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { DAEMON_LOG_ROTATE_MAX_BYTES } from '../../src/daemon/log-rotation.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn, SessionAdapter } from '../../src/types/index.js';

async function drain(iter: AsyncIterable<ParsedTurn>): Promise<void> {
    for await (const _ of iter) void _;
}

describe('IngestionDaemon log growth bounds', () => {
    const daemons: IngestionDaemon[] = [];

    afterEach(async () => {
        await Promise.all(daemons.map((daemon) => daemon.stop()));
        daemons.length = 0;
    });

    it('emits each default-adapter unknown-line warning once, but preserves a distinct type or file warning', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-daemon-log-growth-'));
        const firstFile = path.join(root, 'first.jsonl');
        const secondFile = path.join(root, 'second.jsonl');
        writeFileSync(
            firstFile,
            `${JSON.stringify({ type: 'new-format', sessionId: 'sid', cwd: '/x', timestamp: '2026-08-01T00:00:00.000Z' })}\n`.repeat(2),
        );
        writeFileSync(
            secondFile,
            `${JSON.stringify({ type: 'another-format', sessionId: 'sid', cwd: '/x', timestamp: '2026-08-01T00:00:00.000Z' })}\n`,
        );
        const logs: string[] = [];
        const daemon = new IngestionDaemon({
            store: new MemoryStore(openDb(':memory:')),
            watchRoots: [root],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            log: (message) => logs.push(message),
        });
        daemons.push(daemon);

        const adapters = (daemon as unknown as { adapters: SessionAdapter[] }).adapters;
        const adapter = adapters.find((candidate) => candidate instanceof ClaudeCodeAdapter)!;
        await drain(adapter.parseTurns(firstFile, undefined, { closeTrailingOnIdle: true }));
        await drain(adapter.parseTurns(secondFile, undefined, { closeTrailingOnIdle: true }));

        expect(logs).toHaveLength(2);
        expect(logs).toContain(`ClaudeCodeAdapter: unrecognized line type "new-format" in ${firstFile}`);
        expect(logs).toContain(`ClaudeCodeAdapter: unrecognized line type "another-format" in ${secondFile}`);
    });

    it('rotates oversized launchd logs to one archive and recreates empty primaries at startup', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-daemon-log-rotation-'));
        const stdout = path.join(root, 'daemon.stdout.log');
        const stderr = path.join(root, 'daemon.stderr.log');
        writeFileSync(stdout, 'current stdout'.repeat(Math.ceil((DAEMON_LOG_ROTATE_MAX_BYTES + 1) / 14)));
        writeFileSync(stderr, 'current stderr'.repeat(Math.ceil((DAEMON_LOG_ROTATE_MAX_BYTES + 1) / 14)));
        writeFileSync(`${stdout}.1`, 'older stdout archive');
        writeFileSync(`${stderr}.1`, 'older stderr archive');

        const daemon = new IngestionDaemon({
            store: new MemoryStore(openDb(':memory:')),
            watchRoots: [root],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            daemonLogPaths: { stdout, stderr },
        });
        daemons.push(daemon);
        daemon.start();

        for (const primary of [stdout, stderr]) {
            expect(statSync(primary).size).toBe(0);
            expect(readFileSync(`${primary}.1`, 'utf8')).toMatch(/^current /);
            expect(existsSync(`${primary}.2`)).toBe(false);
        }
    });
});
