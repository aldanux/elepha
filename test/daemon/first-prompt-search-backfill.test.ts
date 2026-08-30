import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIRST_PROMPT_SEARCH_BACKFILL_LOG_PREFIX, IngestionDaemon } from '../../src/daemon/index.js';
import { firstPromptSearch } from '../../src/storage/first-prompt-search.js';
import type { ParsedTurn, SessionAdapter } from '../../src/types/index.js';
import { createTestDb, seedProject, seedSession } from '../helpers/db.js';

const NOW = '2026-08-30T00:00:00.000Z';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function turn(sourcePath: string, prompt: string): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: path.basename(sourcePath, '.jsonl'),
        sourcePath,
        projectPath: '/repo',
        turnIndex: 0,
        startedAt: NOW,
        endedAt: NOW,
        userMessage: prompt,
        assistantText: 'done',
        toolCalls: [],
        cursor: '1',
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

function adapterFor(prompts: Map<string, string>, parsed: string[], onParse?: () => void): SessionAdapter {
    return {
        tool: 'claude-code',
        watchGlobs: [],
        matches: () => false,
        nativeSessionId: (sourcePath) => path.basename(sourcePath, '.jsonl'),
        classifySession: async () => ({ kind: 'primary' }),
        classifyEmptySession: async () => undefined,
        async *parseTurns(sourcePath) {
            parsed.push(sourcePath);
            onParse?.();
            const prompt = prompts.get(sourcePath);
            if (prompt !== undefined) {
                yield turn(sourcePath, prompt);
            }
        },
    };
}

function seedHistoricalSession(
    fixture: ReturnType<typeof createTestDb>,
    project: ReturnType<typeof seedProject>,
    sourcePath: string,
    nativeId: string,
): number {
    const session = seedSession(fixture, { project, tool: 'claude-code', nativeId, sourcePath });
    fixture.db.prepare('UPDATE sessions SET first_prompt_search = NULL WHERE id = ?').run(session.id);
    fixture.db
        .prepare(
            `INSERT INTO memories
                (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
             VALUES (?, ?, 0, 'claude-code', ?, '[]', '[]', '[]', ?)`,
        )
        .run(project.id, session.id, NOW, NOW);
    return session.id;
}

describe('daemon first-prompt search backfill', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('runs after start returns, fills readable rows in batches, and permanently skips an unavailable transcript', async () => {
        const fixture = createTestDb('elepha-daemon-first-prompt-');
        const claudeConfigDir = path.join(fixture.directory, 'claude-home');
        const providerRoot = path.join(claudeConfigDir, 'projects');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);

        const project = seedProject(fixture);
        fixture.store.consent.grant(project.path);
        const prompts = new Map<string, string>();
        const readableOne = path.join(providerRoot, 'one.jsonl');
        const unavailable = path.join(providerRoot, 'missing.jsonl');
        const readableThree = path.join(providerRoot, 'three.jsonl');
        writeFileSync(readableOne, '{}\n');
        writeFileSync(readableThree, '{}\n');
        prompts.set(readableOne, 'first searchable prompt');
        prompts.set(readableThree, 'third searchable prompt');

        const firstId = seedHistoricalSession(fixture, project, readableOne, 'one');
        const missingId = seedHistoricalSession(fixture, project, unavailable, 'missing');
        const thirdId = seedHistoricalSession(fixture, project, readableThree, 'three');
        const parsed: string[] = [];
        const logs: string[] = [];
        const daemon = new IngestionDaemon({
            store: fixture.store,
            adapters: [adapterFor(prompts, parsed)],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'heartbeat.json'),
            updateCheck: () => undefined,
            firstPromptSearchBackfillBatchSize: 2,
            log: (message) => logs.push(message),
        });

        daemon.start();
        expect(parsed).toEqual([]);
        await waitFor(
            () =>
                (
                    fixture.db.prepare('SELECT first_prompt_search FROM sessions WHERE id = ?').get(thirdId) as {
                        first_prompt_search: string | null;
                    }
                ).first_prompt_search !== null,
        );
        await daemon.stop();

        expect(fixture.db.prepare('SELECT id, first_prompt_search FROM sessions ORDER BY id').all()).toEqual([
            { id: firstId, first_prompt_search: firstPromptSearch('first searchable prompt') },
            { id: missingId, first_prompt_search: null },
            { id: thirdId, first_prompt_search: firstPromptSearch('third searchable prompt') },
        ]);
        expect(parsed).toEqual([readableOne, readableThree]);
        expect(logs.filter((message) => message.startsWith(FIRST_PROMPT_SEARCH_BACKFILL_LOG_PREFIX))).toHaveLength(2);

        const restartParsed: string[] = [];
        const restartLogs: string[] = [];
        const restart = new IngestionDaemon({
            store: fixture.store,
            adapters: [adapterFor(prompts, restartParsed)],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'heartbeat.json'),
            updateCheck: () => undefined,
            firstPromptSearchBackfillBatchSize: 2,
            log: (message) => restartLogs.push(message),
        });
        restart.start();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await restart.stop();

        expect(restartParsed).toEqual([]);
        expect(restartLogs.some((message) => message.startsWith(FIRST_PROMPT_SEARCH_BACKFILL_LOG_PREFIX))).toBe(false);
    });

    it('resumes with the next batch when the daemon stops after persisted progress', async () => {
        const fixture = createTestDb('elepha-daemon-first-prompt-resume-');
        const claudeConfigDir = path.join(fixture.directory, 'claude-home');
        const providerRoot = path.join(claudeConfigDir, 'projects');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);

        const project = seedProject(fixture);
        fixture.store.consent.grant(project.path);
        const prompts = new Map<string, string>();
        const ids: number[] = [];
        const sources: string[] = [];
        for (const name of ['one', 'two', 'three']) {
            const sourcePath = path.join(providerRoot, `${name}.jsonl`);
            writeFileSync(sourcePath, '{}\n');
            prompts.set(sourcePath, `${name} prompt`);
            sources.push(sourcePath);
            ids.push(seedHistoricalSession(fixture, project, sourcePath, name));
        }

        const firstParsed: string[] = [];
        let first!: IngestionDaemon;
        let stopAfterFirstBatch: Promise<void> | undefined;
        first = new IngestionDaemon({
            store: fixture.store,
            adapters: [adapterFor(prompts, firstParsed)],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'heartbeat.json'),
            updateCheck: () => undefined,
            firstPromptSearchBackfillBatchSize: 2,
            log: (message) => {
                if (message.startsWith(FIRST_PROMPT_SEARCH_BACKFILL_LOG_PREFIX) && stopAfterFirstBatch === undefined) {
                    stopAfterFirstBatch = first.stop();
                }
            },
        });
        first.start();
        await waitFor(() => stopAfterFirstBatch !== undefined);
        await stopAfterFirstBatch;

        expect(firstParsed).toEqual(sources.slice(0, 2));
        expect(fixture.db.prepare('SELECT id, first_prompt_search FROM sessions ORDER BY id').all()).toEqual([
            { id: ids[0], first_prompt_search: firstPromptSearch('one prompt') },
            { id: ids[1], first_prompt_search: firstPromptSearch('two prompt') },
            { id: ids[2], first_prompt_search: null },
        ]);

        const restartParsed: string[] = [];
        const restart = new IngestionDaemon({
            store: fixture.store,
            adapters: [adapterFor(prompts, restartParsed)],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'heartbeat.json'),
            updateCheck: () => undefined,
            firstPromptSearchBackfillBatchSize: 2,
        });
        restart.start();
        await waitFor(
            () =>
                (
                    fixture.db.prepare('SELECT first_prompt_search FROM sessions WHERE id = ?').get(ids[2]) as {
                        first_prompt_search: string | null;
                    }
                ).first_prompt_search !== null,
        );
        await restart.stop();

        expect(restartParsed).toEqual([sources[2]]);
        expect(fixture.db.prepare('SELECT first_prompt_search FROM sessions WHERE id = ?').get(ids[2])).toEqual({
            first_prompt_search: firstPromptSearch('three prompt'),
        });
    });

    it('rechecks consent after transcript parsing and leaves a revoked row eligible after a later grant', async () => {
        const fixture = createTestDb('elepha-daemon-first-prompt-consent-');
        const claudeConfigDir = path.join(fixture.directory, 'claude-home');
        const providerRoot = path.join(claudeConfigDir, 'projects');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);

        const project = seedProject(fixture);
        fixture.store.consent.grant(project.path);
        const sourcePath = path.join(providerRoot, 'consent-race.jsonl');
        writeFileSync(sourcePath, '{}\n');
        const prompts = new Map([[sourcePath, 'consented prompt']]);
        const sessionId = seedHistoricalSession(fixture, project, sourcePath, 'consent-race');
        const parsed: string[] = [];
        const first = new IngestionDaemon({
            store: fixture.store,
            adapters: [adapterFor(prompts, parsed, () => fixture.store.consent.revoke(project.path))],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'heartbeat.json'),
            updateCheck: () => undefined,
        });
        first.start();
        await waitFor(() => parsed.length === 1);
        await first.stop();

        expect(fixture.db.prepare('SELECT first_prompt_search FROM sessions WHERE id = ?').get(sessionId)).toEqual({
            first_prompt_search: null,
        });
        expect(fixture.db.prepare('SELECT * FROM first_prompt_search_backfill_skips').all()).toEqual([]);

        fixture.store.consent.grant(project.path);
        const restartParsed: string[] = [];
        const restart = new IngestionDaemon({
            store: fixture.store,
            adapters: [adapterFor(prompts, restartParsed)],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'heartbeat.json'),
            updateCheck: () => undefined,
        });
        restart.start();
        await waitFor(
            () =>
                (
                    fixture.db.prepare('SELECT first_prompt_search FROM sessions WHERE id = ?').get(sessionId) as {
                        first_prompt_search: string | null;
                    }
                ).first_prompt_search !== null,
        );
        await restart.stop();

        expect(restartParsed).toEqual([sourcePath]);
        expect(fixture.db.prepare('SELECT first_prompt_search FROM sessions WHERE id = ?').get(sessionId)).toEqual({
            first_prompt_search: firstPromptSearch('consented prompt'),
        });
    });
});
