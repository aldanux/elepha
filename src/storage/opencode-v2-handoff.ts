import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';

export type OpencodeV2HandoffStatus = 'waiting' | 'active' | 'abstained';

export interface OpencodeV2HandoffRow {
    native_id: string;
    source_path: string;
    status: OpencodeV2HandoffStatus;
    v1_cursor: string | null;
    turn_index_offset: number | null;
    observed_seq: number;
    observed_updated: number;
    observed_v1_updated: number;
    needs_continuation: number;
    reason: string | null;
}

export interface OpencodeV2HandoffObservation {
    status: OpencodeV2HandoffStatus;
    v1Cursor?: string;
    turnIndexOffset?: number;
    revision: { seq: number; updated: number; v1Updated: number };
    needsContinuation: boolean;
    reason?: string;
}

// Only identity, cursors, and integers are retained; no transcript text enters
// this table. A persisted turn-index offset is never replaced once set, so a
// restarted daemon maps every V2 turn to the same native-wide index. A row is
// bound to the canonical source database that created it: its V1 cursor and
// offset were verified against that source only, so an observation from any
// other source path is refused rather than rebinding that authority.
export class OpencodeV2HandoffStore {
    private readonly getStatement: Statement;
    private readonly upsertStatement: Statement;
    private readonly listContinuationStatement: Statement;

    constructor(db: Database) {
        this.getStatement = db.prepare('SELECT * FROM opencode_v2_handoffs WHERE native_id = ?');
        this.upsertStatement = db.prepare(`INSERT INTO opencode_v2_handoffs
            (native_id, source_path, status, v1_cursor, turn_index_offset, observed_seq, observed_updated,
             observed_v1_updated, needs_continuation, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (native_id) DO UPDATE SET
                status = excluded.status,
                v1_cursor = COALESCE(opencode_v2_handoffs.v1_cursor, excluded.v1_cursor),
                turn_index_offset = COALESCE(opencode_v2_handoffs.turn_index_offset, excluded.turn_index_offset),
                observed_seq = excluded.observed_seq,
                observed_updated = excluded.observed_updated,
                observed_v1_updated = excluded.observed_v1_updated,
                needs_continuation = excluded.needs_continuation,
                reason = excluded.reason
            WHERE opencode_v2_handoffs.source_path = excluded.source_path`);
        this.listContinuationStatement = db.prepare(`SELECT native_id FROM opencode_v2_handoffs
            WHERE source_path = ? AND needs_continuation = 1 ORDER BY native_id LIMIT ?`);
    }

    get(nativeId: string): OpencodeV2HandoffRow | undefined {
        return this.getStatement.get(nativeId) as OpencodeV2HandoffRow | undefined;
    }

    // False when the native id is already bound to a different source path.
    upsert(nativeId: string, sourcePath: string, observation: OpencodeV2HandoffObservation): boolean {
        const result = this.upsertStatement.run(
            nativeId,
            sourcePath,
            observation.status,
            observation.v1Cursor ?? null,
            observation.turnIndexOffset ?? null,
            observation.revision.seq,
            observation.revision.updated,
            observation.revision.v1Updated,
            Number(observation.needsContinuation),
            observation.reason ?? null,
        );
        return result.changes > 0;
    }

    listNeedingContinuation(sourcePath: string, limit: number): string[] {
        return (this.listContinuationStatement.all(sourcePath, limit) as Array<{ native_id: string }>).map((row) => row.native_id);
    }
}
