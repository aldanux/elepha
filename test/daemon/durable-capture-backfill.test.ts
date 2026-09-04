import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DURABLE_CAPTURE_FILTER_VERSION } from '../../src/config/constants.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { filterTurn } from '../../src/rendering/filtered-turn.js';
import { type DurableCaptureBackfillSession, DurableCaptureBackfillStore } from '../../src/storage/durable-capture-backfill.js';
import type { ParsedTurn, SessionAdapter } from '../../src/types/index.js';
import { createTestDb, seedMemory, seedProject, seedSession } from '../helpers/db.js';

const NOW = '2026-09-04T00:00:00.000Z';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function parsedTurn(sourcePath: string, nativeId: string, turnIndex: number): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: nativeId,
        sourcePath,
        projectPath: '/unused-parser-project',
        turnIndex,
        startedAt: NOW,
        endedAt: NOW,
        userMessage: `prompt ${turnIndex}`,
        assistantText: `response ${turnIndex}`,
        toolCalls: [{ name: 'Read', filePaths: [`/repo/file-${turnIndex}.ts`] }],
        cursor: `${turnIndex}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

function adapterFor(
    turnsBySource: Map<string, ParsedTurn[]>,
    parsed: string[],
    beforeTurn?: (turn: ParsedTurn) => Promise<void> | void,
): SessionAdapter {
    return {
        tool: 'claude-code',
        watchGlobs: [],
        matches: () => false,
        nativeSessionId: (sourcePath) => path.basename(sourcePath, '.jsonl'),
        classifySession: async () => ({ kind: 'primary' }),
        classifyEmptySession: async () => undefined,
        async *parseTurns(sourcePath, sinceCursor, options) {
            expect(sinceCursor).toBeUndefined();
            expect(options?.handle).toBeDefined();
            parsed.push(sourcePath);
            for (const turn of turnsBySource.get(sourcePath) ?? []) {
                await beforeTurn?.(turn);
                yield turn;
            }
        },
    };
}

function enabledConfig() {
    return { config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } };
}

describe('daemon durable capture backfill', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('enforces the configured byte cap while backfilling sessions', () => {
        const fixture = createTestDb('elepha-durable-backfill-cap-');
        const project = seedProject(fixture);
        fixture.store.consent.grant(project.path);
        const firstPath = path.join(fixture.directory, 'first.jsonl');
        const secondPath = path.join(fixture.directory, 'second.jsonl');
        writeFileSync(firstPath, '{}\n');
        writeFileSync(secondPath, '{}\n');
        const first = seedSession(fixture, { project, tool: 'claude-code', nativeId: 'first', sourcePath: firstPath });
        const second = seedSession(fixture, { project, tool: 'claude-code', nativeId: 'second', sourcePath: secondPath });
        seedMemory(fixture, { project, session: first });
        seedMemory(fixture, { project, session: second });
        fixture.db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', first.id);
        fixture.db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', second.id);
        const store = new DurableCaptureBackfillStore(fixture.db, fixture.store.consent, 300);
        const backfillSession = (session: typeof first): DurableCaptureBackfillSession => ({
            id: session.id,
            projectId: session.project_id,
            tool: session.tool,
            nativeId: session.native_id,
            sourcePath: session.source_path,
        });
        for (const session of [first, second]) {
            const candidate = backfillSession(session);
            const work = store.begin(candidate, NOW);
            expect(work?.missingTurnIndexes).toEqual(new Set([0]));
            const parsed = parsedTurn(session.source_path, session.native_id, 0);
            parsed.userMessage = `${session.native_id}-${'x'.repeat(200)}`;
            parsed.toolCalls = [];
            expect(store.record(candidate, 0, filterTurn(parsed), NOW)).toEqual({ state: 'recorded', sessionId: session.id });
            store.finish(candidate, new Set([session.id]), 'success', NOW);
        }

        expect(fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(first.id)).toEqual({
            state: 'evicted',
        });
        expect(fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(second.id)).toEqual({
            state: 'complete',
        });
        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 1 });
        expect(
            (fixture.db.prepare('SELECT total_bytes FROM durable_capture_usage').get() as { total_bytes: number }).total_bytes,
        ).toBeLessThanOrEqual(300);
        expect(store.begin(backfillSession(first), NOW)).toBeUndefined();
        store.finish(backfillSession(first), new Set([first.id]), 'parse_error', NOW);
        expect(fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(first.id)).toEqual({
            state: 'evicted',
        });
    });

    it('runs after the startup sweep, fills historical memories without synthesis, and marks a missing source unavailable', async () => {
        const fixture = createTestDb('elepha-durable-backfill-');
        const claudeConfigDir = path.join(fixture.directory, 'claude-home');
        const providerRoot = path.join(claudeConfigDir, 'projects');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);

        const project = seedProject(fixture);
        fixture.store.consent.grant(project.path);
        const sourcePath = path.join(providerRoot, 'historical.jsonl');
        const missingPath = path.join(providerRoot, 'missing.jsonl');
        writeFileSync(sourcePath, '{}\n');
        const session = seedSession(fixture, { project, tool: 'claude-code', nativeId: 'historical', sourcePath });
        const missingSession = seedSession(fixture, {
            project,
            tool: 'claude-code',
            nativeId: 'missing',
            sourcePath: missingPath,
        });
        seedMemory(fixture, { project, session, turnIndex: 0 });
        seedMemory(fixture, { project, session, turnIndex: 1 });
        seedMemory(fixture, { project, session: missingSession, turnIndex: 0 });

        const parsed: string[] = [];
        const summarize = vi.fn();
        let releaseSweep!: () => void;
        const sweepGate = new Promise<void>((resolve) => {
            releaseSweep = resolve;
        });
        const daemon = new IngestionDaemon({
            store: fixture.store,
            adapters: [
                adapterFor(
                    new Map([[sourcePath, [parsedTurn(sourcePath, 'historical', 0), parsedTurn(sourcePath, 'historical', 1)]]]),
                    parsed,
                ),
            ],
            summarizer: { summarize },
            watchRoots: [providerRoot],
            watcherUsePolling: true,
            readCorpus: async () => {
                await sweepGate;
                return [];
            },
            heartbeatPath: path.join(fixture.directory, 'heartbeat.json'),
            updateCheck: () => undefined,
            readConfig: enabledConfig,
        });

        daemon.start();
        await new Promise((resolve) => setImmediate(resolve));
        expect(parsed).toEqual([]);
        releaseSweep();
        await waitFor(
            () =>
                (
                    fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(missingSession.id) as
                        | { state: string }
                        | undefined
                )?.state === 'source_unavailable',
        );
        await daemon.stop();

        expect(summarize).not.toHaveBeenCalled();
        expect(parsed).toEqual([sourcePath]);
        expect(
            fixture.db
                .prepare(
                    `SELECT m.turn_index, ft.user_prompt, ft.assistant_response, ft.filter_version
                     FROM filtered_turns ft
                     JOIN memories m ON m.id = ft.memory_id
                     WHERE m.session_id = ?
                     ORDER BY m.turn_index`,
                )
                .all(session.id),
        ).toEqual([
            {
                turn_index: 0,
                user_prompt: 'prompt 0',
                assistant_response: 'response 0',
                filter_version: DURABLE_CAPTURE_FILTER_VERSION,
            },
            {
                turn_index: 1,
                user_prompt: 'prompt 1',
                assistant_response: 'response 1',
                filter_version: DURABLE_CAPTURE_FILTER_VERSION,
            },
        ]);
        expect(fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(session.id)).toEqual({
            state: 'complete',
        });
        expect(fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(missingSession.id)).toEqual({
            state: 'source_unavailable',
        });
        expect(
            fixture.db
                .prepare(
                    `SELECT COUNT(*) AS count
                     FROM filtered_turns ft
                     JOIN memories m ON m.id = ft.memory_id
                     WHERE m.session_id = ?`,
                )
                .get(missingSession.id),
        ).toEqual({ count: 0 });
    });

    it('resumes an interrupted session without duplicating already-filtered turns', async () => {
        const fixture = createTestDb('elepha-durable-backfill-resume-');
        const claudeConfigDir = path.join(fixture.directory, 'claude-home');
        const providerRoot = path.join(claudeConfigDir, 'projects');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const project = seedProject(fixture);
        fixture.store.consent.grant(project.path);
        const sourcePath = path.join(providerRoot, 'resume.jsonl');
        writeFileSync(sourcePath, '{}\n');
        const session = seedSession(fixture, { project, tool: 'claude-code', nativeId: 'resume', sourcePath });
        seedMemory(fixture, { project, session, turnIndex: 0 });
        seedMemory(fixture, { project, session, turnIndex: 1 });
        const turns = [parsedTurn(sourcePath, 'resume', 0), parsedTurn(sourcePath, 'resume', 1)];

        let releaseSecondTurn!: () => void;
        const secondTurnGate = new Promise<void>((resolve) => {
            releaseSecondTurn = resolve;
        });
        const first = new IngestionDaemon({
            store: fixture.store,
            adapters: [adapterFor(new Map([[sourcePath, turns]]), [], (turn) => (turn.turnIndex === 1 ? secondTurnGate : undefined))],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'first-heartbeat.json'),
            updateCheck: () => undefined,
            readConfig: enabledConfig,
        });
        first.start();
        await waitFor(() => (fixture.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get() as { count: number }).count === 1);
        const stopped = first.stop();
        releaseSecondTurn();
        await stopped;

        expect(fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(session.id)).toEqual({
            state: 'backfilling',
        });
        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 1 });

        const restart = new IngestionDaemon({
            store: fixture.store,
            adapters: [adapterFor(new Map([[sourcePath, turns]]), [])],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'restart-heartbeat.json'),
            updateCheck: () => undefined,
            readConfig: enabledConfig,
        });
        restart.start();
        await waitFor(
            () =>
                (fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(session.id) as { state: string })
                    .state === 'complete',
        );
        await restart.stop();

        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 2 });
        expect(
            fixture.db
                .prepare(
                    `SELECT m.turn_index
                     FROM filtered_turns ft
                     JOIN memories m ON m.id = ft.memory_id
                     ORDER BY m.turn_index`,
                )
                .all(),
        ).toEqual([{ turn_index: 0 }, { turn_index: 1 }]);
    });

    it('rechecks consent inside the filtered-turn transaction and retries after consent returns', async () => {
        const fixture = createTestDb('elepha-durable-backfill-consent-');
        const claudeConfigDir = path.join(fixture.directory, 'claude-home');
        const providerRoot = path.join(claudeConfigDir, 'projects');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const project = seedProject(fixture);
        fixture.store.consent.grant(project.path);
        const sourcePath = path.join(providerRoot, 'consent.jsonl');
        writeFileSync(sourcePath, '{}\n');
        const session = seedSession(fixture, { project, tool: 'claude-code', nativeId: 'consent', sourcePath });
        seedMemory(fixture, { project, session, turnIndex: 0 });

        const first = new IngestionDaemon({
            store: fixture.store,
            adapters: [
                adapterFor(new Map([[sourcePath, [parsedTurn(sourcePath, 'consent', 0)]]]), [], () => {
                    fixture.store.consent.revoke(project.path);
                }),
            ],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'first-heartbeat.json'),
            updateCheck: () => undefined,
            readConfig: enabledConfig,
        });
        first.start();
        await waitFor(() => fixture.store.consent.consentState(project.path) === 'denied');
        await first.stop();
        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });

        fixture.store.consent.grant(project.path);
        const restart = new IngestionDaemon({
            store: fixture.store,
            adapters: [adapterFor(new Map([[sourcePath, [parsedTurn(sourcePath, 'consent', 0)]]]), [])],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'restart-heartbeat.json'),
            updateCheck: () => undefined,
            readConfig: enabledConfig,
        });
        restart.start();
        await waitFor(() => (fixture.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get() as { count: number }).count === 1);
        await restart.stop();
        expect(fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(session.id)).toEqual({
            state: 'complete',
        });
    });

    it('resolves a memory moved to a new segment by native turn identity', async () => {
        const fixture = createTestDb('elepha-durable-backfill-identity-');
        const claudeConfigDir = path.join(fixture.directory, 'claude-home');
        const providerRoot = path.join(claudeConfigDir, 'projects');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const project = seedProject(fixture);
        fixture.store.consent.grant(project.path);
        const sourcePath = path.join(providerRoot, 'identity.jsonl');
        writeFileSync(sourcePath, '{}\n');
        const original = seedSession(fixture, { project, tool: 'claude-code', nativeId: 'identity', sourcePath });
        const memory = seedMemory(fixture, { project, session: original, turnIndex: 0 });
        const moved = fixture.store.startNextSegment(original, project.id, sourcePath);
        let movedDuringParse = false;
        const daemon = new IngestionDaemon({
            store: fixture.store,
            adapters: [
                adapterFor(new Map([[sourcePath, [parsedTurn(sourcePath, 'identity', 0)]]]), [], () => {
                    fixture.db.prepare('UPDATE memories SET session_id = ? WHERE id = ?').run(moved.id, memory.id);
                    movedDuringParse = true;
                }),
            ],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'heartbeat.json'),
            updateCheck: () => undefined,
            readConfig: enabledConfig,
        });
        daemon.start();
        await waitFor(
            () =>
                movedDuringParse &&
                (fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(moved.id) as { state: string })
                    .state === 'complete',
        );
        await daemon.stop();

        expect(fixture.db.prepare('SELECT memory_id FROM filtered_turns').get()).toEqual({ memory_id: memory.id });
        expect(fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(moved.id)).toEqual({
            state: 'complete',
        });
    });

    it('reruns sentinel and quote-back suppression before durable persistence', async () => {
        const fixture = createTestDb('elepha-durable-backfill-rule4-');
        const claudeConfigDir = path.join(fixture.directory, 'claude-home');
        const providerRoot = path.join(claudeConfigDir, 'projects');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const project = seedProject(fixture);
        fixture.store.consent.grant(project.path);
        const sourcePath = path.join(providerRoot, 'rule4.jsonl');
        writeFileSync(sourcePath, '{}\n');
        const session = seedSession(fixture, { project, tool: 'claude-code', nativeId: 'rule4', sourcePath });
        seedMemory(fixture, { project, session, turnIndex: 0 });
        seedMemory(fixture, { project, session, turnIndex: 1 });
        const sentinel = { ...parsedTurn(sourcePath, 'rule4', 0), droppedReason: 'sentinel' as const };
        const injectionBody = 'This injected memory body is intentionally long enough for exact quote-back suppression.';
        const quoteBack = { ...parsedTurn(sourcePath, 'rule4', 1), userMessage: injectionBody };
        fixture.store.recordInjection({
            tool: 'claude-code',
            nativeSessionId: 'rule4',
            injectedAt: '2026-09-03T00:00:00.000Z',
            injectionId: '01J00000000000000000000000',
            body: injectionBody,
        });

        const daemon = new IngestionDaemon({
            store: fixture.store,
            adapters: [adapterFor(new Map([[sourcePath, [sentinel, quoteBack]]]), [])],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'heartbeat.json'),
            updateCheck: () => undefined,
            readConfig: enabledConfig,
        });
        daemon.start();
        await waitFor(
            () =>
                (
                    fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(session.id) as
                        | { state: string }
                        | undefined
                )?.state === 'parse_error',
        );
        await daemon.stop();

        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
    });

    it('marks a readable transcript parse failure without writing a partial row', async () => {
        const fixture = createTestDb('elepha-durable-backfill-parse-error-');
        const claudeConfigDir = path.join(fixture.directory, 'claude-home');
        const providerRoot = path.join(claudeConfigDir, 'projects');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const project = seedProject(fixture);
        fixture.store.consent.grant(project.path);
        const sourcePath = path.join(providerRoot, 'parse-error.jsonl');
        writeFileSync(sourcePath, '{}\n');
        const session = seedSession(fixture, { project, tool: 'claude-code', nativeId: 'parse-error', sourcePath });
        seedMemory(fixture, { project, session, turnIndex: 0 });

        const daemon = new IngestionDaemon({
            store: fixture.store,
            adapters: [
                adapterFor(new Map([[sourcePath, [parsedTurn(sourcePath, 'parse-error', 0)]]]), [], () => {
                    throw new Error('malformed transcript');
                }),
            ],
            watchRoots: [],
            heartbeatPath: path.join(fixture.directory, 'heartbeat.json'),
            updateCheck: () => undefined,
            readConfig: enabledConfig,
        });
        daemon.start();
        await waitFor(
            () =>
                (
                    fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(session.id) as
                        | { state: string }
                        | undefined
                )?.state === 'parse_error',
        );
        await daemon.stop();

        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
    });
});
