import { describe, expect, it } from 'vitest';
import { DURABLE_CAPTURE_FILTER_VERSION } from '../../src/config/constants.js';
import { type HookTool, isHookTool, parsePayload } from '../../src/hooks/common.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedSession } from '../helpers/db.js';

const NOW = Date.parse('2026-09-09T00:00:00.000Z');

function payload(cwd: string, prompt: string, sessionId = 'opencode-chat'): string {
    return JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt,
    });
}

function additionalContext(result: Awaited<ReturnType<typeof runUserPromptSubmit>>): string {
    expect('output' in result).toBe(true);
    if (!('output' in result)) {
        throw new Error(`command did not emit: ${result.reason}`);
    }
    return (result.output.hookSpecificOutput as Record<string, string>).additionalContext;
}

function injectedBody(context: string): string {
    return context.split('\n').slice(1, -1).join('\n');
}

function seedStoredSession(
    fixture: ReturnType<typeof createTestDb>,
    project: ReturnType<typeof seedProject>,
    nativeId: string,
    title: string,
    timestamp: string,
) {
    const session = seedSession(fixture, {
        project,
        nativeId,
        title,
        startedAt: timestamp,
        lastIngestedAt: timestamp,
        lastTurnAt: timestamp,
    });
    const memory = seedMemory(fixture, {
        project,
        session,
        startedAt: timestamp,
        userMessage: `Request for ${title}`,
        assistantText: `Response for ${title}`,
    });
    fixture.db
        .prepare(
            `INSERT INTO filtered_turns
             (memory_id, included, user_prompt, assistant_response, tool_calls, omitted_tool_call_count,
              dropped_tool_ref_count, omitted_before_chars, filter_version, captured_at)
             VALUES (?, 1, ?, ?, '[]', 0, 0, 0, ?, ?)`,
        )
        .run(memory.id, `Request for ${title}`, `Response for ${title}`, DURABLE_CAPTURE_FILTER_VERSION, timestamp);
    fixture.db
        .prepare(
            `INSERT INTO durable_capture_status (session_id, state, filter_version, updated_at)
             VALUES (?, 'complete', ?, ?)`,
        )
        .run(session.id, DURABLE_CAPTURE_FILTER_VERSION, timestamp);
    return session;
}

describe('D123 OpenCode UserPromptSubmit hook runtime', () => {
    it('accepts OpenCode payloads without Codex-only fields and keeps Codex validation unchanged', () => {
        const valid = {
            session_id: 'session-1',
            cwd: process.cwd(),
            hook_event_name: 'UserPromptSubmit',
            prompt: 'elepha:list',
        } as const;

        expect(parsePayload(JSON.stringify(valid), 'opencode', 'UserPromptSubmit')).toEqual(valid);
        expect(parsePayload(JSON.stringify({ ...valid, prompt: null }), 'opencode', 'UserPromptSubmit')).toBeUndefined();
        expect(parsePayload(JSON.stringify(valid), 'codex', 'UserPromptSubmit')).toBeUndefined();
        expect(
            parsePayload(JSON.stringify({ ...valid, model: 'gpt-5.6', permission_mode: 'default' }), 'codex', 'UserPromptSubmit'),
        ).toMatchObject(valid);

        const runtimeTool: HookTool = 'opencode';
        expect(runtimeTool).toBe('opencode');
        expect(isHookTool('opencode')).toBe(true);
    });

    it('matches Claude list output and keys its shown list and resume to OpenCode', async () => {
        const fixture = createTestDb('elepha-opencode-prompt-hook-');
        const cwd = fixture.directory;
        const project = seedProject(fixture, { path: cwd });
        seedConsentRoot(fixture, { path: cwd });
        const older = seedStoredSession(fixture, project, 'older', 'Older session', '2026-09-08T20:00:00.000Z');
        const newest = seedStoredSession(fixture, project, 'newest', 'Newest session', '2026-09-08T22:00:00.000Z');
        fixture.close();

        const claudeList = await runUserPromptSubmit(payload(cwd, 'elepha:list:1'), 'claude-code', {
            dbPath: fixture.dbPath,
            now: () => NOW,
        });
        const opencodeList = await runUserPromptSubmit(payload(cwd, 'elepha:list:1'), 'opencode', {
            dbPath: fixture.dbPath,
            now: () => NOW,
        });

        expect('output' in opencodeList).toBe(true);
        if (!('output' in opencodeList)) return;
        expect(opencodeList.output).toEqual({
            continue: true,
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.any(String) },
        });
        expect(injectedBody(additionalContext(opencodeList))).toBe(injectedBody(additionalContext(claudeList)));
        expect(additionalContext(opencodeList)).toContain('1. [2h ago | Codex CLI | elepha-opencode-prompt-hook-');
        expect(additionalContext(opencodeList)).toContain('Newest session');

        const verificationDb = openUnmanagedDb(fixture.dbPath);
        expect(
            verificationDb
                .prepare('SELECT session_ids FROM shown_session_lists WHERE tool = ? AND native_session_id = ?')
                .get('opencode', 'opencode-chat'),
        ).toEqual({ session_ids: JSON.stringify([newest.id]) });
        expect(verificationDb.prepare('SELECT COUNT(*) AS count FROM injections WHERE tool = ?').get('opencode')).toEqual({ count: 1 });
        verificationDb.close();

        const resumed = await runUserPromptSubmit(payload(cwd, 'elepha:resume:1'), 'opencode', {
            dbPath: fixture.dbPath,
            now: () => NOW + 1,
        });
        const resumedContext = additionalContext(resumed);
        expect(resumedContext).toContain('# Newest session');
        expect(resumedContext).not.toContain('# Older session');
        expect(older.id).not.toBe(newest.id);
    });
});
