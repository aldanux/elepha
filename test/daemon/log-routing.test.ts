import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import type { RollupService } from '../../src/daemon/rollup-service.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn, SessionAdapter, SessionClassification } from '../../src/types/index.js';

describe('daemon log routing', () => {
    let daemon: IngestionDaemon | undefined;

    afterEach(async () => {
        await daemon?.stop();
    });

    it('routes failures to logError, keeps lifecycle and captures on log, and attributes session-scoped lines', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-daemon-log-routing-'));
        const sourcePath = path.join(root, 'native-session.jsonl');
        const logs: string[] = [];
        const errors: string[] = [];
        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        store.consent.grant('/repo');
        const rollupService = {
            noteActivity(): void {},
            async rollupSession(): Promise<never> {
                throw new Error('forced rollup failure');
            },
        } as unknown as RollupService;

        daemon = new IngestionDaemon({
            store,
            rollupService,
            watchRoots: [root],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            updateCheck: () => undefined,
            log: (message) => logs.push(message),
            logError: (message) => errors.push(message),
        });
        daemon.start();

        expect(logs).toContain(`[elepha] watching:\n  ${root}`);

        const adapter = { tool: 'codex' } as SessionAdapter;
        const turn: ParsedTurn = {
            tool: 'codex',
            sessionId: 'native-session',
            sourcePath,
            projectPath: '/repo',
            turnIndex: 3,
            startedAt: '2026-08-23T00:00:00.000Z',
            endedAt: '2026-08-23T00:00:01.000Z',
            userMessage: 'capture this turn',
            assistantText: 'captured',
            toolCalls: [],
            cursor: '3|4|test',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        };
        const seam = daemon as unknown as {
            persistTurn(adapter: SessionAdapter, turn: ParsedTurn): Promise<boolean>;
            refreshStoredSessionRollup(
                adapter: SessionAdapter,
                filePath: string,
                session: NonNullable<ReturnType<MemoryStore['findSession']>>,
                classification: SessionClassification,
                state: 'live' | 'final',
            ): Promise<void>;
        };

        await expect(seam.persistTurn(adapter, turn)).resolves.toBe(true);
        expect(
            logs.some(
                (message) =>
                    message.includes('[elepha] captured turn 3 (codex)') && message.endsWith('tool=codex session_id=native-session'),
            ),
        ).toBe(true);

        await seam.refreshStoredSessionRollup(
            adapter,
            sourcePath,
            store.findSession('codex', 'native-session')!,
            { kind: 'primary' },
            'live',
        );

        expect(errors).toContain('[elepha] rollup failed for native-session: forced rollup failure tool=codex session_id=native-session');
        expect(logs).not.toContain('[elepha] rollup failed for native-session: forced rollup failure tool=codex session_id=native-session');
    });
});
