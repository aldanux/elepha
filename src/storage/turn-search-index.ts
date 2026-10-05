// Private, derived per-turn coverage index over retained filtered copies.
//
// Lexical search runs on filtered_turns_fts alone; this table holds no text.
// It records, per memory, whether a retained current copy exists, how the
// bounded per-turn projection of that copy was cut (included, truncated, or
// excluded, with the omitted character counts), and the source locator and
// digest that stored-evidence checks and turn embeddings pin against.
//
// Rows are keyed by memories.id and exist only while that memory's filtered
// copy is retained in filtered_turns: a row is written from the stored copy
// in the transaction that wrote it, so coverage never stands for text whose
// only remaining location is a provider transcript. Delete triggers on
// memories and on filtered_turns clear the coverage row, so every deletion
// (eviction, purge, incognito, reconciliation, repair, restore, import
// replacement) stays consistent without each caller knowing about this index.
// A memory with no coverage row therefore has no retained, current copy: it is
// a coverage gap, never an empty turn.

import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';
import { TURN_SEARCH_INDEX_MAX_FIELD_CHARS, TURN_SEARCH_REBUILD_BATCH_SIZE } from '../config/constants.js';
import type { ParsedTurn, ToolName } from '../types/index.js';
import { encodeResumeContext } from './source-resume-context.js';
import { sourceTurnDigest } from './source-turn-digest.js';

export const TURN_SEARCH_INDEX_TABLE = 'turn_search_index';
// Project exports omit the derived index tables, so this trigger must not be
// copied into them either: it would name tables the export does not contain.
export const TURN_SEARCH_CLEANUP_TRIGGER = 'memories_turn_search_ad';
// filtered_turns is never exported, so this trigger needs no export exclusion.
export const TURN_SEARCH_COPY_CLEANUP_TRIGGER = 'filtered_turns_turn_search_ad';

// An earlier schema kept a second, unused set of postings beside
// filtered_turns_fts, plus a marker gating their one-time reconciliation.
// Neither belongs to the current schema; the names stay so migration can
// retire them and integrity checks can reject any object still using them.
export const RETIRED_TURN_SEARCH_FTS_TABLE = 'turn_search_fts';
export const RETIRED_TURN_SEARCH_STATE_TABLE = 'turn_search_state';
// The retired marker's final value. A database at this value already
// reconciled its coverage rows against the retained copies; below it, or
// without the marker, coverage is reconciled once more before retirement.
const RETIRED_POSTINGS_VERSION = 1;

interface SchemaDefinition {
    type: 'table' | 'trigger';
    name: string;
    tblName: string;
    sql: string;
}

// The current cleanup triggers, as SQLite stores them.
const CLEANUP_TRIGGERS: readonly SchemaDefinition[] = [
    {
        type: 'trigger',
        name: TURN_SEARCH_CLEANUP_TRIGGER,
        tblName: 'memories',
        sql: `CREATE TRIGGER ${TURN_SEARCH_CLEANUP_TRIGGER} AFTER DELETE ON memories BEGIN
  DELETE FROM ${TURN_SEARCH_INDEX_TABLE} WHERE memory_id = old.id;
END`,
    },
    {
        type: 'trigger',
        name: TURN_SEARCH_COPY_CLEANUP_TRIGGER,
        tblName: 'filtered_turns',
        sql: `CREATE TRIGGER ${TURN_SEARCH_COPY_CLEANUP_TRIGGER} AFTER DELETE ON filtered_turns BEGIN
  DELETE FROM ${TURN_SEARCH_INDEX_TABLE} WHERE memory_id = old.memory_id;
END`,
    },
];

// Every object the earlier schema wrote for the retired postings, as SQLite
// stores it: the FTS5 table with the shadow tables it owns, the marker, and
// cleanup triggers that also wrote to the postings.
const RETIRED_TABLES: readonly SchemaDefinition[] = [
    {
        type: 'table',
        name: RETIRED_TURN_SEARCH_FTS_TABLE,
        tblName: RETIRED_TURN_SEARCH_FTS_TABLE,
        sql: `CREATE VIRTUAL TABLE ${RETIRED_TURN_SEARCH_FTS_TABLE} USING fts5(
  user_text,
  assistant_text,
  content='',
  contentless_delete=1,
  detail=column
)`,
    },
    ...[
        ['data', '(id INTEGER PRIMARY KEY, block BLOB)'],
        ['idx', '(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID'],
        ['docsize', '(id INTEGER PRIMARY KEY, sz BLOB, origin INTEGER)'],
        ['config', '(k PRIMARY KEY, v) WITHOUT ROWID'],
    ].map(([suffix, body]): SchemaDefinition => {
        const name = `${RETIRED_TURN_SEARCH_FTS_TABLE}_${suffix}`;
        return { type: 'table', name, tblName: name, sql: `CREATE TABLE '${name}'${body}` };
    }),
    {
        type: 'table',
        name: RETIRED_TURN_SEARCH_STATE_TABLE,
        tblName: RETIRED_TURN_SEARCH_STATE_TABLE,
        sql: `CREATE TABLE ${RETIRED_TURN_SEARCH_STATE_TABLE} (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  postings_version INTEGER NOT NULL
)`,
    },
];

const RETIRED_TRIGGERS: readonly SchemaDefinition[] = [
    {
        type: 'trigger',
        name: TURN_SEARCH_CLEANUP_TRIGGER,
        tblName: 'memories',
        sql: `CREATE TRIGGER ${TURN_SEARCH_CLEANUP_TRIGGER} AFTER DELETE ON memories BEGIN
  DELETE FROM ${RETIRED_TURN_SEARCH_FTS_TABLE} WHERE rowid = old.id;
  DELETE FROM ${TURN_SEARCH_INDEX_TABLE} WHERE memory_id = old.id;
END`,
    },
    {
        type: 'trigger',
        name: TURN_SEARCH_COPY_CLEANUP_TRIGGER,
        tblName: 'filtered_turns',
        sql: `CREATE TRIGGER ${TURN_SEARCH_COPY_CLEANUP_TRIGGER} AFTER DELETE ON filtered_turns BEGIN
  DELETE FROM ${RETIRED_TURN_SEARCH_FTS_TABLE} WHERE rowid = old.memory_id;
  DELETE FROM ${TURN_SEARCH_INDEX_TABLE} WHERE memory_id = old.memory_id;
END`,
    },
];

export const TURN_SEARCH_COVERAGES = ['included', 'truncated', 'excluded'] as const;
export type TurnSearchCoverage = (typeof TURN_SEARCH_COVERAGES)[number];

// A memory with no coverage row has no retained current copy: capture was
// off, the copy was refused, evicted, withdrawn, or superseded by a reingest
// that could not retain a replacement. That absence is distinct from every
// coverage value.
const TURN_SEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${TURN_SEARCH_INDEX_TABLE} (
  memory_id               INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  coverage                TEXT NOT NULL CHECK (coverage IN (${TURN_SEARCH_COVERAGES.map((coverage) => `'${coverage}'`).join(',')})),
  locator                 TEXT NOT NULL CHECK (locator IN ('available','unavailable')),
  source_cursor           TEXT,
  source_context          TEXT,
  source_digest           TEXT NOT NULL,
  omitted_user_chars      INTEGER NOT NULL CHECK (omitted_user_chars >= 0),
  omitted_assistant_chars INTEGER NOT NULL CHECK (omitted_assistant_chars >= 0),
  filter_version          INTEGER NOT NULL,
  indexed_at              TEXT NOT NULL,
  CHECK ((locator = 'available') = (source_cursor IS NOT NULL))
);

${CLEANUP_TRIGGERS.map((trigger) => `${trigger.sql.replace('CREATE TRIGGER', 'CREATE TRIGGER IF NOT EXISTS')};`).join('\n\n')}
`;

// Earlier versions indexed every stored turn, with or without a retained
// copy, and left the previous coverage in place when a reingest did not
// recapture the copy. Withdraw those rows using only database state; the
// provider transcript is never read here. A copy captured before the memory's
// latest reingest describes superseded text and does not count as current.
// Surviving rows are then re-derived from their copies, because earlier
// coverage was derived from the parsed turn rather than the stored copy.
const RECONCILE_ORPHANS = `
DELETE FROM ${TURN_SEARCH_INDEX_TABLE} WHERE NOT EXISTS (
  SELECT 1 FROM filtered_turns ft JOIN memories m ON m.id = ft.memory_id
  WHERE ft.memory_id = ${TURN_SEARCH_INDEX_TABLE}.memory_id
    AND (m.reingested_at IS NULL OR ft.captured_at >= m.reingested_at)
);
`;

function normalizedSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

const RETIRED_SQL_LIMIT = Math.max(...[...RETIRED_TABLES, ...RETIRED_TRIGGERS, ...CLEANUP_TRIGGERS].map((d) => d.sql.length)) * 2;

interface StoredObject {
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
    sql_length: number;
}

function matches(row: StoredObject, definition: SchemaDefinition): boolean {
    return (
        row.type === definition.type &&
        row.name === definition.name &&
        row.tbl_name === definition.tblName &&
        row.sql !== null &&
        row.sql_length <= RETIRED_SQL_LIMIT &&
        normalizedSql(row.sql) === normalizedSql(definition.sql)
    );
}

export const RETIRED_TURN_SEARCH_SCHEMA_ERROR =
    'elepha database contains legacy turn-search schema objects that differ from the definitions elepha wrote';

// Raised before any migration runs, so a substituted trigger never fires and
// the legacy set and stored evidence stay exactly as found.
export class RetiredTurnSearchSchemaError extends Error {
    constructor(readonly objects: readonly string[]) {
        super(
            `${RETIRED_TURN_SEARCH_SCHEMA_ERROR}: ${objects.join(', ')}. elepha will not drop, replace, or run them. ` +
                'Inspect these objects in the database, restore their original definitions or drop them, then start elepha again.',
        );
        this.name = 'RetiredTurnSearchSchemaError';
    }
}

type RetiredSchemaPlan = { state: 'none' | 'retire' } | { state: 'noncanonical'; objects: string[] };

// Names come from the database, so render them as escaped, bounded literals.
function describeObject(row: StoredObject): string {
    return `${row.type} ${JSON.stringify(row.name.slice(0, 64))}`;
}

// Decides retirement for the whole legacy object set at once. 'none': no
// retired object is present. 'retire': every present object under a retired
// or cleanup-trigger name is exactly what the earlier or current schema
// wrote, and nothing else is attached to a retired table. 'noncanonical':
// anything else, with the objects that differ. Retiring part of a
// noncanonical set could drop postings a substituted trigger still writes to,
// or launder a substituted object, so such a set is never retired. Reads are
// bounded so a hostile schema cannot force an unbounded scan or copy.
function retiredSchemaPlan(db: Database): RetiredSchemaPlan {
    const tableNames = RETIRED_TABLES.map((table) => table.name);
    const triggerNames = RETIRED_TRIGGERS.map((trigger) => trigger.name);
    const objectLimit = RETIRED_TABLES.length + RETIRED_TRIGGERS.length + 1;
    const rows = db
        .prepare(
            `SELECT type, name, tbl_name, substr(sql, 1, ?) AS sql, length(COALESCE(sql, '')) AS sql_length
             FROM sqlite_master
             WHERE lower(name) GLOB ? OR lower(tbl_name) GLOB ?
                OR lower(name) IN (SELECT value FROM json_each(?)) OR lower(tbl_name) IN (SELECT value FROM json_each(?))
                OR (type = 'trigger' AND lower(name) IN (SELECT value FROM json_each(?)))
             ORDER BY type, name LIMIT ?`,
        )
        .all(
            RETIRED_SQL_LIMIT + 1,
            `${RETIRED_TURN_SEARCH_FTS_TABLE}*`,
            `${RETIRED_TURN_SEARCH_FTS_TABLE}*`,
            JSON.stringify(tableNames),
            JSON.stringify(tableNames),
            JSON.stringify(triggerNames),
            objectLimit,
        ) as StoredObject[];
    const retiredTables = rows.filter((row) => RETIRED_TABLES.some((table) => row.name.toLowerCase() === table.name));
    const retiredTriggers = rows.filter((row) => RETIRED_TRIGGERS.some((trigger) => matches(row, trigger)));
    if (retiredTables.length === 0 && retiredTriggers.length === 0) {
        return { state: 'none' };
    }
    const fts = RETIRED_TABLES[0] as SchemaDefinition;
    const hasFts = rows.some((row) => matches(row, fts));
    const differing = rows.filter((row) => {
        if (row.type === 'trigger' && triggerNames.includes(row.name.toLowerCase())) {
            return ![...RETIRED_TRIGGERS, ...CLEANUP_TRIGGERS].some((definition) => matches(row, definition));
        }
        // Shadow tables exist only as the canonical FTS table's own storage.
        const table = RETIRED_TABLES.find((definition) => matches(row, definition));
        return table === undefined || (table !== fts && table.name !== RETIRED_TURN_SEARCH_STATE_TABLE && !hasFts);
    });
    if (differing.length === 0 && rows.length < objectLimit) {
        return { state: 'retire' };
    }
    const objects = differing.map(describeObject);
    return { state: 'noncanonical', objects: rows.length < objectLimit ? objects : [...objects, 'further objects'] };
}

// Read-only. Called before any migration touches the database, and again by
// the turn-search migration itself.
export function assertRetiredTurnSearchSchemaAdmissible(db: Database): void {
    const plan = retiredSchemaPlan(db);
    if (plan.state === 'noncanonical') {
        throw new RetiredTurnSearchSchemaError(plan.objects);
    }
}

// Idempotent on every open. Memories stored before the index existed get no
// coverage row: indexing them needs the source transcript, which a schema
// migration must not read. A database still carrying a canonical retired set
// finishes any pending coverage reconciliation, then drops the postings,
// their marker, and the cleanup triggers that wrote to them, all in one
// transaction: a failure leaves the database exactly as it was. A
// noncanonical set fails the open with RetiredTurnSearchSchemaError and is
// left untouched. A converged database has none of those objects, so later
// opens only check for them.
// The resume context issued with source_cursor, so recovery can resume at a
// retained turn. Existing rows have none; their cursor is still usable by
// adapters whose turns carry their own context.
function addSourceContextColumn(db: Database): void {
    const columns = (db.pragma(`table_info(${TURN_SEARCH_INDEX_TABLE})`) as Array<{ name: string }>).map((column) => column.name);
    if (!columns.includes('source_context')) {
        db.exec(`ALTER TABLE ${TURN_SEARCH_INDEX_TABLE} ADD COLUMN source_context TEXT`);
    }
}

export function migrateTurnSearchIndex(db: Database): void {
    db.transaction(() => {
        const plan = retiredSchemaPlan(db);
        if (plan.state === 'noncanonical') {
            throw new RetiredTurnSearchSchemaError(plan.objects);
        }
        if (plan.state === 'none') {
            db.exec(TURN_SEARCH_SCHEMA);
            addSourceContextColumn(db);
            return;
        }
        const present = (name: string): boolean =>
            db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
        const hasMarker = present(RETIRED_TURN_SEARCH_STATE_TABLE);
        const marker = hasMarker
            ? (db.prepare(`SELECT postings_version FROM ${RETIRED_TURN_SEARCH_STATE_TABLE} WHERE id = 1`).get() as
                  | { postings_version: number }
                  | undefined)
            : undefined;
        const hasLegacyTables = hasMarker || present(RETIRED_TURN_SEARCH_FTS_TABLE);
        for (const trigger of RETIRED_TRIGGERS) {
            const stored = db
                .prepare(
                    "SELECT type, name, tbl_name, sql, length(sql) AS sql_length FROM sqlite_master WHERE type = 'trigger' AND name = ?",
                )
                .get(trigger.name) as StoredObject | undefined;
            if (stored !== undefined && matches(stored, trigger)) {
                db.exec(`DROP TRIGGER ${trigger.name}`);
            }
        }
        db.exec(TURN_SEARCH_SCHEMA);
        addSourceContextColumn(db);
        if (hasLegacyTables && marker?.postings_version !== RETIRED_POSTINGS_VERSION) {
            db.exec(RECONCILE_ORPHANS);
            new TurnSearchIndex(db).rebuildAll(new Date().toISOString());
        }
        db.exec(`DROP TABLE IF EXISTS ${RETIRED_TURN_SEARCH_FTS_TABLE}`);
        db.exec(`DROP TABLE IF EXISTS ${RETIRED_TURN_SEARCH_STATE_TABLE}`);
    })();
}

interface BoundedField {
    text: string;
    omitted: number;
}

// Keeps the newest end of an oversized field and reports how many leading
// characters were dropped. The cut advances past the partial word it lands in
// so the projection never starts on a word fragment, and never starts on the
// low half of a surrogate pair.
function boundedTail(text: string, maxChars: number): BoundedField {
    if (text.length <= maxChars) {
        return { text, omitted: 0 };
    }
    let start = text.length - maxChars;
    const boundary = text.slice(start).search(/\s/);
    if (boundary >= 0) {
        start += boundary;
    } else if (/[\uDC00-\uDFFF]/.test(text.charAt(start))) {
        start += 1;
    }
    return { text: text.slice(start), omitted: start };
}

interface StoredCopyRow {
    included: number;
    user_prompt: string;
    assistant_response: string;
    omitted_before_chars: number;
    filter_version: number;
}

interface IndexedFields {
    coverage: TurnSearchCoverage;
    user: BoundedField;
    assistant: BoundedField;
}

function indexedFields(copy: StoredCopyRow): IndexedFields {
    const included = copy.included === 1;
    const user = included ? boundedTail(copy.user_prompt, TURN_SEARCH_INDEX_MAX_FIELD_CHARS) : { text: '', omitted: 0 };
    const assistant = included ? boundedTail(copy.assistant_response, TURN_SEARCH_INDEX_MAX_FIELD_CHARS) : { text: '', omitted: 0 };
    const coverage: TurnSearchCoverage = !included
        ? 'excluded'
        : copy.omitted_before_chars > 0 || user.omitted > 0 || assistant.omitted > 0
          ? 'truncated'
          : 'included';
    return { coverage, user, assistant };
}

export class TurnSearchIndex {
    private readonly stmts: {
        storedCopy: Statement;
        coverage: Statement;
        coveragePage: Statement;
        deleteCoverage: Statement;
        upsertCoverage: Statement;
        updateCoverage: Statement;
    };

    constructor(db: Database) {
        this.stmts = {
            storedCopy: db.prepare(
                `SELECT included, user_prompt, assistant_response, omitted_before_chars, filter_version
                 FROM filtered_turns WHERE memory_id = ?`,
            ),
            coverage: db.prepare(
                `SELECT coverage, omitted_user_chars, omitted_assistant_chars, filter_version
                 FROM ${TURN_SEARCH_INDEX_TABLE} WHERE memory_id = ?`,
            ),
            coveragePage: db
                .prepare(`SELECT memory_id FROM ${TURN_SEARCH_INDEX_TABLE} WHERE memory_id > ? ORDER BY memory_id LIMIT ?`)
                .pluck(),
            deleteCoverage: db.prepare(`DELETE FROM ${TURN_SEARCH_INDEX_TABLE} WHERE memory_id = ?`),
            upsertCoverage: db.prepare(
                `INSERT INTO ${TURN_SEARCH_INDEX_TABLE}
                   (memory_id, coverage, locator, source_cursor, source_context, source_digest, omitted_user_chars, omitted_assistant_chars, filter_version, indexed_at)
                 VALUES (@memory_id, @coverage, @locator, @source_cursor, @source_context, @source_digest, @omitted_user_chars, @omitted_assistant_chars, @filter_version, @indexed_at)
                 ON CONFLICT (memory_id) DO UPDATE SET
                   coverage = excluded.coverage,
                   locator = excluded.locator,
                   source_cursor = excluded.source_cursor,
                   source_context = excluded.source_context,
                   source_digest = excluded.source_digest,
                   omitted_user_chars = excluded.omitted_user_chars,
                   omitted_assistant_chars = excluded.omitted_assistant_chars,
                   filter_version = excluded.filter_version,
                   indexed_at = excluded.indexed_at`,
            ),
            updateCoverage: db.prepare(
                `UPDATE ${TURN_SEARCH_INDEX_TABLE}
                 SET coverage = ?, omitted_user_chars = ?, omitted_assistant_chars = ?, filter_version = ?, indexed_at = ?
                 WHERE memory_id = ?`,
            ),
        };
    }

    // Replaces the coverage row for one memory from its retained filtered
    // copy. Must run inside the transaction that wrote that copy. Deriving
    // coverage from the stored text rather than the parsed turn keeps it true
    // to text elepha still holds: the copy is sanitized and drops its oldest
    // text under the session budget. Without a retained copy the turn is
    // withdrawn instead and undefined is returned.
    record(memoryId: number | bigint, turn: ParsedTurn, indexedAt: string): TurnSearchCoverage | undefined {
        const copy = this.stmts.storedCopy.get(memoryId) as StoredCopyRow | undefined;
        if (copy === undefined) {
            this.stmts.deleteCoverage.run(memoryId);
            return undefined;
        }
        const { coverage, user, assistant } = indexedFields(copy);
        const sourceCursor = turn.cursor === '' ? null : turn.cursor;
        this.stmts.upsertCoverage.run({
            memory_id: memoryId,
            coverage,
            locator: sourceCursor === null ? 'unavailable' : 'available',
            source_cursor: sourceCursor,
            source_context: sourceCursor === null ? null : encodeResumeContext(turn.resumeContext),
            source_digest: sourceTurnDigest(turn),
            omitted_user_chars: user.omitted,
            omitted_assistant_chars: assistant.omitted,
            filter_version: copy.filter_version,
            indexed_at: indexedAt,
        });
        return coverage;
    }

    // For a memory whose previous copy stays stored but is no longer current.
    withdraw(memoryId: number | bigint): void {
        this.stmts.deleteCoverage.run(memoryId);
    }

    // Re-derives indexed memories' coverage from their retained copies after
    // that stored text changed, keeping each coverage row's source locator and
    // digest. Must run inside the transaction that changed the copies. A
    // memory without a coverage row stays a gap: building one needs the source
    // turn. The row is updated only when its values change, because any update
    // invalidates the turn's vector.
    reindexStoredCopies(memoryIds: Iterable<number | bigint>, indexedAt: string): void {
        for (const memoryId of memoryIds) {
            const indexed = this.stmts.coverage.get(memoryId) as
                | { coverage: string; omitted_user_chars: number; omitted_assistant_chars: number; filter_version: number }
                | undefined;
            if (indexed === undefined) {
                continue;
            }
            const copy = this.stmts.storedCopy.get(memoryId) as StoredCopyRow | undefined;
            if (copy === undefined) {
                this.stmts.deleteCoverage.run(memoryId);
                continue;
            }
            const { coverage, user, assistant } = indexedFields(copy);
            if (
                indexed.coverage !== coverage ||
                indexed.omitted_user_chars !== user.omitted ||
                indexed.omitted_assistant_chars !== assistant.omitted ||
                indexed.filter_version !== copy.filter_version
            ) {
                this.stmts.updateCoverage.run(coverage, user.omitted, assistant.omitted, copy.filter_version, indexedAt, memoryId);
            }
        }
    }

    rebuildAll(indexedAt: string): void {
        let after = 0;
        for (;;) {
            const page = this.stmts.coveragePage.all(after, TURN_SEARCH_REBUILD_BATCH_SIZE) as number[];
            this.reindexStoredCopies(page, indexedAt);
            const last = page.at(-1);
            if (last === undefined || page.length < TURN_SEARCH_REBUILD_BATCH_SIZE) {
                return;
            }
            after = last;
        }
    }
}

// Incognito keeps memory rows, so the memories delete trigger never fires for
// it. Withdraw every indexed turn of the native transcript, across segments.
export function deleteTurnSearchForTranscript(db: Database, tool: ToolName, nativeId: string): number {
    const memoryIds = `SELECT m.id FROM memories m JOIN sessions s ON s.id = m.session_id WHERE s.tool = ? AND s.native_id = ?`;
    return db.prepare(`DELETE FROM ${TURN_SEARCH_INDEX_TABLE} WHERE memory_id IN (${memoryIds})`).run(tool, nativeId).changes;
}
