import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';
import type { ToolName } from '../types/index.js';
import { SQLITE_SOURCE_WATERMARK_SCHEMA } from './db.js';

export class SqliteSourceWatermarkStore {
    private readonly getCursorStatement: Statement;
    private readonly setCursorStatement: Statement;

    constructor(db: Database) {
        const { table, tool, sourcePath, watermark, cursorId } = SQLITE_SOURCE_WATERMARK_SCHEMA;
        this.getCursorStatement = db.prepare(`SELECT ${watermark}, ${cursorId} FROM ${table} WHERE ${tool} = ? AND ${sourcePath} = ?`);
        this.setCursorStatement = db.prepare(
            `INSERT INTO ${table} (${tool}, ${sourcePath}, ${watermark}, ${cursorId}) VALUES (?, ?, ?, ?)
             ON CONFLICT (${tool}, ${sourcePath}) DO UPDATE SET
             ${watermark} = excluded.${watermark}, ${cursorId} = excluded.${cursorId}`,
        );
    }

    getCursor(tool: ToolName, sourcePath: string): { watermark: number; cursorId?: string } | undefined {
        const row = this.getCursorStatement.get(tool, sourcePath) as { watermark: number; cursor_id: string | null } | undefined;
        return row === undefined ? undefined : { watermark: row.watermark, cursorId: row.cursor_id ?? undefined };
    }

    setCursor(tool: ToolName, sourcePath: string, cursor: { watermark: number; cursorId: string }): void {
        this.setCursorStatement.run(tool, sourcePath, cursor.watermark, cursor.cursorId);
    }
}
