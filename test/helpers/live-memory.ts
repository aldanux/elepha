import type Database from 'better-sqlite3-multiple-ciphers';
import { expect } from 'vitest';
import { LIVE_MEMORY_TRIGGER_NAMES, LIVE_MEMORY_USAGE_TABLE } from '../../src/storage/live-memory-usage.js';

// The approved live-memory field inventory, retyped from the specification
// rather than imported, so the measurement below is independent of the
// ledger's own SQL. Indexed fields carry the logical FTS input charge.
const APPROVED_INVENTORY: Record<string, { stored: string[]; indexed: string[] }> = {
    sessions: { stored: ['title', 'custom_title', 'first_prompt_search'], indexed: [] },
    memories: { stored: ['decisions', 'files_touched', 'pending_items'], indexed: [] },
    session_rollups: { stored: ['title', 'summary', 'decisions', 'instructions', 'pending_items', 'files_touched'], indexed: [] },
    task_state_manifests: { stored: ['report'], indexed: [] },
    filtered_turns: {
        stored: ['user_prompt', 'assistant_response', 'tool_calls', 'assistant_structure'],
        indexed: ['user_prompt', 'assistant_response', 'tool_calls'],
    },
    open_turns: {
        stored: [
            'decisions',
            'pending_items',
            'durable_user_prompt',
            'durable_assistant_response',
            'durable_assistant_structure',
            'durable_tool_calls',
        ],
        indexed: [],
    },
    session_embeddings: { stored: ['vector'], indexed: [] },
    turn_embeddings: { stored: ['vector'], indexed: [] },
};

function valueBytes(value: unknown): number {
    if (value === null || value === undefined) {
        return 0;
    }
    if (Buffer.isBuffer(value)) {
        return value.byteLength;
    }
    return Buffer.byteLength(String(value), 'utf8');
}

// Reads every counted field in JavaScript and sums UTF-8 and BLOB lengths.
export function independentLiveMemoryBytes(db: Database.Database): number {
    let total = 0;
    for (const [table, { stored, indexed }] of Object.entries(APPROVED_INVENTORY)) {
        for (const row of db.prepare(`SELECT ${stored.join(', ')} FROM ${table}`).iterate() as Iterable<Record<string, unknown>>) {
            for (const column of [...stored, ...indexed]) {
                total += valueBytes(row[column]);
            }
        }
    }
    return total;
}

export function ledgerBytes(db: Database.Database): number {
    const rows = db.prepare('SELECT id, total_bytes FROM live_memory_usage').all() as Array<{ id: number; total_bytes: number }>;
    expect(rows).toHaveLength(1);
    return rows[0]?.total_bytes ?? Number.NaN;
}

export function expectLiveMemoryCurrent(db: Database.Database): void {
    expect(ledgerBytes(db)).toBe(independentLiveMemoryBytes(db));
}

// Legacy fixtures are built from a current database; a database written
// before the ledger existed has neither its table nor its triggers, and those
// triggers would block the column drops that model older schemas.
export function dropLiveMemoryLedger(db: Database.Database): void {
    for (const name of LIVE_MEMORY_TRIGGER_NAMES) {
        db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }
    db.exec(`DROP TABLE IF EXISTS ${LIVE_MEMORY_USAGE_TABLE}`);
}
