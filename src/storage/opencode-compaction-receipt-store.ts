import type Database from 'better-sqlite3-multiple-ciphers';
import { OPENCODE_COMPACTION_RECEIPTS_GLOBAL_MAX, OPENCODE_COMPACTION_RECEIPTS_PER_SESSION } from '../config/constants.js';
import { stripShellSyntax } from '../security/sanitize.js';

export interface OpencodeCompactionReceipt {
    sessionId: number;
    text: string;
    reason: string;
    observedAt: string;
}

export class OpencodeCompactionReceiptStore {
    constructor(private readonly db: Database.Database) {}

    insert(input: OpencodeCompactionReceipt): void {
        // Text is an unverified observation from a volatile host callback. It
        // must never be treated as proof of retained state or source evidence.
        const summary = stripShellSyntax(input.text);
        const reason = stripShellSyntax(input.reason);
        // The host event has no stable ID. Every delivery is a separate
        // observation; identical summaries may be distinct compactions.
        this.db
            .prepare(`INSERT INTO opencode_compaction_receipts
                (session_id, summary, reason, observed_at, coverage)
                VALUES (?, ?, ?, ?, 'volatile_unverified')`)
            .run(input.sessionId, summary, reason, input.observedAt);
        this.db
            .prepare(`DELETE FROM opencode_compaction_receipts WHERE session_id = ? AND id NOT IN
            (SELECT id FROM opencode_compaction_receipts WHERE session_id = ? ORDER BY id DESC LIMIT ?)`)
            .run(input.sessionId, input.sessionId, OPENCODE_COMPACTION_RECEIPTS_PER_SESSION);
        this.db
            .prepare(`DELETE FROM opencode_compaction_receipts WHERE id NOT IN
            (SELECT id FROM opencode_compaction_receipts ORDER BY id DESC LIMIT ?)`)
            .run(OPENCODE_COMPACTION_RECEIPTS_GLOBAL_MAX);
    }
}
