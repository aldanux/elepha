// Hook boundary for the live-memory capacity warning. The warning reaches the
// user only through the host's user-visible systemMessage field: never
// additionalContext, a standing rule, or anything the model answers from.
//
// Only a new top-level chat opening may warn. Both Claude Code and Codex
// report it as SessionStart source "startup"; resume, clear, compact and
// Claude's fork continue or reshape an existing chat, and prompts never warn,
// so crossing a threshold mid-chat waits for the next new chat. Callers have
// already discarded child-agent payloads. OpenCode has no verified
// user-visible channel and never warns.

import type Database from 'better-sqlite3-multiple-ciphers';
import { liveMemoryWarningMessage } from '../serving/live-memory-warning.js';
import { type LiveMemoryWarningPolicy, takeChatOpeningLiveMemoryWarning } from '../storage/live-memory-warning.js';
import type { HookSource, HookTool } from './common.js';

export const NEW_CHAT_SESSION_SOURCE: HookSource = 'startup';

// Returns the warning text when this opening warns. Runs inside the caller's
// recording transaction, so a failed record rolls the schedule back. A failed
// check is logged and skipped without blocking the opening's other notices;
// the next opening checks again.
export function chatOpeningLiveMemoryWarning(
    db: Database.Database,
    tool: HookTool,
    source: HookSource,
    policy: LiveMemoryWarningPolicy,
    nowMs: number,
    log: (outcome: string) => void,
): string | undefined {
    if (!policy.enabled || tool === 'opencode' || source !== NEW_CHAT_SESSION_SOURCE) {
        return undefined;
    }
    try {
        const usageBytes = policy.readUsage(db);
        const band = takeChatOpeningLiveMemoryWarning(db, usageBytes, nowMs);
        return band === undefined ? undefined : liveMemoryWarningMessage(usageBytes, band);
    } catch {
        log('live_memory_warning failed reason=schedule_unavailable');
        return undefined;
    }
}
