import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AUTO_BRIEF_CHAR_BUDGET, HOOK_WATCHDOG_TIMEOUT_MS, PACKAGE_VERSION, SESSION_CHAR_BUDGET } from '../../src/config/constants.js';
import { codexSessionsRoot, hookLogPath } from '../../src/config/paths.js';
import {
    envelope,
    handleWatchdogTimeout,
    parsePayload,
    runSessionStart,
    type SessionStartDependencies,
} from '../../src/hooks/session-start.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { CLOSE, OPEN, open } from '../../src/security/sentinel.js';
import { dataBlockClose, dataBlockOpen, servedContextInstructions } from '../../src/serving/instructions.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';

const NOW = Date.parse('2026-08-17T00:00:00.000Z');
const testHookLogPath = path.join(mkdtempSync(path.join(tmpdir(), 'elepha-hook-log-')), 'hook.log');
const priorHookLogPath = process.env.ELEPHA_HOOK_LOG_PATH;
process.env.ELEPHA_HOOK_LOG_PATH = testHookLogPath;
const priorCodexHome = process.env.CODEX_HOME;
const testCodexHome = mkdtempSync(path.join(tmpdir(), 'elepha-hook-codex-'));
process.env.CODEX_HOME = testCodexHome;
const AUTO_SOURCE = path.join(codexSessionsRoot(), 'auto-source.jsonl');
const EMPTY_SOURCE = path.join(codexSessionsRoot(), 'empty-source.jsonl');
mkdirSync(codexSessionsRoot(), { recursive: true });
copyFileSync(
    path.resolve(__dirname, '..', 'fixtures', 'codex', 'rollout-2026-08-10-019fa000-0000-7000-8000-000000000001-with-git.jsonl'),
    AUTO_SOURCE,
);
copyFileSync(
    path.resolve(__dirname, '..', 'fixtures', 'codex', 'rollout-codex-v0.148.0-alpha.9-external-agent-import.jsonl'),
    EMPTY_SOURCE,
);

function seededDb(
    options: {
        ageMs?: number;
        gitCommitCount?: number | null;
        sourcePath?: string;
        gitBranch?: string | null;
        lastTurnAt?: string | null;
        hasExternalContent?: boolean;
    } = {},
): {
    dbPath: string;
    cwd: string;
} {
    const dir = mkdtempSync(path.join(tmpdir(), 'elepha-hook-'));
    const dbPath = path.join(dir, 'elepha.db');
    const db = openDb(dbPath);
    const cwd = process.cwd();
    const now = new Date(NOW - (options.ageMs ?? 0)).toISOString();
    db.prepare('INSERT INTO projects (id, path, display_name, first_seen_at, last_seen_at) VALUES (1, ?, ?, ?, ?)').run(
        cwd,
        'elepha',
        now,
        now,
    );
    db.prepare(
        "INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES ('01J00000000000000000000000', ?, 'approved', ?, 'cli')",
    ).run(cwd, now);
    db.prepare(
        "INSERT INTO sessions (id, tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at, surface, git_branch, git_commit_count, last_turn_at, title) VALUES (1, 'codex', 'native-session', 0, 1, ?, ?, ?, 'cli', ?, ?, ?, 'Stored real session')",
    ).run(
        options.sourcePath ?? path.join(codexSessionsRoot(), 'missing.jsonl'),
        now,
        now,
        options.gitBranch ?? 'main',
        options.gitCommitCount ?? null,
        options.lastTurnAt === undefined ? now : options.lastTurnAt,
    );
    const insert = db.prepare(
        "INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at, summarizer_status) VALUES (1, 1, ?, 'codex', ?, '[]', '[]', '[]', ?, 'ok')",
    );
    insert.run(0, now, now);
    insert.run(1, now, now);
    if (options.hasExternalContent) {
        db.prepare('UPDATE memories SET has_external_content = 1 WHERE session_id = 1').run();
    }
    db.close();
    return { dbPath, cwd };
}

function addSession(
    dbPath: string,
    {
        nativeId,
        tool = 'codex',
        surface = 'cli',
        lastTurnAt,
        sourcePath = path.join(codexSessionsRoot(), 'missing.jsonl'),
        storedTurns = 1,
        projectId = 1,
    }: {
        nativeId: string;
        tool?: 'claude-code' | 'codex';
        surface?: 'cli' | 'desktop';
        lastTurnAt: string;
        sourcePath?: string;
        storedTurns?: number;
        projectId?: number;
    },
): void {
    const db = openDb(dbPath);
    const session = db
        .prepare(
            "INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at, surface, git_branch, git_commit_count, last_turn_at, title) VALUES (?, ?, 0, ?, ?, ?, ?, ?, 'main', 100, ?, 'Stored real session')",
        )
        .run(tool, nativeId, projectId, sourcePath, lastTurnAt, lastTurnAt, surface, lastTurnAt);
    const insert = db.prepare(
        "INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at, summarizer_status) VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', ?, 'ok')",
    );
    for (let turnIndex = 0; turnIndex < storedTurns; turnIndex++) {
        insert.run(projectId, session.lastInsertRowid, turnIndex, tool, lastTurnAt, lastTurnAt);
    }
    db.close();
}

function addProject(dbPath: string, projectPath: string, consented: boolean): number {
    const db = openDb(dbPath);
    const project = db
        .prepare('INSERT INTO projects (path, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
        .run(projectPath, path.basename(projectPath), new Date(NOW).toISOString(), new Date(NOW).toISOString());
    const projectId = Number(project.lastInsertRowid);
    if (consented) {
        db.prepare("INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (?, ?, 'approved', ?, 'cli')").run(
            `consent-${projectId}`,
            projectPath,
            new Date(NOW).toISOString(),
        );
    }
    db.close();
    return projectId;
}

function wideCodexTranscript(turnCount: number): string {
    const lines: object[] = [];
    for (let index = 0; index < turnCount; index++) {
        lines.push(
            {
                timestamp: `2026-08-17T00:00:${String(index).padStart(2, '0')}.000Z`,
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `request ${index}` }] },
            },
            {
                timestamp: `2026-08-17T00:00:${String(index).padStart(2, '0')}.500Z`,
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: `response ${index}: ${'x'.repeat(10_000)}` }],
                },
            },
        );
    }
    return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

const AUTO_CONFIG = { config: { on_startup: 'auto', on_clear: 'auto', on_resume: 'auto', on_compact: 'off' } } as const;
const NOTIFY_CONFIG = { config: { on_startup: 'notify', on_clear: 'off', on_resume: 'off', on_compact: 'off' } } as const;

function sessionStartPayload(cwd: string, sessionId = 'native-session', source = 'startup'): string {
    return JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'SessionStart',
        source,
        model: 'gpt-5.6',
        permission_mode: 'default',
    });
}

function hookText(result: Awaited<ReturnType<typeof runSessionStart>>, tool: 'claude-code' | 'codex'): string | undefined {
    if (!('output' in result)) return undefined;
    const hookOutput = result.output.hookSpecificOutput as Record<string, unknown>;
    const value = tool === 'claude-code' ? result.output.systemMessage : hookOutput.additionalContext;
    return typeof value === 'string' ? value : undefined;
}

function normalizedHookResult(result: Awaited<ReturnType<typeof runSessionStart>>): string {
    return JSON.stringify(result)
        .replace(/\[\[elepha:brief:[0-9A-Z]{26}]]/g, '[[elepha:brief:<id>]]')
        .replace(/\[\[elepha-(data|end) [0-9a-f-]{36}]]/g, '[[elepha-$1 <nonce>]]');
}

describe('P2.8 SessionStart hook', () => {
    it('validates every installed source and both envelope contracts', () => {
        const fixtures = {
            'claude-code': JSON.parse(
                readFileSync(path.resolve(__dirname, '..', 'fixtures', 'hooks', 'claude-session-start.json'), 'utf8'),
            ),
            codex: JSON.parse(readFileSync(path.resolve(__dirname, '..', 'fixtures', 'hooks', 'codex-session-start.json'), 'utf8')),
        };
        for (const source of ['startup', 'clear', 'resume', 'compact'] as const) {
            expect(parsePayload(JSON.stringify({ ...fixtures['claude-code'], source }), 'claude-code')).toMatchObject({ source });
            expect(parsePayload(JSON.stringify({ ...fixtures.codex, source }), 'codex')).toMatchObject({ source });
        }
        expect(parsePayload('{}', 'claude-code')).toBeUndefined();
        expect(envelope('claude-code', 'body', 'additionalContext')).toEqual({
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'body' },
        });
        expect(envelope('codex', 'body', 'additionalContext')).toEqual({
            continue: true,
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'body' },
            stopReason: null,
            suppressOutput: false,
            systemMessage: null,
        });
        expect(envelope('claude-code', 'body', 'systemMessage')).toEqual({
            hookSpecificOutput: { hookEventName: 'SessionStart' },
            systemMessage: 'body',
        });
        expect(envelope('codex', 'body', 'systemMessage')).toEqual({
            continue: true,
            hookSpecificOutput: { hookEventName: 'SessionStart' },
            stopReason: null,
            suppressOutput: false,
            systemMessage: 'body',
        });
    });

    it('rejects missing and wrong-typed required stdin fields without an output envelope', () => {
        const valid = {
            session_id: 's',
            cwd: '/project',
            hook_event_name: 'SessionStart',
            source: 'startup',
            model: 'gpt-5.6',
            permission_mode: 'default',
        };
        expect(parsePayload(JSON.stringify({ ...valid, session_id: 1 }), 'codex')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...valid, cwd: null }), 'codex')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...valid, hook_event_name: 'Stop' }), 'codex')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...valid, source: 'other' }), 'codex')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...valid, model: null }), 'codex')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...valid, permission_mode: 'unsafe' }), 'codex')).toBeUndefined();
    });

    it('reports the recent one-turn session from the other tool, not the 9h-old substantive context session', async () => {
        const { dbPath, cwd } = seededDb({ ageMs: 9 * 60 * 60 * 1000 });
        addSession(dbPath, {
            nativeId: 'recent-codex-desktop',
            surface: 'desktop',
            lastTurnAt: new Date(NOW - 2.4 * 60 * 1000).toISOString(),
        });
        const result = await runSessionStart(
            JSON.stringify({ session_id: 'current-claude-session', cwd, hook_event_name: 'SessionStart', source: 'startup' }),
            'claude-code',
            {
                dbPath,
                now: () => NOW,
                readConfig: () => ({ config: { on_startup: 'notify', on_clear: 'notify', on_resume: 'auto', on_compact: 'off' } }),
            },
        );

        expect('output' in result).toBe(true);
        if ('output' in result) {
            expect(result.output.systemMessage).toContain('last in Codex Desktop, 2m ago');
            expect(result.output.systemMessage).not.toContain('Codex CLI, 9h ago');
        }
    });

    it('reports current/global consented counts and global activity without exposing an unconsented session', async () => {
        const { dbPath, cwd } = seededDb();
        const directory = path.dirname(dbPath);
        const consentedProjectId = addProject(dbPath, path.join(directory, 'consented-claude'), true);
        const unconsentedProjectId = addProject(dbPath, path.join(directory, 'unconsented-codex'), false);
        addSession(dbPath, {
            projectId: consentedProjectId,
            nativeId: 'global-claude',
            tool: 'claude-code',
            surface: 'desktop',
            lastTurnAt: new Date(NOW - 2 * 60 * 1000).toISOString(),
        });
        addSession(dbPath, {
            projectId: unconsentedProjectId,
            nativeId: 'unconsented-newest',
            lastTurnAt: new Date(NOW - 60 * 1000).toISOString(),
        });

        const result = await runSessionStart(
            JSON.stringify({
                session_id: 'native-session',
                cwd,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath,
                now: () => NOW,
                daemonHealth: () => ({ state: 'RUNNING' as const, healthy: true }),
                readConfig: () => ({ config: { on_startup: 'notify', on_clear: 'notify', on_resume: 'auto', on_compact: 'off' } }),
            },
        );

        expect('output' in result).toBe(true);
        if ('output' in result) {
            const context = (result.output.hookSpecificOutput as Record<string, string>).additionalContext;
            expect(context).toBe(
                '🐘 elepha · 1/2 sessions · capture on · last in Claude Code Desktop, 2m ago · type elepha:last to resume',
            );
            expect(context).not.toContain('Codex CLI, 1m ago');
        }
    });

    it('uses stored consented project groups for the SessionStart feed without resolving Git', async () => {
        const { dbPath, cwd } = seededDb();
        const resolveGitRoot = vi.fn(() => {
            throw new Error('SessionStart consented-project enumeration must not resolve Git');
        });

        const result = await runSessionStart(
            JSON.stringify({
                session_id: 'native-session',
                cwd,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath,
                now: () => NOW,
                projectResolver: (db) => new ProjectResolver(db, { resolveGitRoot }),
                readConfig: () => ({ config: { on_startup: 'notify', on_clear: 'notify', on_resume: 'auto', on_compact: 'off' } }),
            },
        );

        expect(result).toEqual(expect.objectContaining({ output: expect.anything() }));
        expect(resolveGitRoot).not.toHaveBeenCalled();
    });

    it('excludes the firing native session from the activity headline', async () => {
        const { dbPath, cwd } = seededDb();
        addSession(dbPath, {
            nativeId: 'prior-session',
            lastTurnAt: new Date(NOW - 2 * 60 * 1000).toISOString(),
        });
        const result = await runSessionStart(
            JSON.stringify({
                session_id: 'native-session',
                cwd,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath,
                now: () => NOW,
                readConfig: () => ({ config: { on_startup: 'notify', on_clear: 'notify', on_resume: 'auto', on_compact: 'off' } }),
            },
        );

        expect('output' in result).toBe(true);
        if ('output' in result) {
            const context = result.output.hookSpecificOutput as Record<string, unknown>;
            expect(context.additionalContext).toContain('last in Codex CLI, 2m ago');
            expect(context.additionalContext).not.toContain('0m ago');
        }
    });

    it('keeps newestSubstantive as the auto-context selector when newer activity is one turn', async () => {
        const { dbPath, cwd } = seededDb({ ageMs: 9 * 60 * 60 * 1000, gitCommitCount: 100, sourcePath: AUTO_SOURCE });
        addSession(dbPath, {
            nativeId: 'recent-one-turn-session',
            lastTurnAt: new Date(NOW - 2 * 60 * 1000).toISOString(),
        });
        const result = await runSessionStart(
            JSON.stringify({
                session_id: 'current-session',
                cwd,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath,
                now: () => NOW,
                daemonHealth: () => ({ state: 'RUNNING' as const, healthy: true }),
                gitBranch: () => 'main',
                gitCommitCount: () => 100,
                readConfig: () => ({ config: { on_startup: 'auto', on_clear: 'auto', on_resume: 'auto', on_compact: 'off' } }),
            },
        );

        expect('output' in result).toBe(true);
        if ('output' in result) {
            const context = result.output.hookSpecificOutput as Record<string, unknown>;
            const brief = context.additionalContext as string;
            expect(brief).toContain(`${OPEN}brief:`);
            const nonce = brief.match(/\[\[elepha-data ([0-9a-f-]{36})]]/)?.[1];
            expect(nonce).toBeDefined();
            if (nonce === undefined) {
                throw new Error('auto brief did not include a data nonce');
            }
            expect(brief).toContain(dataBlockOpen(nonce));
            expect(brief).toContain(dataBlockClose(nonce));
            expect(brief.slice(brief.indexOf('\n') + 1).startsWith(`${servedContextInstructions(nonce)}\n\n# `)).toBe(true);
        }
    });

    it('degrades externally flagged auto context to notify while elepha:last still renders that session', async () => {
        const { dbPath, cwd } = seededDb({
            gitCommitCount: 100,
            sourcePath: AUTO_SOURCE,
            hasExternalContent: true,
        });
        const log: string[] = [];
        const auto = await runSessionStart(
            JSON.stringify({
                session_id: 'current-session',
                cwd,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath,
                now: () => NOW,
                log: (line) => log.push(line),
                gitBranch: () => 'main',
                gitCommitCount: () => 100,
                readConfig: () => ({ config: { on_startup: 'auto', on_clear: 'auto', on_resume: 'auto', on_compact: 'off' } }),
            },
        );

        expect('output' in auto).toBe(true);
        if ('output' in auto) {
            const context = auto.output.hookSpecificOutput as Record<string, unknown>;
            expect(context.additionalContext).toContain('🐘 elepha · 1 sessions');
            expect(context.additionalContext).not.toContain(`${OPEN}brief:`);
            expect(context.additionalContext).not.toContain('## Turn');
        }
        expect(log).toContain('session-start codex source=startup session_id=current-session: auto degraded: session has external content');

        const explicit = await runUserPromptSubmit(
            JSON.stringify({
                session_id: 'current-session',
                cwd,
                hook_event_name: 'UserPromptSubmit',
                prompt: 'elepha:last',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            { dbPath, now: () => NOW },
        );
        expect('output' in explicit).toBe(true);
        if ('output' in explicit) {
            expect((explicit.output.hookSpecificOutput as Record<string, string>).additionalContext).toContain('## Turn 1');
        }
    });

    it('caps the automatic rendered episode at the auto brief budget while default renders retain the session budget', async () => {
        const { dbPath, cwd } = seededDb({ gitCommitCount: 100 });
        const sourcePath = path.join(codexSessionsRoot(), 'wide-rollout.jsonl');
        writeFileSync(sourcePath, wideCodexTranscript(10));
        const db = openDb(dbPath);
        db.prepare('UPDATE sessions SET source_path = ? WHERE id = 1').run(sourcePath);
        const insert = db.prepare(
            "INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at, summarizer_status) VALUES (1, 1, ?, 'codex', ?, '[]', '[]', '[]', ?, 'ok')",
        );
        const timestamp = new Date(NOW).toISOString();
        for (let turnIndex = 2; turnIndex < 10; turnIndex++) {
            insert.run(turnIndex, timestamp, timestamp);
        }
        const reader = new SessionReader(db);
        const session = reader.newestSubstantive({
            key: cwd,
            displayName: 'elepha',
            paths: [cwd],
            projectIds: [1],
            gitRoot: null,
            gitRemote: null,
        });
        expect(session).toBeDefined();
        const fullRender = await reader.render(session!);
        db.close();

        expect(fullRender.episode?.renderedChars).toBeGreaterThan(AUTO_BRIEF_CHAR_BUDGET);
        expect(fullRender.episode?.renderedChars).toBeLessThanOrEqual(SESSION_CHAR_BUDGET);

        const result = await runSessionStart(
            JSON.stringify({
                session_id: 'current-session',
                cwd,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath,
                now: () => NOW,
                gitBranch: () => 'main',
                gitCommitCount: () => 100,
                readConfig: () => ({ config: { on_startup: 'auto', on_clear: 'auto', on_resume: 'auto', on_compact: 'off' } }),
                writeInjection: () => true,
            },
        );

        expect('output' in result).toBe(true);
        if ('output' in result) {
            const body = (result.output.hookSpecificOutput as Record<string, unknown>).additionalContext as string;
            const start = body.indexOf('## Turn 10');
            const end = body.indexOf('\n\ndurable decisions:', start);
            const renderedEpisode = body.slice(start, end);
            expect(start).toBeGreaterThanOrEqual(0);
            expect(end).toBeGreaterThan(start);
            expect(renderedEpisode.length).toBeLessThanOrEqual(AUTO_BRIEF_CHAR_BUDGET);
            expect(renderedEpisode).not.toContain('## Turn 9');
        }
    });

    it('fails open for off, ask, invalid configuration, and an unknown project', async () => {
        const { dbPath, cwd } = seededDb();
        const payload = JSON.stringify({
            session_id: 'native-session',
            cwd,
            hook_event_name: 'SessionStart',
            source: 'startup',
            model: 'gpt-5.6',
            permission_mode: 'default',
        });
        await expect(
            runSessionStart(payload, 'codex', {
                dbPath,
                readConfig: () => ({ config: { on_startup: 'off', on_clear: 'off', on_resume: 'off', on_compact: 'off' } }),
            }),
        ).resolves.toEqual({ reason: 'off' });
        await expect(
            runSessionStart(payload, 'codex', {
                dbPath,
                readConfig: () => ({ config: { on_startup: 'ask', on_clear: 'off', on_resume: 'off', on_compact: 'off' } }),
            }),
        ).resolves.toEqual({ reason: 'ask_unsupported' });
        await expect(runSessionStart(payload, 'codex', { dbPath, readConfig: () => ({ error: 'invalid_config' }) })).resolves.toEqual({
            reason: 'invalid_config',
        });
        await expect(runSessionStart(payload.replace(cwd, '/definitely/unknown'), 'codex', { dbPath })).resolves.toEqual({
            reason: 'project_unavailable_or_unconsented',
        });
    });

    it('classifies recallability as notify or no output', async () => {
        for (const [recallable, expected] of [
            [true, 'notify'],
            [false, 'no_consented_sessions'],
        ] as const) {
            const { dbPath, cwd } = seededDb();
            const db = openDb(dbPath);
            if (recallable) db.prepare('DELETE FROM memories WHERE turn_index = 1').run();
            else db.exec('DELETE FROM memories; UPDATE sessions SET title = NULL, custom_title = NULL');
            db.close();
            const result = await runSessionStart(sessionStartPayload(cwd, 'current-session'), 'codex', {
                dbPath,
                now: () => NOW,
                readConfig: () => AUTO_CONFIG,
            });
            if (expected === 'notify') {
                expect(hookText(result, 'codex')).toContain('capture on');
                expect(JSON.stringify(result)).not.toContain(`${OPEN}brief:`);
            } else {
                expect(result).toEqual({ reason: expected });
            }
        }
    });

    it('routes capture-off consent and count outcomes through both tool channels without exposing memory', async () => {
        for (const tool of ['claude-code', 'codex'] as const) {
            for (const state of ['pending', 'denied'] as const) {
                const { dbPath } = seededDb();
                const cwd = realpathSync(path.join(process.cwd(), '..'));
                if (state === 'denied') {
                    const db = openDb(dbPath);
                    new MemoryStore(db).consent.revoke(cwd);
                    db.close();
                }
                const input = sessionStartPayload(cwd, `${state}-session`);
                const first = await runSessionStart(input, tool, { dbPath, now: () => NOW, readConfig: () => NOTIFY_CONFIG });
                const body = hookText(first, tool);
                const grantHint = state === 'pending' ? ` · run 'elepha consent grant ${cwd}' to capture here` : '';
                expect(body).toBe(`🐘 elepha · 1 sessions · capture off · type elepha:list to recall${grantHint}`);
                expect(body).not.toContain('Stored real session');
                expect(body).not.toContain(OPEN);
                await expect(runSessionStart(input, tool, { dbPath, now: () => NOW, readConfig: () => NOTIFY_CONFIG })).resolves.toEqual(
                    first,
                );
                const db = openDb(dbPath);
                expect(db.prepare('SELECT nudged_at FROM consent_roots WHERE path = ?').get(cwd)).toEqual({ nudged_at: null });
                db.close();
            }
        }

        const retained = seededDb();
        const retainedCwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'elepha-retained-project-')));
        const projectId = addProject(retained.dbPath, retainedCwd, false);
        for (let index = 0; index < 6; index++) {
            addSession(retained.dbPath, {
                nativeId: `retained-session-${index}`,
                lastTurnAt: new Date(NOW - index).toISOString(),
                projectId,
            });
        }
        const retainedResult = await runSessionStart(sessionStartPayload(retainedCwd, 'capture-off-session'), 'codex', {
            dbPath: retained.dbPath,
            now: () => NOW,
            readConfig: () => NOTIFY_CONFIG,
        });
        expect(hookText(retainedResult, 'codex')).toContain('6/1 sessions');

        const emptyDbPath = path.join(mkdtempSync(path.join(tmpdir(), 'elepha-capture-off-zero-')), 'elepha.db');
        const emptyCwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'elepha-capture-off-project-')));
        openDb(emptyDbPath).close();
        const emptyResult = await runSessionStart(sessionStartPayload(emptyCwd, 'capture-off-session'), 'codex', {
            dbPath: emptyDbPath,
            now: () => NOW,
            readConfig: () => NOTIFY_CONFIG,
        });
        expect(hookText(emptyResult, 'codex')).toContain('0 sessions');
        expect(hookText(emptyResult, 'codex')).not.toContain('0/');

        const offCwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'elepha-off-project-')));
        await expect(
            runSessionStart(sessionStartPayload(offCwd), 'codex', {
                dbPath: retained.dbPath,
                readConfig: () => ({ config: { on_startup: 'off', on_clear: 'off', on_resume: 'off', on_compact: 'off' } }),
            }),
        ).resolves.toEqual({ reason: 'off' });
    });

    it('keeps refused HOME roots out of consent while still emitting recall guidance without a grant hint', async () => {
        const { dbPath } = seededDb();
        const cwd = realpathSync(homedir());
        const db = openDb(dbPath);
        const before = db.prepare('SELECT ulid, path, state, decided_at, source FROM consent_roots ORDER BY path').all();
        db.close();

        const result = await runSessionStart(sessionStartPayload(cwd, 'refused-home-session'), 'codex', {
            dbPath,
            now: () => NOW,
            readConfig: () => NOTIFY_CONFIG,
        });

        const reopened = openDb(dbPath);
        expect(reopened.prepare('SELECT ulid, path, state, decided_at, source FROM consent_roots ORDER BY path').all()).toEqual(before);
        reopened.close();
        expect(hookText(result, 'codex')).toBe('🐘 elepha · 1 sessions · capture off · type elepha:list to recall');
        expect(hookText(result, 'codex')).not.toContain('consent grant');
    });

    it('contains ordinary dependency errors without constructing an output', async () => {
        const { dbPath, cwd } = seededDb();
        const log: string[] = [];
        await expect(
            runSessionStart(
                JSON.stringify({
                    session_id: 'native-session',
                    cwd,
                    hook_event_name: 'SessionStart',
                    source: 'startup',
                    model: 'gpt-5.6',
                    permission_mode: 'default',
                }),
                'codex',
                {
                    dbPath,
                    log: (line) => log.push(line),
                    readConfig: () => {
                        throw new Error('read failed');
                    },
                },
            ),
        ).resolves.toEqual({ reason: 'hook_error' });
        expect(log).toContain('session-start codex source=startup session_id=native-session: read failed');
    });

    it('logs the watchdog timeout before exiting successfully without stdout', () => {
        const log: string[] = [];
        const exits: number[] = [];
        handleWatchdogTimeout(
            'claude-code',
            (line) => log.push(line),
            (code) => exits.push(code),
        );
        expect(log).toEqual(['session-start claude-code source=unknown session_id=unknown: watchdog timeout after 2000ms']);
        expect(exits).toEqual([0]);
    });

    it('applies the recency, branch, and git-distance automatic-context boundaries', async () => {
        const day = 24 * 60 * 60 * 1000;
        const cases = [
            { ageMs: 7 * day, storedBranch: 'main', currentBranch: 'main', currentCount: 100, brief: true },
            { ageMs: 7 * day + 1, storedBranch: 'main', currentBranch: 'main', currentCount: 100, brief: false },
            { ageMs: 30 * day, storedBranch: 'main', currentBranch: 'main', currentCount: 100, brief: false },
            { ageMs: 30 * day + 1, storedBranch: 'main', currentBranch: 'main', currentCount: 100, brief: false },
            { ageMs: 0, storedBranch: 'main', currentBranch: 'main', currentCount: 120, brief: true },
            { ageMs: 0, storedBranch: 'main', currentBranch: 'main', currentCount: 121, brief: false },
            { ageMs: 0, storedBranch: 'old', currentBranch: 'main', currentCount: 100, brief: false },
        ];
        for (const scenario of cases) {
            const { dbPath, cwd } = seededDb({
                ageMs: scenario.ageMs,
                gitCommitCount: 100,
                gitBranch: scenario.storedBranch,
                sourcePath: AUTO_SOURCE,
            });
            const result = await runSessionStart(sessionStartPayload(cwd), 'codex', {
                dbPath,
                now: () => NOW,
                gitBranch: () => scenario.currentBranch,
                gitCommitCount: () => scenario.currentCount,
                readConfig: () => AUTO_CONFIG,
            });
            expect(JSON.stringify(result).includes(`${OPEN}brief:`)).toBe(scenario.brief);
            if (!scenario.brief) expect(hookText(result, 'codex')).toContain('capture on');
        }
    });

    it('treats probes still stalled before the watchdog as unavailable git', async () => {
        const { dbPath, cwd } = seededDb({ gitCommitCount: null, sourcePath: AUTO_SOURCE });
        const unavailableLog: string[] = [];
        const commonDependencies: SessionStartDependencies = {
            dbPath,
            now: () => NOW,
            daemonHealth: () => ({ state: 'RUNNING' as const, healthy: true }),
            readUpdateAvailable: () => undefined,
            readConfig: () => AUTO_CONFIG,
            writeInjection: () => true,
        };
        const unavailable = await runSessionStart(sessionStartPayload(cwd), 'codex', {
            ...commonDependencies,
            log: (line) => unavailableLog.push(line),
            gitBranch: () => null,
            gitCommitCount: () => null,
        });
        const stalledLog: string[] = [];
        let branchSignal: AbortSignal | undefined;
        let countSignal: AbortSignal | undefined;
        const stalledBranch = vi.fn((_cwd: string, signal: AbortSignal) => {
            branchSignal = signal;
            return new Promise<string | null>(() => {});
        });
        const stalledCount = vi.fn((_cwd: string, signal: AbortSignal) => {
            countSignal = signal;
            return new Promise<number | null>(() => {});
        });

        vi.useFakeTimers();
        try {
            const inFlight = runSessionStart(sessionStartPayload(cwd), 'codex', {
                ...commonDependencies,
                log: (line) => stalledLog.push(line),
                gitBranch: stalledBranch,
                gitCommitCount: stalledCount,
            });
            let settled = false;
            void inFlight.then(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(HOOK_WATCHDOG_TIMEOUT_MS - 1);

            expect(settled).toBe(true);
            const stalled = await inFlight;
            expect(normalizedHookResult(stalled)).toBe(normalizedHookResult(unavailable));
            expect(stalledLog).toEqual(unavailableLog);
            expect(stalledBranch).toHaveBeenCalledOnce();
            expect(stalledCount).toHaveBeenCalledOnce();
            expect(branchSignal).toBe(countSignal);
            expect(branchSignal?.aborted).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('preserves output bytes and branch order for every normal git outcome', async () => {
        const cases = [
            { name: 'branch changed', storedBranch: 'main', storedCount: 100, branch: 'feature', count: 100, brief: false },
            { name: 'commit count null', storedBranch: 'main', storedCount: null, branch: 'main', count: 100, brief: false },
            { name: 'count behind', storedBranch: 'main', storedCount: 100, branch: 'main', count: 121, brief: false },
            { name: 'count unavailable', storedBranch: 'main', storedCount: 100, branch: 'main', count: null, brief: true },
        ] as const;

        for (const scenario of cases) {
            const { dbPath, cwd } = seededDb({
                gitBranch: scenario.storedBranch,
                gitCommitCount: scenario.storedCount,
                sourcePath: AUTO_SOURCE,
            });
            const commonDependencies: SessionStartDependencies = {
                dbPath,
                now: () => NOW,
                daemonHealth: () => ({ state: 'RUNNING' as const, healthy: true }),
                readUpdateAvailable: () => undefined,
                readConfig: () => AUTO_CONFIG,
                writeInjection: () => true,
            };
            const baselineLog: string[] = [];
            const baseline = await runSessionStart(sessionStartPayload(cwd), 'codex', {
                ...commonDependencies,
                log: (line) => baselineLog.push(line),
                gitBranch: () => scenario.branch,
                gitCommitCount: () => scenario.count,
            });
            const asyncLog: string[] = [];
            const asynchronous = await runSessionStart(sessionStartPayload(cwd), 'codex', {
                ...commonDependencies,
                log: (line) => asyncLog.push(line),
                gitBranch: async () => scenario.branch,
                gitCommitCount: async () => scenario.count,
            });

            expect(normalizedHookResult(asynchronous), scenario.name).toBe(normalizedHookResult(baseline));
            expect(asyncLog, scenario.name).toEqual(baselineLog);
            expect(normalizedHookResult(asynchronous).includes(`${OPEN}brief:`), scenario.name).toBe(scenario.brief);
        }
    });

    it('degrades an existing NULL git_commit_count baseline to notify before raw rendering', async () => {
        const { dbPath, cwd } = seededDb({ gitCommitCount: null, sourcePath: AUTO_SOURCE });
        const log: string[] = [];
        const result = await runSessionStart(
            JSON.stringify({
                session_id: 'native-session',
                cwd,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath,
                now: () => NOW,
                log: (line) => log.push(line),
                gitBranch: () => 'main',
                gitCommitCount: () => 100,
                readConfig: () => ({ config: { on_startup: 'auto', on_clear: 'auto', on_resume: 'auto', on_compact: 'off' } }),
            },
        );
        expect('output' in result).toBe(true);
        if ('output' in result) expect(JSON.stringify(result.output)).toContain('🐘 elepha · 1 sessions');
        expect(log).toContain(
            'session-start codex source=startup session_id=native-session: auto degraded: stored git commit count unavailable',
        );
    });

    it('renders the auto body through SessionReader with framing, raw turns, D24, and aggregate facts', async () => {
        const { dbPath, cwd } = seededDb({ gitCommitCount: 100, sourcePath: AUTO_SOURCE });
        const result = await runSessionStart(
            JSON.stringify({
                session_id: 'native-session',
                cwd,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath,
                now: () => NOW,
                gitBranch: () => 'main',
                gitCommitCount: () => 100,
                readConfig: () => ({ config: { on_startup: 'auto', on_clear: 'auto', on_resume: 'auto', on_compact: 'off' } }),
            },
        );
        expect('output' in result).toBe(true);
        if ('output' in result) {
            const body = JSON.stringify(result.output);
            expect(body).toContain('durable decisions: not available');
            expect(body).toContain('## Turn');
            expect(body).toContain('Recent files:');
            expect(body).toContain(`${OPEN}brief:`);
        }
    });

    it('discards an auto brief when consent is revoked during transcript rendering', async () => {
        const { dbPath, cwd } = seededDb({ gitCommitCount: 100, sourcePath: AUTO_SOURCE });
        const originalRender = SessionReader.prototype.render;
        let releaseRender!: () => void;
        let markRenderStarted!: () => void;
        const renderStarted = new Promise<void>((resolve) => {
            markRenderStarted = resolve;
        });
        const renderRelease = new Promise<void>((resolve) => {
            releaseRender = resolve;
        });
        const render = vi.spyOn(SessionReader.prototype, 'render').mockImplementation(async function (this: SessionReader, ...args) {
            markRenderStarted();
            await renderRelease;
            return originalRender.apply(this, args);
        });
        const writeInjection = vi.fn(() => true);
        const log: string[] = [];

        try {
            const inFlight = runSessionStart(sessionStartPayload(cwd), 'codex', {
                dbPath,
                now: () => NOW,
                gitBranch: () => 'main',
                gitCommitCount: () => 100,
                readConfig: () => AUTO_CONFIG,
                writeInjection,
                log: (line) => log.push(line),
            });
            await renderStarted;

            const revokingDb = openDb(dbPath);
            new MemoryStore(revokingDb).consent.revoke(cwd);
            revokingDb.close();
            releaseRender();

            const result = await inFlight;
            expect(result).toEqual({ reason: 'project_unavailable_or_unconsented' });
            expect(JSON.stringify(result)).not.toContain('## Turn');
            expect(writeInjection).not.toHaveBeenCalled();
            const verificationDb = openDb(dbPath);
            expect(verificationDb.prepare('SELECT COUNT(*) AS count FROM injections').get()).toEqual({ count: 0 });
            verificationDb.close();
            expect(log).toContain(
                'session-start codex source=startup session_id=native-session: discarded reason=project_unavailable_or_unconsented',
            );
        } finally {
            releaseRender();
            render.mockRestore();
        }
    });

    it('classifies daemon health while recording the same fail-open episode for both tools', async () => {
        const healthCases = [
            { healthCheck: () => ({ state: 'RUNNING', healthy: true }), warns: false },
            { healthCheck: () => ({ state: 'NOT RUNNING', healthy: false }), warns: true },
            { healthCheck: () => ({ state: 'STUCK', healthy: false }), warns: true },
            {
                healthCheck: () => {
                    throw new Error('heartbeat unreadable');
                },
                warns: false,
            },
        ];
        for (const { healthCheck, warns } of healthCases) {
            for (const tool of ['claude-code', 'codex'] as const) {
                const { dbPath, cwd } = seededDb({ gitCommitCount: 100, sourcePath: AUTO_SOURCE });
                let recordedBody: string | undefined;
                const result = await runSessionStart(sessionStartPayload(cwd, `native-${tool}`), tool, {
                    dbPath,
                    now: () => NOW,
                    daemonHealth: healthCheck,
                    gitBranch: () => 'main',
                    gitCommitCount: () => 100,
                    readConfig: () => AUTO_CONFIG,
                    writeInjection: (_store, input) => {
                        recordedBody = input.body;
                        return true;
                    },
                });

                expect('output' in result).toBe(true);
                if (!('output' in result)) continue;
                const injected = (result.output.hookSpecificOutput as Record<string, string>).additionalContext;
                expect(injected).toContain(`${OPEN}brief:`);
                expect(injected).toBe(`${open('brief', injected.split(':')[2].split(']]')[0])}\n${recordedBody}\n${CLOSE}`);
                expect(recordedBody?.includes('⚠ elepha:')).toBe(warns);
                expect(recordedBody).toContain('## Turn');
            }
        }
    });

    it('routes optional update state through both tool envelopes', async () => {
        for (const tool of ['claude-code', 'codex'] as const) {
            for (const available of [true, false]) {
                const { dbPath, cwd } = seededDb({ gitCommitCount: 100, sourcePath: AUTO_SOURCE });
                let recordedBody: string | undefined;
                let markerReads = 0;
                const result = await runSessionStart(sessionStartPayload(cwd, `native-${tool}`), tool, {
                    dbPath,
                    now: () => NOW,
                    gitBranch: () => 'main',
                    gitCommitCount: () => 100,
                    daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
                    readUpdateAvailable: () => {
                        markerReads++;
                        return available ? { version: '1.2.4', checkedAt: '2026-08-19T00:00:00.000Z' } : undefined;
                    },
                    readConfig: () => AUTO_CONFIG,
                    writeInjection: (_store, input) => {
                        recordedBody = input.body;
                        return true;
                    },
                });
                expect(markerReads).toBe(1);
                expect('output' in result).toBe(true);
                expect(recordedBody).toContain('## Turn');
                expect(recordedBody?.includes('1.2.4')).toBe(available);
                expect(JSON.stringify(result).includes('1.2.4')).toBe(available);
            }
        }
    });

    it('ignores an update marker naming the running version', async () => {
        const { dbPath, cwd } = seededDb({ gitCommitCount: 100, sourcePath: AUTO_SOURCE });
        let recordedBody: string | undefined;
        const result = await runSessionStart(sessionStartPayload(cwd), 'codex', {
            dbPath,
            now: () => NOW,
            gitBranch: () => 'main',
            gitCommitCount: () => 100,
            daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
            readUpdateAvailable: () => ({ version: PACKAGE_VERSION, checkedAt: '2026-08-29T00:00:00.000Z' }),
            readConfig: () => AUTO_CONFIG,
            writeInjection: (_store, input) => {
                recordedBody = input.body;
                return true;
            },
        });

        expect('output' in result).toBe(true);
        expect(recordedBody).not.toContain('⬆ elepha');
        expect(JSON.stringify(result)).not.toContain('⬆ elepha');
    });

    it('degrades missing, unreadable, and reparse-empty sources to notify with a distinct log reason', async () => {
        const cases = [
            [path.join(realpathSync(codexSessionsRoot()), 'missing.jsonl'), 'transcript_missing'],
            [path.dirname(AUTO_SOURCE), 'transcript_unreadable'],
            [EMPTY_SOURCE, 'transcript_reparse_empty'],
        ] as const;
        for (const [sourcePath, reason] of cases) {
            const { dbPath, cwd } = seededDb({ gitCommitCount: 100, sourcePath });
            const log: string[] = [];
            const result = await runSessionStart(
                JSON.stringify({
                    session_id: 'native-session',
                    cwd,
                    hook_event_name: 'SessionStart',
                    source: 'startup',
                    model: 'gpt-5.6',
                    permission_mode: 'default',
                }),
                'codex',
                {
                    dbPath,
                    now: () => NOW,
                    log: (line) => log.push(line),
                    gitBranch: () => 'main',
                    gitCommitCount: () => 100,
                    readConfig: () => ({ config: { on_startup: 'auto', on_clear: 'auto', on_resume: 'auto', on_compact: 'off' } }),
                },
            );
            expect('output' in result).toBe(true);
            if ('output' in result) expect(JSON.stringify(result.output)).toContain('🐘 elepha · 1 sessions');
            expect(log.some((line) => line.includes(reason))).toBe(true);
        }
    });

    it('uses only the consented project directory for git probes even with an inert hostile transcript path', async () => {
        const { dbPath, cwd } = seededDb({ gitCommitCount: 100, sourcePath: AUTO_SOURCE });
        const seen: string[] = [];
        await runSessionStart(
            JSON.stringify({
                session_id: 'native-session',
                cwd,
                hook_event_name: 'SessionStart',
                source: 'startup',
                transcript_path: '$(touch /tmp/nope)',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath,
                now: () => NOW,
                gitBranch: (gitCwd) => {
                    seen.push(gitCwd);
                    return 'main';
                },
                gitCommitCount: (gitCwd) => {
                    seen.push(gitCwd);
                    return 100;
                },
                readConfig: () => ({ config: { on_startup: 'auto', on_clear: 'auto', on_resume: 'auto', on_compact: 'off' } }),
            },
        );
        expect(seen).toEqual([cwd, cwd]);
    });

    it('routes sentinel-free notify through both tools while retaining quote-back protection', async () => {
        for (const tool of ['claude-code', 'codex'] as const) {
            const { dbPath, cwd } = seededDb();
            let sawPersistentWrite = false;
            const log: string[] = [];
            const result = await runSessionStart(sessionStartPayload(cwd), tool, {
                dbPath,
                now: () => NOW,
                readConfig: () => NOTIFY_CONFIG,
                writeInjection: (store, input) => {
                    const recorded = store.recordInjection(input);
                    sawPersistentWrite =
                        recorded && store.injectionsForSession(input.tool, input.nativeSessionId, input.injectedAt).length === 1;
                    return recorded;
                },
                log: (line) => log.push(line),
            });
            expect(sawPersistentWrite).toBe(true);
            expect(log).toContain(`session-start ${tool} source=startup session_id=native-session: emitted notify`);
            expect(hookText(result, tool)).toContain('capture on');
            expect(JSON.stringify(result)).not.toContain(OPEN);
        }
    });

    it('prints nothing when injection persistence fails', async () => {
        const { dbPath, cwd } = seededDb();
        const result = await runSessionStart(
            JSON.stringify({
                session_id: 'native-session',
                cwd,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'claude-code',
            {
                dbPath,
                writeInjection: () => false,
                readConfig: () => ({ config: { on_startup: 'notify', on_clear: 'notify', on_resume: 'auto', on_compact: 'off' } }),
            },
        );
        expect(result).toEqual({ reason: 'injection_record_failed' });
    });

    it('writes hook diagnostics to its configured temporary log with attributable session metadata', async () => {
        const { dbPath, cwd } = seededDb();
        await runSessionStart(
            JSON.stringify({
                session_id: 'attributable-native-session',
                cwd,
                hook_event_name: 'SessionStart',
                source: 'resume',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath,
                now: () => NOW,
                readConfig: () => ({ config: { on_startup: 'notify', on_clear: 'notify', on_resume: 'notify', on_compact: 'off' } }),
            },
        );

        expect(readFileSync(testHookLogPath, 'utf8')).toContain(
            'session-start codex source=resume session_id=attributable-native-session: emitted notify',
        );
        expect(hookLogPath()).toBe(testHookLogPath);
    });
});

afterAll(() => {
    if (priorHookLogPath === undefined) {
        delete process.env.ELEPHA_HOOK_LOG_PATH;
    } else {
        process.env.ELEPHA_HOOK_LOG_PATH = priorHookLogPath;
    }
    if (priorCodexHome === undefined) {
        delete process.env.CODEX_HOME;
    } else {
        process.env.CODEX_HOME = priorCodexHome;
    }
});
