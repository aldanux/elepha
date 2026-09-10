import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { parse, stringify } from 'smol-toml';
import { describe, expect, it, vi } from 'vitest';
import { HOOK_PAYLOAD_MAX_CHARS, INSTALLED_HOOK_TIMEOUT_SECONDS, KIMI_HOOK_OUTPUT_MAX_BYTES } from '../../src/config/constants.js';
import { kimiOutput } from '../../src/hooks/kimi.js';
import { KIMI_HOOK_EVENT, KIMI_HOOK_MATCHER, kimiHookStatus, transformKimiHook } from '../../src/install/kimi-hook.js';
import { CLOSE, OPEN, wrap } from '../../src/security/sentinel.js';
import { KIMI_HOOK_ARGS, renderKimiHookClient, renderKimiHookCommand } from '../../src/security/subprocess-allowlist.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const launcher = "/opt/elepha's installed launcher";
const other = { event: 'UserPromptSubmit', matcher: '^other:', command: 'notify-elepha-status', timeout: 9 };

describe('Kimi TOML hook registration', () => {
    it('registers only the native prompt hook and preserves other hooks and config', () => {
        const original = { model: 'user-model', hooks: [other, { event: 'SessionStart', command: 'startup' }] };
        const rendered = transformKimiHook(stringify(original), launcher);
        expect(parse(rendered)).toEqual({
            ...original,
            hooks: [
                ...original.hooks,
                {
                    event: KIMI_HOOK_EVENT,
                    matcher: KIMI_HOOK_MATCHER,
                    command: renderKimiHookCommand(launcher),
                    timeout: INSTALLED_HOOK_TIMEOUT_SECONDS,
                },
            ],
        });
        const commented = `# user comment\n${rendered}`;
        expect(transformKimiHook(commented, launcher)).toBe(commented);
        expect(kimiHookStatus(commented, launcher)).toBe('active');
        expect(parse(transformKimiHook(rendered, launcher, true))).toEqual(original);
    });

    it('updates only owned hooks and removes only those hooks after later user edits', () => {
        const source = transformKimiHook(stringify({ hooks: [other] }), '/old/elepha');
        expect(kimiHookStatus(source, launcher)).toBe('stale hook');
        const parsed = parse(source);
        (parsed.hooks as unknown[]).push({ event: 'Stop', command: 'later' });
        const current = transformKimiHook(stringify(parsed), launcher);
        expect(kimiHookStatus(current, launcher)).toBe('active');
        expect(parse(transformKimiHook(current, launcher, true))).toEqual({ hooks: [other, { event: 'Stop', command: 'later' }] });
    });

    it('refuses unowned command conflicts and malformed hook containers without taking ownership', () => {
        const source = stringify({ hooks: [{ event: KIMI_HOOK_EVENT, matcher: KIMI_HOOK_MATCHER, command: 'user-wrapper' }] });
        expect(kimiHookStatus(source, launcher)).toBe('conflict');
        expect(() => transformKimiHook(source, launcher)).toThrow('conflicting user-owned');
        expect(transformKimiHook(source, launcher, true)).toBe(source);
        for (const invalid of ['[hooks]\ncommand="user"', 'hooks = [1]', '[']) {
            expect(kimiHookStatus(invalid, launcher)).toBe('invalid');
            expect(() => transformKimiHook(invalid, launcher)).toThrow();
        }
    });

    it('does not treat hook-looking text inside TOML strings as a registration', () => {
        const source = stringify({ notes: '[[hooks]]\nevent = "UserPromptSubmit"\nmatcher = "^elepha:"' });
        expect(kimiHookStatus(source, launcher)).toBe('not installed');
        expect(parse(transformKimiHook(source, launcher)).notes).toBe(parse(source).notes);
    });
});

async function client(input: string, execute = vi.fn(() => 'response')) {
    const write = vi.fn();
    const source = renderKimiHookClient(launcher)
        .replace("import { execFileSync } from 'node:child_process';", '')
        .replace('await runHook().catch', 'runHook().catch');
    await runInNewContext(source, { execFileSync: execute, process: { stdin: Readable.from([input]), stdout: { write } } });
    return { execute, write };
}

describe('Kimi allowlisted client', () => {
    it('exits successfully with structured denial and forwards only the recorded display body', () => {
        const root = withGrantableTestDir('kimi-client-denial-');
        const stub = path.join(root, 'launcher');
        const output = kimiOutput(wrap('brief', '01J00000000000000000000000', 'Recorded command payload'), { kind: 'info' });
        writeFileSync(stub, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(output))});\n`, { mode: 0o700 });
        // execFileSync throws on nonzero exit; the outer client must preserve the
        // exit-0 structured denial that Kimi maps to block without a model call.
        const stdout = execFileSync('/bin/sh', ['-c', renderKimiHookCommand(stub)], {
            shell: false,
            cwd: root,
            input: '{}',
            encoding: 'utf8',
        });
        expect(JSON.parse(stdout)).toEqual({
            hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Recorded command payload' },
        });
        expect(stdout).not.toContain(OPEN);
        expect(stdout).not.toContain(CLOSE);
    });

    it('uses fixed argv, shell false, bounded execution, and stdin-only event data', async () => {
        const input = JSON.stringify({
            session_id: '$(inert)',
            cwd: '/untrusted/`inert`',
            prompt: [{ type: 'text', text: 'elepha:query ; && | $(inert)' }],
        });
        const { execute, write } = await client(input);
        expect(execute).toHaveBeenCalledExactlyOnceWith(launcher, [...KIMI_HOOK_ARGS], {
            shell: false,
            input,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: INSTALLED_HOOK_TIMEOUT_SECONDS * 1000,
            killSignal: 'SIGKILL',
            maxBuffer: KIMI_HOOK_OUTPUT_MAX_BYTES,
        });
        expect(write).toHaveBeenCalledExactlyOnceWith('response');
    });

    it('fails open without forwarding partial output on error or oversized input', async () => {
        const oversized = await client('x'.repeat(HOOK_PAYLOAD_MAX_CHARS + 1));
        expect(oversized.execute).not.toHaveBeenCalled();
        expect(oversized.write).not.toHaveBeenCalled();
        const failed = await client(
            '{}',
            vi.fn(() => {
                throw Object.assign(new Error('timeout'), { stdout: 'partial' });
            }),
        );
        expect(failed.write).not.toHaveBeenCalled();
        expect(() => renderKimiHookClient('relative')).toThrow('absolute');
    });

    it('executes the exact configured shell command with quoted installation paths and inert payload', () => {
        const root = withGrantableTestDir('kimi-client-runtime-');
        const stub = path.join(root, "elepha 'quoted' $(touch injected) `touch injected` launcher");
        writeFileSync(
            stub,
            `#!/usr/bin/env node\nlet input=''; for await (const chunk of process.stdin) input+=chunk; process.stdout.write(JSON.stringify({argv:process.argv.slice(2),input:JSON.parse(input)}));\n`,
            { mode: 0o700 },
        );
        const input = {
            session_id: '$(touch injected)',
            cwd: '`touch injected`',
            prompt: [{ type: 'text', text: 'elepha:query $(touch injected)' }],
        };
        // Reproduce Kimi's outer shell; the generated client must keep all data on stdin.
        const stdout = execFileSync('/bin/sh', ['-c', renderKimiHookCommand(stub)], {
            shell: false,
            cwd: root,
            input: JSON.stringify(input),
            encoding: 'utf8',
        });
        expect(JSON.parse(stdout)).toEqual({ argv: [...KIMI_HOOK_ARGS], input });
        expect(existsSync(path.join(root, 'injected'))).toBe(false);
    });
});
