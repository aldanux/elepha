import { parse, stringify } from 'smol-toml';
import { INSTALLED_HOOK_TIMEOUT_SECONDS } from '../config/constants.js';
import { KIMI_HOOK_ARGS, renderKimiHookCommand } from '../security/subprocess-allowlist.js';
import { KIMI_HOOK_MARKER } from './markers.js';

export const KIMI_HOOK_EVENT = 'UserPromptSubmit';
export const KIMI_HOOK_MATCHER = '^elepha:';
const KIMI_HOOK_INVOCATION = KIMI_HOOK_ARGS.join(' ');

function configuration(source: string) {
    const config = parse(source);
    if (
        config.hooks !== undefined &&
        (!Array.isArray(config.hooks) || config.hooks.some((hook) => !hook || typeof hook !== 'object' || Array.isArray(hook)))
    ) {
        throw new Error('Kimi Code config.toml hooks must be an array of tables');
    }
    return config;
}

function owned(hook: unknown): boolean {
    if (!hook || typeof hook !== 'object') {
        return false;
    }
    const entry = hook as Record<string, unknown>;
    return entry.event === KIMI_HOOK_EVENT && typeof entry.command === 'string' && entry.command.includes(KIMI_HOOK_MARKER);
}

function conflicting(hook: unknown): boolean {
    if (!hook || typeof hook !== 'object' || owned(hook)) {
        return false;
    }
    const entry = hook as Record<string, unknown>;
    return (
        entry.event === KIMI_HOOK_EVENT &&
        (entry.matcher === KIMI_HOOK_MATCHER || (typeof entry.command === 'string' && entry.command.includes(KIMI_HOOK_INVOCATION)))
    );
}

function expectedHook(launcher: string) {
    return {
        event: KIMI_HOOK_EVENT,
        matcher: KIMI_HOOK_MATCHER,
        command: renderKimiHookCommand(launcher),
        timeout: INSTALLED_HOOK_TIMEOUT_SECONDS,
    };
}

export function kimiHookStatus(source: string, launcher: string) {
    try {
        const hooks = configuration(source).hooks;
        const entries = Array.isArray(hooks) ? hooks : [];
        if (entries.some(conflicting)) {
            return 'conflict';
        }
        const managed = entries.filter(owned);
        if (managed.length === 0) {
            return 'not installed';
        }
        const expected = expectedHook(launcher);
        const actual = managed[0] as Record<string, unknown>;
        return managed.length === 1 &&
            Object.keys(actual).length === Object.keys(expected).length &&
            Object.entries(expected).every(([key, value]) => actual[key] === value)
            ? 'active'
            : 'stale hook';
    } catch {
        return 'invalid';
    }
}

// Parse before ownership decisions; never match TOML headers inside strings.
// Correct registrations are byte-for-byte no-ops, including user comments.
export function transformKimiHook(source: string, launcher: string, uninstall = false): string {
    const config = configuration(source);
    const hooks = Array.isArray(config.hooks) ? config.hooks : [];
    if (!uninstall && hooks.some(conflicting)) {
        throw new Error('conflicting user-owned elepha Kimi hook');
    }
    if (uninstall ? !hooks.some(owned) : kimiHookStatus(source, launcher) === 'active') {
        return source;
    }
    const next = hooks.filter((hook) => !owned(hook));
    if (!uninstall) {
        next.push(expectedHook(launcher));
    }
    if (next.length > 0) {
        config.hooks = next;
    } else {
        delete config.hooks;
    }
    return stringify(config);
}
