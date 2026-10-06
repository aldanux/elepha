import type Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { SUPPORTED_TOOLS } from '../../src/types/index.js';

function tableSchema(db: Database.Database, table: 'sessions' | 'shown_session_lists'): string {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
}

function checkedTools(schema: string): string[] {
    const match = /CHECK \(tool IN \(([^)]+)\)\)/.exec(schema);
    if (match?.[1] === undefined) {
        throw new Error('tool CHECK missing from schema');
    }
    return match[1].split(',').map((literal) => literal.trim().slice(1, -1).replaceAll("''", "'"));
}

describe('tool CHECK migration', () => {
    it('creates a fresh DB with a CHECK covering every supported tool', () => {
        const db = openUnmanagedDb(':memory:');
        expect(checkedTools(tableSchema(db, 'sessions'))).toEqual(SUPPORTED_TOOLS);
        expect(checkedTools(tableSchema(db, 'shown_session_lists'))).toEqual(SUPPORTED_TOOLS);
        db.close();
    });
});
