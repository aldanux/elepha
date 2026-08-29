import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REMEMBER_SCAN_BUDGET_MS, REMEMBER_SESSION_RECENCY_CAP, SESSION_CHAR_BUDGET } from '../../src/config/constants.js';
import { codexSessionsRoot } from '../../src/config/paths.js';
import { getSetting, setSetting } from '../../src/config/settings.js';
import { parseUserPromptCommand, runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { CLOSE } from '../../src/security/sentinel.js';
import {
    DISPLAY_VERBATIM_INSTRUCTIONS,
    REMEMBER_HERE_UNCONSENTED,
    REMEMBER_QUERY_REQUIRED,
    SELECT_HINT,
} from '../../src/serving/instructions.js';
import { lexicalRecall, tokenizeRecallQuery } from '../../src/serving/lexical-recall.js';
import type { ServedSession, SessionReader } from '../../src/serving/session-reader.js';
import { ConsentStore } from '../../src/storage/consent-store.js';
import { openDb } from '../../src/storage/db.js';
import { ProjectResolver, type ProjectSet } from '../../src/storage/project-resolver.js';
import { UNTITLED_EPISODE } from '../../src/storage/session-title.js';
import type { TestDatabase } from '../helpers/db.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';

const NOW = Date.parse('2026-08-22T12:00:00.000Z');
const testCodexHome = mkdtempSync(path.join(tmpdir(), 'elepha-remember-codex-'));
const priorCodexHome = process.env.CODEX_HOME;

beforeAll(() => {
    process.env.CODEX_HOME = testCodexHome;
    mkdirSync(codexSessionsRoot(), { recursive: true });
});

afterAll(() => {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
});

interface TranscriptTurn {
    assistant: string;
    file?: string;
    toolOutput?: string;
    user: string;
}

function transcript(cwd: string, turns: TranscriptTurn[]): string {
    const lines: unknown[] = [
        {
            timestamp: '2026-08-22T00:00:00.000Z',
            type: 'session_meta',
            payload: { cwd, originator: 'codex-tui', source: 'cli' },
        },
    ];
    turns.forEach((turn, index) => {
        const at = (offset: number) => new Date(Date.parse('2026-08-22T00:00:00.000Z') + index * 1_000 + offset).toISOString();
        lines.push(
            {
                timestamp: at(100),
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn.user }] },
            },
            {
                timestamp: at(200),
                type: 'event_msg',
                payload: { type: 'user_message', message: turn.user },
            },
        );
        if (turn.file) {
            lines.push({
                timestamp: at(300),
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'read_file',
                    arguments: JSON.stringify({ file_path: turn.file, projectPath: cwd }),
                },
            });
        }
        if (turn.toolOutput) {
            lines.push({
                timestamp: at(400),
                type: 'response_item',
                payload: { type: 'function_call_output', output: turn.toolOutput },
            });
        }
        lines.push({
            timestamp: at(500),
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.assistant }] },
        });
    });
    return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function addProject(fixture: TestDatabase, name: string, state: 'approved' | 'denied') {
    const requestedPath = path.join(fixture.directory, name);
    mkdirSync(requestedPath, { recursive: true });
    const projectPath = realpathSync(requestedPath);
    const project = seedProject(fixture, { path: projectPath });
    seedConsentRoot(fixture, { path: projectPath, state });
    return { project, projectPath };
}

function addSession(
    fixture: TestDatabase,
    project: ReturnType<typeof seedProject>,
    projectPath: string,
    options: {
        decisions?: Array<{ what: string; why: string | null }>;
        files?: string[];
        nativeId: string;
        rollupSummary?: string;
        timestamp: string;
        title: string;
        turns: TranscriptTurn[];
    },
): ReturnType<typeof seedSession> {
    const sourcePath = path.join(codexSessionsRoot(), path.basename(fixture.directory), `rollout-${options.nativeId}.jsonl`);
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, transcript(projectPath, options.turns));
    const session = seedSession(fixture, {
        project,
        nativeId: options.nativeId,
        sourcePath,
        surface: 'cli',
        title: options.title,
        startedAt: options.timestamp,
        lastIngestedAt: options.timestamp,
        lastTurnAt: options.timestamp,
    });
    options.turns.forEach((_turn, turnIndex) => {
        seedMemory(fixture, {
            project,
            session,
            turnIndex,
            startedAt: options.timestamp,
            userMessage: options.turns[turnIndex]!.user,
            decisions: turnIndex === 0 ? options.decisions : undefined,
            filesTouched: turnIndex === 0 ? options.files : undefined,
        });
    });
    if (options.rollupSummary) {
        seedRollup(fixture, { project, session });
        fixture.db.prepare('UPDATE session_rollups SET summary = ? WHERE session_id = ?').run(options.rollupSummary, session.id);
    }
    return session;
}

function payload(cwd: string, prompt: string): string {
    return JSON.stringify({
        session_id: 'current-session',
        cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt,
        turn_id: 'turn-1',
        model: 'gpt-5.6',
        permission_mode: 'default',
        transcript_path: null,
    });
}

function contextOf(result: Awaited<ReturnType<typeof runUserPromptSubmit>>): string {
    expect('output' in result).toBe(true);
    if (!('output' in result)) return '';
    return (result.output.hookSpecificOutput as Record<string, string>).additionalContext;
}

function recallSession(id: number, title: string, timestamp: string, firstPromptSearch = 'ordinary opening request'): ServedSession {
    return {
        id,
        tool: 'codex',
        native_id: `recall-${id}`,
        segment_index: 0,
        project_id: 1,
        source_path: `/transcripts/recall-${id}.jsonl`,
        started_at: timestamp,
        last_ingested_at: timestamp,
        surface: 'cli',
        git_branch: null,
        last_turn_at: timestamp,
        rendered_chars: 0,
        rendered_turns: 0,
        title,
        custom_title: null,
        first_prompt_search: firstPromptSearch,
        git_commit_count: null,
        rollup_title: null,
        rollup_decisions: null,
        rollup_state: null,
        turn_count: 1,
        has_files_touched: 0,
        has_external_content: 0,
    };
}

describe('UserPromptSubmit lexical recall', () => {
    it('parses both scopes and handles empty or filler-only queries without scanning', async () => {
        expect(parseUserPromptCommand('elepha:query UnicodeQuery')).toEqual({
            kind: 'query',
            query: 'UnicodeQuery',
            scope: 'global',
        });
        expect(parseUserPromptCommand(' elepha:query:here src/raw-turn_renderer.ts ')).toEqual({
            kind: 'query',
            query: 'src/raw-turn_renderer.ts',
            scope: 'here',
        });
        expect(tokenizeRecallQuery('PLEASE ÜberHTTPServer raw-turn_renderer.ts')).toMatchObject({
            components: ['über', 'http', 'server', 'raw', 'turn', 'renderer', 'ts'],
            phrase: 'über http server raw turn renderer ts',
            tokens: expect.arrayContaining(['über', 'http', 'server', 'raw-turn_renderer.ts', 'raw', 'turn', 'renderer', 'ts']),
        });

        const fixture = createTestDb('elepha-remember-empty-');
        const { projectPath } = addProject(fixture, 'current', 'approved');
        const result = await runUserPromptSubmit(payload(projectPath, 'elepha:query please the about'), 'codex', {
            dbPath: fixture.dbPath,
            now: () => NOW,
        });

        expect(contextOf(result)).toContain(REMEMBER_QUERY_REQUIRED);
    });

    it('searches other consented projects globally, keeps here local, and excludes denied projects', async () => {
        const fixture = createTestDb('elepha-remember-scope-');
        const current = addProject(fixture, 'current', 'approved');
        const remote = addProject(fixture, 'remote-approved', 'approved');
        const denied = addProject(fixture, 'remote-denied', 'denied');
        addSession(fixture, current.project, current.projectPath, {
            nativeId: 'current',
            title: 'Current local work',
            timestamp: '2026-08-22T10:00:00.000Z',
            turns: [{ user: 'ordinary local request', assistant: 'ordinary local answer' }],
        });
        addSession(fixture, remote.project, remote.projectPath, {
            nativeId: 'approved',
            title: 'Approved remote match',
            timestamp: '2026-08-22T09:00:00.000Z',
            turns: [{ user: 'find crossProjectNeedle here', assistant: 'approved result' }],
        });
        addSession(fixture, denied.project, denied.projectPath, {
            nativeId: 'denied',
            title: 'Denied remote match',
            timestamp: '2026-08-22T11:00:00.000Z',
            turns: [{ user: 'find crossProjectNeedle here', assistant: 'denied result must not leak' }],
        });

        fixture.close();
        const global = contextOf(
            await runUserPromptSubmit(payload(current.projectPath, 'elepha:query cross project needle'), 'codex', {
                dbPath: fixture.dbPath,
                now: () => NOW,
            }),
        );
        const here = contextOf(
            await runUserPromptSubmit(payload(current.projectPath, 'elepha:query:here cross project needle'), 'codex', {
                dbPath: fixture.dbPath,
                now: () => NOW + 1,
            }),
        );

        expect(global).toContain('1. [3h ago | Codex CLI] · remote-approved · Approved remote match');
        expect(global).not.toContain('Denied remote match');
        expect(global).not.toContain('denied result must not leak');
        expect(global).not.toContain('recency cap');
        expect(global.split('\n').at(-2)).toBe(SELECT_HINT);
        expect(here).toContain('No recall matches found');
        expect(here).not.toContain('Approved remote match');
        expect(here).toContain(`No recall matches found for “cross project needle”.\n\n${SELECT_HINT}`);
        expect(here).not.toContain('\n\n\n');
        expect(here.split('\n').at(-2)).toBe(SELECT_HINT);
    });

    it('discards a global recall when a contributing project is revoked during the await', async () => {
        const fixture = createTestDb('elepha-remember-global-consent-race-');
        const current = addProject(fixture, 'current', 'approved');
        const remote = addProject(fixture, 'remote', 'approved');
        addSession(fixture, remote.project, remote.projectPath, {
            nativeId: 'revoked-global-hit',
            title: 'Revoked global transcript result',
            timestamp: '2026-08-22T11:00:00.000Z',
            turns: [{ user: 'find revocation race needle', assistant: 'stale global answer' }],
        });
        fixture.close();
        const writeInjection = vi.fn(() => true);
        const log: string[] = [];

        queueMicrotask(() => {
            const revokingDb = openDb(fixture.dbPath);
            new ConsentStore(revokingDb).revoke(remote.projectPath);
            revokingDb.close();
        });
        const result = await runUserPromptSubmit(payload(current.projectPath, 'elepha:query revocation race needle'), 'codex', {
            dbPath: fixture.dbPath,
            now: () => NOW,
            writeInjection,
            log: (line) => log.push(line),
        });

        expect(result).toEqual({ reason: 'project_unavailable_or_unconsented' });
        expect(JSON.stringify(result)).not.toContain('Revoked global transcript result');
        expect(writeInjection).not.toHaveBeenCalled();
        const verificationDb = openDb(fixture.dbPath);
        expect(verificationDb.prepare('SELECT COUNT(*) AS count FROM injections').get()).toEqual({ count: 0 });
        verificationDb.close();
        expect(log).toContain('user-prompt-submit codex session_id=current-session: discarded reason=project_unavailable_or_unconsented');
    });

    it('replaces a revoked here recall with exactly the unconsented-project notice', async () => {
        const fixture = createTestDb('elepha-remember-here-consent-race-');
        const current = addProject(fixture, 'current', 'approved');
        addSession(fixture, current.project, current.projectPath, {
            nativeId: 'revoked-here-hit',
            title: 'Revoked here transcript result',
            timestamp: '2026-08-22T11:00:00.000Z',
            turns: [{ user: 'find local revocation needle', assistant: 'stale local answer' }],
        });
        fixture.close();
        const log: string[] = [];

        queueMicrotask(() => {
            const revokingDb = openDb(fixture.dbPath);
            new ConsentStore(revokingDb).revoke(current.projectPath);
            revokingDb.close();
        });
        const result = await runUserPromptSubmit(payload(current.projectPath, 'elepha:query:here local revocation needle'), 'codex', {
            dbPath: fixture.dbPath,
            now: () => NOW,
            log: (line) => log.push(line),
        });

        const context = contextOf(result);
        const body = context.slice(context.indexOf('\n') + 1, -`\n${CLOSE}`.length);
        expect(body).toBe(`${DISPLAY_VERBATIM_INSTRUCTIONS}\n${REMEMBER_HERE_UNCONSENTED}`);
        expect(context).not.toContain('Revoked here transcript result');
        expect(context).not.toContain('stale local answer');
        const verificationDb = openDb(fixture.dbPath);
        expect(verificationDb.prepare('SELECT body FROM injections').all()).toEqual([{ body }]);
        verificationDb.close();
        expect(log).toContain('user-prompt-submit codex session_id=current-session: discarded reason=project_unavailable_or_unconsented');
    });

    it('uses stored no-Git project groups across query, last, list, and select', async () => {
        const fixture = createTestDb('elepha-stored-hook-projects-');
        const current = addProject(fixture, 'current', 'approved');
        const remote = addProject(fixture, 'remote', 'approved');
        addSession(fixture, current.project, current.projectPath, {
            nativeId: 'current',
            title: 'Current project work',
            timestamp: '2026-08-22T10:00:00.000Z',
            turns: [{ user: 'ordinary local request', assistant: 'ordinary local answer' }],
        });
        addSession(fixture, remote.project, remote.projectPath, {
            nativeId: 'remote',
            title: 'Remote project work',
            timestamp: '2026-08-22T09:00:00.000Z',
            turns: [{ user: 'find crossProjectNeedle here', assistant: 'remote answer' }],
        });
        fixture.close();
        const resolveGitRoot = vi.fn(() => {
            throw new Error('hook consented-project enumeration must not resolve Git');
        });
        for (const command of ['elepha:query cross project needle', 'elepha:last', 'elepha:list', 'elepha:select:1']) {
            const result = await runUserPromptSubmit(payload(current.projectPath, command), 'codex', {
                dbPath: fixture.dbPath,
                now: () => NOW,
                projectResolver: (db) => new ProjectResolver(db, { resolveGitRoot }),
            });

            expect(result).not.toEqual({ reason: 'hook_error' });
        }
        expect(resolveGitRoot).not.toHaveBeenCalled();
    });

    it('opens the second shown cross-project recall hit and blocks it after consent is revoked', async () => {
        const fixture = createTestDb('elepha-remember-open-');
        const current = addProject(fixture, 'current', 'approved');
        const remote = addProject(fixture, 'remote', 'approved');
        addSession(fixture, current.project, current.projectPath, {
            nativeId: 'first-hit',
            title: 'Needle first hit',
            timestamp: '2026-08-22T11:00:00.000Z',
            turns: [{ user: 'find durable needle', assistant: 'first current-project answer' }],
        });
        addSession(fixture, remote.project, remote.projectPath, {
            nativeId: 'second-hit',
            title: 'Needle second hit',
            timestamp: '2026-08-22T10:00:00.000Z',
            turns: [{ user: 'find durable needle', assistant: 'second cross-project answer' }],
        });
        fixture.close();

        const remembered = await runUserPromptSubmit(payload(current.projectPath, 'elepha:query durable needle'), 'codex', {
            dbPath: fixture.dbPath,
            now: () => NOW,
        });
        const opened = await runUserPromptSubmit(payload(current.projectPath, 'elepha:select:2'), 'codex', {
            dbPath: fixture.dbPath,
            now: () => NOW + 1,
        });

        expect(contextOf(remembered)).toContain('2. [2h ago | Codex CLI] · remote · Needle second hit');
        const openedContext = contextOf(opened);
        expect(openedContext).toContain('# Needle second hit');
        expect(openedContext).toContain('second cross-project answer');
        expect(openedContext).not.toContain('first current-project answer');

        const db = openDb(fixture.dbPath);
        db.prepare("UPDATE consent_roots SET state = 'denied' WHERE path = ?").run(remote.projectPath);
        db.close();
        const blocked = await runUserPromptSubmit(payload(current.projectPath, 'elepha:select:2'), 'codex', {
            dbPath: fixture.dbPath,
            now: () => NOW + 2,
        });
        expect(blocked).toEqual({ reason: 'project_unavailable_or_unconsented' });
    });

    it('requires every multi-term component across titles and first turns while preserving old and single-token matches', async () => {
        const project: ProjectSet = {
            key: 'coverage-project',
            displayName: 'coverage-project',
            paths: ['/coverage-project'],
            projectIds: [1],
            gitRoot: null,
            gitRemote: null,
        };
        const sessions = [
            recallSession(1, 'Alpha newest title', '2026-08-22T11:00:00.000Z'),
            recallSession(2, 'Alpha Beta middle title', '2026-08-22T10:00:00.000Z'),
            recallSession(3, 'Alpha Beta Gamma oldest title', '2026-08-22T09:00:00.000Z'),
            recallSession(4, 'Laravel Cloud deployment', '2026-08-22T08:00:00.000Z', 'Configure routine deployment'),
            recallSession(5, 'Laravel Cloud application', '2026-08-22T07:00:00.000Z', 'Configure Lighthouse audits'),
            recallSession(6, 'Archived Needle design', '2025-01-01T00:00:00.000Z', 'unrelated opening request'),
        ];
        const reader = {
            sessionsFor: () => sessions,
            storedRecallFieldsFor: () => new Map(sessions.map((session) => [session.id, new Map()])),
            turns: async () => ({ reason: 'must_not_parse' }),
        } as unknown as SessionReader;
        const multiToken = tokenizeRecallQuery('alpha beta gamma');
        const misspelledToken = tokenizeRecallQuery('alpha beta gamma gammma');
        const singleToken = tokenizeRecallQuery('alpha');
        const unionQuery = tokenizeRecallQuery('laravel cloud lighthouse');
        const oldTitleQuery = tokenizeRecallQuery('archived needle');
        expect(multiToken).toBeDefined();
        expect(misspelledToken).toBeDefined();
        expect(singleToken).toBeDefined();
        if (!multiToken || !misspelledToken || !singleToken || !unionQuery || !oldTitleQuery) return;

        const { body: multiTokenBody } = await lexicalRecall(reader, [project], multiToken, 'here', undefined, undefined, 'strict');
        expect(multiTokenBody).toContain('Alpha Beta Gamma oldest title');
        expect(multiTokenBody).not.toContain('Alpha Beta middle title');
        expect(multiTokenBody).not.toContain('Alpha newest title');
        expect(multiTokenBody.match(/^\d+\. /gm)).toHaveLength(1);

        const { body: misspelledTokenBody } = await lexicalRecall(
            reader,
            [project],
            misspelledToken,
            'here',
            undefined,
            undefined,
            'strict',
        );
        expect(misspelledTokenBody).toContain('No recall matches found for “alpha beta gamma gammma”.');

        const { body: unionBody } = await lexicalRecall(reader, [project], unionQuery, 'here', undefined, undefined, 'strict');
        expect(unionBody).toContain('Laravel Cloud application');
        expect(unionBody).not.toContain('Laravel Cloud deployment');

        const { body: oldTitleBody } = await lexicalRecall(reader, [project], oldTitleQuery, 'here', undefined, undefined, 'strict');
        expect(oldTitleBody).toContain('Archived Needle design');

        const { body: singleTokenBody } = await lexicalRecall(reader, [project], singleToken, 'here', undefined, undefined, 'strict');
        expect(singleTokenBody).toContain('Alpha newest title');
        expect(singleTokenBody).toContain('Alpha Beta middle title');
        expect(singleTokenBody).toContain('Alpha Beta Gamma oldest title');
    });

    it('uses lax matching across split terms while preserving the two-token floor', async () => {
        const project: ProjectSet = {
            key: 'lax-project',
            displayName: 'lax-project',
            paths: ['/lax-project'],
            projectIds: [1],
            gitRoot: null,
            gitRemote: null,
        };
        const sessions = [
            recallSession(1, 'Alpha Beta combined work', '2026-08-22T11:00:00.000Z'),
            recallSession(2, 'Gamma isolated work', '2026-08-22T10:00:00.000Z'),
            recallSession(3, 'Alpha isolated work', '2026-08-22T09:00:00.000Z'),
        ];
        const reader = {
            sessionsFor: () => sessions,
            storedRecallFieldsFor: () => new Map(sessions.map((session) => [session.id, new Map()])),
            turns: async () => ({ reason: 'must_not_parse' }),
        } as unknown as SessionReader;
        const query = tokenizeRecallQuery('alpha beta gamma');
        const matchingConfig = path.join(mkdtempSync(path.join(tmpdir(), 'elepha-query-matching-')), 'config.json');
        expect(query).toBeDefined();
        if (!query) return;

        const strictMode = getSetting('query-matching', {}, matchingConfig).value;
        const strict = await lexicalRecall(reader, [project], query, 'here', () => 0, undefined, strictMode);
        expect(strict.body).toContain('No recall matches found for “alpha beta gamma”.');

        setSetting('query-matching', 'lax', matchingConfig);
        const laxMode = getSetting('query-matching', {}, matchingConfig).value;
        const lax = await lexicalRecall(reader, [project], query, 'here', () => 0, undefined, laxMode);

        expect(lax.body).toContain('Alpha Beta combined work');
        expect(lax.body).not.toContain('Gamma isolated work');
        expect(lax.body).not.toContain('Alpha isolated work');
        expect(lax.sessionIds).toEqual([1]);
    });

    it('keeps substantive command-opened sessions and excludes command-only sessions', async () => {
        const project: ProjectSet = {
            key: 'command-project',
            displayName: 'command-project',
            paths: ['/command-project'],
            projectIds: [1],
            gitRoot: null,
            gitRemote: null,
        };
        const substantive = recallSession(
            1,
            'Laravel Cloud Lighthouse investigation',
            '2026-08-22T11:00:00.000Z',
            '  ELEPHA:query laravel cloud lighthouse',
        );
        const commandOnly = recallSession(2, UNTITLED_EPISODE, '2026-08-22T10:00:00.000Z', 'elepha:list');
        const sessions = [
            substantive,
            commandOnly,
            ...Array.from({ length: 10 }, (_, index) =>
                recallSession(index + 3, `Alpha Beta work ${index + 1}`, new Date(NOW - index * 1_000).toISOString()),
            ),
        ];
        let transcriptParses = 0;
        const reader = {
            sessionsFor: () => sessions,
            storedRecallFieldsFor: () =>
                new Map(sessions.map((session) => [session.id, new Map([[0, { decisions: [], filesTouched: [], pendingItems: [] }]])])),
            turns: async (session: ServedSession) => {
                transcriptParses += 1;
                return {
                    turns: [
                        {
                            assistantText: 'ordinary response',
                            toolCalls: [],
                            turnIndex: 0,
                            userMessage: session.id === substantive.id ? '  ELEPHA:query laravel cloud lighthouse' : 'elepha:list',
                        },
                    ],
                };
            },
        } as unknown as SessionReader;
        const substantiveQuery = tokenizeRecallQuery('laravel cloud lighthouse');
        const commandQuery = tokenizeRecallQuery('elepha list');
        const cappedQuery = tokenizeRecallQuery('alpha beta');
        expect(substantiveQuery).toBeDefined();
        expect(commandQuery).toBeDefined();
        if (!substantiveQuery || !commandQuery || !cappedQuery) return;

        const substantiveResult = await lexicalRecall(reader, [project], substantiveQuery, 'here', undefined, undefined, 'strict');
        const commandResult = await lexicalRecall(reader, [project], commandQuery, 'here', undefined, undefined, 'strict');
        const cappedResult = await lexicalRecall(reader, [project], cappedQuery, 'here', undefined, undefined, 'strict');

        expect(substantiveResult.sessionIds).toEqual([substantive.id]);
        expect(substantiveResult.body).toContain('Laravel Cloud Lighthouse investigation');
        expect(commandResult.sessionIds).toEqual([]);
        expect(commandResult.body).not.toContain(UNTITLED_EPISODE);
        expect(cappedResult.body).not.toContain(UNTITLED_EPISODE);
        expect(cappedResult.body.match(/^\d+\. /gm)).toHaveLength(5);
        expect(transcriptParses).toBe(0);
    });

    it('does not search derived, file, project, assistant, or later-turn fields', async () => {
        const fixture = createTestDb('elepha-remember-rank-');
        const current = addProject(fixture, 'alpha-beta-project', 'approved');
        const cases = [
            {
                nativeId: 'body',
                title: 'Ordinary body',
                timestamp: '2026-08-22T11:00:00.000Z',
                turns: [{ user: 'gamma appears far away from delta', assistant: 'ordinary response' }],
            },
            {
                nativeId: 'decision',
                title: 'Derived decision',
                timestamp: '2026-08-22T10:00:00.000Z',
                decisions: [{ what: 'alpha strategy', why: 'beta constraint' }],
                turns: [{ user: 'unrelated request', assistant: 'unrelated response' }],
            },
            {
                nativeId: 'phrase',
                title: 'Exact phrase body',
                timestamp: '2026-08-22T09:00:00.000Z',
                turns: [{ user: 'the gamma delta implementation', assistant: 'completed' }],
            },
            {
                nativeId: 'deep',
                title: 'Deep transcript noise',
                timestamp: '2026-08-22T08:45:00.000Z',
                turns: [
                    { user: 'unrelated opening request', assistant: 'unrelated opening response' },
                    { user: 'buried zephyr appears only later', assistant: 'deep response' },
                ],
            },
            {
                nativeId: 'assistant',
                title: 'Assistant-only noise',
                timestamp: '2026-08-22T08:40:00.000Z',
                turns: [{ user: 'unrelated opening request', assistant: 'gamma delta appears only in the assistant response' }],
            },
            {
                nativeId: 'summary',
                title: 'Derived summary',
                timestamp: '2026-08-22T08:30:00.000Z',
                rollupSummary: 'alpha signal under a beta constraint',
                turns: [{ user: 'unrelated request', assistant: 'unrelated response' }],
            },
            {
                nativeId: 'file',
                title: 'Filename match',
                timestamp: '2026-08-22T08:00:00.000Z',
                files: [path.join(current.projectPath, 'src', 'alpha-beta.ts')],
                turns: [{ user: 'unrelated request', assistant: 'unrelated response' }],
            },
            {
                nativeId: 'title',
                title: 'Alpha Beta title',
                timestamp: '2026-08-22T07:00:00.000Z',
                turns: [{ user: 'unrelated request', assistant: 'unrelated response' }],
            },
        ];
        for (const item of cases) {
            addSession(fixture, current.project, current.projectPath, item);
        }
        fixture.close();

        const context = contextOf(
            await runUserPromptSubmit(payload(current.projectPath, 'elepha:query:here alpha beta'), 'codex', {
                dbPath: fixture.dbPath,
                now: () => NOW,
            }),
        );
        expect(context).toContain('Alpha Beta title');
        expect(context).not.toContain('Filename match');
        expect(context).not.toContain('Derived decision');
        expect(context).not.toContain('Derived summary');

        const rawContext = contextOf(
            await runUserPromptSubmit(payload(current.projectPath, 'elepha:query:here gamma delta'), 'codex', {
                dbPath: fixture.dbPath,
                now: () => NOW + 1,
            }),
        );
        expect(rawContext.indexOf('Exact phrase body')).toBeGreaterThan(-1);
        expect(rawContext.indexOf('Ordinary body')).toBeGreaterThan(-1);
        expect(rawContext.indexOf('Exact phrase body')).toBeLessThan(rawContext.indexOf('Ordinary body'));
        expect(rawContext).not.toContain('Deep transcript noise');
        expect(rawContext).not.toContain('Assistant-only noise');

        const deepOnlyContext = contextOf(
            await runUserPromptSubmit(payload(current.projectPath, 'elepha:query:here buried zephyr'), 'codex', {
                dbPath: fixture.dbPath,
                now: () => NOW + 2,
            }),
        );
        expect(deepOnlyContext).toContain('No recall matches found for “buried zephyr”.');
        expect(deepOnlyContext).not.toContain('Deep transcript noise');
    });

    it('keeps the list-only body within the output budget', async () => {
        const project: ProjectSet = {
            key: 'budget-project',
            displayName: 'budget-project',
            paths: ['/budget-project'],
            projectIds: [1],
            gitRoot: null,
            gitRemote: null,
        };
        const session = recallSession(1, `Needle target ${'x'.repeat(SESSION_CHAR_BUDGET)}`, '2026-08-22T11:00:00.000Z');
        const reader = {
            sessionsFor: () => [session],
            storedRecallFieldsFor: () => new Map([[session.id, new Map([[0, { decisions: [], filesTouched: [], pendingItems: [] }]])]]),
            turns: async () => ({ turns: [{ turnIndex: 0, userMessage: 'ordinary opening request' }] }),
        } as unknown as SessionReader;
        const query = tokenizeRecallQuery('needle target');
        expect(query).toBeDefined();
        if (!query) return;

        const { body } = await lexicalRecall(reader, [project], query, 'here', undefined, undefined, 'strict');
        expect(body.length).toBeLessThanOrEqual(SESSION_CHAR_BUDGET);
    });

    it('reports accurate partial coverage when the per-scope recency cap excludes sessions', async () => {
        const total = REMEMBER_SESSION_RECENCY_CAP.here + 1;
        const project: ProjectSet = {
            key: 'cap-project',
            displayName: 'cap-project',
            paths: ['/cap-project'],
            projectIds: [1],
            gitRoot: null,
            gitRemote: null,
        };
        const sessions = Array.from(
            { length: total },
            (_, index): ServedSession => ({
                id: index + 1,
                tool: 'codex',
                native_id: `cap-${index}`,
                segment_index: 0,
                project_id: 1,
                source_path: `/transcripts/cap-${index}.jsonl`,
                started_at: new Date(NOW - index * 1_000).toISOString(),
                last_ingested_at: new Date(NOW - index * 1_000).toISOString(),
                surface: 'cli',
                git_branch: null,
                last_turn_at: new Date(NOW - index * 1_000).toISOString(),
                rendered_chars: 0,
                rendered_turns: 0,
                title: `Cap session ${index}`,
                custom_title: null,
                first_prompt_search: 'unrelated opening request',
                git_commit_count: null,
                rollup_title: null,
                rollup_decisions: null,
                rollup_state: null,
                turn_count: 1,
                has_files_touched: 0,
                has_external_content: 0,
            }),
        );
        const reader = {
            sessionsFor: () => sessions,
            turns: async () => ({ turns: [{ turnIndex: 0, userMessage: 'unrelated opening request' }] }),
            storedRecallFieldsFor: () =>
                new Map(sessions.map((session) => [session.id, new Map([[0, { decisions: [], filesTouched: [], pendingItems: [] }]])])),
        } as unknown as SessionReader;
        const query = tokenizeRecallQuery('cap session');
        expect(query).toBeDefined();
        if (!query) return;

        const { body } = await lexicalRecall(reader, [project], query, 'here', undefined, undefined, 'strict');
        const coverage = `Partial coverage (recency cap): searched 0 of 1 projects and ${REMEMBER_SESSION_RECENCY_CAP.here} of ${total} sessions.`;
        expect(body).toContain(`\n\n${coverage}\n\n${SELECT_HINT}`);
        expect(body.split('\n').at(-1)).toBe(SELECT_HINT);
    });

    it('keeps the newest scanned hits and reports time-budget coverage', async () => {
        const project: ProjectSet = {
            key: 'time-budget-project',
            displayName: 'time-budget-project',
            paths: ['/time-budget-project'],
            projectIds: [1],
            gitRoot: null,
            gitRemote: null,
        };
        const sessions = [
            recallSession(1, 'Newest scan target', '2026-08-22T12:00:00.000Z'),
            recallSession(2, 'Second newest scan target', '2026-08-22T11:00:00.000Z'),
            recallSession(3, 'Older scan target', '2026-08-22T10:00:00.000Z'),
            recallSession(4, 'Oldest scan target', '2026-08-22T09:00:00.000Z'),
        ];
        const reader = {
            sessionsFor: () => sessions,
            storedRecallFieldsFor: () => new Map(sessions.map((session) => [session.id, new Map()])),
            turns: async () => ({ reason: 'must_not_parse' }),
        } as unknown as SessionReader;
        const query = tokenizeRecallQuery('scan target');
        expect(query).toBeDefined();
        if (!query) return;

        let clockReads = 0;
        const now = () => (++clockReads > 3 ? REMEMBER_SCAN_BUDGET_MS + 1 : 0);
        const { body, sessionIds } = await lexicalRecall(reader, [project], query, 'here', now, undefined, 'strict');

        expect(sessionIds).toEqual([1, 2]);
        expect(body).toContain('Newest scan target');
        expect(body).toContain('Second newest scan target');
        expect(body).not.toContain('Older scan target');
        expect(body).not.toContain('Oldest scan target');
        expect(body).toContain(`Partial coverage (time budget): searched 0 of 1 projects and 2 of ${sessions.length} sessions.`);
    });

    it('scans every candidate when the scan remains under the time budget', async () => {
        const project: ProjectSet = {
            key: 'under-budget-project',
            displayName: 'under-budget-project',
            paths: ['/under-budget-project'],
            projectIds: [1],
            gitRoot: null,
            gitRemote: null,
        };
        const sessions = [
            recallSession(1, 'Newest complete target', '2026-08-22T12:00:00.000Z'),
            recallSession(2, 'Second complete target', '2026-08-22T11:00:00.000Z'),
            recallSession(3, 'Older complete target', '2026-08-22T10:00:00.000Z'),
            recallSession(4, 'Oldest complete target', '2026-08-22T09:00:00.000Z'),
        ];
        const reader = {
            sessionsFor: () => sessions,
            storedRecallFieldsFor: () => new Map(sessions.map((session) => [session.id, new Map()])),
            turns: async () => ({ reason: 'must_not_parse' }),
        } as unknown as SessionReader;
        const query = tokenizeRecallQuery('complete target');
        expect(query).toBeDefined();
        if (!query) return;

        const { body, sessionIds } = await lexicalRecall(reader, [project], query, 'here', () => 0, undefined, 'strict');

        expect(sessionIds).toEqual([1, 2, 3, 4]);
        expect(body).toContain('Newest complete target');
        expect(body).toContain('Second complete target');
        expect(body).toContain('Older complete target');
        expect(body).toContain('Oldest complete target');
        expect(body).not.toContain('Partial coverage (time budget)');
    });
});
