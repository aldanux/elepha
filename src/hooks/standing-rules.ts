// OpenCode's system transform requests only the user's standing project rules.
// This is not a SessionStart event and never serves operational notices.

import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import { HOOK_PAYLOAD_MAX_CHARS, HOOK_WATCHDOG_TIMEOUT_MS } from '../config/constants.js';
import { prepareStandingRulesDelivery } from '../serving/standing-rules.js';
import { defaultDbPath, openDb } from '../storage/db.js';
import { MemoryStore } from '../storage/memory-store.js';
import {
    type AuthenticatedReadGeneration,
    memoryReadAuthorityMatchesGenerationInTransaction,
    withMemoryReadGeneration,
} from '../storage/paranoid-gate.js';
import { readStdin } from './common.js';
import { appendHookLog } from './hook-log.js';
import { recordHookOutput } from './output.js';

interface StandingRulesPayload {
    session_id: string;
    cwd: string;
}

export interface StandingRulesHookDependencies {
    dbPath?: string;
    openDatabase?: typeof openDb;
    now?: () => number;
    log?: (line: string) => void;
    beforeDelivery?: (db: Database.Database) => void;
    writeInjection?: (store: MemoryStore, input: Parameters<MemoryStore['recordInjection']>[0]) => boolean;
}

export type StandingRulesHookResult = { context: string } | { reason: string };

export function parseStandingRulesPayload(raw: string): StandingRulesPayload | undefined {
    if (raw.length > HOOK_PAYLOAD_MAX_CHARS) {
        return undefined;
    }
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }
        const payload = value as Record<string, unknown>;
        if (
            Object.keys(payload).length !== 2 ||
            typeof payload.session_id !== 'string' ||
            !payload.session_id.trim() ||
            typeof payload.cwd !== 'string' ||
            !payload.cwd.trim()
        ) {
            return undefined;
        }
        return { session_id: payload.session_id, cwd: payload.cwd };
    } catch {
        return undefined;
    }
}

export async function runStandingRulesHook(
    raw: string,
    dependencies: StandingRulesHookDependencies = {},
): Promise<StandingRulesHookResult> {
    const log = dependencies.log ?? appendHookLog;
    const report = (reason: string): void => log(`standing-rules opencode: ${reason}`);
    const payload = parseStandingRulesPayload(raw);
    if (payload === undefined) {
        report('invalid_payload');
        return { reason: 'invalid_payload' };
    }
    let db: Database.Database;
    try {
        const dbPath = dependencies.dbPath ?? defaultDbPath();
        if (!existsSync(dbPath)) {
            report('database_unavailable');
            return { reason: 'database_unavailable' };
        }
        db = await (dependencies.openDatabase ?? openDb)(dbPath);
    } catch {
        report('database_unavailable');
        return { reason: 'database_unavailable' };
    }
    const recordFailed = new Error('injection_record_failed');
    try {
        const store = new MemoryStore(db);
        const generation = withMemoryReadGeneration<AuthenticatedReadGeneration | undefined>(
            db,
            () => undefined,
            (token) => token,
        );
        const readRules = generation === undefined ? () => undefined : prepareStandingRulesDelivery(db, store, payload.cwd);
        dependencies.beforeDelivery?.(db);
        const injectedAt = new Date((dependencies.now ?? Date.now)()).toISOString();
        const result = db
            .transaction((): StandingRulesHookResult => {
                if (generation === undefined || !memoryReadAuthorityMatchesGenerationInTransaction(db, generation)) {
                    return { reason: 'locked_or_stale' };
                }
                const delivery = readRules();
                if (delivery === undefined) {
                    return { reason: 'no_rules' };
                }
                if ('reason' in delivery) {
                    return delivery;
                }
                let context: string | undefined;
                try {
                    context = recordHookOutput({
                        store,
                        tool: 'opencode',
                        nativeSessionId: payload.session_id,
                        body: delivery.body,
                        kind: 'rules',
                        attribution: 'exact',
                        injectedAt,
                        writeInjection: dependencies.writeInjection,
                    });
                } catch {
                    throw recordFailed;
                }
                if (context === undefined) {
                    throw recordFailed;
                }
                return { context };
            })
            .immediate();
        // An ordinary empty project is the hot path, not an error. Avoid a
        // synchronous log append/stat for every model request without rules.
        if ('reason' in result && result.reason !== 'no_rules') {
            report(result.reason);
        }
        return result;
    } catch (error) {
        const reason = error === recordFailed ? 'injection_record_failed' : 'hook_error';
        report(reason);
        return { reason };
    } finally {
        db.close();
    }
}

// The plugin receives one narrow JSON object, only after durable attribution.
// All failures and empty results remain silent on stdout.
export async function runStandingRulesHookCli(): Promise<void> {
    const watchdog = setTimeout(() => {
        appendHookLog('standing-rules opencode: watchdog_timeout');
        process.exit(0);
    }, HOOK_WATCHDOG_TIMEOUT_MS);
    try {
        const result = await runStandingRulesHook(await readStdin());
        if ('context' in result) {
            process.stdout.write(JSON.stringify(result));
        }
    } catch {
        appendHookLog('standing-rules opencode: hook_error');
    } finally {
        clearTimeout(watchdog);
    }
}
