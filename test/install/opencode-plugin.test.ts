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

const launcher = '/opt/elepha with spaces/elepha';
const directory = '/projects/current worktree';
const response = (context: unknown) => JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: context } });

type Part = { type: string; text?: string };
interface Hooks {
    'chat.message': (input: { sessionID: string }, output: { parts: Part[] }) => Promise<void>;
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

// Runs chat.message on a single text part and returns that part's resulting text.
async function message(hooks: Hooks, prompt: string, sessionID = 'session-a'): Promise<string | undefined> {
    const parts: Part[] = [{ type: 'text', text: prompt }];
    await hooks['chat.message']({ sessionID }, { parts });
    return parts[0]?.text;
}

describe('generated OpenCode plugin', () => {
    it('ignores ordinary text and non-text parts without invoking the binary', async () => {
        const { hooks, execute } = await fixture();
        expect(await message(hooks, 'please explain elepha:list')).toBe('please explain elepha:list');
        const fileOnly: { parts: Part[] } = { parts: [{ type: 'file', text: 'elepha:list' }] };
        await hooks['chat.message']({ sessionID: 'session-a' }, fileOnly);
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

    it('strips the brief sentinel wrapper, keeping the inner instructions and payload', async () => {
        const context =
            '[[elepha:brief:01ABCDEF]]\nDisplay everything below this line to the user exactly as written.\n🐘 status line\n[[/elepha]]';
        const { hooks } = await fixture(response(context));
        expect(await message(hooks, 'elepha:info')).toBe(
            'Display everything below this line to the user exactly as written.\n🐘 status line',
        );
    });

    it('joins text parts for the payload and rewrites only the first text part', async () => {
        const { hooks, execute } = await fixture();
        const output: { parts: Part[] } = {
            parts: [{ type: 'text', text: 'elepha:query' }, { type: 'file' }, { type: 'text', text: 'topic' }],
        };
        await hooks['chat.message']({ sessionID: 'session-a' }, output);
        expect(JSON.parse(execute.mock.calls[0]![2].input as string).prompt).toBe('elepha:query\ntopic');
        expect(output.parts).toEqual([{ type: 'text', text: 'rendered context' }, { type: 'file' }, { type: 'text', text: 'topic' }]);
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
await hooks['chat.message']({sessionID:'runtime'}, {parts});
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
            installationStatus('', '', '', '/config.toml', mcp, launcher, { claude: false, codex: false, opencode: present }, source);
        expect(status(undefined).ready).toBe(false);
        expect(status(renderOpencodePlugin('/old/bin')).ready).toBe(false);
        expect(status(renderOpencodePlugin(launcher)).ready).toBe(true);
        expect(status(undefined, false)).toMatchObject({ ready: true, opencodePlugin: 'not present' });
    });
});
