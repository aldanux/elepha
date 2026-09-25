import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { withTempDir } from '../helpers/tmp.js';

describe('Codex paginated fork ingestion', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('captures only the child turns after consent, while legacy copied forks remain excluded', async () => {
        const root = withTempDir('elepha-paginated-fork-');
        const codexHome = path.join(root, '.codex');
        const watchRoot = path.join(codexHome, 'sessions');
        const projectPath = path.join(root, 'project');
        mkdirSync(watchRoot, { recursive: true });
        mkdirSync(projectPath);
        vi.stubEnv('CODEX_HOME', codexHome);

        const paginatedId = '11111111-1111-4111-8111-111111111111';
        const legacyId = '22222222-2222-4222-8222-222222222222';
        const createRollout = (id: string, paginated: boolean): string => {
            const file = path.join(watchRoot, `rollout-2026-09-25T00-00-00-${id}.jsonl`);
            const lines = [
                {
                    type: 'session_meta',
                    ordinal: paginated ? 48 : undefined,
                    timestamp: '2026-09-25T00:00:00.000Z',
                    payload: {
                        id,
                        cwd: projectPath,
                        forked_from_id: 'parent-123',
                        ...(paginated
                            ? {
                                  history_mode: 'paginated',
                                  history_base: { thread_id: 'parent-123', end_ordinal_exclusive: 48, end_byte_offset: 302241 },
                                  forked_from_ordinal_exclusive: 48,
                              }
                            : {}),
                    },
                },
                {
                    type: 'event_msg',
                    ordinal: paginated ? 49 : undefined,
                    timestamp: '2026-09-25T00:00:01.000Z',
                    payload: { type: 'user_message', message: paginated ? 'New child turn' : 'Copied parent turn' },
                },
                {
                    type: 'response_item',
                    ordinal: paginated ? 50 : undefined,
                    timestamp: '2026-09-25T00:00:02.000Z',
                    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
                },
            ];
            writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
            return file;
        };
        const paginatedFile = createRollout(paginatedId, true);
        const legacyFile = createRollout(legacyId, false);
        const store = new MemoryStore(openUnmanagedDb(path.join(root, 'elepha.db')));
        const adapter = new CodexAdapter();
        const daemon = new IngestionDaemon({
            store,
            adapters: [adapter],
            watchRoots: [watchRoot],
            readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } }),
        });
        const scan = daemon as unknown as {
            scanFile(adapter: CodexAdapter, file: string, closeTrailingOnIdle: boolean): Promise<{ ingested: number }>;
        };

        try {
            expect(await scan.scanFile(adapter, paginatedFile, true)).toMatchObject({ ingested: 0 });
            expect(store.findSession('codex', paginatedId)).toBeUndefined();

            store.consent.grant(projectPath);
            expect(await scan.scanFile(adapter, legacyFile, true)).toMatchObject({ ingested: 0 });
            expect(await scan.scanFile(adapter, paginatedFile, true)).toMatchObject({ ingested: 1 });
            expect(store.findSession('codex', legacyId)).toBeUndefined();
            expect(store.findSession('codex', paginatedId)).toMatchObject({ kind: 'main' });
            expect(store.database.prepare('SELECT user_prompt FROM filtered_turns').all()).toEqual([{ user_prompt: 'New child turn' }]);
        } finally {
            store.database.close();
        }
    });
});
