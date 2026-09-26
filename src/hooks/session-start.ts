// Fail-open SessionStart hook. User-saved rules and operational notices use
// separate channels and separately attributable, atomically recorded bodies.

import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import { HOOK_WATCHDOG_TIMEOUT_MS, PACKAGE_VERSION } from '../config/constants.js';
import { codexWorktreeRootContaining, updateAvailablePath } from '../config/paths.js';
import { isNewerVersion, readUpdateAvailable, type UpdateAvailable } from '../daemon/update-check.js';
import { daemonHealth as classifyDaemonHealth } from '../install/health-checks.js';
import { terminalHandoff } from '../markers.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { prepareStandingRulesDelivery } from '../serving/standing-rules.js';
import { defaultDbPath, openDb } from '../storage/db.js';
import { MemoryStore } from '../storage/memory-store.js';
import {
    type AuthenticatedReadGeneration,
    memoryReadAuthorityMatchesGenerationInTransaction,
    withMemoryReadGeneration,
} from '../storage/paranoid-gate.js';
import { type HookTool, parsePayload, readStdin, type SessionStartPayload } from './common.js';
import { appendHookLog } from './hook-log.js';
import { recordHookOutput } from './output.js';

export interface SessionStartDependencies {
    dbPath?: string;
    openDatabase?: typeof openDb;
    now?: () => number;
    log?: (line: string) => void;
    daemonHealth?: typeof classifyDaemonHealth;
    // Local daemon marker only. The hook never performs the registry check.
    readUpdateAvailable?: (markerPath: string) => UpdateAvailable | undefined;
    writeInjection?: (store: MemoryStore, input: Parameters<MemoryStore['recordInjection']>[0]) => boolean;
    // Synchronous checkpoint after physical resolution, before the DB-only
    // authorization and recording transaction. Used to exercise stale plans.
    beforeDelivery?: (db: Database.Database) => void;
}

export type HookResult = { output: Record<string, unknown> } | { reason: string };

function logLine(message: string): void {
    appendHookLog(message);
}

function sessionLogLine(tool: HookTool, payload: SessionStartPayload | undefined, outcome: string): string {
    return `session-start ${tool} source=${payload?.source ?? 'unknown'} session_id=${payload?.session_id ?? 'unknown'}: ${outcome}`;
}

export function handleWatchdogTimeout(
    tool: HookTool,
    log: (line: string) => void = logLine,
    exit: (code: number) => void = process.exit,
): void {
    log(sessionLogLine(tool, undefined, `watchdog timeout after ${HOOK_WATCHDOG_TIMEOUT_MS}ms`));
    exit(0);
}

function envelope(tool: HookTool, channels: { additionalContext?: string; systemMessage?: string }): Record<string, unknown> {
    const hookSpecificOutput = {
        hookEventName: 'SessionStart',
        ...(channels.additionalContext === undefined ? {} : { additionalContext: channels.additionalContext }),
    };
    return tool === 'claude-code'
        ? { hookSpecificOutput, ...(channels.systemMessage === undefined ? {} : { systemMessage: channels.systemMessage }) }
        : {
              continue: true,
              hookSpecificOutput,
              stopReason: null,
              suppressOutput: false,
              ...(channels.systemMessage === undefined ? {} : { systemMessage: channels.systemMessage }),
          };
}

export function withDaemonHealthWarning(body: string, now: number, healthCheck: typeof classifyDaemonHealth): string {
    try {
        const health = healthCheck(undefined, now);
        if (health.healthy) {
            return body;
        }
        const warning = health.state.startsWith('STUCK')
            ? `⚠ elepha: capture may be stalled — daemon heartbeat is stale. ${terminalHandoff('doctor')}`
            : `⚠ elepha: capture is paused — daemon not running. ${terminalHandoff('doctor')}`;
        return body ? `${warning}\n${body}` : warning;
    } catch {
        return body;
    }
}

export function withUpdateNotice(body: string, readMarker: (markerPath: string) => UpdateAvailable | undefined): string {
    try {
        const update = readMarker(updateAvailablePath());
        if (!update || !isNewerVersion(update.version, PACKAGE_VERSION)) {
            return body;
        }
        const notice = `⬆ elepha ${update.version} available — ${terminalHandoff('self-update')}`;
        return body ? `${notice}\n${body}` : notice;
    } catch {
        return body;
    }
}

// The root is displayed, never embedded in the command: a worktree name is
// untrusted, so the user runs a fixed command from inside that directory.
function worktreeConsentNotice(physicalRoot: string): string {
    const displayRoot = escapeShellSyntax(physicalRoot).replace(/[\n\t]/g, ' ');
    const command = terminalHandoff('consent grant --here');
    return `ℹ elepha: Codex worktree not captured (shown once): ${displayRoot}\nTo capture it, from that worktree root: ${command}`;
}

// Pure orchestration seam used by tests and the thin CLI adapter.
export async function runSessionStart(rawStdin: string, tool: HookTool, dependencies: SessionStartDependencies = {}): Promise<HookResult> {
    const log = dependencies.log ?? logLine;
    const payload = parsePayload(rawStdin, tool, 'SessionStart');
    if (!payload) {
        return { reason: 'invalid_payload' };
    }
    // Child hooks can carry the parent's native session ID, so neither
    // rules nor notices can be safely attributed to this hook invocation.
    if (payload.agent_id !== undefined) {
        log(sessionLogLine(tool, payload, 'discarded reason=subagent_context'));
        return { reason: 'subagent_context' };
    }
    const clock = dependencies.now ?? Date.now;
    const now = clock();
    let body = withDaemonHealthWarning('', now, dependencies.daemonHealth ?? classifyDaemonHealth);
    body = withUpdateNotice(body, dependencies.readUpdateAvailable ?? readUpdateAvailable);
    let db: Database.Database;
    try {
        const dbPath = dependencies.dbPath ?? defaultDbPath();
        if (!existsSync(dbPath)) {
            return { reason: 'database_unavailable' };
        }
        // Hooks must see additive schema migrations before reading rules or recording output.
        // `openDb` is idempotent and refuses no existing data.
        db = await (dependencies.openDatabase ?? openDb)(dbPath);
    } catch {
        return { reason: 'database_unavailable' };
    }
    try {
        const store = new MemoryStore(db);
        const generation = withMemoryReadGeneration<AuthenticatedReadGeneration | undefined>(
            db,
            () => undefined,
            (token) => token,
        );
        const readRules =
            generation === undefined
                ? () => undefined
                : prepareStandingRulesDelivery(
                      db,
                      store,
                      payload.cwd,
                      tool === 'opencode' ? undefined : { tool, nativeSessionId: payload.session_id },
                  );
        // Filesystem validation stays outside the write transaction; the claim inside it is DB-only.
        const worktreeRoot = tool === 'opencode' ? undefined : codexWorktreeRootContaining(payload.cwd);
        dependencies.beforeDelivery?.(db);
        const recordFailed = new Error('injection_record_failed');
        const record = (text: string, kind: 'rules' | 'notify'): string => {
            let output: string | undefined;
            try {
                output = recordHookOutput({
                    store,
                    tool,
                    nativeSessionId: payload.session_id,
                    injectedAt: new Date(now).toISOString(),
                    body: text,
                    kind,
                    attribution: kind === 'rules' ? 'exact' : 'normalized',
                    writeInjection: dependencies.writeInjection,
                });
            } catch {
                throw recordFailed;
            }
            if (output === undefined) {
                throw recordFailed;
            }
            return output;
        };
        let result: HookResult;
        let invalidRulesReason: string | undefined;
        try {
            result = db
                .transaction((): HookResult => {
                    const readable = generation !== undefined && memoryReadAuthorityMatchesGenerationInTransaction(db, generation);
                    const delivery = readable ? readRules() : undefined;
                    invalidRulesReason = delivery === undefined ? undefined : 'reason' in delivery ? delivery.reason : delivery.chatReason;
                    const rules = delivery !== undefined && 'body' in delivery ? delivery.body : undefined;
                    // A failed record below rolls this claim back, so the one-time notice is not consumed.
                    const nudgedAt = new Date(now).toISOString();
                    const worktreeNotice =
                        worktreeRoot !== undefined && store.consent.claimWorktreeConsentNotice(worktreeRoot, nudgedAt)
                            ? worktreeConsentNotice(worktreeRoot)
                            : undefined;
                    const notices = [body, worktreeNotice].filter((notice) => !!notice).join('\n');
                    if (rules === undefined && !notices) {
                        return { reason: invalidRulesReason ?? 'no_notice' };
                    }
                    const additionalContext = rules === undefined ? undefined : record(rules, 'rules');
                    const systemMessage = notices ? record(notices, 'notify') : undefined;
                    return { output: envelope(tool, { additionalContext, systemMessage }) };
                })
                .immediate();
        } catch (error) {
            if (error === recordFailed) {
                log(sessionLogLine(tool, payload, 'failed reason=injection_record_failed'));
                return { reason: 'injection_record_failed' };
            }
            //noinspection ExceptionCaughtLocallyJS
            throw error;
        }
        if (invalidRulesReason !== undefined) {
            log(sessionLogLine(tool, payload, `skipped reason=${invalidRulesReason}`));
        }
        if ('output' in result) {
            log(sessionLogLine(tool, payload, 'emitted output'));
        }
        return result;
    } catch (error) {
        log(sessionLogLine(tool, payload, (error as Error).message));
        return { reason: 'hook_error' };
    } finally {
        db.close();
    }
}

// CLI boundary: no diagnostics or partial JSON may reach stdout.
export async function runSessionStartCli(tool: HookTool): Promise<void> {
    const watchdog = setTimeout(() => {
        handleWatchdogTimeout(tool);
    }, HOOK_WATCHDOG_TIMEOUT_MS);
    try {
        const input = await readStdin();
        const result = await runSessionStart(input, tool);
        if ('output' in result) {
            process.stdout.write(JSON.stringify(result.output));
        } else {
            const payload = parsePayload(input, tool, 'SessionStart');
            logLine(sessionLogLine(tool, payload, result.reason));
        }
    } catch (error) {
        logLine(sessionLogLine(tool, undefined, (error as Error).message));
    } finally {
        clearTimeout(watchdog);
    }
}

export { envelope, parsePayload };
