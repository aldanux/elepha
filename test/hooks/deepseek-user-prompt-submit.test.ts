import { describe, expect, it, vi } from 'vitest';
import { isHookTool, parsePayload } from '../../src/hooks/common.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { CLOSE, containsSentinel, OPEN } from '../../src/security/sentinel.js';
import { DISPLAY_VERBATIM_INSTRUCTIONS, HELP } from '../../src/serving/instructions.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { InjectionStore } from '../../src/storage/injection-store.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedSession } from '../helpers/db.js';

const NOW = Date.parse('2026-09-10T00:00:00.000Z');

function payload(cwd: string, prompt: string, sessionId = 'deepseek-chat'): string {
    return JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'UserPromptSubmit', prompt });
}

function block(result: Awaited<ReturnType<typeof runUserPromptSubmit>>): string {
    if (!('output' in result) || result.block === undefined) throw new Error('reason' in result ? result.reason : 'expected block');
    return result.block;
}

function context(result: Awaited<ReturnType<typeof runUserPromptSubmit>>): string {
    if (!('output' in result)) throw new Error('reason' in result ? result.reason : 'expected output');
    const hookSpecificOutput = result.output.hookSpecificOutput as Record<string, unknown>;
    return hookSpecificOutput.additionalContext as string;
}

describe('DeepSeek Harness UserPromptSubmit', () => {
    it('accepts the DeepSeek hook payload and rejects other event/tool shapes', () => {
        const raw = {
            session_id: 'chat',
            cwd: process.cwd(),
            hook_event_name: 'UserPromptSubmit',
            prompt: 'elepha:help',
        };
        expect(parsePayload(JSON.stringify(raw), 'deepseek', 'UserPromptSubmit')).toEqual(raw);
        expect(parsePayload(JSON.stringify(raw), 'deepseek', 'SessionStart')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...raw, prompt: null }), 'deepseek', 'UserPromptSubmit')).toBeUndefined();
        expect(isHookTool('deepseek')).toBe(true);
    });

    it.each(['elepha:info', 'elepha:list', 'elepha:help', 'elepha:update', 'elepha:query topic', 'elepha:query'])(
        'returns %s as verbatim display output without recording an injection',
        async (command) => {
            const fixture = createTestDb('deepseek-display-');
            seedConsentRoot(fixture, { path: fixture.directory });
            fixture.close();
            const writeInjection = vi.fn(() => false);
            const rendered = block(
                await runUserPromptSubmit(payload(fixture.directory, command), 'deepseek', {
                    dbPath: fixture.dbPath,
                    now: () => NOW,
                    daemonHealth: () => ({ state: 'running', healthy: true }),
                    readUpdateAvailable: () => undefined,
                    writeInjection,
                }),
            );
            expect(rendered).not.toContain(OPEN);
            expect(rendered).not.toContain(CLOSE);
            expect(rendered).not.toContain(DISPLAY_VERBATIM_INSTRUCTIONS);
            if (command === 'elepha:help') expect(rendered).toBe(HELP);
            if (command === 'elepha:update') expect(rendered).toContain('elepha self-update');
            expect(writeInjection).not.toHaveBeenCalled();
            const db = openUnmanagedDb(fixture.dbPath);
            try {
                expect(new InjectionStore(db).injectionsForSession('deepseek', 'deepseek-chat', new Date(NOW).toISOString())).toEqual([]);
            } finally {
                db.close();
            }
        },
    );

    it.each(['elepha:last', 'elepha:resume:1'])('records and returns sentinel-wrapped model context for %s', async (command) => {
        const fixture = createTestDb('deepseek-inject-');
        const project = seedProject(fixture, { path: fixture.directory });
        seedConsentRoot(fixture, { path: fixture.directory });
        const session = seedSession(fixture, {
            project,
            nativeId: 'prior-session',
            title: 'Prior work',
            startedAt: '2026-09-09T20:00:00.000Z',
            lastIngestedAt: '2026-09-09T20:00:00.000Z',
            lastTurnAt: '2026-09-09T20:00:00.000Z',
        });
        seedMemory(fixture, { project, session, userMessage: 'Build it', assistantText: 'Built it' });
        if (command === 'elepha:resume:1') {
            fixture.store.shownSessionLists.replace('deepseek', 'deepseek-chat', [session.id]);
        }
        fixture.close();
        const rendered = context(
            await runUserPromptSubmit(payload(fixture.directory, command), 'deepseek', { dbPath: fixture.dbPath, now: () => NOW }),
        );
        expect(containsSentinel(rendered)).toBe(true);
        expect(rendered).toContain('Prior work');
        const db = openUnmanagedDb(fixture.dbPath);
        try {
            const injections = new InjectionStore(db).injectionsForSession('deepseek', 'deepseek-chat', new Date(NOW).toISOString());
            expect(injections).toHaveLength(1);
            expect(rendered).toContain(injections[0].body);
            expect(
                new InjectionStore(db).isQuoteBack({
                    tool: 'deepseek',
                    sessionId: 'deepseek-chat',
                    endedAt: new Date(NOW).toISOString(),
                    userMessage: injections[0].body,
                    assistantText: '',
                    toolCalls: [],
                }),
            ).toBe(true);
        } finally {
            db.close();
        }
    });

    it('does not claim ordinary or slash-prefixed prompts and fails closed when model-context recording fails', async () => {
        for (const prompt of ['hello', '/elepha info']) {
            expect(await runUserPromptSubmit(payload(process.cwd(), prompt), 'deepseek', { dbPath: '/must-not-open' })).toEqual({
                reason: 'not_command',
            });
        }
        const fixture = createTestDb('deepseek-record-failure-');
        const project = seedProject(fixture, { path: fixture.directory });
        seedConsentRoot(fixture, { path: fixture.directory });
        const session = seedSession(fixture, { project });
        seedMemory(fixture, { project, session });
        fixture.close();
        expect(
            await runUserPromptSubmit(payload(fixture.directory, 'elepha:last'), 'deepseek', {
                dbPath: fixture.dbPath,
                writeInjection: () => false,
            }),
        ).toEqual({ reason: 'injection_record_failed' });
    });
});
