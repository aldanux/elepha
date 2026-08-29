import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { transformClaudeHook, transformCodexHook } from '../../src/hooks/installer.js';
import { hookCommand } from '../../src/install/binary.js';
import {
    CODEX_ADDITIONAL_CONTEXT_LIMIT,
    CODEX_SESSION_START_BEGIN,
    CODEX_SESSION_START_END,
    CODEX_SESSION_START_HOOK_TABLE,
    CODEX_SESSION_START_TABLE,
    CODEX_USER_PROMPT_SUBMIT_BEGIN,
    CODEX_USER_PROMPT_SUBMIT_END,
    CODEX_USER_PROMPT_SUBMIT_HOOK_TABLE,
    CODEX_USER_PROMPT_SUBMIT_TABLE,
} from '../../src/install/markers.js';

const bin = '/opt/npm/bin/elepha';

describe('global hook transforms', () => {
    it('installs exactly one Claude handler and preserves its sibling handler', () => {
        const input = JSON.stringify({
            hooks: {
                SessionStart: [
                    {
                        matcher: 'all',
                        hooks: [
                            { type: 'command', command: 'keep' },
                            { type: 'command', command: 'elepha hook session-start --tool claude-code' },
                        ],
                    },
                ],
            },
        });
        const installed = transformClaudeHook(input, bin);
        const groups = (JSON.parse(installed) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } }).hooks
            .SessionStart;
        expect(groups.flatMap((group) => group.hooks).map((handler) => handler.command)).toContain('keep');
        expect(
            groups.flatMap((group) => group.hooks).filter((handler) => handler.command === hookCommand(bin, 'claude-code')),
        ).toHaveLength(1);
        const removed = transformClaudeHook(installed, bin, true);
        expect(removed).toContain('keep');
        expect(removed).not.toContain('session-start --tool claude-code');
    });

    it('writes PascalCase Codex hooks in an owned block without creating hooks.json', () => {
        const installed = transformCodexHook('# retain\n[unrelated]\nvalue = true\n', bin);
        expect(installed).toContain('# retain');
        expect(installed).toContain(CODEX_SESSION_START_TABLE);
        expect(installed).toContain(CODEX_ADDITIONAL_CONTEXT_LIMIT);
        expect(installed).toContain(hookCommand(bin, 'codex'));
        expect(transformCodexHook(installed, bin)).toBe(installed);
        expect(transformCodexHook(installed, bin, true)).not.toContain('session-start --tool codex');
    });

    it('adds and removes an independent UserPromptSubmit hook without disturbing SessionStart', () => {
        const claudeInstalled = transformClaudeHook(
            JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'keep-start' }] }] } }),
            bin,
        );
        const claudeHooks = (JSON.parse(claudeInstalled) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }).hooks;
        expect(claudeHooks.SessionStart.flatMap((group) => group.hooks).map((handler) => handler.command)).toContain('keep-start');
        expect(claudeHooks.UserPromptSubmit.flatMap((group) => group.hooks).map((handler) => handler.command)).toContain(
            hookCommand(bin, 'claude-code', 'user-prompt-submit'),
        );
        const claudeRemoved = transformClaudeHook(claudeInstalled, bin, true);
        expect(claudeRemoved).toContain('keep-start');
        expect(claudeRemoved).not.toContain('user-prompt-submit --tool claude-code');

        const codexInstalled = transformCodexHook('# preserve\n', bin);
        expect(codexInstalled).toContain(CODEX_SESSION_START_BEGIN);
        expect(codexInstalled).toContain(CODEX_USER_PROMPT_SUBMIT_BEGIN);
        expect(codexInstalled).toContain(CODEX_USER_PROMPT_SUBMIT_TABLE);
        expect(codexInstalled).toContain(hookCommand(bin, 'codex', 'user-prompt-submit'));
        const codexRemoved = transformCodexHook(codexInstalled, bin, true);
        expect(codexRemoved).toContain('# preserve');
        expect(codexRemoved).not.toContain('elepha-user-prompt-submit');
        expect(codexRemoved).not.toContain('session-start --tool codex');
    });

    it('refuses malformed or noncanonical user-owned Codex hook definitions', () => {
        expect(() => transformCodexHook('[broken', bin)).toThrow('malformed');
        expect(() =>
            transformCodexHook(
                `${CODEX_SESSION_START_TABLE}\nmatcher = "x"\n${CODEX_SESSION_START_HOOK_TABLE}\ncommand = "elepha hook session-start --tool codex --different"\n`,
                bin,
            ),
        ).toThrow('conflicting');
    });

    it('removes a complete indented elepha trust-state table without corrupting its predecessor', () => {
        const configPath = '/tmp/config.toml';
        const input = `[prior]
trusted_hash = "one"
    [hooks.state."${configPath}:session_start:0:0"]
trusted_hash = "two"
${CODEX_SESSION_START_BEGIN}
${CODEX_SESSION_START_END}
`;

        const removed = transformCodexHook(input, bin, true, configPath);

        expect(removed).toBe('[prior]\ntrusted_hash = "one"\n');
        expect(removed).not.toContain('session_start:0:0');
        expect(removed.match(/trusted_hash/g) ?? []).toHaveLength(1);
        expect(parse(removed)).toEqual({ prior: { trusted_hash: 'one' } });
    });

    it('rekeys later SessionStart trust-state sections and keeps their leading comments', () => {
        const configPath = '/tmp/config.toml';
        const input = `${CODEX_SESSION_START_TABLE}
matcher = "before"
${CODEX_SESSION_START_HOOK_TABLE}
command = "before"

${CODEX_SESSION_START_BEGIN}
${CODEX_SESSION_START_TABLE}
matcher = "startup|clear|resume|compact"
${CODEX_SESSION_START_HOOK_TABLE}
command = "${hookCommand(bin, 'codex')}"
${CODEX_SESSION_START_END}

${CODEX_SESSION_START_TABLE}
matcher = "after"
${CODEX_SESSION_START_HOOK_TABLE}
command = "after"

[hooks.state."${configPath}:session_start:1:0"]
trusted_hash = "owned"
# comment for the following trust-state table
[hooks.state."${configPath}:session_start:2:0"]
trusted_hash = "later"
`;

        const removed = transformCodexHook(input, bin, true, configPath);

        expect(removed).not.toContain('trusted_hash = "owned"');
        expect(removed).toContain('# comment for the following trust-state table');
        expect(removed).toContain(`[hooks.state."${configPath}:session_start:1:0"]\ntrusted_hash = "later"`);
        expect(parse(removed)).toBeDefined();
    });

    it('rekeys later UserPromptSubmit trust-state sections in their own event namespace', () => {
        const configPath = '/tmp/config.toml';
        const input = `${CODEX_USER_PROMPT_SUBMIT_BEGIN}
${CODEX_USER_PROMPT_SUBMIT_TABLE}
${CODEX_USER_PROMPT_SUBMIT_HOOK_TABLE}
command = "${hookCommand(bin, 'codex', 'user-prompt-submit')}"
${CODEX_USER_PROMPT_SUBMIT_END}

${CODEX_USER_PROMPT_SUBMIT_TABLE}
${CODEX_USER_PROMPT_SUBMIT_HOOK_TABLE}
command = "after"

[hooks.state."${configPath}:user_prompt_submit:0:0"]
trusted_hash = "owned"
[hooks.state."${configPath}:user_prompt_submit:1:0"]
trusted_hash = "later"
`;

        const removed = transformCodexHook(input, bin, true, configPath);

        expect(removed).not.toContain('trusted_hash = "owned"');
        expect(removed).toContain(`[hooks.state."${configPath}:user_prompt_submit:0:0"]\ntrusted_hash = "later"`);
        expect(removed).not.toContain(':session_start:');
        expect(parse(removed)).toBeDefined();
    });
});
