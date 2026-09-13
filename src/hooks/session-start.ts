// Fail-open SessionStart hook. This module emits operational notices only.

import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import { HOOK_WATCHDOG_TIMEOUT_MS, PACKAGE_VERSION } from '../config/constants.js';
import { updateAvailablePath } from '../config/paths.js';
import { isNewerVersion, readUpdateAvailable, type UpdateAvailable } from '../daemon/update-check.js';
import { daemonHealth as classifyDaemonHealth } from '../install/health-checks.js';
import { terminalHandoff } from '../markers.js';
import { defaultDbPath, openDb } from '../storage/db.js';
import { MemoryStore } from '../storage/memory-store.js';
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

function envelope(tool: HookTool, body: string, channel: 'additionalContext' | 'systemMessage'): Record<string, unknown> {
    const hookSpecificOutput =
        channel === 'additionalContext' ? { hookEventName: 'SessionStart', additionalContext: body } : { hookEventName: 'SessionStart' };
    return tool === 'claude-code'
        ? channel === 'systemMessage'
            ? { hookSpecificOutput, systemMessage: body }
            : { hookSpecificOutput }
        : {
              continue: true,
              hookSpecificOutput,
              stopReason: null,
              suppressOutput: false,
              systemMessage: channel === 'systemMessage' ? body : null,
          };
}

function notifyChannel(tool: HookTool): 'additionalContext' | 'systemMessage' {
    // Claude Code renders systemMessage at startup. Codex renders only
    // additionalContext there; its developer-channel record is not ingested.
    return tool === 'claude-code' ? 'systemMessage' : 'additionalContext';
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

// Pure orchestration seam used by tests and the thin CLI adapter.
export async function runSessionStart(rawStdin: string, tool: HookTool, dependencies: SessionStartDependencies = {}): Promise<HookResult> {
    const log = dependencies.log ?? logLine;
    const payload = parsePayload(rawStdin, tool, 'SessionStart');
    if (!payload) {
        return { reason: 'invalid_payload' };
    }
    const clock = dependencies.now ?? Date.now;
    const now = clock();
    let body = withDaemonHealthWarning('', now, dependencies.daemonHealth ?? classifyDaemonHealth);
    body = withUpdateNotice(body, dependencies.readUpdateAvailable ?? readUpdateAvailable);
    if (!body) {
        return { reason: 'no_notice' };
    }
    let db: Database.Database;
    try {
        const dbPath = dependencies.dbPath ?? defaultDbPath();
        if (!existsSync(dbPath)) {
            return { reason: 'database_unavailable' };
        }
        // Hooks must see additive schema migrations before recording a notice.
        // `openDb` is idempotent and refuses no existing data.
        db = await (dependencies.openDatabase ?? openDb)(dbPath);
    } catch {
        return { reason: 'database_unavailable' };
    }
    try {
        const store = new MemoryStore(db);
        const emit = (notice: string): HookResult => {
            const output = recordHookOutput({
                store,
                tool,
                nativeSessionId: payload.session_id,
                injectedAt: new Date(now).toISOString(),
                body: notice,
                kind: 'notify',
                writeInjection: dependencies.writeInjection,
            });
            if (output === undefined) {
                log(sessionLogLine(tool, payload, 'failed reason=injection_record_failed'));
                return { reason: 'injection_record_failed' };
            }
            return { output: envelope(tool, output, notifyChannel(tool)) };
        };
        const result = emit(body);
        if ('output' in result) {
            log(sessionLogLine(tool, payload, 'emitted notice'));
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
