import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
    runSessionStartCli: vi.fn(async () => undefined),
    runUserPromptSubmitCli: vi.fn(async () => undefined),
    runStandingRulesHookCli: vi.fn(async () => undefined),
}));

vi.mock('../../src/hooks/session-start.js', () => ({ runSessionStartCli: hooks.runSessionStartCli }));
vi.mock('../../src/hooks/user-prompt-submit.js', () => ({ runUserPromptSubmitCli: hooks.runUserPromptSubmitCli }));
vi.mock('../../src/hooks/standing-rules.js', () => ({ runStandingRulesHookCli: hooks.runStandingRulesHookCli }));

import { registerHook } from '../../src/cli/commands/hook.js';

describe('hook CLI tool validation', () => {
    beforeEach(() => {
        hooks.runSessionStartCli.mockClear();
        hooks.runUserPromptSubmitCli.mockClear();
        hooks.runStandingRulesHookCli.mockClear();
    });

    it.each(['opencode', 'codex', 'claude-code', 'unknown'])('routes the dedicated rules command only for OpenCode: %s', async (tool) => {
        const program = new Command();
        registerHook(program);
        await program.parseAsync(['node', 'elepha', 'hook', 'standing-rules', '--tool', tool]);
        expect(hooks.runStandingRulesHookCli).toHaveBeenCalledTimes(tool === 'opencode' ? 1 : 0);
        expect(hooks.runSessionStartCli).not.toHaveBeenCalled();
        expect(hooks.runUserPromptSubmitCli).not.toHaveBeenCalled();
    });

    it('passes OpenCode through to the UserPromptSubmit runtime', async () => {
        const program = new Command();
        registerHook(program);

        await program.parseAsync(['node', 'elepha', 'hook', 'user-prompt-submit', '--tool', 'opencode']);

        expect(hooks.runUserPromptSubmitCli).toHaveBeenCalledExactlyOnceWith('opencode');
        expect(hooks.runSessionStartCli).not.toHaveBeenCalled();
    });
});
