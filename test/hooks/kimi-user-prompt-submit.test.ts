import { describe, expect, it } from 'vitest';
import { DURABLE_CAPTURE_FILTER_VERSION, HOOK_PAYLOAD_MAX_CHARS } from '../../src/config/constants.js';
import { isHookTool, parsePayload } from '../../src/hooks/common.js';
import { kimiOutput } from '../../src/hooks/kimi.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { CLOSE, containsSentinel, OPEN, wrap } from '../../src/security/sentinel.js';
import {
    DISPLAY_VERBATIM_INSTRUCTIONS,
    dataBlockClose,
    dataBlockOpen,
    HELP,
    RESUME_RECAP_INSTRUCTIONS,
    SERVER_INSTRUCTIONS,
    servedContextInstructions,
} from '../../src/serving/instructions.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { InjectionStore } from '../../src/storage/injection-store.js';
import { ShownSessionListStore } from '../../src/storage/shown-session-list-store.js';
import { SESSION_ADAPTER_TOOLS, SUPPORTED_TOOLS } from '../../src/types/index.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedSession } from '../helpers/db.js';

const NOW = Date.parse('2026-09-10T00:00:00.000Z');
function payload(cwd: string, prompt: string, sessionId = 'kimi-chat'): string {
    return JSON.stringify({ session_id: sessionId, cwd, prompt: [{ type: 'text', text: prompt }], is_steer: false });
}
function output(result: Awaited<ReturnType<typeof runUserPromptSubmit>>): Record<string, unknown> {
    if (!('output' in result)) throw new Error(result.reason);
    return result.output;
}
function blockedBody(result: Awaited<ReturnType<typeof runUserPromptSubmit>>): string {
    const rendered = output(result);
    expect(rendered).toEqual({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.any(String) } });
    return (rendered.hookSpecificOutput as Record<string, string>).permissionDecisionReason;
}
function body(context: string): string {
    expect(containsSentinel(context)).toBe(true);
    const content = context.split('\n').slice(1, -1).join('\n');
    const id = context.split('\n')[0].slice(`${OPEN}brief:`.length, -2);
    expect(context).toBe(wrap('brief', id, content));
    expect(context.endsWith(CLOSE)).toBe(true);
    return content;
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

describe('Kimi UserPromptSubmit', () => {
    it.each(['8d88e717-7188-4418-9633-5ee5f143a94b', '2cc58f4d-f1e0-4de8-9462-50431ea14875'])(
        'strips query display framing while preserving the full model message for nonce %s',
        (nonce) => {
            const payload = 'Recall hits for “git” (1 shown of 1):\n1. Git workflow';
            const framed = wrap(
                'brief',
                'query-display',
                [
                    servedContextInstructions(nonce),
                    DISPLAY_VERBATIM_INSTRUCTIONS,
                    '',
                    dataBlockOpen(nonce),
                    payload,
                    dataBlockClose(nonce),
                ].join('\n'),
            );
            expect(kimiOutput(framed, { kind: 'query', query: 'git', scope: 'global' })).toEqual({
                hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: payload },
            });
            expect(kimiOutput(framed, { kind: 'resume', index: 1 })).toEqual({ message: framed });
            expect(kimiOutput(framed, { kind: 'last' })).toEqual({ message: framed });
        },
    );

    it('normalizes snake_case text parts with capture registered and SessionStart excluded', () => {
        const raw = {
            session_id: 'chat',
            cwd: process.cwd(),
            is_steer: true,
            prompt: [
                { type: 'text', text: 'elepha:query' },
                { type: 'image_url', image_url: { url: 'inert' } },
                { type: 'text', text: 'topic' },
            ],
        };
        expect(parsePayload(JSON.stringify(raw), 'kimi', 'UserPromptSubmit')).toMatchObject({
            session_id: raw.session_id,
            cwd: raw.cwd,
            hook_event_name: 'UserPromptSubmit',
            prompt: 'elepha:query\ntopic',
        });
        expect(parsePayload(JSON.stringify(raw), 'kimi', 'SessionStart')).toBeUndefined();
        expect(isHookTool('kimi')).toBe(true);
        expect(SUPPORTED_TOOLS).toContain('kimi');
        expect(SESSION_ADAPTER_TOOLS).toContain('kimi');
        for (const prompt of ['elepha:help', null, [{ type: 'text', text: 1 }], [null]]) {
            expect(parsePayload(JSON.stringify({ ...raw, prompt }), 'kimi', 'UserPromptSubmit')).toBeUndefined();
        }
        expect(parsePayload('x'.repeat(HOOK_PAYLOAD_MAX_CHARS + 1), 'kimi', 'UserPromptSubmit')).toBeUndefined();
    });

    it.each(['elepha:info', 'elepha:list', 'elepha:help', 'elepha:update', 'elepha:query topic', 'elepha:query'])(
        'blocks and displays %s without a model echo directive',
        async (command) => {
            const fixture = createTestDb('kimi-display-');
            seedConsentRoot(fixture, { path: fixture.directory });
            fixture.close();
            const context = blockedBody(
                await runUserPromptSubmit(payload(fixture.directory, command), 'kimi', {
                    dbPath: fixture.dbPath,
                    now: () => NOW,
                    daemonHealth: () => ({ state: 'running', healthy: true }),
                    readUpdateAvailable: () => undefined,
                }),
            );
            const displayed = context;
            expect(displayed).not.toContain(OPEN);
            expect(displayed).not.toContain(CLOSE);
            expect(displayed).not.toContain(DISPLAY_VERBATIM_INSTRUCTIONS);
            if (command === 'elepha:help') expect(displayed).toBe(HELP);
            if (command === 'elepha:update') expect(displayed).toContain('elepha self-update');
            const db = openUnmanagedDb(fixture.dbPath);
            try {
                const store = new InjectionStore(db);
                expect(store.injectionsForSession('kimi', 'kimi-chat', new Date(NOW).toISOString())).toMatchObject([{ body: displayed }]);
                if (command === 'elepha:help') {
                    const turn = {
                        tool: 'kimi' as const,
                        sessionId: 'kimi-chat',
                        endedAt: new Date(NOW).toISOString(),
                        userMessage: '',
                        assistantText: displayed,
                        toolCalls: [],
                    };
                    expect(store.isQuoteBack(turn)).toBe(true);
                    expect(store.isQuoteBack({ ...turn, sessionId: 'different' })).toBe(false);
                    expect(store.isQuoteBack({ ...turn, tool: 'codex' })).toBe(false);
                }
            } finally {
                db.close();
            }
        },
    );

    it('recalls hits, stores the Kimi selector, and injects the selected resume with exact DATA framing', async () => {
        const fixture = createTestDb('kimi-recall-');
        const project = seedProject(fixture, { path: fixture.directory });
        seedConsentRoot(fixture, { path: fixture.directory });
        const older = seedStoredSession(fixture, project, 'older', 'Zebra older', '2026-09-09T20:00:00.000Z');
        seedStoredSession(fixture, project, 'newer', 'Newer session', '2026-09-09T22:00:00.000Z');
        fixture.close();
        const dependencies = { dbPath: fixture.dbPath, now: () => NOW };
        const recall = blockedBody(await runUserPromptSubmit(payload(fixture.directory, 'elepha:query Zebra'), 'kimi', dependencies));
        expect(recall).toContain('Zebra older');
        expect(recall).not.toContain(SERVER_INSTRUCTIONS);
        expect(recall).not.toContain(DISPLAY_VERBATIM_INSTRUCTIONS);
        expect(recall).not.toContain(dataBlockOpen('').slice(0, -2));
        expect(recall).not.toContain(dataBlockClose('').slice(0, -2));
        const db = openUnmanagedDb(fixture.dbPath);
        try {
            const recorded = new InjectionStore(db).injectionsForSession('kimi', 'kimi-chat', new Date(NOW).toISOString());
            expect(recorded).toHaveLength(1);
            const nonce = recorded[0].body.split(dataBlockOpen('').slice(0, -2))[1]?.split(']]')[0];
            expect(nonce).toBeDefined();
            expect(recorded[0].body).toBe(`${servedContextInstructions(nonce!)}\n${DISPLAY_VERBATIM_INSTRUCTIONS}\n\n${recall}`);
            expect(new ShownSessionListStore(db).forChat('kimi', 'kimi-chat')).toEqual([older.id]);
            expect(new ShownSessionListStore(db).forChat('codex', 'kimi-chat')).toBeUndefined();
        } finally {
            db.close();
        }
        const result = output(await runUserPromptSubmit(payload(fixture.directory, 'elepha:resume:1'), 'kimi', dependencies));
        expect(Object.keys(result)).toEqual(['message']);
        const context = result.message as string;
        expect(body(context)).toContain(RESUME_RECAP_INSTRUCTIONS);
        expect(context).toContain('# Zebra older');
        expect(context).not.toContain('# Newer session');
        const nonce = context.split(dataBlockOpen('').slice(0, -2))[1]?.split(']]')[0];
        expect(nonce).toBeDefined();
        expect(context).toContain(servedContextInstructions(nonce!));
        expect(context).toContain(dataBlockOpen(nonce!));
        expect(context).toContain(dataBlockClose(nonce!));
        const last = output(await runUserPromptSubmit(payload(fixture.directory, 'elepha:last'), 'kimi', dependencies));
        expect(last.message).toContain('# Newer session');
        expect(last).not.toHaveProperty('hookSpecificOutput');
    });

    it('keeps ordinary prompts inert and fails open if recording fails', async () => {
        expect(await runUserPromptSubmit(payload(process.cwd(), 'hello'), 'kimi', { dbPath: '/must-not-open' })).toEqual({
            reason: 'not_command',
        });
        const fixture = createTestDb('kimi-record-failure-');
        fixture.close();
        expect(
            await runUserPromptSubmit(payload(fixture.directory, 'elepha:help'), 'kimi', {
                dbPath: fixture.dbPath,
                writeInjection: () => false,
            }),
        ).toEqual({ reason: 'injection_record_failed' });
    });
});
