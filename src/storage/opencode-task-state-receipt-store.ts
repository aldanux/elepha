import type Database from 'better-sqlite3-multiple-ciphers';
import { OPENCODE_TASK_STATE_RECEIPTS_GLOBAL_MAX, OPENCODE_TASK_STATE_RECEIPTS_PER_SESSION } from '../config/constants.js';

export interface OpencodeTaskStateReceipt {
    sessionId: number;
    assistantMessageId: string;
    callId: string;
    startedEventId: string;
    calledEventId: string;
    successEventId: string;
    requestId: string;
    reportDigest: string;
    observedAt: string;
}

export class OpencodeTaskStateReceiptStore {
    constructor(private readonly db: Database.Database) {}

    insert(input: OpencodeTaskStateReceipt): 'stored' | 'duplicate' | 'conflict' {
        const existing = this.db
            .prepare(`SELECT session_id, assistant_message_id, call_id, started_event_id,
            called_event_id, success_event_id, request_id, report_digest FROM opencode_task_state_receipts
            WHERE (session_id = ? AND assistant_message_id = ? AND call_id = ?) OR success_event_id = ?`)
            .get(input.sessionId, input.assistantMessageId, input.callId, input.successEventId) as
            | Record<string, string | number>
            | undefined;
        if (existing) {
            return existing.session_id === input.sessionId &&
                existing.assistant_message_id === input.assistantMessageId &&
                existing.call_id === input.callId &&
                existing.started_event_id === input.startedEventId &&
                existing.called_event_id === input.calledEventId &&
                existing.success_event_id === input.successEventId &&
                existing.request_id === input.requestId &&
                existing.report_digest === input.reportDigest
                ? 'duplicate'
                : 'conflict';
        }
        this.db
            .prepare(`INSERT INTO opencode_task_state_receipts
            (session_id, assistant_message_id, call_id, started_event_id, called_event_id,
             success_event_id, request_id, report_digest, observed_at, coverage)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'volatile_unverified')`)
            .run(
                input.sessionId,
                input.assistantMessageId,
                input.callId,
                input.startedEventId,
                input.calledEventId,
                input.successEventId,
                input.requestId,
                input.reportDigest,
                input.observedAt,
            );
        this.db
            .prepare(`DELETE FROM opencode_task_state_receipts WHERE session_id = ? AND id NOT IN
            (SELECT id FROM opencode_task_state_receipts WHERE session_id = ? ORDER BY id DESC LIMIT ?)`)
            .run(input.sessionId, input.sessionId, OPENCODE_TASK_STATE_RECEIPTS_PER_SESSION);
        this.db
            .prepare(`DELETE FROM opencode_task_state_receipts WHERE id NOT IN
            (SELECT id FROM opencode_task_state_receipts ORDER BY id DESC LIMIT ?)`)
            .run(OPENCODE_TASK_STATE_RECEIPTS_GLOBAL_MAX);
        return 'stored';
    }
}
