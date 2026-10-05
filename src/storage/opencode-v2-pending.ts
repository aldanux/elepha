import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';

export interface OpencodeV2PendingRow {
    native_id: string;
    observed_seq: number;
    observed_updated: number;
    retry_rank: number;
    needs_continuation: number;
    resume_cursor: string | null;
}

// Only source identity and progress are retained; no transcript text enters this queue.
export class OpencodeV2PendingStore {
    private readonly listStatement: Statement;
    private readonly countStatement: Statement;
    private readonly upsertStatement: Statement;
    private readonly touchStatement: Statement;
    private readonly deleteStatement: Statement;

    constructor(db: Database) {
        this.listStatement = db.prepare(`SELECT native_id, observed_seq, observed_updated, retry_rank, needs_continuation, resume_cursor
            FROM opencode_v2_pending WHERE source_path = ? ORDER BY retry_rank, native_id LIMIT ?`);
        this.countStatement = db.prepare('SELECT COUNT(*) AS count FROM opencode_v2_pending WHERE source_path = ?');
        this.upsertStatement = db.prepare(`INSERT INTO opencode_v2_pending
            (source_path, native_id, observed_seq, observed_updated, retry_rank, needs_continuation, resume_cursor)
            VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(retry_rank), -1) + 1 FROM opencode_v2_pending WHERE source_path = ?), ?, ?)
            ON CONFLICT (source_path, native_id) DO UPDATE SET
                observed_seq = excluded.observed_seq,
                observed_updated = excluded.observed_updated,
                retry_rank = (SELECT MAX(retry_rank) + 1 FROM opencode_v2_pending WHERE source_path = excluded.source_path),
                needs_continuation = excluded.needs_continuation,
                resume_cursor = excluded.resume_cursor`);
        this.touchStatement = db.prepare(`UPDATE opencode_v2_pending
            SET retry_rank = (SELECT MAX(retry_rank) + 1 FROM opencode_v2_pending WHERE source_path = ?)
            WHERE source_path = ? AND native_id = ?`);
        this.deleteStatement = db.prepare('DELETE FROM opencode_v2_pending WHERE source_path = ? AND native_id = ?');
    }

    list(sourcePath: string, limit: number): OpencodeV2PendingRow[] {
        return this.listStatement.all(sourcePath, limit) as OpencodeV2PendingRow[];
    }

    count(sourcePath: string): number {
        return (this.countStatement.get(sourcePath) as { count: number }).count;
    }

    upsert(
        sourcePath: string,
        nativeId: string,
        revision: { seq: number; updated: number },
        needsContinuation: boolean,
        resumeCursor?: string,
    ): void {
        this.upsertStatement.run(
            sourcePath,
            nativeId,
            revision.seq,
            revision.updated,
            sourcePath,
            Number(needsContinuation),
            resumeCursor ?? null,
        );
    }

    touch(sourcePath: string, nativeId: string): void {
        this.touchStatement.run(sourcePath, sourcePath, nativeId);
    }

    delete(sourcePath: string, nativeId: string): void {
        this.deleteStatement.run(sourcePath, nativeId);
    }
}
