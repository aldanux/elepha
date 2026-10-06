import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { registerReingest } from '../../src/cli/commands/reingest.js';
import { readMemoryConfig } from '../../src/config/memory-config.js';
import { elephaConfigPath } from '../../src/config/paths.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import type { SessionAdapter, SummarizationOutput } from '../../src/types/index.js';
import { createTestDb } from '../helpers/db.js';
import { expectLiveMemoryCurrent } from '../helpers/live-memory.js';

const mocks = vi.hoisted(() => ({ summarize: vi.fn() }));

// Reingest keeps its existing synthesis-provider requirement; the provider is
// stubbed so only the capture policy is under test.
vi.mock('../../src/summarizer/provider-config.js', () => ({
    createConfiguredSynthesisProviders: () => ({
        name: 'test',
        turnExtraction: { summarize: mocks.summarize },
        rollupMerge: {},
    }),
}));

const NATIVE_ID = '019fa000-0000-7000-8000-0000000000c1';

function codexTranscript(cwd: string, answer: string, timestamp: string): string {
    return [
        { type: 'session_meta', payload: { id: NATIVE_ID, cwd, originator: 'codex-tui' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Which ledger format?' } },
        {
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] },
        },
    ]
        .map((record) => `${JSON.stringify({ timestamp, ...record })}\n`)
        .join('');
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
});

describe('elepha reingest under automatic filtered capture', () => {
    it.each(['absent', 'false'] as const)(
        'replaces a live Codex copy with the changed source text when the legacy setting is %s',
        async (legacy) => {
            const fixture = createTestDb('elepha-reingest-auto-capture-');
            const codexHome = path.join(fixture.directory, 'codex-home');
            const elephaHome = path.join(fixture.directory, 'elepha-home');
            vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
            vi.stubEnv('ELEPHA_HOME', elephaHome);
            vi.stubEnv('CODEX_HOME', codexHome);
            mkdirSync(elephaHome, { recursive: true });
            if (legacy === 'false') {
                writeFileSync(elephaConfigPath(), '{"durable-capture":false}\n');
            }
            const projectPath = path.join(fixture.directory, 'project');
            mkdirSync(projectPath, { recursive: true });
            fixture.store.consent.grant(projectPath);
            const sourcePath = path.join(codexHome, 'sessions', '2026', '09', '30', `rollout-2026-09-30T10-00-00-${NATIVE_ID}.jsonl`);
            mkdirSync(path.dirname(sourcePath), { recursive: true });
            const timestamp = new Date().toISOString();
            writeFileSync(sourcePath, codexTranscript(projectPath, 'Use the oldanswerneedle format.', timestamp));
            const daemon = new IngestionDaemon({ store: fixture.store, watchRoots: [codexHome], readConfig: () => readMemoryConfig() });
            const scan = daemon as unknown as { scanFile(adapter: SessionAdapter, filePath: string, close: boolean): Promise<unknown> };
            await expect(scan.scanFile(new CodexAdapter(), sourcePath, true)).resolves.toMatchObject({ ingested: 1 });
            await daemon.stop();
            const cursorBefore = fixture.store.getSessionCursor('codex', NATIVE_ID);
            expect(fixture.db.prepare('SELECT decisions, pending_items FROM memories').get()).toEqual({
                decisions: '[]',
                pending_items: '[]',
            });
            expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 1 });
            fixture.close();

            // The source changes after capture; reingest must replace, not
            // withdraw, the retained copy and leave no superseded text searchable.
            writeFileSync(sourcePath, codexTranscript(projectPath, 'Use the newanswerneedle format.', timestamp));
            const sourceBefore = readFileSync(sourcePath);
            const regenerated: SummarizationOutput = {
                decisions: [{ what: 'Use the new ledger format', why: 'Keep the ledger compatible' }],
                pending_items: ['Migrate the remaining ledger'],
                status: 'ok',
            };
            mocks.summarize.mockResolvedValue(regenerated);
            vi.spyOn(console, 'log').mockImplementation(() => {});
            const program = new Command();
            registerReingest(program);
            await program.parseAsync(['node', 'elepha', 'reingest', '--since', '30d']);

            expect(process.exitCode).toBeUndefined();
            expect(mocks.summarize).toHaveBeenCalledTimes(1);
            expect(mocks.summarize).toHaveBeenCalledWith({
                userMessage: 'Which ledger format?',
                assistantText: 'Use the newanswerneedle format.',
            });
            const db = openUnmanagedDb(fixture.dbPath);
            expect(db.prepare('SELECT decisions, pending_items, summarizer_status FROM memories').get()).toEqual({
                decisions: JSON.stringify(regenerated.decisions),
                pending_items: JSON.stringify(regenerated.pending_items),
                summarizer_status: 'ok',
            });
            expect(readFileSync(sourcePath)).toEqual(sourceBefore);
            const hits = (term: string) =>
                (
                    db.prepare('SELECT COUNT(*) AS count FROM filtered_turns_fts WHERE filtered_turns_fts MATCH ?').get(term) as {
                        count: number;
                    }
                ).count;
            expect(hits('newanswerneedle')).toBe(1);
            expect(hits('oldanswerneedle')).toBe(0);
            expect(db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 1 });
            expect(db.prepare('SELECT COUNT(*) AS count FROM turn_search_index').get()).toEqual({ count: 1 });
            // The replacement is current, not a copy older than the reingest.
            const row = db
                .prepare('SELECT ft.captured_at, m.reingested_at FROM filtered_turns ft JOIN memories m ON m.id = ft.memory_id')
                .get() as { captured_at: string; reingested_at: string };
            expect(row.reingested_at).not.toBeNull();
            expect(row.captured_at >= row.reingested_at).toBe(true);
            expect(db.prepare("SELECT state FROM durable_capture_status WHERE state != 'complete'").all()).toEqual([]);
            // Reingest never moves the live cursor.
            expect(
                (db.prepare('SELECT cursor FROM sessions WHERE tool = ? AND native_id = ?').get('codex', NATIVE_ID) as { cursor: string })
                    .cursor,
            ).toBe(cursorBefore);
            expectLiveMemoryCurrent(db);
            db.close();
        },
    );
});
