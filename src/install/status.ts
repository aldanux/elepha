import { type CodexTrustState, codexTrustStatus } from '../hooks/codex-trust.js';
import { hasClaudeMcp, hasCodexMcp } from '../mcp/installer.js';
import { type HookCommandName, hookCommand } from './binary.js';
import type { PresentTools } from './present-tools.js';

export type ClaudeHookStatus = 'active' | 'not present' | 'not installed' | 'invalid' | 'stale binary';
type ClaudeMcpStatus = ReturnType<typeof hasClaudeMcp> | 'not present';
type CodexMcpStatus = ReturnType<typeof hasCodexMcp> | 'not present';
type CodexHookStatus = CodexTrustState | 'not present';

function hookConfigName(hook: HookCommandName): 'SessionStart' | 'UserPromptSubmit' {
    return hook === 'session-start' ? 'SessionStart' : 'UserPromptSubmit';
}

export function claudeHookStatus(text: string, bin: string, hook: HookCommandName = 'session-start'): ClaudeHookStatus {
    if (!text.trim()) {
        return 'not installed';
    }
    try {
        const config = JSON.parse(text) as { hooks?: Record<string, unknown> };
        const groups = config.hooks?.[hookConfigName(hook)];
        if (!Array.isArray(groups)) {
            return 'not installed';
        }
        for (const group of groups) {
            const handlers = group && typeof group === 'object' ? (group as Record<string, unknown>).hooks : undefined;
            if (!Array.isArray(handlers)) {
                continue;
            }
            for (const handler of handlers) {
                const command = handler && typeof handler === 'object' ? (handler as Record<string, unknown>).command : undefined;
                if (typeof command === 'string' && command.endsWith(`hook ${hook} --tool claude-code`)) {
                    return command === hookCommand(bin, 'claude-code', hook) ? 'active' : 'stale binary';
                }
            }
        }
        return 'not installed';
    } catch {
        return 'invalid';
    }
}

export interface InstallStatus {
    claudeHook: ClaudeHookStatus;
    claudeUserPromptSubmitHook: ClaudeHookStatus;
    codexHook: CodexHookStatus;
    codexUserPromptSubmitHook: CodexHookStatus;
    claudeMcp: ClaudeMcpStatus;
    codexMcp: CodexMcpStatus;
    ready: boolean;
}

export function installationStatus(
    claudeSettings: string,
    claudeMcp: string,
    codexConfig: string,
    codexPath: string,
    bin: string,
    present: PresentTools = { claude: true, codex: true },
): InstallStatus {
    const claudeHook = present.claude ? claudeHookStatus(claudeSettings, bin) : 'not present';
    const claudeUserPromptSubmitHook = present.claude ? claudeHookStatus(claudeSettings, bin, 'user-prompt-submit') : 'not present';
    const codexHook = present.codex ? codexTrustStatus(codexConfig, codexPath, codexConfig, hookCommand(bin, 'codex')) : 'not present';
    const codexUserPromptSubmitHook = present.codex
        ? codexTrustStatus(codexConfig, codexPath, codexConfig, hookCommand(bin, 'codex', 'user-prompt-submit'), 'UserPromptSubmit')
        : 'not present';
    const result: InstallStatus = {
        claudeHook,
        claudeUserPromptSubmitHook,
        codexHook,
        codexUserPromptSubmitHook,
        claudeMcp: present.claude ? hasClaudeMcp(claudeMcp, bin) : 'not present',
        codexMcp: present.codex ? hasCodexMcp(codexConfig, bin) : 'not present',
        ready: false,
    };
    result.ready =
        (!present.claude ||
            (result.claudeHook === 'active' && result.claudeUserPromptSubmitHook === 'active' && result.claudeMcp === 'registered')) &&
        (!present.codex ||
            (result.codexHook === 'active' && result.codexUserPromptSubmitHook === 'active' && result.codexMcp === 'registered'));
    return result;
}
