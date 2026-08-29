import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ELEPHA_LIST_DEFAULT_LIMIT } from '../../src/config/constants.js';
import { claudeProjectsRoot, codexSessionsRoot, hookLogPath } from '../../src/config/paths.js';
import { parseUserPromptCommand, runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { terminalHandoff } from '../../src/markers.js';
import { OPEN } from '../../src/security/sentinel.js';
import { dataBlockClose, dataBlockOpen, HELP, SELECT_HINT, servedContextInstructions } from '../../src/serving/instructions.js';
import { openDb } from '../../src/storage/db.js';
import { UNTITLED_EPISODE } from '../../src/storage/session-title.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedSession } from '../helpers/db.js';

const NOW = Date.parse('2026-08-19T00:00:00.000Z');
const testCodexHome = mkdtempSync(path.join(tmpdir(), 'elepha-user-prompt-codex-'));
const testClaudeConfigDir = mkdtempSync(path.join(tmpdir(), 'elepha-user-prompt-claude-'));
const SOURCE = path.join(testCodexHome, 'sessions', 'source.jsonl');
const CLAUDE_SOURCE = path.join(testClaudeConfigDir, 'projects', 'source.jsonl');
const priorCodexHome = process.env.CODEX_HOME;
const priorClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeAll(() => {
    process.env.CODEX_HOME = testCodexHome;
    process.env.CLAUDE_CONFIG_DIR = testClaudeConfigDir;
    mkdirSync(codexSessionsRoot(), { recursive: true });
    mkdirSync(claudeProjectsRoot(), { recursive: true });
    copyFileSync(
        path.resolve(__dirname, '..', 'fixtures', 'codex', 'rollout-2026-08-10-019fa000-0000-7000-8000-000000000001-with-git.jsonl'),
        SOURCE,
    );
    copyFileSync(path.resolve(__dirname, '..', 'fixtures', 'claude-code', 'sample-session.jsonl'), CLAUDE_SOURCE);
});

afterAll(() => {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    if (priorClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorClaudeConfigDir;
});

function seededDb(): { dbPath: string; cwd: string } {
    const fixture = createTestDb('elepha-user-prompt-');
    const cwd = process.cwd();
    const project = seedProject(fixture, { path: cwd });
    seedConsentRoot(fixture, { path: cwd, state: 'approved' });
    const sessions: readonly [string, string, string, number][] = [
        ['earliest', 'Earliest episode', '2026-08-18T17:00:00.000Z', 2],
        ['earlier', 'Earlier episode', '2026-08-18T18:00:00.000Z', 2],
        ['early', 'Early episode', '2026-08-18T19:00:00.000Z', 2],
        ['oldest', 'Oldest episode', '2026-08-18T20:00:00.000Z', 2],
        ['middle', 'Middle episode', '2026-08-18T21:00:00.000Z', 2],
        ['newest', 'Newest one-turn audit', '2026-08-18T22:00:00.000Z', 1],
    ];
    for (const [nativeId, title, timestamp, turnCount] of sessions) {
        const session = seedSession(fixture, {
            project,
            nativeId,
            sourcePath: SOURCE,
            surface: 'cli',
            gitBranch: 'main',
            gitCommitCount: 1,
            startedAt: timestamp,
            lastIngestedAt: timestamp,
            lastTurnAt: timestamp,
            title,
        });
        for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
            seedMemory(fixture, { project, session, turnIndex, startedAt: timestamp });
        }
    }
    fixture.close();
    return { dbPath: fixture.dbPath, cwd };
}

function addProjectSession(
    dbPath: string,
    {
        projectPath,
        consented,
        nativeId,
        title,
        timestamp,
        tool = 'codex',
        surface = 'cli',
        sourcePath = tool === 'claude-code' ? CLAUDE_SOURCE : SOURCE,
    }: {
        projectPath: string;
        consented: boolean;
        nativeId: string;
        title: string;
        timestamp: string;
        tool?: 'claude-code' | 'codex';
        surface?: 'cli' | 'desktop';
        sourcePath?: string;
    },
): void {
    const db = openDb(dbPath);
    const project = db
        .prepare('INSERT INTO projects (path, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
        .run(projectPath, path.basename(projectPath), timestamp, timestamp);
    const projectId = Number(project.lastInsertRowid);
    if (consented) {
        db.prepare("INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (?, ?, 'approved', ?, 'cli')").run(
            `consent-${nativeId}`,
            projectPath,
            timestamp,
        );
    }
    const session = db
        .prepare(
            'INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at, surface, last_turn_at, title) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(tool, nativeId, projectId, sourcePath, timestamp, timestamp, surface, timestamp, title);
    db.prepare(
        "INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at, summarizer_status) VALUES (?, ?, 0, ?, ?, '[]', '[]', '[]', ?, 'ok')",
    ).run(projectId, session.lastInsertRowid, tool, timestamp, timestamp);
    db.close();
}

function payload(cwd: string, prompt: string, sessionId = 'current-session') {
    return JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt,
        turn_id: 'turn-1',
        model: 'gpt-5.6',
        permission_mode: 'default',
        transcript_path: null,
    });
}

function expectNonceBoundServedContext(context: string): void {
    const nonce = context.match(/\[\[elepha-data ([0-9a-f-]{36})]]/)?.[1];
    expect(nonce).toBeDefined();
    if (!nonce) {
        throw new Error('served context has no nonce');
    }
    const body = context.slice(context.indexOf('\n') + 1);
    expect(body.startsWith(`${servedContextInstructions(nonce)}\n\n# `)).toBe(true);
    expect(context).toContain(dataBlockOpen(nonce));
    expect(context).toContain(dataBlockClose(nonce));
}

describe('D40 UserPromptSubmit command hook', () => {
    it('accepts every exact lowercase command form after trimming and distinguishes help from rejected input', async () => {
        expect(ELEPHA_LIST_DEFAULT_LIMIT).toBe(5);
        expect(parseUserPromptCommand('  elepha:help  ')).toEqual({ kind: 'help' });
        expect(parseUserPromptCommand('  elepha:last  ')).toEqual({ kind: 'last' });
        expect(parseUserPromptCommand('elepha:list')).toEqual({ kind: 'list', count: ELEPHA_LIST_DEFAULT_LIMIT });
        expect(parseUserPromptCommand('elepha:list:1')).toEqual({ kind: 'list', count: 1 });
        expect(parseUserPromptCommand('elepha:list:100')).toEqual({ kind: 'list', count: 100 });
        expect(parseUserPromptCommand('elepha:list:codex')).toEqual({
            kind: 'list',
            count: ELEPHA_LIST_DEFAULT_LIMIT,
            tool: 'codex',
        });
        expect(parseUserPromptCommand('elepha:list:claude')).toEqual({
            kind: 'list',
            count: ELEPHA_LIST_DEFAULT_LIMIT,
            tool: 'claude-code',
        });
        expect(parseUserPromptCommand('elepha:list:7:codex')).toEqual({ kind: 'list', count: 7, tool: 'codex' });
        expect(parseUserPromptCommand('elepha:list:7:claude')).toEqual({ kind: 'list', count: 7, tool: 'claude-code' });
        expect(parseUserPromptCommand('elepha:select:1')).toEqual({ kind: 'select', index: 1 });
        expect(parseUserPromptCommand('elepha:update')).toEqual({ kind: 'action', command: 'self-update' });
        for (const input of [
            'elepha:list:0',
            'elepha:list:101',
            'elepha:list:codex:10',
            'elepha:select:0',
            'elepha:select:+1',
            'elepha:remember query',
            'elepha:remember:here query',
            'elepha:open:1',
            'elepha:open:last',
            'Elepha:last',
            'elepha:update:arbitrary-suffix',
            'elepha:unknown',
        ]) {
            expect(parseUserPromptCommand(input), input).toBeUndefined();
        }
        const { dbPath, cwd } = seededDb();
        for (const [command, shouldEcho] of [
            ['elepha:help', true],
            ['elepha:unknown', false],
        ] as const) {
            const result = await runUserPromptSubmit(payload(cwd, command), 'codex', { dbPath, now: () => NOW });
            expect('output' in result).toBe(true);
            if (!('output' in result)) continue;
            const context = (result.output.hookSpecificOutput as Record<string, string>).additionalContext;
            expect(context).toContain(`${OPEN}brief:`);
            expect(context.includes(command)).toBe(shouldEcho);
        }
    });

    it('resumes and lists globally across consented projects while excluding unconsented sessions', async () => {
        const { dbPath, cwd } = seededDb();
        for (const tool of ['claude-code', 'codex'] as const) {
            const localLast = await runUserPromptSubmit(payload(cwd, 'elepha:last'), tool, { dbPath, now: () => NOW });
            expect('output' in localLast).toBe(true);
            if (!('output' in localLast)) continue;
            expect(localLast.output).toEqual({
                continue: true,
                hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.any(String) },
            });
            const context = (localLast.output.hookSpecificOutput as Record<string, string>).additionalContext;
            expect(context).toContain('Newest one-turn audit');
            expect(context).toContain('## Turn 1');
            expectNonceBoundServedContext(context);
        }
        const directory = path.dirname(dbPath);
        addProjectSession(dbPath, {
            projectPath: path.join(directory, 'consented-claude'),
            consented: true,
            nativeId: 'global-claude',
            title: 'Global Claude newest',
            timestamp: '2026-08-18T23:00:00.000Z',
            tool: 'claude-code',
            surface: 'desktop',
        });
        addProjectSession(dbPath, {
            // This path is stored test data only. Keep it outside the approved
            // repository tree now that database fixtures live inside that tree.
            projectPath: path.join(path.dirname(cwd), path.basename(directory), 'unconsented-codex'),
            consented: false,
            nativeId: 'unconsented-newest',
            title: 'Unconsented newest',
            timestamp: '2026-08-18T23:30:00.000Z',
        });
        addProjectSession(dbPath, {
            projectPath: path.join(directory, 'consented-codex'),
            consented: true,
            nativeId: 'global-codex',
            title: 'Global Codex second',
            timestamp: '2026-08-18T22:30:00.000Z',
        });

        const last = await runUserPromptSubmit(payload(cwd, 'elepha:last'), 'codex', { dbPath, now: () => NOW });
        const list = await runUserPromptSubmit(payload(cwd, 'elepha:list:2'), 'codex', { dbPath, now: () => NOW + 1 });
        const claudeList = await runUserPromptSubmit(payload(cwd, 'elepha:list:claude'), 'codex', { dbPath, now: () => NOW + 2 });
        const selected = await runUserPromptSubmit(payload(cwd, 'elepha:select:1'), 'codex', { dbPath, now: () => NOW + 3 });
        const codexList = await runUserPromptSubmit(payload(cwd, 'elepha:list:2:codex'), 'codex', { dbPath, now: () => NOW + 4 });

        for (const result of [last, list, claudeList, codexList, selected]) {
            expect('output' in result).toBe(true);
            if ('output' in result) {
                expect((result.output.hookSpecificOutput as Record<string, string>).additionalContext).not.toContain('Unconsented newest');
            }
        }
        if (!('output' in last) || !('output' in list) || !('output' in claudeList) || !('output' in codexList) || !('output' in selected))
            return;

        const lastContext = (last.output.hookSpecificOutput as Record<string, string>).additionalContext;
        const listContext = (list.output.hookSpecificOutput as Record<string, string>).additionalContext;
        const claudeListContext = (claudeList.output.hookSpecificOutput as Record<string, string>).additionalContext;
        const codexListContext = (codexList.output.hookSpecificOutput as Record<string, string>).additionalContext;
        const selectedContext = (selected.output.hookSpecificOutput as Record<string, string>).additionalContext;
        expect(lastContext).toContain('# Global Claude newest');
        expect(listContext.indexOf('1. [1h ago | Claude Code Desktop] · Global Claude newest')).toBeLessThan(
            listContext.indexOf('2. [1h ago | Codex CLI] · Global Codex second'),
        );
        expect(claudeListContext).toContain('1. [1h ago | Claude Code Desktop] · Global Claude newest');
        expect(claudeListContext).not.toContain('Newest one-turn audit');
        expect(codexListContext.indexOf('1. [1h ago | Codex CLI] · Global Codex second')).toBeLessThan(
            codexListContext.indexOf('2. [2h ago | Codex CLI] · Newest one-turn audit'),
        );
        expect(codexListContext).not.toContain('Global Claude newest');
        expect(selectedContext).toContain('# Global Claude newest');
    });

    it('serves global list and last outside a consented project and gracefully rejects select fallback', async () => {
        const { dbPath } = seededDb();
        const unconsentedCwd = mkdtempSync(path.join(tmpdir(), 'elepha-unconsented-cwd-'));
        const logs: string[] = [];

        const list = await runUserPromptSubmit(payload(unconsentedCwd, 'elepha:list'), 'codex', {
            dbPath,
            now: () => NOW,
            log: (line) => logs.push(line),
        });
        const last = await runUserPromptSubmit(payload(unconsentedCwd, 'elepha:last'), 'codex', {
            dbPath,
            now: () => NOW + 1,
            log: (line) => logs.push(line),
        });
        const storedSelected = await runUserPromptSubmit(payload(unconsentedCwd, 'elepha:select:1'), 'codex', {
            dbPath,
            now: () => NOW + 2,
            log: (line) => logs.push(line),
        });
        const selected = await runUserPromptSubmit(payload(unconsentedCwd, 'elepha:select:1', 'chat-without-stored-list'), 'codex', {
            dbPath,
            now: () => NOW + 3,
            log: (line) => logs.push(line),
        });

        for (const result of [list, last, storedSelected, selected]) {
            expect('output' in result).toBe(true);
        }
        if (!('output' in list) || !('output' in last) || !('output' in storedSelected) || !('output' in selected)) return;
        expect((list.output.hookSpecificOutput as Record<string, string>).additionalContext).toContain(
            '1. [2h ago | Codex CLI] · Newest one-turn audit',
        );
        expect((last.output.hookSpecificOutput as Record<string, string>).additionalContext).toContain('# Newest one-turn audit');
        expect((storedSelected.output.hookSpecificOutput as Record<string, string>).additionalContext).toContain('# Newest one-turn audit');
        expect((selected.output.hookSpecificOutput as Record<string, string>).additionalContext).toContain(
            'No session found at that position.',
        );
        expect(logs).toContain('user-prompt-submit codex session_id=current-session: list');
        expect(logs).toContain('user-prompt-submit codex session_id=current-session: last');
        expect(logs).toContain('user-prompt-submit codex session_id=current-session: select');
        expect(logs).toContain('user-prompt-submit codex session_id=chat-without-stored-list: select');
        expect(logs.some((line) => line.includes('failed reason=project_unavailable_or_unconsented'))).toBe(false);
    });

    it('uses the shared newest-first session order for list and select indexes', async () => {
        const { dbPath, cwd } = seededDb();
        addProjectSession(dbPath, {
            projectPath: path.join(path.dirname(dbPath), 'command-only'),
            consented: true,
            nativeId: 'command-only',
            title: UNTITLED_EPISODE,
            timestamp: '2026-08-18T23:00:00.000Z',
        });

        const listed = await runUserPromptSubmit(payload(cwd, 'elepha:list:2:codex'), 'codex', { dbPath, now: () => NOW });
        const selected = await runUserPromptSubmit(payload(cwd, 'elepha:select:2'), 'codex', { dbPath, now: () => NOW + 1 });

        expect('output' in listed).toBe(true);
        expect('output' in selected).toBe(true);
        if (!('output' in listed) || !('output' in selected)) return;
        const listContext = (listed.output.hookSpecificOutput as Record<string, string>).additionalContext;
        const selectContext = (selected.output.hookSpecificOutput as Record<string, string>).additionalContext;
        expect(listContext).toContain('Recent sessions (2):');
        expect(listContext.indexOf('1. [2h ago | Codex CLI] · Newest one-turn audit')).toBeLessThan(
            listContext.indexOf('2. [3h ago | Codex CLI] · Middle episode'),
        );
        expect(listContext).not.toContain(UNTITLED_EPISODE);
        expect(listContext).not.toContain('Oldest episode');
        expect(listContext.split('\n').at(-2)).toBe(SELECT_HINT);
        expect(selectContext).toContain('Middle episode');
        expectNonceBoundServedContext(selectContext);
        expect(listContext).not.toContain('substantive');
    });

    it('falls back to current-project recent-session order when the chat has no stored list', async () => {
        const { dbPath, cwd } = seededDb();

        const opened = await runUserPromptSubmit(payload(cwd, 'elepha:select:2'), 'codex', { dbPath, now: () => NOW });

        expect('output' in opened).toBe(true);
        if (!('output' in opened)) return;
        const context = (opened.output.hookSpecificOutput as Record<string, string>).additionalContext;
        expect(context).toContain('# Middle episode');
        expectNonceBoundServedContext(context);
    });

    it('overwrites the stored list and does not fall back when its new list is out of range', async () => {
        const { dbPath, cwd } = seededDb();

        await runUserPromptSubmit(payload(cwd, 'elepha:list:2'), 'codex', { dbPath, now: () => NOW });
        await runUserPromptSubmit(payload(cwd, 'elepha:list:1'), 'codex', { dbPath, now: () => NOW + 1 });
        const opened = await runUserPromptSubmit(payload(cwd, 'elepha:select:2'), 'codex', { dbPath, now: () => NOW + 2 });

        expect('output' in opened).toBe(true);
        if (!('output' in opened)) return;
        const context = (opened.output.hookSpecificOutput as Record<string, string>).additionalContext;
        expect(context).toContain('No session found at that position.');
        expect(context).not.toContain('# Middle episode');
    });

    it('isolates stored lists by tool and native chat session', async () => {
        const { dbPath, cwd } = seededDb();

        await runUserPromptSubmit(payload(cwd, 'elepha:list:1'), 'codex', { dbPath, now: () => NOW });
        const otherChat = await runUserPromptSubmit(payload(cwd, 'elepha:select:2', 'other-session'), 'codex', {
            dbPath,
            now: () => NOW + 1,
        });
        const otherTool = await runUserPromptSubmit(payload(cwd, 'elepha:select:2'), 'claude-code', {
            dbPath,
            now: () => NOW + 2,
        });

        for (const opened of [otherChat, otherTool]) {
            expect('output' in opened).toBe(true);
            if (!('output' in opened)) continue;
            expect((opened.output.hookSpecificOutput as Record<string, string>).additionalContext).toContain('# Middle episode');
        }
    });

    it('injects syntax help for malformed input and maps only the fixed update hand-off', async () => {
        const { dbPath, cwd } = seededDb();
        const malformed = await runUserPromptSubmit(payload(cwd, 'elepha:list:codex:10'), 'claude-code', { dbPath, now: () => NOW });
        const action = await runUserPromptSubmit(payload(cwd, 'elepha:update'), 'claude-code', { dbPath, now: () => NOW + 1 });
        const suffix = await runUserPromptSubmit(payload(cwd, 'elepha:update:rm -rf /'), 'claude-code', { dbPath, now: () => NOW + 2 });

        for (const result of [malformed, action, suffix]) {
            expect('output' in result).toBe(true);
            if ('output' in result) {
                expect((result.output.hookSpecificOutput as Record<string, string>).additionalContext).toContain(`${OPEN}brief:`);
            }
        }
        if ('output' in malformed) {
            expect((malformed.output.hookSpecificOutput as Record<string, string>).additionalContext).toContain(HELP);
        }
        if ('output' in suffix) {
            expect((suffix.output.hookSpecificOutput as Record<string, string>).additionalContext).toContain(HELP);
            expect((suffix.output.hookSpecificOutput as Record<string, string>).additionalContext).not.toContain('rm -rf');
        }
        if ('output' in action) {
            expect((action.output.hookSpecificOutput as Record<string, string>).additionalContext).toContain(
                terminalHandoff('self-update'),
            );
        }
    });

    it('fails open without output when the database is unavailable', async () => {
        const result = await runUserPromptSubmit(payload(process.cwd(), 'elepha:last'), 'codex', {
            dbPath: path.join(tmpdir(), `elepha-missing-${Date.now()}.db`),
        });
        expect(result).toEqual({ reason: 'database_unavailable' });
    });

    it('appends successful commands and failure reasons to the isolated hook log', async () => {
        const logPath = path.join(mkdtempSync(path.join(tmpdir(), 'elepha-user-prompt-log-')), 'hook.log');
        const priorHookLogPath = process.env.ELEPHA_HOOK_LOG_PATH;
        process.env.ELEPHA_HOOK_LOG_PATH = logPath;

        try {
            const { dbPath, cwd } = seededDb();
            const success = await runUserPromptSubmit(payload(cwd, 'elepha:list'), 'codex', { dbPath, now: () => NOW });
            const failure = await runUserPromptSubmit(payload(cwd, 'elepha:last'), 'codex', {
                dbPath: path.join(tmpdir(), `elepha-missing-${Date.now()}.db`),
            });

            expect('output' in success).toBe(true);
            expect(failure).toEqual({ reason: 'database_unavailable' });
            const log = readFileSync(logPath, 'utf8');
            expect(log).toContain('user-prompt-submit codex session_id=current-session: list');
            expect(log).toContain('user-prompt-submit codex session_id=current-session: failed reason=database_unavailable');
            expect(hookLogPath()).toBe(logPath);
        } finally {
            if (priorHookLogPath === undefined) {
                delete process.env.ELEPHA_HOOK_LOG_PATH;
            } else {
                process.env.ELEPHA_HOOK_LOG_PATH = priorHookLogPath;
            }
        }
    });
});
