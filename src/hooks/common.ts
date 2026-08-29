// Shared fail-open hook boundary helpers. They preserve each hook's payload
// contract while sharing stdin handling and consent resolution: under
// raw ambiguity it may select the sole consented project, but never an
// unconsented project and never one of multiple consented candidates.

import { realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { HOOK_PAYLOAD_MAX_CHARS } from '../config/constants.js';
import { ConsentStore } from '../storage/consent-store.js';
import { ProjectResolver, type ProjectSet } from '../storage/project-resolver.js';
import type { ToolName } from '../types/index.js';

export type HookTool = ToolName;
export type HookSource = 'startup' | 'clear' | 'resume' | 'compact';

interface CommonHookPayload {
    session_id: string;
    cwd: string;
    model?: string;
    permission_mode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';
    transcript_path?: string | null;
}

export interface SessionStartPayload extends CommonHookPayload {
    hook_event_name: 'SessionStart';
    source: HookSource;
}

export interface UserPromptSubmitPayload extends CommonHookPayload {
    hook_event_name: 'UserPromptSubmit';
    prompt: string;
}

export type HookPayload = SessionStartPayload | UserPromptSubmitPayload;

export function parsePayload(raw: string, tool: HookTool, event: 'SessionStart'): SessionStartPayload | undefined;
export function parsePayload(raw: string, tool: HookTool, event: 'UserPromptSubmit'): UserPromptSubmitPayload | undefined;
export function parsePayload(raw: string, tool: HookTool, event?: undefined): HookPayload | undefined;
export function parsePayload(raw: string, tool: HookTool, event?: HookPayload['hook_event_name']): HookPayload | undefined {
    if (raw.length > HOOK_PAYLOAD_MAX_CHARS) {
        return undefined;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const payload = value as Record<string, unknown>;
    if (
        typeof payload.session_id !== 'string' ||
        payload.session_id.length === 0 ||
        typeof payload.cwd !== 'string' ||
        payload.cwd.length === 0 ||
        (payload.hook_event_name !== 'SessionStart' && payload.hook_event_name !== 'UserPromptSubmit') ||
        (event !== undefined && payload.hook_event_name !== event)
    ) {
        return undefined;
    }
    // Codex explicitly allows a null transcript path. Neither tool's path is
    // used beyond validation; it cannot become a reader or subprocess input.
    if (payload.transcript_path !== undefined && payload.transcript_path !== null && typeof payload.transcript_path !== 'string') {
        return undefined;
    }
    if (
        tool === 'codex' &&
        (typeof payload.model !== 'string' ||
            !['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].includes(payload.permission_mode as string))
    ) {
        return undefined;
    }
    const common: CommonHookPayload = {
        session_id: payload.session_id,
        cwd: payload.cwd,
        model: payload.model as string | undefined,
        permission_mode: payload.permission_mode as CommonHookPayload['permission_mode'],
        transcript_path: payload.transcript_path as string | null | undefined,
    };
    if (payload.hook_event_name === 'SessionStart') {
        if (!['startup', 'clear', 'resume', 'compact'].includes(payload.source as string)) {
            return undefined;
        }
        return { ...common, hook_event_name: 'SessionStart', source: payload.source as HookSource };
    }
    if (typeof payload.prompt !== 'string') {
        return undefined;
    }
    return { ...common, hook_event_name: 'UserPromptSubmit', prompt: payload.prompt };
}

export function consentedProject(db: Database.Database, cwd: string): ProjectSet | undefined {
    let canonical: string;
    try {
        canonical = realpathSync(cwd);
    } catch {
        return undefined;
    }
    const resolved = new ProjectResolver(db).resolveConsented(canonical, new ConsentStore(db));
    return 'project' in resolved && resolved.project !== null ? resolved.project : undefined;
}

export async function readStdin(): Promise<string> {
    let input = '';
    for await (const chunk of process.stdin) {
        input += String(chunk);
        if (input.length > HOOK_PAYLOAD_MAX_CHARS) {
            break;
        }
    }
    return input;
}
