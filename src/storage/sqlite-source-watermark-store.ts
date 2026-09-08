import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';
import type { ToolName } from '../types/index.js';
import { SQLITE_SOURCE_WATERMARK_SCHEMA } from './db.js';

export class SqliteSourceWatermarkStore {
    private readonly getStatement: Statement;
    private readonly setStatement: Statement;

    constructor(db: Database) {
        const { table, tool, sourcePath, watermark } = SQLITE_SOURCE_WATERMARK_SCHEMA;
        this.getStatement = db.prepare(`SELECT ${watermark} FROM ${table} WHERE ${tool} = ? AND ${sourcePath} = ?`);
        this.setStatement = db.prepare(
            `INSERT INTO ${table} (${tool}, ${sourcePath}, ${watermark}) VALUES (?, ?, ?)
             ON CONFLICT (${tool}, ${sourcePath}) DO UPDATE SET ${watermark} = excluded.${watermark}`,
        );
    }

    get(tool: ToolName, sourcePath: string): number | undefined {
        const row = this.getStatement.get(tool, sourcePath) as { watermark: number } | undefined;
        return row?.watermark;
    }

    set(tool: ToolName, sourcePath: string, watermark: number): void {
        this.setStatement.run(tool, sourcePath, watermark);
    }
}
