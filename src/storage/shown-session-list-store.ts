import type { Database, Statement } from 'better-sqlite3';
import type { ToolName } from '../types/index.js';

interface ShownSessionListRow {
    session_ids: string;
}

export class ShownSessionListStore {
    private readonly replaceList: Statement;
    private readonly listForChat: Statement;

    constructor(db: Database) {
        this.replaceList = db.prepare(
            `INSERT INTO shown_session_lists (tool, native_session_id, session_ids)
             VALUES (?, ?, ?)
             ON CONFLICT(tool, native_session_id) DO UPDATE SET session_ids = excluded.session_ids`,
        );
        this.listForChat = db.prepare('SELECT session_ids FROM shown_session_lists WHERE tool = ? AND native_session_id = ?');
    }

    // Replaces the complete ordered list so one chat can only open what it was most recently shown.
    replace(tool: ToolName, nativeSessionId: string, sessionIds: readonly number[]): void {
        this.replaceList.run(tool, nativeSessionId, JSON.stringify(sessionIds));
    }

    // Undefined means no list has ever been shown; an empty array is a shown list with no rows.
    forChat(tool: ToolName, nativeSessionId: string): number[] | undefined {
        const row = this.listForChat.get(tool, nativeSessionId) as ShownSessionListRow | undefined;
        if (row === undefined) {
            return undefined;
        }
        let decoded: unknown;
        try {
            decoded = JSON.parse(row.session_ids);
        } catch {
            throw new Error('stored shown session list is invalid');
        }
        if (!Array.isArray(decoded) || !decoded.every((id) => Number.isSafeInteger(id) && id > 0)) {
            throw new Error('stored shown session list is invalid');
        }
        return decoded as number[];
    }
}
