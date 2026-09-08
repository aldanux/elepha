import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
    runSessionStartCli: vi.fn(async () => undefined),
    runUserPromptSubmitCli: vi.fn(async () => undefined),
}));

vi.mock('../../src/hooks/session-start.js', () => ({ runSessionStartCli: hooks.runSessionStartCli }));
vi.mock('../../src/hooks/user-prompt-submit.js', () => ({ runUserPromptSubmitCli: hooks.runUserPromptSubmitCli }));

import { registerHook } from '../../src/cli/commands/hook.js';

describe('hook CLI tool validation', () => {
    beforeEach(() => {
        hooks.runSessionStartCli.mockClear();
        hooks.runUserPromptSubmitCli.mockClear();
    });

    it('passes opencode through to the UserPromptSubmit runtime', async () => {
        const program = new Command();
        registerHook(program);

        await program.parseAsync(['node', 'elepha', 'hook', 'user-prompt-submit', '--tool', 'opencode']);

        expect(hooks.runUserPromptSubmitCli).toHaveBeenCalledExactlyOnceWith('opencode');
        expect(hooks.runSessionStartCli).not.toHaveBeenCalled();
    });
});
