import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import { parseTaskStateReportInput, taskStateReportRawGuard } from '../adapters/task-state-report.js';
import {
    HOOK_PAYLOAD_MAX_CHARS,
    HOOK_WATCHDOG_TIMEOUT_MS,
    OPENCODE_COMPACTION_RECEIPT_MAX_CWD_BYTES,
    OPENCODE_TASK_STATE_RECEIPT_ACK,
    OPENCODE_TASK_STATE_RECEIPT_CONTRACT,
    OPENCODE_V2_HANDOFF_MAX_ID_BYTES,
} from '../config/constants.js';
import { samePath } from '../config/paths.js';
import { ConsentStore } from '../storage/consent-store.js';
import { defaultDbPath, openDb } from '../storage/db.js';
import { MemoryStore } from '../storage/memory-store.js';
import { OpencodeTaskStateReceiptStore } from '../storage/opencode-task-state-receipt-store.js';
import { consentedProject, readStdin } from './common.js';
import { appendHookLog } from './hook-log.js';

interface ReceiptPayload {
    contract: typeof OPENCODE_TASK_STATE_RECEIPT_CONTRACT;
    session_id: string;
    cwd: string;
    session_root: true;
    assistant_message_id: string;
    call_id: string;
    started_event_id: string;
    called_event_id: string;
    success_event_id: string;
    report: unknown;
}

function boundedId(value: unknown, event = false): value is string {
    return (
        typeof value === 'string' &&
        value.length > (event ? 4 : 0) &&
        Buffer.byteLength(value) <= OPENCODE_V2_HANDOFF_MAX_ID_BYTES &&
        (!event || /^evt_[A-Za-z0-9_-]+$/.test(value))
    );
}

export function parseOpencodeTaskStateReceipt(raw: string): ReceiptPayload | undefined {
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
            Object.keys(p).length !== 10 ||
            p.contract !== OPENCODE_TASK_STATE_RECEIPT_CONTRACT ||
            !boundedId(p.session_id) ||
            typeof p.cwd !== 'string' ||
            !p.cwd.trim() ||
            Buffer.byteLength(p.cwd) > OPENCODE_COMPACTION_RECEIPT_MAX_CWD_BYTES ||
            p.session_root !== true ||
            !boundedId(p.assistant_message_id) ||
            !boundedId(p.call_id) ||
            !boundedId(p.started_event_id, true) ||
            !boundedId(p.called_event_id, true) ||
            !boundedId(p.success_event_id, true) ||
            new Set([p.started_event_id, p.called_event_id, p.success_event_id]).size !== 3 ||
            taskStateReportRawGuard(p.report) !== undefined ||
            parseTaskStateReportInput(p.report).state !== 'complete'
        ) {
            return;
        }
        return p as unknown as ReceiptPayload;
    } catch {
        return;
    }
}

export interface OpencodeTaskStateReceiptDependencies {
    dbPath?: string;
    openDatabase?: typeof openDb;
    now?: () => number;
    log?: (line: string) => void;
}

export async function runOpencodeTaskStateReceipt(
    raw: string,
    dependencies: OpencodeTaskStateReceiptDependencies = {},
): Promise<'stored' | 'duplicate' | 'unavailable'> {
    const report = (reason: string): 'unavailable' => {
        (dependencies.log ?? appendHookLog)(`task-state-receipt opencode: ${reason}`);
        return 'unavailable';
    };
    const payload = parseOpencodeTaskStateReceipt(raw);
    if (!payload) {
        return report('invalid_payload');
    }
    const parsed = parseTaskStateReportInput(payload.report);
    if (parsed.state !== 'complete') {
        return report('invalid_report');
    }
    // Hash the validated canonical projection; no model-authored report text
    // reaches durable receipt storage or hook logs.
    const reportDigest = createHash('sha256').update(JSON.stringify(parsed.input)).digest('hex');
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
                    consent.isRefusedForCapture(payload.cwd) ||
                    consent.isRefusedForCapture(current.path) ||
                    !samePath(realpathSync(payload.cwd), canonical) ||
                    !samePath(realpathSync(current.path), canonical) ||
                    consent.consentStateForCanonicalPath(canonical) !== 'approved' ||
                    memory.isTranscriptCaptureBlocked('opencode', payload.session_id) ||
                    memory.isTranscriptIncognito('opencode', payload.session_id)
                ) {
                    return 'unavailable' as const;
                }
                return new OpencodeTaskStateReceiptStore(db).insert({
                    sessionId: current.id,
                    assistantMessageId: payload.assistant_message_id,
                    callId: payload.call_id,
                    startedEventId: payload.started_event_id,
                    calledEventId: payload.called_event_id,
                    successEventId: payload.success_event_id,
                    requestId: parsed.input.request_id,
                    reportDigest,
                    observedAt: new Date((dependencies.now ?? Date.now)()).toISOString(),
                });
            })
            .immediate();
        return outcome === 'conflict' || outcome === 'unavailable' ? report('receipt_conflict_or_unauthorized') : outcome;
    } catch {
        return report('receipt_error');
    } finally {
        db.close();
    }
}

export async function runOpencodeTaskStateReceiptCli(): Promise<void> {
    const watchdog = setTimeout(() => {
        appendHookLog('task-state-receipt opencode: watchdog_timeout');
        process.exit(0);
    }, HOOK_WATCHDOG_TIMEOUT_MS);
    try {
        const outcome = await runOpencodeTaskStateReceipt(await readStdin());
        if (outcome === 'stored' || outcome === 'duplicate') {
            process.stdout.write(OPENCODE_TASK_STATE_RECEIPT_ACK);
        }
    } catch {
        appendHookLog('task-state-receipt opencode: hook_error');
    } finally {
        clearTimeout(watchdog);
    }
}
