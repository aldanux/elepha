// Logical live-memory ledger: one running byte total over every persisted
// representation of retained memory evidence.
//
// The total is logical, not physical. Text and JSON fields count as their
// UTF-8 bytes, vector BLOBs as their byte length, and NULL as zero. Each
// representation counts once. The external-content FTS index over
// filtered_turns is charged one byte per UTF-8 byte of each live row's indexed
// fields rather than measured: FTS5 keeps immutable segments and deletion
// markers until a merge, so shadow-table bytes would give identical live
// evidence a different total depending on merge history. SQLite file size,
// free pages, provider transcripts, and control records (paths, cursors,
// hashes, timestamps, status, coverage, receipts, injections, rules, consent)
// are outside the ledger.
//
// The fixed live-memory retention policy reads this ledger to decide when a
// capture write reaches capacity, then remeasures the stored rows before it
// removes anything. The older durable_capture_usage counter no longer drives
// any policy.
//
// Row triggers keep the total current inside the same SQLite transaction as
// every insert, update, and delete, including foreign-key cascades, so no
// writer needs to know about the ledger and a rollback also rolls back the
// charge. Opening a database whose ledger is missing, incomplete, or
// noncanonical reinstalls the canonical triggers and measures the total once.

import type { Database } from 'better-sqlite3-multiple-ciphers';
import { LIVE_MEMORY_CAPACITY_BYTES } from '../config/live-memory-retention.js';
import {
    configureLiveMemoryCapacity,
    ensureLiveMemoryCapacity,
    LIVE_MEMORY_CAPACITY_GUARD_TRIGGER,
    LiveMemoryCapacityError,
    liveMemoryCapacityGuardSql,
    withLiveMemoryCapacityGuardBypassed,
} from './live-memory-capacity-guard.js';

export const LIVE_MEMORY_USAGE_TABLE = 'live_memory_usage';

interface LiveMemoryTable {
    table: string;
    // How a row reaches its session: the session row itself, a session_id
    // column, or a memory_id column naming a turn of that session.
    owner: 'session' | 'session_id' | 'memory_id';
    // Persisted evidence fields, each charged at its stored byte length.
    stored: readonly string[];
    // Fields indexed by an FTS table, each charged once more as logical index input.
    indexed: readonly string[];
}

// The approved field inventory. Adding a table or column here changes what
// live memory means; every other field in the schema is control metadata.
const LIVE_MEMORY_INVENTORY: readonly LiveMemoryTable[] = [
    { table: 'sessions', owner: 'session', stored: ['title', 'custom_title', 'first_prompt_search'], indexed: [] },
    { table: 'memories', owner: 'session_id', stored: ['decisions', 'files_touched', 'pending_items'], indexed: [] },
    {
        table: 'session_rollups',
        owner: 'session_id',
        stored: ['title', 'summary', 'decisions', 'instructions', 'pending_items', 'files_touched'],
        indexed: [],
    },
    { table: 'task_state_manifests', owner: 'memory_id', stored: ['report'], indexed: [] },
    {
        table: 'filtered_turns',
        owner: 'memory_id',
        stored: ['user_prompt', 'assistant_response', 'tool_calls', 'assistant_structure'],
        indexed: ['user_prompt', 'assistant_response', 'tool_calls'],
    },
    {
        table: 'open_turns',
        owner: 'session_id',
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
    { table: 'session_embeddings', owner: 'session_id', stored: ['vector'], indexed: [] },
    { table: 'turn_embeddings', owner: 'memory_id', stored: ['vector'], indexed: [] },
];

// Text is stored UTF-8 in elepha databases, so the BLOB cast yields its UTF-8
// bytes; a BLOB is already its own byte length.
function rowBytes(entry: LiveMemoryTable, row: 'new' | 'old' | 'x' | undefined): string {
    const column = (name: string) => (row === undefined ? name : `${row}.${name}`);
    return [...entry.stored, ...entry.indexed].map((name) => `COALESCE(length(CAST(${column(name)} AS BLOB)), 0)`).join(' + ');
}

interface TriggerDefinition {
    name: string;
    table: string;
    sql: string;
}

// The definitions as SQLite stores them in sqlite_master.
const LIVE_MEMORY_LEDGER_TRIGGERS: readonly TriggerDefinition[] = LIVE_MEMORY_INVENTORY.flatMap((entry) => {
    const update = (delta: string) => `UPDATE ${LIVE_MEMORY_USAGE_TABLE} SET total_bytes = total_bytes ${delta} WHERE id = 1;`;
    const prefix = `live_memory_${entry.table}`;
    return [
        {
            name: `${prefix}_ai`,
            table: entry.table,
            sql: `CREATE TRIGGER ${prefix}_ai AFTER INSERT ON ${entry.table} BEGIN
  ${update(`+ (${rowBytes(entry, 'new')})`)}
END`,
        },
        {
            name: `${prefix}_ad`,
            table: entry.table,
            sql: `CREATE TRIGGER ${prefix}_ad AFTER DELETE ON ${entry.table} BEGIN
  ${update(`- (${rowBytes(entry, 'old')})`)}
END`,
        },
        {
            name: `${prefix}_au`,
            table: entry.table,
            sql: `CREATE TRIGGER ${prefix}_au AFTER UPDATE OF ${entry.stored.join(', ')} ON ${entry.table} BEGIN
  ${update(`- (${rowBytes(entry, 'old')}) + (${rowBytes(entry, 'new')})`)}
END`,
        },
    ];
});

// The capacity guard sits on the ledger row itself and is installed, verified
// and admitted exactly like the ledger's own triggers.
const LIVE_MEMORY_TRIGGERS: readonly TriggerDefinition[] = [
    ...LIVE_MEMORY_LEDGER_TRIGGERS,
    {
        name: LIVE_MEMORY_CAPACITY_GUARD_TRIGGER,
        table: LIVE_MEMORY_USAGE_TABLE,
        sql: liveMemoryCapacityGuardSql(LIVE_MEMORY_USAGE_TABLE),
    },
];

// Project exports and restore admission name these so they can exclude or
// admit exactly the ledger triggers and nothing else.
export const LIVE_MEMORY_TRIGGER_NAMES: readonly string[] = LIVE_MEMORY_TRIGGERS.map((trigger) => trigger.name);

// [table, trigger] pairs, for SQL that admits a ledger trigger only on its own table.
export const LIVE_MEMORY_TRIGGER_TABLES_JSON = JSON.stringify(LIVE_MEMORY_TRIGGERS.map((trigger) => [trigger.table, trigger.name]));

const LEDGER_SCHEMA = `CREATE TABLE IF NOT EXISTS ${LIVE_MEMORY_USAGE_TABLE} (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0)
)`;

function normalizedSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

const TRIGGER_SQL_LIMIT = Math.max(...LIVE_MEMORY_TRIGGERS.map((trigger) => trigger.sql.length)) * 2;

// Full measurement from the stored rows, independent of the ledger.
export function measureLiveMemoryBytes(db: Database): number {
    const terms = LIVE_MEMORY_INVENTORY.map((entry) => `(SELECT COALESCE(SUM(${rowBytes(entry, undefined)}), 0) FROM ${entry.table})`);
    const row = db.prepare(`SELECT ${terms.join(' + ')} AS total_bytes`).get() as { total_bytes: number };
    return Number(row.total_bytes);
}

export interface NativeSessionLiveMemory {
    tool: string;
    native_id: string;
    // Per counted table: rows owned by this native session and their bytes.
    tables: Record<string, { rows: number; bytes: number }>;
    bytes: number;
}

// Measures the rows each native session owns across every segment, from the
// stored rows rather than the ledger. With identitiesJson (a JSON array of
// [tool, native_id] pairs) only those native sessions are measured. Rows whose
// owning session no longer exists belong to no native session. schema names an
// attached copy, such as a backup being verified.
export function measureLiveMemoryByNativeSession(
    db: Database,
    identitiesJson?: string,
    schema = 'main',
): Map<string, NativeSessionLiveMemory> {
    const scope =
        identitiesJson === undefined
            ? ''
            : `WHERE EXISTS (SELECT 1 FROM json_each(?) j WHERE json_extract(j.value, '$[0]') = s.tool AND json_extract(j.value, '$[1]') = s.native_id)`;
    const result = new Map<string, NativeSessionLiveMemory>();
    for (const entry of LIVE_MEMORY_INVENTORY) {
        const owner =
            entry.owner === 'session'
                ? `JOIN ${schema}.sessions s ON s.id = x.id`
                : entry.owner === 'session_id'
                  ? `JOIN ${schema}.sessions s ON s.id = x.session_id`
                  : `JOIN ${schema}.memories om ON om.id = x.memory_id JOIN ${schema}.sessions s ON s.id = om.session_id`;
        const statement = db.prepare(
            `SELECT s.tool, s.native_id, COUNT(*) AS row_count, COALESCE(SUM(${rowBytes(entry, 'x')}), 0) AS bytes
             FROM ${schema}.${entry.table} x ${owner} ${scope}
             GROUP BY s.tool, s.native_id`,
        );
        const rows = (identitiesJson === undefined ? statement.all() : statement.all(identitiesJson)) as Array<{
            tool: string;
            native_id: string;
            row_count: number;
            bytes: number;
        }>;
        for (const row of rows) {
            const key = nativeSessionKey(row.tool, row.native_id);
            const current = result.get(key) ?? { tool: row.tool, native_id: row.native_id, tables: {}, bytes: 0 };
            current.tables[entry.table] = { rows: Number(row.row_count), bytes: Number(row.bytes) };
            current.bytes += Number(row.bytes);
            result.set(key, current);
        }
    }
    return result;
}

export function nativeSessionKey(tool: string, nativeId: string): string {
    return JSON.stringify([tool, nativeId]);
}

interface StoredTrigger {
    name: string;
    tbl_name: string;
    sql: string | null;
    sql_length: number;
}

// Every stored trigger under a ledger name, read with bounded size so a
// hostile schema cannot force an unbounded copy.
function storedLedgerTriggers(db: Database): StoredTrigger[] {
    return db
        .prepare(
            `SELECT name, tbl_name, substr(sql, 1, ?) AS sql, length(COALESCE(sql, '')) AS sql_length
             FROM sqlite_master
             WHERE type = 'trigger' AND lower(name) IN (SELECT value FROM json_each(?))
             LIMIT ?`,
        )
        .all(TRIGGER_SQL_LIMIT + 1, JSON.stringify(LIVE_MEMORY_TRIGGER_NAMES), LIVE_MEMORY_TRIGGERS.length + 1) as StoredTrigger[];
}

function isCanonical(row: StoredTrigger): boolean {
    const definition = LIVE_MEMORY_TRIGGERS.find((trigger) => trigger.name === row.name);
    return (
        definition !== undefined &&
        row.tbl_name === definition.table &&
        row.sql !== null &&
        row.sql_length <= TRIGGER_SQL_LIMIT &&
        normalizedSql(row.sql) === normalizedSql(definition.sql)
    );
}

// True when a trigger under a ledger name differs from what elepha writes.
// Absent triggers are not reported: migration creates them. Restore uses this
// before migrating a candidate, so a substituted ledger trigger never fires.
export function hasNoncanonicalLiveMemoryTrigger(db: Database): boolean {
    const stored = storedLedgerTriggers(db);
    return stored.length > LIVE_MEMORY_TRIGGERS.length || !stored.every(isCanonical);
}

function ledgerIsCanonical(db: Database): boolean {
    if (db.prepare(`SELECT 1 FROM ${LIVE_MEMORY_USAGE_TABLE} WHERE id = 1`).get() === undefined) {
        return false;
    }
    const stored = storedLedgerTriggers(db);
    return stored.length === LIVE_MEMORY_TRIGGERS.length && stored.every(isCanonical);
}

// Replaces every ledger trigger with its canonical definition and sets the
// total to a fresh measurement, atomically. Only ledger objects change; no
// evidence row is read for anything but its length.
function installLedger(db: Database): void {
    const present = db
        .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'trigger' AND lower(name) IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(LIVE_MEMORY_TRIGGER_NAMES)) as Array<{ name: string }>;
    for (const { name } of present) {
        db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    }
    for (const trigger of LIVE_MEMORY_TRIGGERS) {
        db.exec(trigger.sql);
    }
    // Correcting a stale total adds no evidence, so the capacity guard does
    // not apply; restore checks capacity explicitly.
    ensureLiveMemoryCapacity(db);
    withLiveMemoryCapacityGuardBypassed(db, () => setLiveMemoryTotal(db, measureLiveMemoryBytes(db)));
}

function setLiveMemoryTotal(db: Database, totalBytes: number): void {
    db.prepare(
        `INSERT INTO ${LIVE_MEMORY_USAGE_TABLE} (id, total_bytes) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET total_bytes = excluded.total_bytes`,
    ).run(totalBytes);
}

// Idempotent on every open. Must run after every counted table exists and
// after any migration that rebuilds a counted table, because dropping a table
// drops its triggers. A converged database only reads sqlite_master and the
// ledger row; a fresh, upgraded, or altered one is measured once.
export function migrateLiveMemoryUsage(db: Database): void {
    db.transaction(() => {
        db.exec(LEDGER_SCHEMA);
        configureLiveMemoryCapacity(db);
        if (!ledgerIsCanonical(db)) {
            installLedger(db);
        }
    })();
}

// Restore and repair rebuild the ledger from the stored rows instead of
// trusting a total carried in from another database. Joins the caller's
// transaction when one is open.
export function reconcileLiveMemoryUsage(db: Database): number {
    return db.transaction(() => {
        db.exec(LEDGER_SCHEMA);
        installLedger(db);
        return readLiveMemoryUsage(db);
    })();
}

// For bulk writes that cannot run automatic cleanup: call inside the write
// transaction, before commit, with the total read when it began. A result that
// grew to capacity or beyond throws, so the transaction rolls back whole.
export function assertLiveMemoryBulkWrite(db: Database, beforeBytes: number, capacityBytes: number = LIVE_MEMORY_CAPACITY_BYTES): void {
    const after = readLiveMemoryUsage(db);
    if (after > beforeBytes && after >= capacityBytes) {
        throw new LiveMemoryCapacityError(after, capacityBytes);
    }
}

export function readLiveMemoryUsage(db: Database): number {
    const row = db.prepare(`SELECT total_bytes FROM ${LIVE_MEMORY_USAGE_TABLE} WHERE id = 1`).get() as { total_bytes: number } | undefined;
    if (row === undefined) {
        throw new Error('Live-memory usage ledger is not initialized.');
    }
    return Number(row.total_bytes);
}
