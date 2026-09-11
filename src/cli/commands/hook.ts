import type { Command } from 'commander';
import { isHookTool } from '../../hooks/common.js';
import { runSessionStartCli } from '../../hooks/session-start.js';
import { runUserPromptSubmitCli } from '../../hooks/user-prompt-submit.js';

export function registerHook(program: Command): void {
    const hook = program.command('hook', { hidden: true }).description('Install and execute bounded elepha hooks');
    hook.command('session-start')
        .requiredOption('--tool <tool>', 'claude-code, codex, opencode, kimi, or deepseek')
        .action(async (opts: { tool: string }) => {
            if (!isHookTool(opts.tool)) {
                process.exitCode = 0;
                return;
            }
            await runSessionStartCli(opts.tool);
        });
    hook.command('user-prompt-submit')
        .requiredOption('--tool <tool>', 'claude-code, codex, opencode, kimi, or deepseek')
        .action(async (opts: { tool: string }) => {
            if (!isHookTool(opts.tool)) {
                process.exitCode = 0;
                return;
            }
            await runUserPromptSubmitCli(opts.tool);
        });
}
