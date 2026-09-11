import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INSTALLED_HOOK_TIMEOUT_SECONDS } from '../../src/config/constants.js';
import {
    DEEPSEEK_HOOKS_BRIDGE,
    deepSeekCommandsStatus,
    deepSeekHooksPatchStatus,
    deepSeekHooksPath,
    ownsDeepSeekHooks,
    renderDeepSeekHooks,
    transformDeepSeekHooksPatch,
} from '../../src/install/deepseek-hooks.js';
import {
    DEEPSEEK_SESSION_START_HOOK_ARGS,
    DEEPSEEK_USER_PROMPT_SUBMIT_HOOK_ARGS,
    renderDeepSeekHookClient,
} from '../../src/security/subprocess-allowlist.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const launcher = "/opt/elepha's installed launcher";
const patchPath = '/home/user/.dsh/cordis.patch.yml';
const hooksPath = deepSeekHooksPath(patchPath);

describe('DeepSeek Harness Claude hook bridge registration', () => {
    it('owns one idempotent patch block pointing at the generated hooks file', () => {
        const source = '- insert:\n    - id: user-plugin\n      name: /opt/user/plugin.js\n      config: {}\n';
        const rendered = transformDeepSeekHooksPatch(source, hooksPath);

        expect(transformDeepSeekHooksPatch(rendered, hooksPath)).toBe(rendered);
        expect(deepSeekHooksPatchStatus(rendered, hooksPath)).toBe('active');
        expect(parse(rendered)).toEqual([
            ...parse(source),
            {
                insert: [
                    {
                        id: 'elepha-commands',
                        name: DEEPSEEK_HOOKS_BRIDGE,
                        config: { configPath: hooksPath },
                    },
                ],
            },
        ]);
        expect(rendered).not.toContain('projectDir');
        expect(transformDeepSeekHooksPatch(rendered, hooksPath, true)).toBe(source);
    });

    it('reports stale owned bridge config and rejects user-owned conflicts', () => {
        const migrated = transformDeepSeekHooksPatch('[]\n', hooksPath);
        expect(deepSeekHooksPatchStatus(migrated.replace(hooksPath, '/old/hooks.json'), hooksPath)).toBe('stale bridge');

        const conflict = '- insert:\n    - id: elepha-commands\n      name: /user/plugin.js\n';
        expect(deepSeekHooksPatchStatus(conflict, hooksPath)).toBe('conflict');
        expect(() => transformDeepSeekHooksPatch(conflict, hooksPath)).toThrow('conflicting user-owned');
        expect(deepSeekHooksPatchStatus('# elepha-deepseek-hooks: begin\n[]\n', hooksPath)).toBe('invalid');
    });
});

describe('DeepSeek Harness owned Claude-format hooks.json', () => {
    it('registers SessionStart and UserPromptSubmit through fixed allowlisted clients', () => {
        const source = renderDeepSeekHooks(launcher);
        const config = JSON.parse(source) as {
            elephaManaged: string;
            hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
        };

        expect(ownsDeepSeekHooks(source)).toBe(true);
        expect(config.elephaManaged).toBe('elepha-managed-deepseek-hooks: v1');
        expect(config.hooks.SessionStart?.[0]?.matcher).toBe('startup|clear|resume|compact');
        expect(config.hooks.SessionStart?.[0]?.hooks[0]).toEqual({
            type: 'command',
            command: expect.any(String),
            timeout: INSTALLED_HOOK_TIMEOUT_SECONDS,
        });
        expect(config.hooks.UserPromptSubmit?.[0]?.hooks[0]).toEqual({
            type: 'command',
            command: expect.any(String),
            timeout: INSTALLED_HOOK_TIMEOUT_SECONDS,
        });
        expect(deepSeekCommandsStatus(transformDeepSeekHooksPatch('[]\n', hooksPath), patchPath, launcher, source)).toBe('active');
        expect(deepSeekCommandsStatus(transformDeepSeekHooksPatch('[]\n', hooksPath), patchPath, launcher, undefined)).toBe('stale hooks');
        expect(deepSeekCommandsStatus('[]\n', patchPath, launcher, undefined)).toBe('not installed');
        expect(deepSeekCommandsStatus('[]\n', patchPath, launcher, '{}')).toBe('conflict');
    });

    it('renders fixed shell:false launcher invocations and preserves protocol streams and status', () => {
        const sessionStart = renderDeepSeekHookClient(launcher, 'session-start');
        const userPrompt = renderDeepSeekHookClient(launcher, 'user-prompt-submit');

        expect(sessionStart).toContain(`spawnSync(${JSON.stringify(launcher)}, ${JSON.stringify(DEEPSEEK_SESSION_START_HOOK_ARGS)}`);
        expect(userPrompt).toContain(`spawnSync(${JSON.stringify(launcher)}, ${JSON.stringify(DEEPSEEK_USER_PROMPT_SUBMIT_HOOK_ARGS)}`);
        for (const client of [sessionStart, userPrompt]) {
            expect(client).toContain('shell: false');
            expect(client).toContain("input,\n    encoding: 'utf8'");
            expect(client).toContain('process.stdout.write(result.stdout)');
            expect(client).toContain('process.stderr.write(result.stderr)');
            expect(client).toContain('process.exitCode = result.status');
            expect(client).not.toContain('cwd:');
        }
        expect(() => renderDeepSeekHookClient('relative', 'session-start')).toThrow('absolute');
    });

    it('passes DSH payload only on stdin and preserves an exit-2 verbatim display reason', () => {
        const directory = withGrantableTestDir('deepseek-hook-client-');
        const fakeLauncher = path.join(directory, 'elepha');
        writeFileSync(
            fakeLauncher,
            `#!/usr/bin/env node
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify([...DEEPSEEK_USER_PROMPT_SUBMIT_HOOK_ARGS]))}) process.exit(9);
process.stderr.write(input);
process.exitCode = 2;
`,
        );
        chmodSync(fakeLauncher, 0o700);
        const payload = JSON.stringify({
            session_id: 'session-1',
            cwd: '/untrusted/$(inert)',
            hook_event_name: 'UserPromptSubmit',
            prompt: 'elepha:query ; && | $(inert)',
        });

        const result = spawnSync(
            process.execPath,
            ['--input-type=module', '-e', renderDeepSeekHookClient(fakeLauncher, 'user-prompt-submit')],
            {
                input: payload,
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(payload);
    });
});
