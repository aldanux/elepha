import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { realpath as fsRealpath } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { DURABLE_CAPTURE_FILTER_VERSION, MAX_GET_SESSION_LAST_N, SESSION_CHAR_BUDGET } from '../../src/config/constants.js';
import { codexSessionsRoot } from '../../src/config/paths.js';
import { omissionMarker } from '../../src/rendering/raw-turn-renderer.js';
import { openProviderTranscript, type ProviderTranscriptOpener } from '../../src/security/provider-transcript.js';
import { dataBlockClose, dataBlockOpen } from '../../src/serving/instructions.js';
import { boundedRender, newestActivity, type ServedSession, SessionReader } from '../../src/serving/session-reader.js';
import type { ProjectSet } from '../../src/storage/project-resolver.js';
import { UNTITLED_EPISODE } from '../../src/storage/session-title.js';
import type { ParsedTurn, ParseTurnsOptions, SessionAdapter } from '../../src/types/index.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedSession } from '../helpers/db.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

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

async function collectTurns(turns: AsyncIterable<ParsedTurn>): Promise<ParsedTurn[]> {
    const collected: ParsedTurn[] = [];
    for await (const parsedTurn of turns) {
        collected.push(parsedTurn);
    }
    return collected;
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

function readerWithParseTurns(
    db: ReturnType<typeof createTestDb>['db'],
    parseTurns: SessionAdapter['parseTurns'],
    openTranscript?: ProviderTranscriptOpener,
): SessionReader {
    const adapter = { parseTurns } as SessionAdapter;
    return new SessionReader(db, { codex: adapter, 'claude-code': adapter }, openTranscript);
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

describe('P2.8 bounded shared episode reader', () => {
    it('rejects an existing transcript outside the Codex store before parsing it', async () => {
        const fixture = createTestDb('elepha-session-reader-');
        await withCodexStore(fixture.directory, async () => {
            const parseTurns = vi.fn(async function* (): AsyncIterable<ParsedTurn> {
                yield turn(0, 'must not be read');
            });

            await expect(
                readerWithParseTurns(fixture.db, parseTurns).turns(
                    session('outside', '2026-08-17T00:00:00.000Z', '/etc/passwd'),
                    undefined,
                    new Set([0]),
                ),
            ).resolves.toEqual({
                reason: 'transcript_outside_store',
            });
            expect(parseTurns).not.toHaveBeenCalled();
        });
    });

    it('rejects a store-local symlink whose target is outside the Codex store', async () => {
        const fixture = createTestDb('elepha-session-reader-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const outside = `${fixture.directory}/outside.jsonl`;
            const symlink = `${storeRoot}/escape.jsonl`;
            writeFileSync(outside, '{}\n');
            symlinkSync(outside, symlink);
            const parseTurns = vi.fn(async function* (): AsyncIterable<ParsedTurn> {
                yield turn(0, 'must not be read');
            });

            await expect(
                readerWithParseTurns(fixture.db, parseTurns).turns(
                    session('symlink', '2026-08-17T00:00:00.000Z', symlink),
                    undefined,
                    new Set([0]),
                ),
            ).resolves.toEqual({
                reason: 'transcript_outside_store',
            });
            expect(parseTurns).not.toHaveBeenCalled();
        });
    });

    it('rejects a parent symlink retargeted outside after the file is opened', async () => {
        const fixture = createTestDb('elepha-session-reader-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const projectPath = path.join(withGrantableTestDir('elepha-session-reader-project-'), 'project');
            const insideDirectory = path.join(storeRoot, 'inside');
            const outsideDirectory = path.join(fixture.directory, 'outside');
            const alias = path.join(storeRoot, 'alias');
            const sourcePath = path.join(alias, 'episode.jsonl');
            mkdirSync(projectPath);
            mkdirSync(insideDirectory);
            mkdirSync(outsideDirectory);
            writeFileSync(path.join(insideDirectory, 'episode.jsonl'), '{"assistantText":"inside"}\n');
            writeFileSync(path.join(outsideDirectory, 'episode.jsonl'), '{"assistantText":"outside-derived"}\n');
            symlinkSync(insideDirectory, alias, 'dir');
            seedConsentRoot(fixture, { path: projectPath });
            const project = seedProject(fixture, { path: projectPath });
            const storedSession = seedSession(fixture, { project, nativeId: 'swapped', sourcePath });
            seedMemory(fixture, { project, session: storedSession });

            const parseTurns = vi.fn(async function* (): AsyncIterable<ParsedTurn> {
                yield turn(0, 'must not be read');
            });
            const reader = readerWithParseTurns(fixture.db, parseTurns, (tool, candidate) =>
                openProviderTranscript(tool, candidate, {
                    realpath: async (openedPath) => {
                        unlinkSync(alias);
                        symlinkSync(outsideDirectory, alias, 'dir');
                        return fsRealpath(openedPath);
                    },
                }),
            );
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded session was not found');

            const result = await reader.turns(servedSession);

            expect(result).toEqual({ reason: 'transcript_outside_store' });
            expect(result.turns).toBeUndefined();
            expect(parseTurns).not.toHaveBeenCalled();
        });
    });

    it('parses a real transcript inside the Codex store', async () => {
        const fixture = createTestDb('elepha-session-reader-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/episode.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const parseTurns = vi.fn(async function* (
                _filePath: string,
                _sinceCursor?: string,
                options?: ParseTurnsOptions,
            ): AsyncIterable<ParsedTurn> {
                await expect(options?.handle?.stat()).resolves.toMatchObject({ size: 3 });
                yield turn(0, 'served');
            });

            await expect(
                readerWithParseTurns(fixture.db, parseTurns).turns(
                    session('inside', '2026-08-17T00:00:00.000Z', sourcePath),
                    undefined,
                    new Set([0]),
                ),
            ).resolves.toEqual({
                turns: [turn(0, 'served')],
            });
            expect(parseTurns).toHaveBeenCalledWith(sourcePath, undefined, {
                closeTrailingOnIdle: true,
                handle: expect.anything(),
                signal: undefined,
            });
        });
    });

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
            for (const parsedTurn of turns) {
                seedMemory(fixture, { project, session: storedSession, turnIndex: parsedTurn.turnIndex });
            }
            let renderedBodies = 0;
            const parseTurns = vi.fn(async function* (): AsyncIterable<ParsedTurn> {
                for (const parsedTurn of turns) {
                    const instrumented = { ...parsedTurn };
                    Object.defineProperty(instrumented, 'assistantText', {
                        enumerable: true,
                        get: () => {
                            renderedBodies += 1;
                            return parsedTurn.assistantText;
                        },
                    });
                    yield instrumented;
                }
            });
            const reader = readerWithParseTurns(fixture.db, parseTurns);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded session was not found');

            const result = await reader.render(servedSession, 1);

            expect(result.episode).toMatchObject({ returned: 1, omitted: 49, total: 50 });
            expect(result.episode?.text).toContain('## Turn 50');
            expect(result.episode?.text).toContain('assistant 49');
            expect(result.episode?.text).not.toContain('assistant 48');
            expect(result.episode?.text).toContain(omissionMarker(49, 1, 50));
            expect(renderedBodies).toBe(turns.length + 1);
        });
    });

    it('keeps the retained streaming high-water below both count and character bounds with a large last_n', async () => {
        const fixture = createTestDb('elepha-session-reader-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/large-budgeted.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'large-budgeted', sourcePath });
            const turns = Array.from({ length: 60 }, (_, index) => turn(index, `assistant ${index} ${'x'.repeat(4_000)}`));
            for (const parsedTurn of turns) {
                seedMemory(fixture, { project, session: storedSession, turnIndex: parsedTurn.turnIndex });
            }
            const parseTurns = vi.fn(async function* (): AsyncIterable<ParsedTurn> {
                yield* turns;
            });
            const reader = readerWithParseTurns(fixture.db, parseTurns);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded session was not found');
            const charBudget = 12_000;

            const result = await reader.turns(servedSession, undefined, undefined, {
                lastN: 1_000_000_000,
                charBudget,
                nonce: 'high-water-nonce',
            });

            expect(result.retentionHighWater?.renderedChars).toBeLessThanOrEqual(charBudget);
            expect(result.retentionHighWater?.turns).toBe(2);
            expect(result.turns).toHaveLength(2);
        });
    });

    it('matches the full-parse renderer byte-for-byte on real Claude and Codex fixtures', async () => {
        const fixtureCases = [
            {
                name: 'claude-code/sample-session.jsonl',
                adapter: new ClaudeCodeAdapter(),
                source: path.join(__dirname, '..', 'fixtures', 'claude-code', 'sample-session.jsonl'),
            },
            {
                name: 'codex/rollout-2026-08-15 resume-marker.jsonl',
                adapter: new CodexAdapter(),
                source: path.join(
                    __dirname,
                    '..',
                    'fixtures',
                    'codex',
                    'rollout-2026-08-15T09-00-00-019fc000-0000-7000-8000-000000000002-resume-marker.jsonl',
                ),
            },
        ];

        for (const fixtureCase of fixtureCases) {
            const parsedTurns = await collectTurns(
                fixtureCase.adapter.parseTurns(fixtureCase.source, undefined, { closeTrailingOnIdle: true }),
            );
            const fixture = createTestDb('elepha-session-reader-equality-');
            await withCodexStore(fixture.directory, async (storeRoot) => {
                const sourcePath = `${storeRoot}/${path.basename(fixtureCase.source)}`;
                writeFileSync(sourcePath, '{}\n');
                const project = seedProject(fixture, { path: `/tmp/${fixtureCase.adapter.tool}` });
                const storedSession = seedSession(fixture, {
                    project,
                    nativeId: `equality-${fixtureCase.adapter.tool}`,
                    sourcePath,
                });
                for (const parsedTurn of parsedTurns) {
                    seedMemory(fixture, { project, session: storedSession, turnIndex: parsedTurn.turnIndex });
                }
                const reader = readerWithParseTurns(fixture.db, async function* (): AsyncIterable<ParsedTurn> {
                    yield* parsedTurns;
                });
                const servedSession = reader.sessionById(storedSession.id);
                if (!servedSession) throw new Error(`seeded ${fixtureCase.name} session was not found`);

                for (const lastN of [undefined, 1, 2, parsedTurns.length + 10]) {
                    const result = await reader.render(servedSession, lastN);
                    expect(result.episode, `${fixtureCase.name}, last_n=${String(lastN)}`).toEqual(
                        boundedRender(parsedTurns, lastN, SESSION_CHAR_BUDGET, result.episode?.nonce),
                    );
                }
            });
        }
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
            const parseTurns = vi.fn(async function* (): AsyncIterable<ParsedTurn> {
                yield* turns;
            });
            const reader = readerWithParseTurns(fixture.db, parseTurns);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded durable session was not found');

            fixture.db.prepare("UPDATE durable_capture_status SET state = 'disabled_gap' WHERE session_id = ?").run(storedSession.id);
            const source = await reader.render(servedSession, 2, undefined, Number.MAX_SAFE_INTEGER);
            expect(parseTurns).toHaveBeenCalledTimes(1);

            fixture.db.prepare("UPDATE durable_capture_status SET state = 'complete' WHERE session_id = ?").run(storedSession.id);
            const persisted = await reader.render(servedSession, 2, undefined, Number.MAX_SAFE_INTEGER);

            expect(source.episode).toBeDefined();
            expect(persisted.episode).toEqual({
                ...source.episode,
                nonce: persisted.episode?.nonce,
                text: source.episode?.text.replaceAll(source.episode.nonce, persisted.episode?.nonce ?? ''),
            });
            expect(persisted.episode).toMatchObject({ returned: 2, omitted: 1, total: 3 });
            expect(parseTurns).toHaveBeenCalledTimes(1);
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
            const openTranscript: ProviderTranscriptOpener = vi.fn(openProviderTranscript);
            const reader = readerWithParseTurns(
                fixture.db,
                async function* (): AsyncIterable<ParsedTurn> {
                    yield turn(99, 'the deleted source must not be parsed');
                },
                openTranscript,
            );
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded durable session was not found');

            const result = await reader.render(servedSession);

            expect(result.episode?.text).toContain('recovered response');
            expect(openTranscript).not.toHaveBeenCalled();
        });
    });

    it.each([
        {
            name: 'a missing filtered row',
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
    ])('uses only the source for $name, then reports an incomplete durable copy when the source is gone', async ({ invalidate }) => {
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
            const parseTurns = vi.fn(async function* (): AsyncIterable<ParsedTurn> {
                yield* turns;
            });
            const reader = readerWithParseTurns(fixture.db, parseTurns);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded durable session was not found');

            const fromSource = await reader.render(servedSession);

            expect(fromSource.episode?.text).toContain('source newest');
            expect(fromSource.episode?.text).not.toContain('partial copy must not render');
            expect(parseTurns).toHaveBeenCalledTimes(1);

            unlinkSync(sourcePath);
            await expect(reader.render(servedSession)).resolves.toEqual({ reason: 'durable_capture_incomplete' });
            expect(parseTurns).toHaveBeenCalledTimes(1);
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
            const parseTurns = vi.fn(async function* (): AsyncIterable<ParsedTurn> {
                yield turn(99, 'a complete_truncated copy must not parse the source');
            });
            const reader = readerWithParseTurns(fixture.db, parseTurns);
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
            for (const parsedTurn of turns) {
                seedMemory(fixture, { project, session: storedSession, turnIndex: parsedTurn.turnIndex });
            }
            const reader = readerWithParseTurns(fixture.db, async function* (): AsyncIterable<ParsedTurn> {
                yield* turns;
            });
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
            seedMemory(fixture, { project, session: storedSession, turnIndex: 0 });
            seedMemory(fixture, { project, session: storedSession, turnIndex: 1 });
            const controller = new AbortController();
            const reader = readerWithParseTurns(fixture.db, async function* (): AsyncIterable<ParsedTurn> {
                yield turn(0, 'partial content');
                controller.abort();
                yield turn(1, 'must not render');
            });
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded session was not found');

            const result = await reader.render(servedSession, undefined, controller.signal);

            expect(result).toEqual({ reason: 'deadline' });
            expect(result.episode).toBeUndefined();
        });
    });

    it('keeps a durable-capture-off session byte-identical on the source path when streaming does not evict', async () => {
        const fixture = createTestDb('elepha-session-reader-');
        await withCodexStore(fixture.directory, async (storeRoot) => {
            const sourcePath = `${storeRoot}/normal.jsonl`;
            writeFileSync(sourcePath, '{}\n');
            const project = seedProject(fixture, { path: '/tmp/project' });
            const storedSession = seedSession(fixture, { project, nativeId: 'normal', sourcePath });
            const turns = [turn(0, 'first'), turn(1, 'second')];
            for (const parsedTurn of turns) {
                seedMemory(fixture, { project, session: storedSession, turnIndex: parsedTurn.turnIndex });
            }
            const parseTurns = vi.fn(async function* (): AsyncIterable<ParsedTurn> {
                yield* turns;
            });
            const reader = readerWithParseTurns(fixture.db, parseTurns);
            const servedSession = reader.sessionById(storedSession.id);
            if (!servedSession) throw new Error('seeded session was not found');

            const result = await reader.render(servedSession);

            expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM durable_capture_status').get()).toEqual({ count: 0 });
            expect(result.episode).toBeDefined();
            expect(result.episode).toEqual(boundedRender(turns, undefined, SESSION_CHAR_BUDGET, result.episode?.nonce));
            expect(parseTurns).toHaveBeenCalledTimes(1);
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
