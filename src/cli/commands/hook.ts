import type { Command } from 'commander';
import { runSessionStartCli } from '../../hooks/session-start.js';
import { runUserPromptSubmitCli } from '../../hooks/user-prompt-submit.js';
import type { ToolName } from '../../types/index.js';

export function registerHook(program: Command): void {
    const hook = program.command('hook', { hidden: true }).description('Install and execute bounded elepha hooks');
    hook.command('session-start')
        .requiredOption('--tool <tool>', 'claude-code or codex')
        .action(async (opts: { tool: ToolName }) => {
            if (opts.tool !== 'claude-code' && opts.tool !== 'codex') {
                process.exitCode = 0;
                return;
            }
            await runSessionStartCli(opts.tool);
        });
    hook.command('user-prompt-submit')
        .requiredOption('--tool <tool>', 'claude-code or codex')
        .action(async (opts: { tool: ToolName }) => {
            if (opts.tool !== 'claude-code' && opts.tool !== 'codex') {
                process.exitCode = 0;
                return;
            }
            await runUserPromptSubmitCli(opts.tool);
        });
}
