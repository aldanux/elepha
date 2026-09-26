import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { HOOK_PAYLOAD_MAX_CHARS, INSTALLED_HOOK_TIMEOUT_SECONDS, OPENCODE_PLUGIN_OUTPUT_MAX_BYTES } from '../../src/config/constants.js';
import { opencodePluginStatus, renderOpencodePlugin, transformOpencodePlugin } from '../../src/install/opencode-plugin.js';
import { installationStatus } from '../../src/install/status.js';
import { transformOpencodeMcp } from '../../src/mcp/installer.js';
import { wrap } from '../../src/security/sentinel.js';
import { OPENCODE_HOOK_ARGS, OPENCODE_RULES_HOOK_ARGS } from '../../src/security/subprocess-allowlist.js';
import { DISPLAY_VERBATIM_INSTRUCTIONS, RESUME_RECAP_INSTRUCTIONS } from '../../src/serving/instructions.js';

const launcher = '/opt/elepha with spaces/elepha';
const directory = '/projects/current worktree';
const response = (context: unknown) => JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: context } });
const RULE_ID = `01J${'0'.repeat(23)}`;
const RULE_CONTEXT = wrap('rules', RULE_ID, 'Follow the explicitly saved project rule.');

type Part = { type: string; text?: string };
type Message = { info: { role: string; sessionID: string }; parts: Part[] };
interface Hooks {
    'experimental.chat.system.transform': (input: { sessionID?: unknown }, output: { system: string[] }) => Promise<void>;
    'experimental.chat.messages.transform': (input: object, output: { messages: Message[] }) => Promise<void>;
}

type V2Message = { role: string; content: Array<{ type: string; text?: string }> };
type V2Tools = Record<string, { description: string; input: object }>;
type V2Event = { sessionID: string; messages: V2Message[]; system: Array<{ type: string; text: string }>; tools?: V2Tools };
const v2Tools = (): V2Tools => ({ 'elepha.recall': { description: 'Recall', input: { type: 'object' } } });
const DISPLAY_CONTEXT = `[[elepha:brief:01ABCDEF]]\n${DISPLAY_VERBATIM_INSTRUCTIONS}\n🐘 Added chat standing rule.\n[[/elepha]]`;
const RESUME_CONTEXT = `[[elepha:brief:01ABCDEF]]\n${RESUME_RECAP_INSTRUCTIONS}\n# Session title\n\nSession turns\n[[/elepha]]`;
const history = (): V2Message[] => [
    { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
];

async function v2Fixture(stdout = response('rendered context'), rulesStdout = JSON.stringify({ context: RULE_CONTEXT })) {
    const execute = vi.fn((_command: string, _args: readonly string[], _options: ExecFileSyncOptionsWithStringEncoding) => stdout);
    const rulesInputs: string[] = [];
    const executeRules = vi.fn(
        (_command: string, _args: readonly string[], _options: object, callback: (error: Error | null, stdout: string) => void) => ({
            stdin: Object.assign(new EventEmitter(), {
                end: (input: string) => {
                    rulesInputs.push(input);
                    callback(null, rulesStdout);
                },
            }),
        }),
    );
    const source = renderOpencodePlugin(launcher)
        .replace("import { execFileSync } from 'node:child_process';", '')
        .replace("import { execFile } from 'node:child_process';", '')
        .replace('export default ', 'const ElephaPlugin = ');
    const plugin = runInNewContext(`${source}\nElephaPlugin`, { execFileSync: execute, execFile: executeRules, Buffer }) as {
        id: string;
        setup: (ctx: {
            location: { directory: string };
            session: {
                get: (input: { sessionID: string }) => Promise<unknown>;
                hook: (name: string, callback: (event: V2Event) => Promise<void>) => Promise<void>;
            };
        }) => Promise<void>;
    };
    const hooks = new Map<string, (event: V2Event) => Promise<void>>();
    const get = vi.fn(async (_input: { sessionID: string }): Promise<unknown> => ({ location: { directory } }));
    await plugin.setup({
        location: { directory: '/wrong/plugin/location' },
        session: {
            get,
            hook: async (name, callback) => {
                hooks.set(name, callback);
            },
        },
    });
    return { plugin, hooks, get, execute, executeRules, rulesInputs };
}

type V1Client = { session: { get: (input: { path: { id: string } }) => Promise<unknown> } };

async function fixture(stdout = response('rendered context'), rulesStdout = JSON.stringify({ context: RULE_CONTEXT }), client?: V1Client) {
    const execute = vi.fn((_command: string, _args: readonly string[], _options: ExecFileSyncOptionsWithStringEncoding) => stdout);
    const rulesInputs: string[] = [];
    const executeRules = vi.fn(
        (_command: string, _args: readonly string[], _options: object, callback: (error: Error | null, stdout: string) => void) => {
            const stdin = Object.assign(new EventEmitter(), {
                end: (input: string) => {
                    rulesInputs.push(input);
                    callback(null, rulesStdout);
                },
            });
            return { stdin };
        },
    );
    // Exercise the generated hook and call boundary with only the native import replaced.
    const source = renderOpencodePlugin(launcher)
        .replace("import { execFileSync } from 'node:child_process';", '')
        .replace("import { execFile } from 'node:child_process';", '')
        .replace('export default ', 'const ElephaPlugin = ');
    const plugin = runInNewContext(`${source}\nElephaPlugin`, { execFileSync: execute, execFile: executeRules, Buffer }) as {
        server: (input: { directory: string; client?: V1Client }) => Promise<Hooks>;
    };
    return { execute, executeRules, rulesInputs, hooks: await plugin.server({ directory, client }) };
}

// Runs the model-view transform on a single user message.
async function message(hooks: Hooks, prompt: string, sessionID = 'session-a'): Promise<string | undefined> {
    const parts: Part[] = [{ type: 'text', text: prompt }];
    await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { role: 'user', sessionID }, parts }] });
    return parts[0]?.text;
}

describe('generated OpenCode V2 plugin', () => {
    it('loads the default definition and registers every model request kind', async () => {
        const { plugin, hooks } = await v2Fixture();
        expect(plugin.id).toBe('elepha');
        expect([...hooks.keys()]).toEqual(['context', 'compaction', 'generate', 'title']);
    });

    it('rewrites only the outgoing last user message and uses its session directory for both clients', async () => {
        const { hooks, execute, rulesInputs, get } = await v2Fixture();
        const original: V2Message = {
            role: 'user',
            content: [{ type: 'text', text: 'elepha:list' }, { type: 'file' }, { type: 'text', text: 'recent' }],
        };
        const event: V2Event = {
            sessionID: 'v2-session',
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'prior reply' }] }, original],
            system: [
                { type: 'text', text: 'Primary' },
                { type: 'text', text: 'Other plugin' },
            ],
        };
        await hooks.get('context')?.(event);
        expect(get).toHaveBeenCalledWith({ sessionID: 'v2-session' });
        expect(rulesInputs).toEqual([JSON.stringify({ session_id: 'v2-session', cwd: directory })]);
        expect(JSON.parse(execute.mock.calls[0]![2].input as string)).toEqual({
            hook_event_name: 'UserPromptSubmit',
            session_id: 'v2-session',
            cwd: directory,
            prompt: 'elepha:list\nrecent',
        });
        expect(event.system).toEqual([
            { type: 'text', text: `Primary\n\n${RULE_CONTEXT}` },
            { type: 'text', text: 'Other plugin' },
        ]);
        expect(event.messages[1]?.content).toEqual([{ type: 'text', text: 'rendered context' }, { type: 'file' }]);
        expect(original.content).toEqual([{ type: 'text', text: 'elepha:list' }, { type: 'file' }, { type: 'text', text: 'recent' }]);
    });

    it('does not replay a persisted command on a tool-driven continuation', async () => {
        const { hooks, execute } = await v2Fixture();
        const original: V2Message = { role: 'user', content: [{ type: 'text', text: 'elepha:list' }] };
        const event: V2Event = {
            sessionID: 'v2-session',
            messages: [original, { role: 'assistant', content: [{ type: 'text', text: 'tool result' }] }],
            system: [],
        };
        await hooks.get('context')?.(event);
        expect(execute).not.toHaveBeenCalled();
        expect(event.messages[0]).toBe(original);
        expect(event.system).toEqual([{ type: 'text', text: RULE_CONTEXT }]);
    });

    it('sends a display-only command result alone and with no tools', async () => {
        const { hooks, execute } = await v2Fixture(response(DISPLAY_CONTEXT));
        const command: V2Message = { role: 'user', content: [{ type: 'text', text: 'elepha:rules:session:add keep it short' }] };
        const tools = v2Tools();
        const event: V2Event = { sessionID: 'v2-session', messages: [...history(), command], system: [], tools };
        await hooks.get('context')?.(event);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(event.messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: `${DISPLAY_VERBATIM_INSTRUCTIONS}\n🐘 Added chat standing rule.` }] },
        ]);
        expect(event.tools).toBe(tools);
        expect(tools).toEqual({});
        expect(event.system).toEqual([{ type: 'text', text: RULE_CONTEXT }]);
        expect(command.content).toEqual([{ type: 'text', text: 'elepha:rules:session:add keep it short' }]);
    });

    it('keeps history and tools for recap commands, ordinary prompts and failed commands', async () => {
        for (const [stdout, prompt] of [
            [response(RESUME_CONTEXT), 'elepha:resume:1'],
            [response(DISPLAY_CONTEXT), 'ordinary question'],
            ['', 'elepha:list'],
        ] as const) {
            const { hooks } = await v2Fixture(stdout);
            const tools = v2Tools();
            const event: V2Event = {
                sessionID: 'v2-session',
                messages: [...history(), { role: 'user', content: [{ type: 'text', text: prompt }] }],
                system: [],
                tools,
            };
            await hooks.get('context')?.(event);
            expect(event.messages.slice(0, 2)).toEqual(history());
            expect(event.messages).toHaveLength(3);
            expect(event.tools).toBe(tools);
            expect(tools).toEqual(v2Tools());
        }
    });

    it('does not rerun or isolate a persisted display command on continuation', async () => {
        const { hooks, execute } = await v2Fixture(response(DISPLAY_CONTEXT));
        const messages: V2Message[] = [
            ...history(),
            { role: 'user', content: [{ type: 'text', text: 'elepha:rules:session:add keep it short' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'receipt' }] },
        ];
        const tools = v2Tools();
        const event: V2Event = { sessionID: 'v2-session', messages: [...messages], system: [], tools };
        await hooks.get('context')?.(event);
        expect(execute).not.toHaveBeenCalled();
        expect(event.messages).toEqual(messages);
        expect(tools).toEqual(v2Tools());
    });

    it('applies rules to auxiliary model calls without rewriting their messages', async () => {
        const { hooks, execute, rulesInputs } = await v2Fixture();
        for (const kind of ['compaction', 'generate', 'title']) {
            const event: V2Event = {
                sessionID: kind,
                messages: [{ role: 'user', content: [{ type: 'text', text: 'elepha:list' }] }],
                system: [],
            };
            await hooks.get(kind)?.(event);
            expect(event.system).toEqual([{ type: 'text', text: RULE_CONTEXT }]);
            expect(event.messages[0]?.content[0]?.text).toBe('elepha:list');
        }
        expect(rulesInputs.map((input) => JSON.parse(input).session_id)).toEqual(['compaction', 'generate', 'title']);
        expect(execute).not.toHaveBeenCalled();
    });

    it('fails open when session lookup or bounded rules output fails', async () => {
        const { hooks, get, executeRules } = await v2Fixture(response('rendered context'), '{');
        const event: V2Event = {
            sessionID: 'v2-session',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'ordinary text' }] }],
            system: [{ type: 'text', text: 'Primary' }],
        };
        await hooks.get('context')?.(event);
        expect(event.system).toEqual([{ type: 'text', text: 'Primary' }]);
        expect(executeRules).toHaveBeenCalledTimes(1);
        get.mockRejectedValueOnce(new Error('session gone'));
        await hooks.get('context')?.(event);
        expect(executeRules).toHaveBeenCalledTimes(1);
        expect(event.messages[0]?.content[0]?.text).toBe('ordinary text');
    });

    it('does not spawn a rules child for an oversized V2 identity payload', async () => {
        const { hooks, executeRules } = await v2Fixture();
        const event: V2Event = {
            sessionID: 'x'.repeat(HOOK_PAYLOAD_MAX_CHARS),
            messages: [],
            system: [{ type: 'text', text: 'Primary' }],
        };
        await hooks.get('context')?.(event);
        expect(executeRules).not.toHaveBeenCalled();
        expect(event.system).toEqual([{ type: 'text', text: 'Primary' }]);
    });
});

describe('generated OpenCode plugin', () => {
    it('registers model-view and system transforms without a persisted message hook', async () => {
        const { hooks } = await fixture();
        expect(Object.keys(hooks)).toEqual(['experimental.chat.system.transform', 'experimental.chat.messages.transform']);
        expect(renderOpencodePlugin(launcher)).not.toContain("'chat.message':");
    });

    it.each([[], [''], ['Primary system', 'Other plugin', 'Another plugin']])(
        'appends the full rules marker to the primary system entry only: %j',
        async (...entries: string[]) => {
            const { hooks, executeRules, execute, rulesInputs } = await fixture();
            const system = [...entries];
            await hooks['experimental.chat.system.transform']({ sessionID: 'native-system-session' }, { system });
            expect(system).toEqual([entries[0] ? `${entries[0]}\n\n${RULE_CONTEXT}` : RULE_CONTEXT, ...entries.slice(1)]);
            expect(executeRules).toHaveBeenCalledWith(
                launcher,
                [...OPENCODE_RULES_HOOK_ARGS],
                {
                    shell: false,
                    encoding: 'utf8',
                    timeout: INSTALLED_HOOK_TIMEOUT_SECONDS * 1000,
                    killSignal: 'SIGKILL',
                    maxBuffer: OPENCODE_PLUGIN_OUTPUT_MAX_BYTES,
                },
                expect.any(Function),
            );
            expect(rulesInputs).toEqual([JSON.stringify({ session_id: 'native-system-session', cwd: directory })]);
            expect(execute).not.toHaveBeenCalled();
        },
    );

    it.each([undefined, null, '', '  ', 123])('does not invoke the rules client without an actual sessionID: %s', async (sessionID) => {
        const { hooks, executeRules } = await fixture();
        const system = ['Primary'];
        await hooks['experimental.chat.system.transform']({ sessionID }, { system });
        expect(system).toEqual(['Primary']);
        expect(executeRules).not.toHaveBeenCalled();
    });

    it('bounds the serialized identity payload before spawning a rules child', async () => {
        const { hooks, executeRules } = await fixture();
        const system = ['Primary'];
        await hooks['experimental.chat.system.transform']({ sessionID: 'x'.repeat(HOOK_PAYLOAD_MAX_CHARS) }, { system });
        expect(executeRules).not.toHaveBeenCalled();
        expect(system).toEqual(['Primary']);
    });

    it('awaits the asynchronous rules child without blocking or touching the system until it succeeds', async () => {
        const { hooks, executeRules } = await fixture();
        let complete: ((error: Error | null, stdout: string) => void) | undefined;
        executeRules.mockImplementation((_command, _args, _options, callback) => {
            complete = callback;
            return { stdin: Object.assign(new EventEmitter(), { end: vi.fn() }) };
        });
        const system = ['Primary'];
        const pending = hooks['experimental.chat.system.transform']({ sessionID: 'session-a' }, { system });
        // The host parentage lookup settles before the rules child starts.
        await vi.waitFor(() => expect(complete).toBeDefined());
        expect(system).toEqual(['Primary']);
        complete?.(null, JSON.stringify({ context: RULE_CONTEXT }));
        await pending;
        expect(system).toEqual([`Primary\n\n${RULE_CONTEXT}`]);
    });

    it('does not cache sessions or rules across A, B, A requests', async () => {
        const { hooks, rulesInputs } = await fixture();
        for (const sessionID of ['A', 'B', 'A']) {
            const system = ['Primary'];
            await hooks['experimental.chat.system.transform']({ sessionID }, { system });
            expect(system).toEqual([`Primary\n\n${RULE_CONTEXT}`]);
        }
        expect(rulesInputs.map((input) => JSON.parse(input).session_id)).toEqual(['A', 'B', 'A']);
    });

    it.each([
        '',
        '{',
        'null',
        '{}',
        JSON.stringify({ context: '' }),
        response(RULE_CONTEXT),
        JSON.stringify({ context: RULE_CONTEXT, systemMessage: 'wrong channel' }),
        JSON.stringify({ context: wrap('brief', RULE_ID, 'wrong kind') }),
        JSON.stringify({ context: RULE_CONTEXT.slice(0, -1) }),
        JSON.stringify({ context: wrap('rules', RULE_ID, 'x'.repeat(OPENCODE_PLUGIN_OUTPUT_MAX_BYTES)) }),
        JSON.stringify({ context: wrap('rules', RULE_ID, '🙂'.repeat(OPENCODE_PLUGIN_OUTPUT_MAX_BYTES / 4)) }),
    ])('fails open for a malformed, wrong-channel or oversized rules response %#', async (stdout) => {
        const { hooks } = await fixture(undefined, stdout);
        const system = ['Primary', 'Other'];
        await hooks['experimental.chat.system.transform']({ sessionID: 'A' }, { system });
        expect(system).toEqual(['Primary', 'Other']);
    });

    it.each(['error', 'timeout', 'throw', 'stdin'])(
        'fails open on rules child %s without changing other system entries',
        async (failure) => {
            const { hooks, executeRules } = await fixture();
            executeRules.mockImplementation((_command, _args, _options, callback) => {
                if (failure === 'throw') throw new Error('spawn failure');
                const stdin = Object.assign(new EventEmitter(), {
                    end: () => {
                        if (failure === 'stdin') stdin.emit('error', new Error('EPIPE'));
                        else callback(Object.assign(new Error(failure), { code: failure === 'timeout' ? 'ETIMEDOUT' : 'ENOENT' }), '');
                    },
                });
                return { stdin };
            });
            const system = ['Primary', 'Other'];
            await hooks['experimental.chat.system.transform']({ sessionID: 'A' }, { system });
            expect(system).toEqual(['Primary', 'Other']);
        },
    );

    it('transforms only the last user message and is a no-op when fired again', async () => {
        const { hooks, execute } = await fixture();
        const messages: Message[] = [
            { info: { role: 'user', sessionID: 'older' }, parts: [{ type: 'text', text: 'elepha:list' }] },
            { info: { role: 'user', sessionID: 'latest' }, parts: [{ type: 'text', text: 'elepha:info' }] },
            { info: { role: 'assistant', sessionID: 'latest' }, parts: [{ type: 'text', text: 'elepha:help' }] },
        ];
        await hooks['experimental.chat.messages.transform']({}, { messages });
        await hooks['experimental.chat.messages.transform']({}, { messages });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(JSON.parse(execute.mock.calls[0]![2].input as string).session_id).toBe('latest');
        expect(messages.map((entry) => entry.parts[0]?.text)).toEqual(['elepha:list', 'rendered context', 'elepha:help']);
    });

    it('does not replay older commands when the latest user message is ordinary text', async () => {
        const { hooks, execute } = await fixture();
        await hooks['experimental.chat.messages.transform']({}, { messages: [] });
        await hooks['experimental.chat.messages.transform'](
            {},
            {
                messages: [
                    { info: { role: 'user', sessionID: 'same' }, parts: [{ type: 'text', text: 'elepha:list' }] },
                    { info: { role: 'user', sessionID: 'same' }, parts: [{ type: 'text', text: 'continue' }] },
                ],
            },
        );
        expect(execute).not.toHaveBeenCalled();
    });

    it('ignores ordinary text and non-text parts without invoking the binary', async () => {
        const { hooks, execute } = await fixture();
        expect(await message(hooks, 'please explain elepha:list')).toBe('please explain elepha:list');
        const fileOnly: { parts: Part[] } = { parts: [{ type: 'file', text: 'elepha:list' }] };
        await hooks['experimental.chat.messages.transform'](
            {},
            {
                messages: [{ info: { role: 'user', sessionID: 'session-a' }, parts: fileOnly.parts }],
            },
        );
        expect(execute).not.toHaveBeenCalled();
        expect(fileOnly.parts).toEqual([{ type: 'file', text: 'elepha:list' }]);
    });

    it('sends fixed argv and an inert stdin payload, then rewrites the message with the response', async () => {
        const { hooks, execute } = await fixture();
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax is intentionally inert test input.
        const prompt = '  elepha:query `inert` $(inert) ${inert}; | &&\nsecond line';
        const rewritten = await message(hooks, prompt);
        expect(execute).toHaveBeenCalledExactlyOnceWith(launcher, [...OPENCODE_HOOK_ARGS], {
            shell: false,
            input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-a', cwd: directory, prompt }),
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: INSTALLED_HOOK_TIMEOUT_SECONDS * 1000,
            killSignal: 'SIGKILL',
            maxBuffer: OPENCODE_PLUGIN_OUTPUT_MAX_BYTES,
        });
        expect(rewritten).toBe('rendered context');
    });

    it('strips only the brief sentinel wrapper and keeps the full verbatim instruction and payload', async () => {
        const context = `[[elepha:brief:01ABCDEF]]\n${DISPLAY_VERBATIM_INSTRUCTIONS}\n🐘 status line\n[[/elepha]]`;
        const { hooks } = await fixture(response(context));
        const rewritten = await message(hooks, 'elepha:info');
        expect(rewritten).toBe(`${DISPLAY_VERBATIM_INSTRUCTIONS}\n🐘 status line`);
    });

    it('keeps the resume recap instruction while stripping the brief sentinel wrapper', async () => {
        const context = `[[elepha:brief:01ABCDEF]]\n${RESUME_RECAP_INSTRUCTIONS}\n# Session title\n\nSession turns\n[[/elepha]]`;
        const { hooks } = await fixture(response(context));
        expect(await message(hooks, 'elepha:resume:1')).toBe(`${RESUME_RECAP_INSTRUCTIONS}\n# Session title\n\nSession turns`);
    });

    it('joins text parts for the payload and removes extra model-view text parts', async () => {
        const { hooks, execute } = await fixture();
        const output: Message = {
            info: { role: 'user', sessionID: 'session-from-info' },
            parts: [{ type: 'text', text: 'elepha:query' }, { type: 'file' }, { type: 'text', text: 'topic' }],
        };
        await hooks['experimental.chat.messages.transform']({}, { messages: [output] });
        expect(JSON.parse(execute.mock.calls[0]![2].input as string).session_id).toBe('session-from-info');
        expect(JSON.parse(execute.mock.calls[0]![2].input as string).prompt).toBe('elepha:query\ntopic');
        expect(output.parts).toEqual([{ type: 'text', text: 'rendered context' }, { type: 'file' }]);
    });

    it.each(['', '{', 'null', '{}', response(null), response(123), response('')])(
        'fails open for empty or malformed output %s',
        async (stdout) => {
            const { hooks } = await fixture(stdout);
            expect(await message(hooks, 'elepha:list')).toBe('elepha:list');
        },
    );

    it('fails open on binary errors without touching the message', async () => {
        const { hooks, execute } = await fixture();
        execute.mockImplementation(() => {
            throw new Error('binary failed');
        });
        expect(await message(hooks, 'elepha:list')).toBe('elepha:list');
    });

    it('loads the unmodified standalone module and executes both real stdin-only clients', () => {
        const scratch = path.resolve('.test-scratch');
        mkdirSync(scratch, { recursive: true });
        const root = mkdtempSync(path.join(scratch, 'opencode-plugin-runtime-'));
        let cleanupError: unknown;
        try {
            const stub = path.join(root, "elepha 'quoted' launcher");
            writeFileSync(
                stub,
                `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nconst payload = JSON.parse(readFileSync(0, 'utf8'));\nconst argv = process.argv.slice(2);\nconst body = JSON.stringify({argv,payload});\nconsole.log(JSON.stringify(argv[1] === 'standing-rules' ? {context:${JSON.stringify(`[[elepha:rules:${RULE_ID}]]\n`)} + body + ${JSON.stringify('\n[[/elepha]]')}} : {hookSpecificOutput:{additionalContext:body}}));\n`,
                { mode: 0o700 },
            );
            const file = path.join(root, 'elepha.js');
            writeFileSync(file, renderOpencodePlugin(stub));
            const script = `const { default: ElephaPlugin } = await import(${JSON.stringify(pathToFileURL(file).href)});
const hooks = await ElephaPlugin.server({directory:${JSON.stringify(directory)}});
const v2Hooks = {};
await ElephaPlugin.setup({location:{directory:'/wrong/plugin/location'},session:{
    get:async ({sessionID})=>({location:{directory:${JSON.stringify(directory)}}}),
    hook:async (kind,callback)=>{v2Hooks[kind]=callback;},
}});
const original = {role:'user',content:[{type:'text',text:'elepha:list'}]};
const v2Event = {sessionID:'runtime',messages:[original],system:[{type:'text',text:'Primary'},{type:'text',text:'Other plugin'}]};
await v2Hooks.context(v2Event);
const parts = [{type:'text',text:'elepha:list'}];
await hooks['experimental.chat.messages.transform']({}, {messages:[{info:{role:'user',sessionID:'runtime'},parts}]});
const system = ['Primary', 'Other plugin'];
await hooks['experimental.chat.system.transform']({sessionID:'runtime'}, {system});
console.log(JSON.stringify({message:JSON.parse(parts[0].text),system,v2:{message:JSON.parse(v2Event.messages[0].content[0].text),system:v2Event.system,original:original.content[0].text,hooks:Object.keys(v2Hooks)}}));`;
            const rewritten = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', shell: false });
            expect(JSON.parse(rewritten)).toEqual({
                message: {
                    argv: [...OPENCODE_HOOK_ARGS],
                    payload: { hook_event_name: 'UserPromptSubmit', session_id: 'runtime', cwd: directory, prompt: 'elepha:list' },
                },
                system: [
                    `Primary\n\n${wrap('rules', RULE_ID, JSON.stringify({ argv: [...OPENCODE_RULES_HOOK_ARGS], payload: { session_id: 'runtime', cwd: directory } }))}`,
                    'Other plugin',
                ],
                v2: {
                    message: {
                        argv: [...OPENCODE_HOOK_ARGS],
                        payload: { hook_event_name: 'UserPromptSubmit', session_id: 'runtime', cwd: directory, prompt: 'elepha:list' },
                    },
                    system: [
                        {
                            type: 'text',
                            text: `Primary\n\n${wrap('rules', RULE_ID, JSON.stringify({ argv: [...OPENCODE_RULES_HOOK_ARGS], payload: { session_id: 'runtime', cwd: directory } }))}`,
                        },
                        { type: 'text', text: 'Other plugin' },
                    ],
                    original: 'elepha:list',
                    hooks: ['context', 'compaction', 'generate', 'title'],
                },
            });
        } finally {
            try {
                rmSync(root, { recursive: true, force: true });
            } catch (error) {
                // Cleanup is a courtesy; sandbox permissions must not mask
                // the standalone module's execution or assertion result.
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'EPERM' && code !== 'EACCES') cleanupError = error;
            }
        }
        if (cleanupError !== undefined) throw cleanupError;
    });
});

// Host session shapes and whether each proves a top-level chat for 'native'.
const PARENTAGE: Array<[string, unknown, boolean]> = [
    ['root without parentID', { id: 'native' }, true],
    ['root with null parentID', { id: 'native', parentID: null }, true],
    ['child', { id: 'native', parentID: 'parent-chat' }, false],
    ['empty parentID', { id: 'native', parentID: '' }, false],
    ['non-string parentID', { id: 'native', parentID: 7 }, false],
    ['mismatched identity', { id: 'other-chat' }, false],
    ['missing identity', { parentID: null }, false],
    ['array', [], false],
    ['string', 'native', false],
    ['absent', undefined, false],
];

describe('OpenCode chat parentage classification', () => {
    it.each(PARENTAGE)('V1 %s keeps project rules and grants chat authority only to a root', async (_label, session, root) => {
        const get = vi.fn(async (_input: { path: { id: string } }) => ({ data: session }));
        const { hooks, execute, rulesInputs } = await fixture(undefined, undefined, { session: { get } });
        const system = ['Primary', 'Other plugin'];
        await hooks['experimental.chat.system.transform']({ sessionID: 'native' }, { system });
        expect(system).toEqual([`Primary\n\n${RULE_CONTEXT}`, 'Other plugin']);
        expect(rulesInputs.map((input) => JSON.parse(input))).toEqual([
            { session_id: 'native', cwd: directory, ...(root ? { session_root: true } : {}) },
        ]);
        expect(await message(hooks, 'elepha:rules:session', 'native')).toBe('rendered context');
        expect(JSON.parse(execute.mock.calls[0]![2].input as string)).toEqual({
            hook_event_name: 'UserPromptSubmit',
            session_id: 'native',
            cwd: directory,
            prompt: 'elepha:rules:session',
            ...(root ? { session_root: true } : {}),
        });
        expect(get.mock.calls).toEqual([[{ path: { id: 'native' } }], [{ path: { id: 'native' } }]]);
    });

    it('V1 fails closed for chat authority when the host lookup rejects or returns an error result', async () => {
        for (const get of [
            vi.fn(async () => {
                throw new Error('lookup failed');
            }),
            vi.fn(async () => ({ error: { name: 'NotFoundError' } })),
        ]) {
            const { hooks, execute, rulesInputs } = await fixture(undefined, undefined, { session: { get } });
            const system = ['Primary'];
            await hooks['experimental.chat.system.transform']({ sessionID: 'native' }, { system });
            expect(system).toEqual([`Primary\n\n${RULE_CONTEXT}`]);
            expect(rulesInputs).toEqual([JSON.stringify({ session_id: 'native', cwd: directory })]);
            expect(await message(hooks, 'elepha:rules', 'native')).toBe('rendered context');
            expect(JSON.parse(execute.mock.calls[0]![2].input as string)).not.toHaveProperty('session_root');
        }
    });

    it('V1 does not look up parentage for ordinary prompts', async () => {
        const get = vi.fn(async () => ({ data: { id: 'native' } }));
        const { hooks, execute } = await fixture(undefined, undefined, { session: { get } });
        expect(await message(hooks, 'ordinary text', 'native')).toBe('ordinary text');
        expect(get).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    });

    it.each(PARENTAGE)('V2 %s reuses the directory lookup and grants chat authority only to a root', async (_label, session, root) => {
        const { hooks, get, execute, rulesInputs } = await v2Fixture();
        const withDirectory =
            session && typeof session === 'object' && !Array.isArray(session) ? { ...session, location: { directory } } : session;
        get.mockResolvedValue(withDirectory);
        const original: V2Message = { role: 'user', content: [{ type: 'text', text: 'elepha:rules:session' }] };
        const event: V2Event = {
            sessionID: 'native',
            messages: [original],
            system: [
                { type: 'text', text: 'Primary' },
                { type: 'text', text: 'Other plugin' },
            ],
        };
        await hooks.get('context')?.(event);
        expect(get).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledWith({ sessionID: 'native' });
        if (withDirectory === session) {
            // Without a session object there is no native directory to serve.
            expect(rulesInputs).toEqual([]);
            expect(execute).not.toHaveBeenCalled();
            expect(event.messages[0]).toBe(original);
            return;
        }
        expect(rulesInputs.map((input) => JSON.parse(input))).toEqual([
            { session_id: 'native', cwd: directory, ...(root ? { session_root: true } : {}) },
        ]);
        expect(JSON.parse(execute.mock.calls[0]![2].input as string)).toEqual({
            hook_event_name: 'UserPromptSubmit',
            session_id: 'native',
            cwd: directory,
            prompt: 'elepha:rules:session',
            ...(root ? { session_root: true } : {}),
        });
        expect(event.system).toEqual([
            { type: 'text', text: `Primary\n\n${RULE_CONTEXT}` },
            { type: 'text', text: 'Other plugin' },
        ]);
        expect(original.content).toEqual([{ type: 'text', text: 'elepha:rules:session' }]);
    });

    it('V2 auxiliary requests carry the same classification from one lookup each', async () => {
        const { hooks, get, rulesInputs } = await v2Fixture();
        get.mockResolvedValue({ id: 'native', parentID: 'parent-chat', location: { directory } });
        await hooks.get('title')?.({ sessionID: 'native', messages: [], system: [] });
        get.mockResolvedValue({ id: 'native', location: { directory } });
        await hooks.get('compaction')?.({ sessionID: 'native', messages: [], system: [] });
        expect(get).toHaveBeenCalledTimes(2);
        expect(rulesInputs.map((input) => JSON.parse(input))).toEqual([
            { session_id: 'native', cwd: directory },
            { session_id: 'native', cwd: directory, session_root: true },
        ]);
    });
});

describe('OpenCode plugin ownership and health', () => {
    it('distinguishes absent, conflicting, stale launcher, and stale source without executing code', () => {
        expect(opencodePluginStatus(undefined, launcher)).toBe('not installed');
        expect(opencodePluginStatus('', launcher)).toBe('conflict');
        expect(opencodePluginStatus('user plugin', launcher)).toBe('conflict');
        const source = renderOpencodePlugin(launcher);
        expect(opencodePluginStatus(source, launcher)).toBe('installed');
        expect(opencodePluginStatus(source, '/new/launcher')).toBe('stale binary');
        expect(opencodePluginStatus(`${source}\n// old source`, launcher)).toBe('stale plugin');
        expect(transformOpencodePlugin(source, '/new/launcher')).toBe(renderOpencodePlugin('/new/launcher'));
        expect(() => transformOpencodePlugin('', launcher)).toThrow('user-owned');
        expect(() => transformOpencodePlugin('user plugin', launcher)).toThrow('user-owned');
        expect(() => renderOpencodePlugin('relative')).toThrow('absolute path');
    });

    it('requires the plugin only when OpenCode is present', () => {
        const mcp = transformOpencodeMcp('', launcher);
        const status = (source: string | undefined, present = true) =>
            installationStatus('', '', '', '/config.toml', mcp, launcher, { claude: false, codex: false, opencode: present }, source);
        expect(status(undefined).ready).toBe(false);
        expect(status(renderOpencodePlugin('/old/bin')).ready).toBe(false);
        expect(status(renderOpencodePlugin(launcher)).ready).toBe(true);
        expect(status(undefined, false)).toMatchObject({ ready: true, opencodePlugin: 'not present' });
    });
});
