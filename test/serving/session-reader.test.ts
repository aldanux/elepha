import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { DURABLE_CAPTURE_FILTER_VERSION, MAX_GET_SESSION_LAST_N, SESSION_CHAR_BUDGET } from '../../src/config/constants.js';
import { codexSessionsRoot } from '../../src/config/paths.js';
import { omissionMarker } from '../../src/rendering/raw-turn-renderer.js';
import * as providerTranscript from '../../src/security/provider-transcript.js';
import { dataBlockClose, dataBlockOpen } from '../../src/serving/instructions.js';
import {
    boundedRender,
    newestActivity,
    type ServedSession,
    SessionReader,
    STORED_EVIDENCE_REASONS,
} from '../../src/serving/session-reader.js';
import type { ProjectSet } from '../../src/storage/project-resolver.js';
import { UNTITLED_EPISODE } from '../../src/storage/session-title.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { createTestDb, seedMemory, seedProject, seedSession } from '../helpers/db.js';

function turn(index: number, text: string): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'native',
        sourcePath: '/tmp/episode.jsonl',
        projectPath: '/tmp/project',
        turnIndex: index,
        startedAt: '2026-08-17T00:00:00.000Z',
        endedAt: '2026-08-17T00:00:01.000Z',
        userMessage: `user ${index}`,
        assistantText: text,
        toolCalls: [],
        cursor: `${index}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

function session(nativeId: string, lastTurnAt: string, sourcePath = '/tmp/episode.jsonl'): ServedSession {
    return {
        id: 1,
        tool: 'codex',
        native_id: nativeId,
        segment_index: 0,
        project_id: 1,
        source_path: sourcePath,
        started_at: '2026-08-17T00:00:00.000Z',
        last_ingested_at: '2026-08-17T00:00:00.000Z',
        surface: 'cli',
        git_branch: null,
        git_commit_count: null,
        last_turn_at: lastTurnAt,
        rendered_chars: null,
        rendered_turns: null,
        title: null,
        custom_title: null,
        first_prompt_search: null,
        rollup_title: null,
        rollup_instructions: null,
        rollup_decisions: null,
        rollup_state: null,
        turn_count: 1,
        has_files_touched: 0,
        has_external_content: 0,
    };
}

async function withCodexStore<T>(fixtureDirectory: string, run: (storeRoot: string) => Promise<T>): Promise<T> {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fixtureDirectory;
    const storeRoot = codexSessionsRoot();
    mkdirSync(storeRoot, { recursive: true });
    try {
        return await run(storeRoot);
    } finally {
        if (previous === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
    }
}

const storedSummary = { decisions: [], pending_items: [], status: 'not_configured' as const };

function captureTurns(
    fixture: ReturnType<typeof createTestDb>,
    project: ReturnType<typeof seedProject>,
    storedSession: ReturnType<typeof seedSession>,
    turns: readonly ParsedTurn[],
    durableCapture: boolean,
): void {
    for (const parsedTurn of turns) {
        expect(
            fixture.store.recordTurn(
                {
                    ...parsedTurn,
                    sessionId: storedSession.native_id,
                    sourcePath: storedSession.source_path,
                    projectPath: project.path,
                },
                storedSession.id,
                project.id,
                storedSummary,
                durableCapture,
            ),
        ).toBe(true);
    }
}

afterEach(() => vi.restoreAllMocks());

describe('P2.8 bounded shared episode reader', () => {
    it.each(['outside', 'symlink', 'inside'] as const)(
        'never opens or parses a %s provider source to fill missing retained evidence',
        async (location) => {
            const fixture = createTestDb('elepha-session-reader-');
            await withCodexStore(fixture.directory, async (storeRoot) => {
                const outside = path.join(fixture.directory, 'outside.jsonl');
                const inside = path.join(storeRoot, 'inside.jsonl');
                const alias = path.join(storeRoot, 'alias.jsonl');
                writeFileSync(outside, '{}\n');
                writeFileSync(inside, '{}\n');
                symlinkSync(outside, alias);
                const sourcePath = location === 'outside' ? outside : location === 'symlink' ? alias : inside;
                const opened = vi.spyOn(providerTranscript, 'openProviderTranscript');
                const parsed = vi.spyOn(CodexAdapter.prototype, 'parseTurns');
                try {
                    await expect(new SessionReader(fixture.db).render(session(location, '2026-08-17', sourcePath))).resolves.toEqual({
                        reason: STORED_EVIDENCE_REASONS.missing,
                    });
                    expect(opened).not.toHaveBeenCalled();
                    expect(parsed).not.toHaveBeenCalled();
                } finally {
                    opened.mockRestore();
                    parsed.mockRestore();
                }
            });
        },
    );

    it('counts every stored session, including non-substantive sessions', () => {
        const now = Date.parse('2026-08-20T00:00:00.000Z');
        const fixture = createTestDb('elepha-session-reader-');
        const project: ProjectSet = {
            key: '/tmp/project',
            displayName: 'project',
            paths: ['/tmp/project'],
            projectIds: [1],
            gitRoot: null,
            gitRemote: null,
        };
        const storedProject = seedProject(fixture, { path: project.paths[0] });
        const addSession = (nativeId: string, ageMs: number, turns: number): void => {
            const timestamp = new Date(now - ageMs).toISOString();
            const storedSession = seedSession(fixture, {
                project: storedProject,
                nativeId,
                sourcePath: '/tmp/episode.jsonl',
                startedAt: timestamp,
                lastIngestedAt: timestamp,
                lastTurnAt: timestamp,
            });
            for (let turnIndex = 0; turnIndex < turns; turnIndex++) {
                seedMemory(fixture, { project: storedProject, session: storedSession, turnIndex, startedAt: timestamp });
            }
        };
        addSession('substantive', 8 * 24 * 60 * 60 * 1000, 2);
        addSession('recent-one-turn', 24 * 60 * 60 * 1000, 1);
        addSession('old-one-turn', 9 * 24 * 60 * 60 * 1000, 1);

        const counts = new SessionReader(fixture.db).counts(project, now);

        expect(counts).toEqual({ total: 3, recent: 1 });
    });

    it('memoizes project-session reads per reader instance while a fresh reader observes new writes (F4)', () => {
        const fixture = createTestDb('elepha-session-reader-');
        const project: ProjectSet = {
            key: '/tmp/project',
            displayName: 'project',
            paths: ['/tmp/project'],
            projectIds: [1],
            gitRoot: null,
            gitRemote: null,
        };
        const storedProject = seedProject(fixture, { path: project.paths[0] });
        const first = seedSession(fixture, { project: storedProject, nativeId: 'first', sourcePath: '/tmp/first.jsonl' });
        seedMemory(fixture, { project: storedProject, session: first, turnIndex: 0 });

        const reader = new SessionReader(fixture.db);
        const initial = reader.sessionsFor(project);
        const second = seedSession(fixture, { project: storedProject, nativeId: 'second', sourcePath: '/tmp/second.jsonl' });
        seedMemory(fixture, { project: storedProject, session: second, turnIndex: 0 });

        expect(reader.sessionsFor(project)).toBe(initial);
        expect(initial).toHaveLength(1);
        expect(new SessionReader(fixture.db).sessionsFor(project)).toHaveLength(2);
    });

    it('keeps real and custom-titled sessions while dropping untitled command-only sessions from the consented feed', () => {
        const fixture = createTestDb('elepha-session-reader-');
        const storedProject = seedProject(fixture, { path: '/tmp/project' });
        const project: ProjectSet = {
            key: storedProject.path,
            displayName: 'project',
            paths: [storedProject.path],
            projectIds: [storedProject.id],
            gitRoot: null,
            gitRemote: null,
        };
        const real = seedSession(fixture, {
            project: storedProject,
            nativeId: 'real',
            title: 'Implement filtered recent sessions',
            lastTurnAt: '2026-08-19T03:00:00.000Z',
        });
        const leadingCommandReal = seedSession(fixture, {
            project: storedProject,
            nativeId: 'leading-command-real',
            title: 'Fix the session list',
            lastTurnAt: '2026-08-19T02:00:00.000Z',
        });
        const customTitled = seedSession(fixture, {
            project: storedProject,
            nativeId: 'custom-titled',
            title: UNTITLED_EPISODE,
            customTitle: 'Saved investigation',
            lastTurnAt: '2026-08-19T01:00:00.000Z',
        });
        seedSession(fixture, {
            project: storedProject,
            nativeId: 'command-only',
            title: UNTITLED_EPISODE,
            lastTurnAt: '2026-08-19T04:00:00.000Z',
        });

        const sessions = new SessionReader(fixture.db).recentConsentedSessions([project]);

        expect(sessions.map((session) => session.native_id)).toEqual([
            real.native_id,
            leadingCommandReal.native_id,
            customTitled.native_id,
        ]);
    });

    it('selects the newest activity across sessions while excluding the current native session', () => {
        const current = session('current', '2026-08-17T00:00:00.000Z');
        const recent = session('recent', '2026-08-16T23:58:00.000Z');
        const older = session('older', '2026-08-16T15:00:00.000Z');

        expect(newestActivity([older, current, recent], { excludeNativeId: 'current' })).toBe(recent);
    });

    it('keeps newest renderable turns under 80,000 characters and reports exact omitted arithmetic', () => {
        const episode = boundedRender([turn(0, 'old'), turn(1, 'x'.repeat(90_000)), turn(2, 'newest')]);
        expect(episode.renderedChars).toBeLessThanOrEqual(SESSION_CHAR_BUDGET);
        expect(episode.text).toContain('## Turn 3');
        expect(episode.text).not.toContain('## Turn 2');
        expect(episode.omitted).toBe(2);
        expect(episode.text).toContain(omissionMarker(2, 1, 3));
        expect(episode.returned + episode.omitted).toBe(episode.total);
    });

    it('streams last_n through a tail-sized render while preserving full-session counts', async () => {
        const fixture = createTestDb('elepha-session-reader-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/large.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'large', sourcePath });
            const turns = Array.from({ length: 50 }, (_, index) => turn(index, `assistant ${index}`));
            captureTurns(fixture, project, storedSession, turns, true);
            const parseTurns = vi.spyOn(CodexAdapter.prototype, 'parseTurns');
            const reader = new SessionReader(fixture.db);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded session was not found');

            const result = await reader.render(servedSession, 1);

            expect(result.episode).toMatchObject({ returned: 1, omitted: 49, total: 50 });
            expect(result.episode?.text).toContain('## Turn 50');
            expect(result.episode?.text).toContain('assistant 49');
            expect(result.episode?.text).not.toContain('assistant 48');
            expect(result.episode?.text).toContain(omissionMarker(49, 1, 50));
            expect(parseTurns).not.toHaveBeenCalled();
            parseTurns.mockRestore();
        });
    });

    it('keeps newest retained content within the character bound with a large last_n', async () => {
        const fixture = createTestDb('elepha-session-reader-');
        const project = seedProject(fixture);
        const storedSession = seedSession(fixture, { project });
        const turns = Array.from({ length: 60 }, (_, index) => turn(index, `assistant ${index} ${'x'.repeat(4_000)}`));
        captureTurns(fixture, project, storedSession, turns, true);
        const reader = new SessionReader(fixture.db);
        const result = await reader.render(reader.sessionById(storedSession.id)!, MAX_GET_SESSION_LAST_N, undefined, 12_000);
        expect(result.episode?.renderedChars).toBeLessThanOrEqual(12_000);
        expect(result.episode).toMatchObject({ returned: 2, omitted: 58, total: 60 });
        expect(result.episode?.text).toContain('assistant 59');
        expect(result.episode?.text).not.toContain('assistant 57');
    });

    it('prefers a verified complete copy and renders it byte-for-byte like the source with the same bounds', async () => {
        const fixture = createTestDb('elepha-session-reader-durable-equality-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/durable-equality.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'durable-equality', sourcePath });
            const turns = [
                {
                    ...turn(0, 'first response'),
                    userMessage: 'first prompt <oai-mem-citation>injected</oai-mem-citation>',
                    toolCalls: [
                        { name: 'read_file', filePaths: ['/tmp/project/src/a.ts'] },
                        { name: 'pathless', filePaths: [] },
                    ],
                },
                { ...turn(1, 'Okay, waiting.'), userMessage: 'pause here' },
                turn(2, 'second rendered response'),
                turn(3, 'newest rendered response'),
            ];
            captureTurns(fixture, project, storedSession, turns, true);
            const parseTurns = vi.spyOn(CodexAdapter.prototype, 'parseTurns');
            const reader = new SessionReader(fixture.db);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded durable session was not found');

            fixture.db.prepare("UPDATE durable_capture_status SET state = 'disabled_gap' WHERE session_id = ?").run(storedSession.id);
            await expect(reader.render(servedSession, 2)).resolves.toEqual({ reason: 'durable_capture_disabled_gap' });

            fixture.db.prepare("UPDATE durable_capture_status SET state = 'complete' WHERE session_id = ?").run(storedSession.id);
            const persisted = await reader.render(servedSession, 2, undefined, Number.MAX_SAFE_INTEGER);

            expect(persisted.episode).toEqual(boundedRender(turns, 2, Number.MAX_SAFE_INTEGER, persisted.episode?.nonce));
            expect(persisted.episode).toMatchObject({ returned: 2, omitted: 1, total: 3 });
            expect(parseTurns).not.toHaveBeenCalled();
        });
    });

    it('serves a verified complete copy after the source transcript is physically deleted', async () => {
        const fixture = createTestDb('elepha-session-reader-durable-recovery-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/durable-recovery.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'durable-recovery', sourcePath });
            captureTurns(fixture, project, storedSession, [turn(0, 'recovered response')], true);
            unlinkSync(sourcePath);
            const openTranscript = vi.spyOn(providerTranscript, 'openProviderTranscript');
            const reader = new SessionReader(fixture.db);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded durable session was not found');

            const result = await reader.render(servedSession);

            expect(result.episode?.text).toContain('recovered response');
            expect(openTranscript).not.toHaveBeenCalled();
            openTranscript.mockRestore();
        });
    });

    it('reports evicted coverage without rescuing it from a source', async () => {
        const fixture = createTestDb('elepha-session-reader-evicted-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/evicted.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'evicted', sourcePath });
            captureTurns(fixture, project, storedSession, [turn(0, 'evictedsearchneedle durable response')], true);
            fixture.db.transaction(() => {
                fixture.db
                    .prepare('DELETE FROM filtered_turns WHERE memory_id IN (SELECT id FROM memories WHERE session_id = ?)')
                    .run(storedSession.id);
                fixture.db.prepare("UPDATE durable_capture_status SET state = 'evicted' WHERE session_id = ?").run(storedSession.id);
            })();
            const parseTurns = vi.spyOn(CodexAdapter.prototype, 'parseTurns');
            const reader = new SessionReader(fixture.db);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded evicted session was not found');

            const recall = reader.storedContentRecallFor([servedSession], ['"evictedsearchneedle"'], 10, () => true);
            expect(recall.coverage).toEqual({
                complete: 0,
                completeTruncated: 0,
                incomplete: 0,
                evicted: 1,
                neverCaptured: 0,
                total: 1,
            });
            expect(recall.matches).toEqual(new Map());
            const fromSource = await reader.render(servedSession);
            expect(fromSource).toEqual({ reason: STORED_EVIDENCE_REASONS.evicted });
            expect(parseTurns).not.toHaveBeenCalled();

            unlinkSync(sourcePath);
            await expect(reader.render(servedSession)).resolves.toEqual({ reason: STORED_EVIDENCE_REASONS.evicted });
        });
    });

    it('never serves a source quote-back or persists its receipt on a missing-copy read', async () => {
        const fixture = createTestDb('elepha-session-reader-rule4-source-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/rule4-source.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'rule4-source', sourcePath });
            seedMemory(fixture, { project, session: storedSession, turnIndex: 1 });
            const reader = new SessionReader(fixture.db);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded Rule 4 session was not found');

            await expect(reader.render(servedSession)).resolves.toEqual({ reason: STORED_EVIDENCE_REASONS.missing });
            expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM injections').get()).toEqual({ count: 0 });
        });
    });

    it.each([
        {
            name: 'a missing filtered row',
            reason: STORED_EVIDENCE_REASONS.incomplete,
            invalidate: (fixture: ReturnType<typeof createTestDb>, sessionId: number): void => {
                fixture.db
                    .prepare(
                        `DELETE FROM filtered_turns
                         WHERE memory_id = (
                           SELECT id FROM memories WHERE session_id = ? ORDER BY turn_index DESC LIMIT 1
                         )`,
                    )
                    .run(sessionId);
            },
        },
        {
            name: 'an unsupported filtered row version',
            reason: STORED_EVIDENCE_REASONS.filterVersionMismatch,
            invalidate: (fixture: ReturnType<typeof createTestDb>, sessionId: number): void => {
                fixture.db
                    .prepare(
                        `UPDATE filtered_turns
                         SET filter_version = ?
                         WHERE memory_id = (
                           SELECT id FROM memories WHERE session_id = ? ORDER BY turn_index DESC LIMIT 1
                         )`,
                    )
                    .run(DURABLE_CAPTURE_FILTER_VERSION + 1, sessionId);
            },
        },
    ])('reports the retained gap for $name independently of source presence', async ({ invalidate, reason }) => {
        const fixture = createTestDb('elepha-session-reader-durable-incomplete-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/durable-incomplete.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'durable-incomplete', sourcePath });
            const turns = [turn(0, 'source first'), turn(1, 'source newest')];
            captureTurns(fixture, project, storedSession, turns, true);
            fixture.db.prepare("UPDATE filtered_turns SET assistant_response = 'partial copy must not render'").run();
            invalidate(fixture, storedSession.id);
            const parseTurns = vi.spyOn(CodexAdapter.prototype, 'parseTurns');
            const reader = new SessionReader(fixture.db);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded durable session was not found');

            const fromSource = await reader.render(servedSession);

            expect(fromSource).toEqual({ reason });
            expect(parseTurns).not.toHaveBeenCalled();

            unlinkSync(sourcePath);
            await expect(reader.render(servedSession)).resolves.toEqual({ reason });
            expect(parseTurns).not.toHaveBeenCalled();
        });
    });

    it('applies last_n and character bounds to a complete_truncated copy using the shared renderer', async () => {
        const fixture = createTestDb('elepha-session-reader-durable-truncated-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/durable-truncated.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'durable-truncated', sourcePath });
            captureTurns(
                fixture,
                project,
                storedSession,
                [
                    { ...turn(0, 'old response'), userMessage: `old-${'x'.repeat(SESSION_CHAR_BUDGET + 100)}` },
                    turn(1, 'middle response'),
                    turn(2, 'newest response'),
                ],
                true,
            );
            expect(fixture.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(storedSession.id)).toEqual({
                state: 'complete_truncated',
            });
            const storedRows = fixture.db
                .prepare(
                    `SELECT m.turn_index, ft.user_prompt, ft.assistant_response
                     FROM memories m
                     JOIN filtered_turns ft ON ft.memory_id = m.id
                     WHERE m.session_id = ?
                     ORDER BY m.turn_index`,
                )
                .all(storedSession.id) as Array<{ turn_index: number; user_prompt: string; assistant_response: string }>;
            const storedTurns = storedRows.map((row) => ({
                ...turn(row.turn_index, row.assistant_response),
                userMessage: row.user_prompt,
            }));
            const parseTurns = vi.spyOn(CodexAdapter.prototype, 'parseTurns');
            const reader = new SessionReader(fixture.db);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded durable session was not found');

            for (const [lastN, charBudget] of [
                [1, Number.MAX_SAFE_INTEGER],
                [undefined, 1_000],
            ] as const) {
                const result = await reader.render(servedSession, lastN, undefined, charBudget);
                expect(result.episode).toEqual(boundedRender(storedTurns, lastN, charBudget, result.episode?.nonce));
            }
            expect(parseTurns).not.toHaveBeenCalled();
        });
    });

    it('clamps last_n when the reader is called directly', async () => {
        const fixture = createTestDb('elepha-session-reader-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/reader-clamp.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'reader-clamp', sourcePath });
            const turns = Array.from({ length: MAX_GET_SESSION_LAST_N + 10 }, (_, index) => turn(index, `assistant ${index}`));
            captureTurns(fixture, project, storedSession, turns, true);
            const reader = new SessionReader(fixture.db);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded session was not found');

            const result = await reader.render(servedSession, MAX_GET_SESSION_LAST_N + 10, undefined, Number.MAX_SAFE_INTEGER);

            expect(result.episode).toMatchObject({
                returned: MAX_GET_SESSION_LAST_N,
                omitted: 10,
                total: MAX_GET_SESSION_LAST_N + 10,
            });
            expect(result.episode?.text).not.toContain('assistant 9\n');
            expect(result.episode?.text).toContain(`assistant ${MAX_GET_SESSION_LAST_N + 9}`);
        });
    });

    it('returns the existing deadline reason when aborted during render', async () => {
        const fixture = createTestDb('elepha-session-reader-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/deadline.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'deadline', sourcePath });
            captureTurns(fixture, project, storedSession, [turn(0, 'partial content'), turn(1, 'must not render')], true);
            const controller = new AbortController();
            controller.abort();
            const reader = new SessionReader(fixture.db);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded session was not found');

            const result = await reader.render(servedSession, undefined, controller.signal);

            expect(result).toEqual({ reason: 'deadline' });
            expect(result.episode).toBeUndefined();
        });
    });

    it('renders retained content byte-identically with the standalone renderer', async () => {
        const fixture = createTestDb('elepha-session-reader-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/normal.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'normal', sourcePath });
            const turns = [turn(0, 'first'), turn(1, 'second')];
            captureTurns(fixture, project, storedSession, turns, true);
            const parseTurns = vi.spyOn(CodexAdapter.prototype, 'parseTurns');
            const reader = new SessionReader(fixture.db);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded session was not found');

            const result = await reader.render(servedSession);

            expect(fixture.db.prepare('SELECT state FROM durable_capture_status').get()).toEqual({ state: 'complete' });
            expect(result.episode).toBeDefined();
            expect(result.episode).toEqual(boundedRender(turns, undefined, SESSION_CHAR_BUDGET, result.episode?.nonce));
            expect(parseTurns).not.toHaveBeenCalled();
        });
    });

    it('wraps every rendered turn in the injection nonce delimiters', () => {
        const episode = boundedRender([turn(0, 'first'), turn(1, 'second')], undefined, SESSION_CHAR_BUDGET, 'test-nonce');

        expect(episode.nonce).toBe('test-nonce');
        expect(episode.text.split(dataBlockOpen('test-nonce'))).toHaveLength(3);
        expect(episode.text.split(dataBlockClose('test-nonce'))).toHaveLength(3);
        expect(episode.text).toContain('## Turn 1');
        expect(episode.text).toContain('## Turn 2');
    });
});
