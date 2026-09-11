import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekHarnessAdapter } from '../../src/adapters/deepseek-harness.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import { wrap } from '../../src/security/sentinel.js';
import { createDeepSeekFixture, deepSeekHeader, deepSeekTurn, deepSeekZstdBytes } from '../fixtures/deepseek-session.js';
import { createTestDb } from '../helpers/db.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

interface ScanSeam {
    scanFile(
        adapter: DeepSeekHarnessAdapter,
        filePath: string,
        close: boolean,
    ): Promise<{ ingested: number; skipped?: { category: string; reason: string } }>;
}

describe('DeepSeek Harness ingestion', () => {
    let projectPath: string;

    beforeEach(() => {
        vi.stubEnv('DSH_HOME', withTempDir('deepseek-daemon-home-'));
        projectPath = withGrantableTestDir('deepseek-daemon-project-');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    function setup(frames: object[][]) {
        const file = createDeepSeekFixture(projectPath, frames);
        const db = createTestDb('deepseek-memory-');
        db.store.consent.grant(projectPath);
        const logs: string[] = [];
        const summarize = vi.fn(async ({ assistantText }: { userMessage: string; assistantText: string }) => ({
            decisions: [{ what: assistantText, why: null }],
            pending_items: [],
            status: 'ok' as const,
        }));
        const daemon = new IngestionDaemon({
            store: db.store,
            summarizer: { summarize },
            log: (message) => logs.push(message),
            readConfig: () => ({ config: DEFAULT_MEMORY_CONFIG }),
        });
        const scan = () => (daemon as unknown as ScanSeam).scanFile(new DeepSeekHarnessAdapter(), file, true);
        return { ...db, file, logs, summarize, daemon, scan };
    }

    it('captures closed turns once and treats changed content at a stored sequence as corruption, not retraction', async () => {
        const fixture = setup([[deepSeekHeader(projectPath)], [...deepSeekTurn(0), ...deepSeekTurn(1)]]);
        expect(await fixture.scan()).toMatchObject({ ingested: 2 });
        expect(await fixture.scan()).toMatchObject({ ingested: 0 });
        expect(fixture.summarize).toHaveBeenCalledTimes(2);

        writeFileSync(
            fixture.file,
            deepSeekZstdBytes([[deepSeekHeader(projectPath)], [...deepSeekTurn(0), ...deepSeekTurn(1, 'Changed answer')]]),
        );
        expect(await fixture.scan()).toMatchObject({
            ingested: 0,
            skipped: { category: 'unexpected error', reason: expect.stringContaining('no longer identifies the same content') },
        });
        const stored = fixture.store.findSession('deepseek', 'session-main')!;
        expect(fixture.store.listMemoriesForSession(stored.id).map((row) => row.decisions[0]?.what)).toEqual(['Answer 0', 'Answer 1']);
    });

    it('uses turn/end time for quote-back suppression and advances past a sentinel-bearing turn', async () => {
        const body = 'A sufficiently long injected memory paragraph describing local capture and its consent boundary across coding tools.';
        const poisoned = deepSeekTurn(0, 'Echo');
        poisoned.splice(2, 0, {
            type: 'system/message',
            data: {
                message: { content: [{ type: 'text', text: wrap('brief', '01J00000000000000000000000', 'Injected') }] },
            },
        });
        const fixture = setup([[deepSeekHeader(projectPath)], [...poisoned, ...deepSeekTurn(1, body), ...deepSeekTurn(2)]]);
        fixture.store.recordInjection({
            tool: 'deepseek',
            nativeSessionId: 'session-main',
            injectedAt: '2026-09-11T00:00:02.500Z',
            injectionId: '01J00000000000000000000000',
            body,
        });

        expect(await fixture.scan()).toMatchObject({ ingested: 1 });
        const stored = fixture.store.findSession('deepseek', 'session-main')!;
        expect(fixture.store.listMemoriesForSession(stored.id).map((row) => row.turn_index)).toEqual([24]);
        expect(fixture.summarize).toHaveBeenCalledExactlyOnceWith({ userMessage: 'Prompt 2', assistantText: 'Answer 2' });
        expect(await fixture.scan()).toMatchObject({ ingested: 0 });
    });

    it('applies late provider and custom titles without source reconciliation and sanitizes them at the store boundary', async () => {
        const fixture = setup([[deepSeekHeader(projectPath)], deepSeekTurn(0)]);
        await fixture.scan();
        const stored = fixture.store.findSession('deepseek', 'session-main')!;
        expect(stored.title).toBe('Prompt 0');

        const original = readFileSync(fixture.file);
        writeFileSync(
            fixture.file,
            Buffer.concat([
                original,
                deepSeekZstdBytes([[{ type: 'session/title', data: { title: 'Provider title', source: { kind: 'provider' } } }]]),
            ]),
        );
        expect(await fixture.scan()).toMatchObject({ ingested: 0 });
        expect(fixture.store.findSession('deepseek', 'session-main')).toMatchObject({ title: 'Provider title', custom_title: null });

        const withProvider = readFileSync(fixture.file);
        writeFileSync(
            fixture.file,
            Buffer.concat([
                withProvider,
                deepSeekZstdBytes([[{ type: 'session/title', data: { title: '`whoami` $(touch nope)', source: { kind: 'user' } } }]]),
            ]),
        );
        expect(await fixture.scan()).toMatchObject({ ingested: 0 });
        const titled = fixture.store.findSession('deepseek', 'session-main')!;
        expect(titled.custom_title).not.toBeNull();
        expect(detectShellSyntax(titled.custom_title ?? '')).toBe(false);
    });

    it('revalidates a non-retractable source after awaited summarization', async () => {
        const fixture = setup([[deepSeekHeader(projectPath)], deepSeekTurn(0)]);
        fixture.summarize.mockImplementationOnce(async () => {
            const replacement = `${fixture.file}.replacement`;
            writeFileSync(replacement, deepSeekZstdBytes([[deepSeekHeader(projectPath)]]));
            renameSync(replacement, fixture.file);
            return { decisions: [], pending_items: [], status: 'ok' };
        });

        expect(await fixture.scan()).toMatchObject({ ingested: 0 });
        expect(fixture.store.findSession('deepseek', 'session-main')).toBeUndefined();
    });

    it('reports a missing literal cwd as a counted skip', async () => {
        const fixture = setup([[{ type: 'session', id: 'session-main', version: 3 }]]);
        expect(await fixture.scan()).toMatchObject({
            ingested: 0,
            skipped: { category: 'unexpected error', reason: expect.stringContaining('cwd is missing or not absolute') },
        });
        expect(fixture.logs.some((line) => line.includes('cwd is missing or not absolute'))).toBe(true);
    });
});
