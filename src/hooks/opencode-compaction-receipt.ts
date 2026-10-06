import { existsSync, realpathSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import {
    HOOK_PAYLOAD_MAX_CHARS,
    HOOK_WATCHDOG_TIMEOUT_MS,
    OPENCODE_COMPACTION_RECEIPT_ACK,
    OPENCODE_COMPACTION_RECEIPT_CONTRACT,
    OPENCODE_COMPACTION_RECEIPT_MAX_CWD_BYTES,
    OPENCODE_COMPACTION_RECEIPT_MAX_TEXT_BYTES,
    OPENCODE_V2_HANDOFF_MAX_ID_BYTES,
} from '../config/constants.js';
import { samePath } from '../config/paths.js';
import { ConsentStore } from '../storage/consent-store.js';
import { defaultDbPath, openDb } from '../storage/db.js';
import { MemoryStore } from '../storage/memory-store.js';
import { OpencodeCompactionReceiptStore } from '../storage/opencode-compaction-receipt-store.js';
import { consentedProject, readStdin } from './common.js';
import { appendHookLog } from './hook-log.js';

interface ReceiptPayload {
    contract: typeof OPENCODE_COMPACTION_RECEIPT_CONTRACT;
    session_id: string;
    cwd: string;
    session_root: true;
    text: string;
    reason: 'auto' | 'manual';
}

export function parseOpencodeCompactionReceipt(raw: string): ReceiptPayload | undefined {
    if (raw.length > HOOK_PAYLOAD_MAX_CHARS) {
        return;
    }
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return;
        }
        const p = value as Record<string, unknown>;
        if (
            Object.keys(p).length !== 6 ||
            p.contract !== OPENCODE_COMPACTION_RECEIPT_CONTRACT ||
            typeof p.session_id !== 'string' ||
            !p.session_id.trim() ||
            Buffer.byteLength(p.session_id) > OPENCODE_V2_HANDOFF_MAX_ID_BYTES ||
            typeof p.cwd !== 'string' ||
            !p.cwd.trim() ||
            Buffer.byteLength(p.cwd) > OPENCODE_COMPACTION_RECEIPT_MAX_CWD_BYTES ||
            p.session_root !== true ||
            typeof p.text !== 'string' ||
            !p.text.trim() ||
            Buffer.byteLength(p.text) > OPENCODE_COMPACTION_RECEIPT_MAX_TEXT_BYTES ||
            (p.reason !== 'auto' && p.reason !== 'manual')
        ) {
            return;
        }
        return p as unknown as ReceiptPayload;
    } catch {
        return;
    }
}

export interface OpencodeCompactionReceiptDependencies {
    dbPath?: string;
    openDatabase?: typeof openDb;
    now?: () => number;
    log?: (line: string) => void;
}

export async function runOpencodeCompactionReceipt(
    raw: string,
    dependencies: OpencodeCompactionReceiptDependencies = {},
): Promise<'stored' | 'unavailable'> {
    const report = (reason: string): 'unavailable' => {
        (dependencies.log ?? appendHookLog)(`compaction-receipt opencode: ${reason}`);
        return 'unavailable';
    };
    const payload = parseOpencodeCompactionReceipt(raw);
    if (!payload) {
        return report('invalid_payload');
    }
    let db: Database.Database;
    try {
        const dbPath = dependencies.dbPath ?? defaultDbPath();
        if (!existsSync(dbPath)) {
            return report('database_unavailable');
        }
        db = await (dependencies.openDatabase ?? openDb)(dbPath);
    } catch {
        return report('database_unavailable');
    }
    try {
        const canonical = realpathSync(payload.cwd);
        const consent = new ConsentStore(db);
        if (consent.isRefusedForCapture(payload.cwd) || consent.consentState(payload.cwd) !== 'approved') {
            return report('unconsented');
        }
        const project = consentedProject(db, payload.cwd);
        if (!project) {
            return report('unconsented');
        }
        const identity = db
            .prepare(`SELECT s.id, s.project_id, s.kind, p.path FROM sessions s
            JOIN projects p ON p.id = s.project_id
            WHERE s.tool = 'opencode' AND s.native_id = ? AND s.source_format = 'opencode-v2'
            ORDER BY s.segment_index DESC LIMIT 1`)
            .get(payload.session_id) as { id: number; project_id: number; kind: string | null; path: string } | undefined;
        if (
            !identity ||
            !project.projectIds.includes(identity.project_id) ||
            identity.kind !== 'main' ||
            !samePath(realpathSync(identity.path), canonical)
        ) {
            return report('native_chat_unavailable');
        }
        // Re-resolve both names immediately before the write transaction.
        // This narrows path-substitution exposure; an OS race after this check
        // still cannot be ruled out without handle-bound directory identity.
        if (!samePath(realpathSync(payload.cwd), canonical) || !samePath(realpathSync(identity.path), canonical)) {
            return report('checkout_changed');
        }
        const outcome = db
            .transaction(() => {
                const current = db
                    .prepare(`SELECT s.id, s.project_id, s.kind, s.source_format, p.path FROM sessions s
                JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND s.tool = 'opencode' AND s.native_id = ?`)
                    .get(identity.id, payload.session_id) as
                    | { id: number; project_id: number; kind: string | null; source_format: string; path: string }
                    | undefined;
                const memory = new MemoryStore(db);
                if (
                    !current ||
                    current.project_id !== identity.project_id ||
                    current.path !== identity.path ||
                    current.source_format !== 'opencode-v2' ||
                    current.kind !== 'main' ||
                    consent.consentStateForCanonicalPath(canonical) !== 'approved' ||
                    memory.isTranscriptCaptureBlocked('opencode', payload.session_id) ||
                    memory.isTranscriptIncognito('opencode', payload.session_id)
                ) {
                    return 'unavailable' as const;
                }
                new OpencodeCompactionReceiptStore(db).insert({
                    sessionId: current.id,
                    text: payload.text,
                    reason: payload.reason,
                    observedAt: new Date((dependencies.now ?? Date.now)()).toISOString(),
                });
                return 'stored' as const;
            })
            .immediate();
        return outcome === 'unavailable' ? report('authorization_changed') : outcome;
    } catch {
        return report('receipt_error');
    } finally {
        db.close();
    }
}

export async function runOpencodeCompactionReceiptCli(): Promise<void> {
    const watchdog = setTimeout(() => {
        appendHookLog('compaction-receipt opencode: watchdog_timeout');
        process.exit(0);
    }, HOOK_WATCHDOG_TIMEOUT_MS);
    try {
        if ((await runOpencodeCompactionReceipt(await readStdin())) === 'stored') {
            process.stdout.write(OPENCODE_COMPACTION_RECEIPT_ACK);
        }
    } catch {
        appendHookLog('compaction-receipt opencode: hook_error');
    } finally {
        clearTimeout(watchdog);
    }
}
