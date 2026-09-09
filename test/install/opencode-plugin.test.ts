import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    INSTALLED_HOOK_TIMEOUT_SECONDS,
    OPENCODE_PLUGIN_MAX_PENDING_SESSIONS,
    OPENCODE_PLUGIN_OUTPUT_MAX_BYTES,
} from '../../src/config/constants.js';
import { OPENCODE_PLUGIN_DROPPED_CONTEXT } from '../../src/install/markers.js';
import { opencodePluginStatus, renderOpencodePlugin, transformOpencodePlugin } from '../../src/install/opencode-plugin.js';
import { installationStatus } from '../../src/install/status.js';
import { transformOpencodeMcp } from '../../src/mcp/installer.js';
import { OPENCODE_HOOK_ARGS } from '../../src/security/subprocess-allowlist.js';

const launcher = '/opt/elepha with spaces/elepha';
const directory = '/projects/current worktree';
const response = (context: unknown) => JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: context } });

interface Hooks {
    'chat.message': (input: { sessionID: string }, output: { parts: { type: string; text?: string }[] }) => Promise<void>;
    'experimental.chat.system.transform': (input: { sessionID?: string }, output: { system: string[] }) => Promise<void>;
}

async function fixture(stdout = response('rendered context')) {
    const execute = vi.fn((_command: string, _args: readonly string[], _options: ExecFileSyncOptionsWithStringEncoding) => stdout);
    // Exercise the generated hooks and call boundary with only the native import replaced.
    const source = renderOpencodePlugin(launcher)
        .replace("import { execFileSync } from 'node:child_process';", '')
        .replace('export const ElephaPlugin =', 'const ElephaPlugin =');
    const plugin = runInNewContext(`${source}\nElephaPlugin`, { execFileSync: execute }) as (input: {
        directory: string;
    }) => Promise<Hooks>;
    return { execute, hooks: await plugin({ directory }) };
}

async function message(hooks: Hooks, prompt: string, sessionID = 'session-a') {
    await hooks['chat.message']({ sessionID }, { parts: [{ type: 'text', text: prompt }] });
}

async function transform(hooks: Hooks, sessionID: string | undefined = 'session-a') {
    const output = { system: ['existing system'] };
    await hooks['experimental.chat.system.transform']({ sessionID }, output);
    return output.system;
}

describe('generated OpenCode plugin', () => {
    it('ignores ordinary text and non-text parts without invoking the binary', async () => {
        const { hooks, execute } = await fixture();
        await message(hooks, 'please explain elepha:list');
        await hooks['chat.message']({ sessionID: 'session-a' }, { parts: [{ type: 'file', text: 'elepha:list' }] });
        expect(execute).not.toHaveBeenCalled();
        expect(await transform(hooks)).toEqual(['existing system']);
    });

    it('sends fixed argv and an inert stdin payload, then injects once into the matching session', async () => {
        const { hooks, execute } = await fixture();
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax is intentionally inert test input.
        const prompt = '  elepha:query `inert` $(inert) ${inert}; | &&\nsecond line';
        await message(hooks, prompt);
        expect(execute).toHaveBeenCalledExactlyOnceWith(launcher, [...OPENCODE_HOOK_ARGS], {
            shell: false,
            input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-a', cwd: directory, prompt }),
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: INSTALLED_HOOK_TIMEOUT_SECONDS * 1000,
            killSignal: 'SIGKILL',
            maxBuffer: OPENCODE_PLUGIN_OUTPUT_MAX_BYTES,
        });
        expect(await transform(hooks, 'other-session')).toEqual(['existing system']);
        const noSession = { system: [] as string[] };
        await hooks['experimental.chat.system.transform']({}, noSession);
        expect(noSession.system).toEqual([]);
        expect(await transform(hooks)).toEqual(['existing system', 'rendered context']);
        expect(await transform(hooks)).toEqual(['existing system']);
    });

    it('joins text parts and leaves the original message untouched', async () => {
        const { hooks, execute } = await fixture();
        const output = { parts: [{ type: 'text', text: 'elepha:query' }, { type: 'file' }, { type: 'text', text: 'topic' }] };
        const original = structuredClone(output);
        await hooks['chat.message']({ sessionID: 'session-a' }, output);
        expect(JSON.parse(execute.mock.calls[0]![2].input as string).prompt).toBe('elepha:query\ntopic');
        expect(output).toEqual(original);
    });

    it.each(['', '{', 'null', '{}', response(null), response(123), response('')])(
        'fails open for empty or malformed output %s',
        async (stdout) => {
            const { hooks } = await fixture(stdout);
            await expect(message(hooks, 'elepha:list')).resolves.toBeUndefined();
            expect(await transform(hooks)).toEqual(['existing system']);
        },
    );

    it('fails open on binary errors and clears abandoned context before the next message', async () => {
        const { hooks, execute } = await fixture();
        await message(hooks, 'elepha:list');
        execute.mockImplementation(() => {
            throw new Error('binary failed');
        });
        await expect(message(hooks, 'elepha:list')).resolves.toBeUndefined();
        expect(await transform(hooks)).toEqual(['existing system']);
        execute.mockReturnValue(response('abandoned'));
        await message(hooks, 'elepha:list');
        await message(hooks, 'ordinary message');
        expect(await transform(hooks)).toEqual(['existing system']);
    });

    it('evicts the oldest abandoned context at the retention limit and names the drop', async () => {
        const { hooks } = await fixture();
        for (let index = 0; index <= OPENCODE_PLUGIN_MAX_PENDING_SESSIONS; index++) {
            await message(hooks, 'elepha:list', `session-${index}`);
        }
        expect(await transform(hooks, 'session-0')).toEqual(['existing system']);
        expect(await transform(hooks, `session-${OPENCODE_PLUGIN_MAX_PENDING_SESSIONS}`)).toEqual([
            'existing system',
            `${OPENCODE_PLUGIN_DROPPED_CONTEXT}\nrendered context`,
        ]);
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
await hooks['chat.message']({sessionID:'runtime'}, {parts:[{type:'text',text:'elepha:list'}]});
const output = {system:[]};
await hooks['experimental.chat.system.transform']({sessionID:'runtime'}, output);
console.log(JSON.stringify(output));`;
            const output = JSON.parse(
                execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', shell: false }),
            );
            expect(JSON.parse(output.system[0])).toEqual({
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
