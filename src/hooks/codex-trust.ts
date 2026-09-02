import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';

export interface CodexHandler {
    matcher?: string;
    command: string;
    timeout?: number;
    async?: boolean;
    statusMessage?: string;
    additionalContextLimit?: number;
    commandWindows?: string;
}

export type CodexHookEvent = 'SessionStart' | 'UserPromptSubmit';

function snakeEventName(event: CodexHookEvent): 'session_start' | 'user_prompt_submit' {
    return event === 'SessionStart' ? 'session_start' : 'user_prompt_submit';
}

function sort(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sort);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, sort(v)]),
        );
    }
    return value;
}

// Matches Codex's normalized command-hook fingerprint.
export function codexTrustHash(handler: CodexHandler, event: CodexHookEvent = 'SessionStart'): string {
    const timeout = Math.max(1, handler.timeout ?? 600);
    const command: Record<string, unknown> = { type: 'command', command: handler.command, timeout, async: handler.async ?? false };
    if (handler.statusMessage !== undefined) {
        command.statusMessage = handler.statusMessage;
    }
    if (handler.additionalContextLimit !== undefined && handler.additionalContextLimit !== 2500) {
        command.additionalContextLimit = handler.additionalContextLimit;
    }
    const identity: Record<string, unknown> = { event_name: snakeEventName(event), hooks: [command] };
    if (handler.matcher !== undefined) {
        identity.matcher = handler.matcher;
    }
    return `sha256:${createHash('sha256')
        .update(JSON.stringify(sort(identity)))
        .digest('hex')}`;
}

export type CodexTrustState = 'active' | 'awaiting approval' | 'hash invalidated' | 'not configured' | 'malformed';

export function codexTrustStatus(
    definitionText: string,
    definitionPath: string,
    stateText = definitionText,
    command = 'elepha hook session-start --tool codex',
    event: CodexHookEvent = 'SessionStart',
): CodexTrustState {
    let config: Record<string, unknown>;
    try {
        config = parse(definitionText) as Record<string, unknown>;
    } catch {
        return 'malformed';
    }
    let stateConfig: Record<string, unknown>;
    try {
        stateConfig = parse(stateText) as Record<string, unknown>;
    } catch {
        return 'malformed';
    }
    const hooks = config.hooks as Record<string, unknown> | undefined;
    const groups = hooks?.[event];
    if (!Array.isArray(groups)) {
        return 'not configured';
    }
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex] as Record<string, unknown>;
        const handlers = group.hooks;
        if (!Array.isArray(handlers)) {
            continue;
        }
        for (let handlerIndex = 0; handlerIndex < handlers.length; handlerIndex++) {
            const handler = handlers[handlerIndex] as Record<string, unknown>;
            if (handler.command !== command) {
                continue;
            }
            const key = `${definitionPath}:${snakeEventName(event)}:${groupIndex}:${handlerIndex}`;
            const state = ((stateConfig.hooks as Record<string, unknown> | undefined)?.state as Record<string, unknown> | undefined)?.[
                key
            ] as Record<string, unknown> | undefined;
            const hash = codexTrustHash(
                {
                    matcher: typeof group.matcher === 'string' ? group.matcher : undefined,
                    ...handler,
                } as CodexHandler,
                event,
            );
            if (state?.enabled === false || (typeof state?.trusted_hash === 'string' && state.trusted_hash !== hash)) {
                return 'hash invalidated';
            }
            return typeof state?.trusted_hash === 'string' ? 'active' : 'awaiting approval';
        }
    }
    return 'not configured';
}
