import type Database from 'better-sqlite3-multiple-ciphers';
import {
    RETIRED_TURN_SEARCH_FTS_TABLE,
    RETIRED_TURN_SEARCH_STATE_TABLE,
    TURN_SEARCH_CLEANUP_TRIGGER,
    TURN_SEARCH_COPY_CLEANUP_TRIGGER,
    TURN_SEARCH_INDEX_TABLE,
} from '../../src/storage/turn-search-index.js';

// Rewrites a current database into the shape the earlier schema left behind:
// a second contentless postings table beside filtered_turns_fts, cleanup
// triggers that also wrote to it, and optionally its reconciliation marker.
// The definitions are typed out as that schema wrote them, independently of
// the migration's own copy, so the test proves the migration recognizes them.
export function seedRetiredTurnSearchSchema(db: Database.Database, marker: number | undefined): void {
    db.exec(`
      DROP TRIGGER ${TURN_SEARCH_CLEANUP_TRIGGER};
      DROP TRIGGER ${TURN_SEARCH_COPY_CLEANUP_TRIGGER};

      CREATE VIRTUAL TABLE IF NOT EXISTS ${RETIRED_TURN_SEARCH_FTS_TABLE} USING fts5(
        user_text,
        assistant_text,
        content='',
        contentless_delete=1,
        detail=column
      );

      CREATE TRIGGER IF NOT EXISTS ${TURN_SEARCH_CLEANUP_TRIGGER} AFTER DELETE ON memories BEGIN
        DELETE FROM ${RETIRED_TURN_SEARCH_FTS_TABLE} WHERE rowid = old.id;
        DELETE FROM ${TURN_SEARCH_INDEX_TABLE} WHERE memory_id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS ${TURN_SEARCH_COPY_CLEANUP_TRIGGER} AFTER DELETE ON filtered_turns BEGIN
        DELETE FROM ${RETIRED_TURN_SEARCH_FTS_TABLE} WHERE rowid = old.memory_id;
        DELETE FROM ${TURN_SEARCH_INDEX_TABLE} WHERE memory_id = old.memory_id;
      END;

      CREATE TABLE IF NOT EXISTS ${RETIRED_TURN_SEARCH_STATE_TABLE} (
        id               INTEGER PRIMARY KEY CHECK (id = 1),
        postings_version INTEGER NOT NULL
      );

      INSERT INTO ${RETIRED_TURN_SEARCH_FTS_TABLE} (rowid, user_text, assistant_text)
      SELECT ft.memory_id, ft.user_prompt, ft.assistant_response
      FROM filtered_turns ft JOIN ${TURN_SEARCH_INDEX_TABLE} tsi ON tsi.memory_id = ft.memory_id
      WHERE ft.included = 1;
    `);
    if (marker !== undefined) {
        db.prepare(`INSERT INTO ${RETIRED_TURN_SEARCH_STATE_TABLE} (id, postings_version) VALUES (1, ?)`).run(marker);
    }
}

// Every schema object that belongs only to the retired postings.
export function retiredTurnSearchObjects(db: Database.Database): Array<{ type: string; name: string }> {
    return db
        .prepare(
            `SELECT type, name FROM sqlite_master
             WHERE lower(name) GLOB ? OR lower(tbl_name) GLOB ? OR name = ?
                OR (type = 'trigger' AND instr(sql, ?) > 0)
             ORDER BY type, name`,
        )
        .all(
            `${RETIRED_TURN_SEARCH_FTS_TABLE}*`,
            `${RETIRED_TURN_SEARCH_FTS_TABLE}*`,
            RETIRED_TURN_SEARCH_STATE_TABLE,
            RETIRED_TURN_SEARCH_FTS_TABLE,
        ) as Array<{ type: string; name: string }>;
}

// Retired sets that differ from what the earlier schema wrote, as
// [label, substitution, repair]. Each substitution is applied after
// seedRetiredTurnSearchSchema, and none may be partially retired or silently
// replaced; its repair restores the valid legacy definition.
export const NONCANONICAL_RETIRED_SETS: ReadonlyArray<readonly [string, string, string]> = [
    [
        'a canonical postings table paired with a substituted cleanup trigger',
        `DROP TRIGGER ${TURN_SEARCH_CLEANUP_TRIGGER};
         CREATE TRIGGER ${TURN_SEARCH_CLEANUP_TRIGGER} AFTER DELETE ON memories BEGIN
           DELETE FROM ${RETIRED_TURN_SEARCH_FTS_TABLE} WHERE rowid = old.id;
         END;`,
        `DROP TRIGGER ${TURN_SEARCH_CLEANUP_TRIGGER};
         CREATE TRIGGER ${TURN_SEARCH_CLEANUP_TRIGGER} AFTER DELETE ON memories BEGIN
           DELETE FROM ${RETIRED_TURN_SEARCH_FTS_TABLE} WHERE rowid = old.id;
           DELETE FROM ${TURN_SEARCH_INDEX_TABLE} WHERE memory_id = old.id;
         END;`,
    ],
    [
        'a substituted marker that still exposes postings_version',
        `DROP TABLE ${RETIRED_TURN_SEARCH_STATE_TABLE};
         CREATE TABLE ${RETIRED_TURN_SEARCH_STATE_TABLE} (id INTEGER PRIMARY KEY, postings_version INTEGER NOT NULL, note TEXT);
         INSERT INTO ${RETIRED_TURN_SEARCH_STATE_TABLE} (id, postings_version, note) VALUES (1, 0, 'substituted');`,
        `DROP TABLE ${RETIRED_TURN_SEARCH_STATE_TABLE};
         CREATE TABLE ${RETIRED_TURN_SEARCH_STATE_TABLE} (
           id               INTEGER PRIMARY KEY CHECK (id = 1),
           postings_version INTEGER NOT NULL
         );
         INSERT INTO ${RETIRED_TURN_SEARCH_STATE_TABLE} (id, postings_version) VALUES (1, 0);`,
    ],
    [
        'a canonical marker carrying an attached trigger',
        `CREATE TRIGGER ${RETIRED_TURN_SEARCH_STATE_TABLE}_au AFTER UPDATE ON ${RETIRED_TURN_SEARCH_STATE_TABLE} BEGIN
           DELETE FROM consent_roots;
         END;`,
        `DROP TRIGGER ${RETIRED_TURN_SEARCH_STATE_TABLE}_au;`,
    ],
];
