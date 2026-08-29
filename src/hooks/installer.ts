import { parse } from 'smol-toml';
import { INSTALLED_HOOK_TIMEOUT_SECONDS } from '../config/constants.js';
import { type HookCommandName, hookCommand } from '../install/binary.js';
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
} from '../install/markers.js';

type HookTool = 'claude-code' | 'codex';
type HookEvent = {
    cliName: HookCommandName;
    configName: 'SessionStart' | 'UserPromptSubmit';
    blockStart: string;
    blockEnd: string;
    table: string;
    hookTable: string;
    matcher?: string;
};

const SESSION_START: HookEvent = {
    cliName: 'session-start',
    configName: 'SessionStart',
    blockStart: CODEX_SESSION_START_BEGIN,
    blockEnd: CODEX_SESSION_START_END,
    table: CODEX_SESSION_START_TABLE,
    hookTable: CODEX_SESSION_START_HOOK_TABLE,
    matcher: 'startup|clear|resume|compact',
};
const USER_PROMPT_SUBMIT: HookEvent = {
    cliName: 'user-prompt-submit',
    configName: 'UserPromptSubmit',
    blockStart: CODEX_USER_PROMPT_SUBMIT_BEGIN,
    blockEnd: CODEX_USER_PROMPT_SUBMIT_END,
    table: CODEX_USER_PROMPT_SUBMIT_TABLE,
    hookTable: CODEX_USER_PROMPT_SUBMIT_HOOK_TABLE,
};
const EVENTS = [SESSION_START, USER_PROMPT_SUBMIT] as const;

function isElephaCommand(value: unknown, tool: HookTool, event: HookEvent): value is string {
    return typeof value === 'string' && value.includes(`hook ${event.cliName} --tool ${tool}`);
}

function sameCommand(value: unknown, bin: string, tool: HookTool, event: HookEvent): boolean {
    return value === hookCommand(bin, tool, event.cliName);
}

function hooksObject(config: Record<string, unknown>): Record<string, unknown> {
    return config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
        ? (config.hooks as Record<string, unknown>)
        : {};
}

/** Pure Claude settings transform. It removes just elepha's handler, never a sibling group. */
export function transformClaudeHook(text: string, bin: string, uninstall = false): string {
    let config: Record<string, unknown> = {};
    if (text.trim()) {
        try {
            config = JSON.parse(text) as Record<string, unknown>;
        } catch {
            throw new Error('Claude settings.json is malformed');
        }
    }
    const hooks = hooksObject(config);
    let found = false;
    const nextHooks = { ...hooks };
    for (const event of EVENTS) {
        const configuredGroups = hooks[event.configName];
        const groups: unknown[] = Array.isArray(configuredGroups) ? configuredGroups : [];
        const nextGroups: unknown[] = groups
            .map((group) => {
                if (!group || typeof group !== 'object' || Array.isArray(group)) {
                    return group;
                }
                const record = group as Record<string, unknown>;
                const handlers = Array.isArray(record.hooks) ? record.hooks : [];
                const kept = handlers.filter((handler) => {
                    const command = handler && typeof handler === 'object' ? (handler as Record<string, unknown>).command : undefined;
                    if (!isElephaCommand(command, 'claude-code', event)) {
                        return true;
                    }
                    found = true;
                    return false;
                });
                return kept.length === 0 ? undefined : { ...record, hooks: kept };
            })
            .filter((group) => group !== undefined);
        if (!uninstall) {
            nextGroups.push({
                ...(event.matcher === undefined ? {} : { matcher: event.matcher }),
                hooks: [
                    { type: 'command', command: hookCommand(bin, 'claude-code', event.cliName), timeout: INSTALLED_HOOK_TIMEOUT_SECONDS },
                ],
            });
        }
        if (nextGroups.length > 0) {
            nextHooks[event.configName] = nextGroups;
        } else {
            delete nextHooks[event.configName];
        }
    }
    if (!found && uninstall) {
        return text;
    }
    config.hooks = nextHooks;
    return `${JSON.stringify(config, null, 2)}\n`;
}

function blockStart(event: HookEvent): string {
    return event.blockStart;
}

function blockEnd(event: HookEvent): string {
    return event.blockEnd;
}

function blockPattern(event: HookEvent): RegExp {
    return new RegExp(`${blockStart(event)}[\\s\\S]*?${blockEnd(event)}\\n?`, 'g');
}

function codexBlock(bin: string, event: HookEvent): string {
    return `${blockStart(event)}\n${event.table}\n${event.matcher === undefined ? '' : `matcher = ${JSON.stringify(event.matcher)}\n`}\n${event.hookTable}\ntype = "command"\ncommand = ${JSON.stringify(
        hookCommand(bin, 'codex', event.cliName),
    )}\ntimeout = ${INSTALLED_HOOK_TIMEOUT_SECONDS}\n${event === SESSION_START ? `statusMessage = "Loading project memory"\n${CODEX_ADDITIONAL_CONTEXT_LIMIT}\n` : ''}${blockEnd(event)}\n`;
}

/** Text-level TOML transform keeps unrelated comments and table order intact. */
export function transformCodexHook(text: string, bin: string, uninstall = false, configPath?: string): string {
    try {
        parse(text);
    } catch {
        throw new Error('Codex config.toml is malformed');
    }
    const groupIndexes = new Map(
        EVENTS.map((event) => {
            const start = text.indexOf(blockStart(event));
            return [
                event,
                start < 0 ? -1 : (text.slice(0, start).match(new RegExp(`\\[\\[hooks\\.${event.configName}]]`, 'g')) ?? []).length,
            ] as const;
        }),
    );
    let withoutOwned = text;
    for (const event of EVENTS) {
        withoutOwned = withoutOwned.replace(blockPattern(event), '');
    }
    if (uninstall) {
        if (configPath) {
            for (const event of EVENTS) {
                const groupIndex = groupIndexes.get(event) ?? -1;
                if (groupIndex >= 0) {
                    withoutOwned = rekeyCodexTrustState(withoutOwned, configPath, event.configName, groupIndex);
                }
            }
        }
        return withoutOwned;
    }
    const parsed = parse(withoutOwned) as { hooks?: Record<string, unknown> };
    for (const event of EVENTS) {
        const groups = parsed.hooks?.[event.configName];
        if (!Array.isArray(groups)) {
            continue;
        }
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            const group = groups[groupIndex] as Record<string, unknown>;
            const handlers = Array.isArray(group.hooks) ? group.hooks : [];
            for (let handlerIndex = 0; handlerIndex < handlers.length; handlerIndex++) {
                const handler = handlers[handlerIndex] as Record<string, unknown>;
                if (isElephaCommand(handler.command, 'codex', event)) {
                    if (!sameCommand(handler.command, bin, 'codex', event)) {
                        throw new Error(`conflicting user-owned elepha Codex hook at ${groupIndex}:${handlerIndex}`);
                    }
                    // It is canonical but not owned yet. Do not re-index a trusted handler.
                    throw new Error(`unmanaged canonical elepha Codex hook at ${groupIndex}:${handlerIndex}`);
                }
            }
        }
    }
    const next = `${withoutOwned.replace(/\s*$/, '\n\n')}${EVENTS.map((event) => codexBlock(bin, event)).join('\n')}`;
    parse(next);
    return next;
}

/**
 * The managed group is appended, but users can add later groups before removal.
 * Codex keys trust state by positional hook identity, so move those later keys
 * with their handlers rather than letting uninstall silently disable them.
 */
function rekeyCodexTrustState(text: string, configPath: string, eventName: HookEvent['configName'], removedGroup: number): string {
    const headers = Array.from(text.matchAll(/^[ \t]*\[[^\r\n]*(?:\r?\n|$)/gm));
    let result = '';
    let cursor = 0;

    for (let index = 0; index < headers.length; index++) {
        const header = headers[index];
        const start = header.index;
        if (start === undefined) {
            continue;
        }
        const headerLine = header[0];
        const sectionEnd = headers[index + 1]?.index ?? text.length;
        const section = text.slice(start, sectionEnd);
        const event = eventName === 'SessionStart' ? 'session_start' : 'user_prompt_submit';
        const match = new RegExp(`^([ \\t]*)\\[hooks\\.state\\."([^"]+):${event}:(\\d+):(\\d+)"]([^\\r\\n]*)(\\r?\\n)?$`).exec(headerLine);
        if (!match || match[2] !== configPath) {
            continue;
        }

        const group = Number(match[3]);
        const handler = Number(match[4]);
        if (group < removedGroup || (group === removedGroup && handler !== 0)) {
            continue;
        }

        result += text.slice(cursor, start);
        const body = section.slice(headerLine.length);
        if (group === removedGroup) {
            // Keep comments immediately preceding the next table: text transforms
            // must not treat the following table's leading comment as table state.
            const leadingComment = headers[index + 1] ? body.match(/(?:[ \t]*(?:#.*)?\r?\n)*$/)?.[0] : '';
            result += leadingComment;
        } else {
            result += `${match[1]}[hooks.state."${configPath}:${event}:${group - 1}:${match[4]}"]${match[5]}${match[6] ?? ''}${body}`;
        }
        cursor = sectionEnd;
    }

    return cursor === 0 ? text : `${result}${text.slice(cursor)}`;
}
