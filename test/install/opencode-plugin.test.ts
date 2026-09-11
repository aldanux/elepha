import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { INSTALLED_HOOK_TIMEOUT_SECONDS, OPENCODE_PLUGIN_OUTPUT_MAX_BYTES } from '../../src/config/constants.js';
import { opencodePluginStatus, renderOpencodePlugin, transformOpencodePlugin } from '../../src/install/opencode-plugin.js';
import { installationStatus } from '../../src/install/status.js';
import { transformOpencodeMcp } from '../../src/mcp/installer.js';
import { OPENCODE_HOOK_ARGS } from '../../src/security/subprocess-allowlist.js';
import { DISPLAY_VERBATIM_INSTRUCTIONS, RESUME_RECAP_INSTRUCTIONS } from '../../src/serving/instructions.js';

const launcher = '/opt/elepha with spaces/elepha';
const directory = '/projects/current worktree';
const response = (context: unknown) => JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: context } });

type Part = { type: string; text?: string };
type Message = { info: { role: string; sessionID: string }; parts: Part[] };
interface Hooks {
    'experimental.chat.messages.transform': (input: object, output: { messages: Message[] }) => Promise<void>;
}

async function fixture(stdout = response('rendered context')) {
    const execute = vi.fn((_command: string, _args: readonly string[], _options: ExecFileSyncOptionsWithStringEncoding) => stdout);
    // Exercise the generated hook and call boundary with only the native import replaced.
    const source = renderOpencodePlugin(launcher)
        .replace("import { execFileSync } from 'node:child_process';", '')
        .replace('export const ElephaPlugin =', 'const ElephaPlugin =');
    const plugin = runInNewContext(`${source}\nElephaPlugin`, { execFileSync: execute }) as (input: {
        directory: string;
    }) => Promise<Hooks>;
    return { execute, hooks: await plugin({ directory }) };
}

// Runs the model-view transform on a single user message.
async function message(hooks: Hooks, prompt: string, sessionID = 'session-a'): Promise<string | undefined> {
    const parts: Part[] = [{ type: 'text', text: prompt }];
    await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { role: 'user', sessionID }, parts }] });
    return parts[0]?.text;
}

describe('generated OpenCode plugin', () => {
    it('registers only the model-view hook', async () => {
        const { hooks } = await fixture();
        expect(Object.keys(hooks)).toEqual(['experimental.chat.messages.transform']);
        expect(renderOpencodePlugin(launcher)).not.toContain("'chat.message':");
    });

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

    it('loads the unmodified standalone module and executes a real stdin-only client', () => {
        const scratch = path.resolve('.test-scratch');
        mkdirSync(scratch, { recursive: true });
        const root = mkdtempSync(path.join(scratch, 'opencode-plugin-runtime-'));
        try {
            const stub = path.join(root, "elepha 'quoted' launcher");
            writeFileSync(
                stub,
                `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nconst payload = JSON.parse(readFileSync(0, 'utf8'));\nconsole.log(JSON.stringify({hookSpecificOutput:{additionalContext:JSON.stringify({argv:process.argv.slice(2),payload})}}));\n`,
                { mode: 0o700 },
            );
            const file = path.join(root, 'elepha.js');
            writeFileSync(file, renderOpencodePlugin(stub));
            const script = `const { ElephaPlugin } = await import(${JSON.stringify(pathToFileURL(file).href)});
const hooks = await ElephaPlugin({directory:${JSON.stringify(directory)}});
const parts = [{type:'text',text:'elepha:list'}];
await hooks['experimental.chat.messages.transform']({}, {messages:[{info:{role:'user',sessionID:'runtime'},parts}]});
console.log(parts[0].text);`;
            const rewritten = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', shell: false });
            expect(JSON.parse(rewritten)).toEqual({
                argv: [...OPENCODE_HOOK_ARGS],
                payload: { hook_event_name: 'UserPromptSubmit', session_id: 'runtime', cwd: directory, prompt: 'elepha:list' },
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
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
            installationStatus(
                '',
                '',
                '',
                '/config.toml',
                mcp,
                launcher,
                { claude: false, codex: false, deepseek: false, opencode: present, kimi: false },
                source,
            );
        expect(status(undefined).ready).toBe(false);
        expect(status(renderOpencodePlugin('/old/bin')).ready).toBe(false);
        expect(status(renderOpencodePlugin(launcher)).ready).toBe(true);
        expect(status(undefined, false)).toMatchObject({ ready: true, opencodePlugin: 'not present' });
    });
});
