// SQLite connection + schema management. Single local DB file, zero config.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { elephaHome } from '../config/paths.js';
import { hardenDir, hardenFile } from '../security/file-permissions.js';
import { CONSENT_GRANDFATHERED_AT_KEY, canonicalizeConsentRoots, grandfatherConsentRoots } from './consent-store.js';

export function defaultDbPath(): string {
    const override = process.env.ELEPHA_DB_PATH?.trim();
    return override ? path.resolve(override) : path.join(elephaHome(), 'elepha.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  git_root      TEXT,
  git_remote    TEXT,
  git_root_commit TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY,
  tool             TEXT NOT NULL CHECK (tool IN ('claude-code','codex')),
  native_id        TEXT NOT NULL,
  segment_index    INTEGER NOT NULL DEFAULT 0,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  source_path      TEXT NOT NULL,
  cursor           TEXT,
  started_at       TEXT NOT NULL,
  last_ingested_at TEXT NOT NULL,
  surface          TEXT CHECK (surface IN ('cli','desktop')),
  git_branch       TEXT,
  kind             TEXT CHECK (kind IN ('main','subagent','fork','adjudicator')),
  last_turn_at     TEXT,
  trailing_branch  TEXT,
  trailing_files   TEXT NOT NULL DEFAULT '[]',
  rendered_chars   INTEGER DEFAULT 0,
  rendered_turns   INTEGER DEFAULT 0,
  title            TEXT,
  custom_title     TEXT,
  first_prompt_search TEXT,
  git_commit_count INTEGER,
  UNIQUE (tool, native_id, segment_index)
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

CREATE TABLE IF NOT EXISTS memories (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id),
  session_id      INTEGER NOT NULL REFERENCES sessions(id),
  turn_index      INTEGER NOT NULL,
  tool            TEXT NOT NULL,
  turn_started_at TEXT NOT NULL,
  decisions       TEXT NOT NULL,
  files_touched   TEXT NOT NULL,
  pending_items   TEXT NOT NULL,
  superseded_at   TEXT,
  created_at      TEXT NOT NULL,
  summarizer_status TEXT NOT NULL DEFAULT 'unknown',
  reingested_at   TEXT,
  has_external_content INTEGER NOT NULL DEFAULT 0 CHECK (has_external_content IN (0,1)),
  UNIQUE (session_id, turn_index)
);
CREATE INDEX IF NOT EXISTS idx_memories_project_time ON memories(project_id, turn_started_at);

-- Session-level rollups. Additive: turn rows in memories are never deleted
-- after rollup, and a rollup can always be rebuilt from them.
--
-- rollup_state is the crux. "Closed" is a heuristic (file idle), never a
-- guarantee: Codex Desktop reopens a session days later and appends to the
-- original rollout file. So final -> live -> final -> live must be safe to
-- repeat any number of times, and re-processing the same turns must not
-- double-count. rolled_up_through_turn_index is the high-water mark that makes
-- the incremental merge idempotent - it advances in the SAME transaction as
-- the content it accounts for.
CREATE TABLE IF NOT EXISTS session_rollups (
  session_id                   INTEGER PRIMARY KEY REFERENCES sessions(id),
  project_id                   INTEGER NOT NULL REFERENCES projects(id),
  tool                         TEXT    NOT NULL,
  title                        TEXT    NOT NULL,
  summary                      TEXT    NOT NULL,
  decisions                    TEXT    NOT NULL,  -- JSON [{what, why}]
  pending_items                TEXT    NOT NULL,  -- JSON string[]
  files_touched                TEXT    NOT NULL,  -- JSON string[], case-insensitively deduped
  turn_count                   INTEGER NOT NULL,
  started_at                   TEXT    NOT NULL,
  ended_at                     TEXT    NOT NULL,
  kind                         TEXT    NOT NULL,  -- 'primary' | 'subagent'
  parent_session_id            INTEGER REFERENCES sessions(id),
  summarizer_status            TEXT    NOT NULL,
  rollup_state                 TEXT    NOT NULL,  -- 'live' | 'final'
  rolled_up_through_turn_index INTEGER NOT NULL,
  computed_at                  TEXT    NOT NULL,
  rollup_version               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rollups_project ON session_rollups(project_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_rollups_parent ON session_rollups(parent_session_id);

CREATE TABLE IF NOT EXISTS consent_roots (
  id         INTEGER PRIMARY KEY,
  ulid       TEXT NOT NULL UNIQUE,
  path       TEXT NOT NULL UNIQUE,
  state      TEXT NOT NULL CHECK (state IN ('approved', 'denied', 'pending')),
  decided_at TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('discovery', 'cli', 'grandfathered')),
  nudged_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_consent_roots_state ON consent_roots(state);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Security Rule 4 quote-back guard. One row per successfully recorded injection.
CREATE TABLE IF NOT EXISTS injections (
  id                INTEGER PRIMARY KEY,
  tool              TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  injected_at       TEXT NOT NULL,
  injection_id      TEXT NOT NULL,   -- ULID embedded in the sentinel
  body_hash         TEXT NOT NULL,   -- sha256 of the normalized body
  body              TEXT NOT NULL,   -- needed for near-verbatim comparison
  UNIQUE (tool, native_session_id, body_hash)
);
CREATE INDEX IF NOT EXISTS idx_injections_session ON injections(tool, native_session_id);

-- The ordered session ids behind elepha:select:<n>. One row is the complete
-- last list shown to one native chat, including an intentionally empty list.
CREATE TABLE IF NOT EXISTS shown_session_lists (
  tool              TEXT NOT NULL CHECK (tool IN ('claude-code','codex')),
  native_session_id TEXT NOT NULL,
  session_ids       TEXT NOT NULL,
  PRIMARY KEY (tool, native_session_id)
);

-- A purge is absolute for a transcript. A later daemon sweep must not
-- recreate any segment from a file whose history was deliberately removed.
CREATE TABLE IF NOT EXISTS purged_transcripts (
  tool      TEXT NOT NULL,
  native_id TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  PRIMARY KEY (tool, native_id)
);

-- Capture-off sessions observed under an explicit denial stay excluded even
-- if that root is later approved. This stores identity only; transcript
-- content remains solely in the provider's on-disk file.
CREATE TABLE IF NOT EXISTS incognito_transcripts (
  tool          TEXT NOT NULL,
  native_id     TEXT NOT NULL,
  tombstoned_at TEXT NOT NULL,
  PRIMARY KEY (tool, native_id)
);
`;

/**
 * No migration framework exists yet (single-table-additive product, pre-1.0).
 * Columns added after the initial CREATE TABLE need an idempotent ALTER TABLE
 * here, guarded by a PRAGMA table_info check, since ALTER TABLE ADD COLUMN
 * has no IF NOT EXISTS form and CREATE TABLE IF NOT EXISTS is a no-op against
 * an already-existing table.
 */
function migrate(db: Database.Database): void {
    migrateSessionsTable(db);

    const projectColumns = (db.pragma('table_info(projects)') as Array<{ name: string }>).map((c) => c.name);
    if (!projectColumns.includes('git_root_commit')) {
        db.exec('ALTER TABLE projects ADD COLUMN git_root_commit TEXT');
    }

    const consentColumns = (db.pragma('table_info(consent_roots)') as Array<{ name: string }>).map((c) => c.name);
    if (!consentColumns.includes('nudged_at')) {
        db.exec('ALTER TABLE consent_roots ADD COLUMN nudged_at TEXT');
    }
    db.prepare(
        `INSERT OR IGNORE INTO meta (key, value)
         SELECT @key, @value
         WHERE EXISTS (SELECT 1 FROM consent_roots)
           AND NOT EXISTS (SELECT 1 FROM meta WHERE key = @key)`,
    ).run({ key: CONSENT_GRANDFATHERED_AT_KEY, value: new Date().toISOString() });

    // The gap comparison needs the prior closed turn's timestamp.
    // Keep it on the session row with the rest of the trailing window: using
    // last_ingested_at would compare wall-clock daemon activity, not transcript
    // time, and querying memories here would make every turn scan its history.
    const sessionColumns = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name);
    if (!sessionColumns.includes('last_turn_at')) {
        db.exec('ALTER TABLE sessions ADD COLUMN last_turn_at TEXT');
    }
    if (!sessionColumns.includes('rendered_chars')) {
        // Existing rows need a transcript backfill. NULL means that transcript
        // is unavailable, while new rows receive the SCHEMA default of zero.
        db.exec('ALTER TABLE sessions ADD COLUMN rendered_chars INTEGER');
    }
    if (!sessionColumns.includes('rendered_turns')) {
        // Existing rows need the same renderer-derived backfill as
        // rendered_chars. NULL means the transcript was unavailable.
        db.exec('ALTER TABLE sessions ADD COLUMN rendered_turns INTEGER');
    }
    if (!sessionColumns.includes('title')) {
        db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
    }
    if (!sessionColumns.includes('custom_title')) {
        db.exec('ALTER TABLE sessions ADD COLUMN custom_title TEXT');
    }
    if (!sessionColumns.includes('first_prompt_search')) {
        // Historical rows stay visibly unindexed until the explicit transcript
        // backfill can derive their first stored user prompt.
        db.exec('ALTER TABLE sessions ADD COLUMN first_prompt_search TEXT');
    }
    // This is the count at segment open. Historical rows deliberately remain
    // unknown: recording today's count would manufacture stale-gate evidence.
    if (!sessionColumns.includes('git_commit_count')) {
        db.exec('ALTER TABLE sessions ADD COLUMN git_commit_count INTEGER');
    }

    const columns = (db.pragma('table_info(memories)') as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes('summarizer_status')) {
        db.exec(`ALTER TABLE memories ADD COLUMN summarizer_status TEXT NOT NULL DEFAULT 'unknown'`);
    }
    if (!columns.includes('reingested_at')) {
        db.exec('ALTER TABLE memories ADD COLUMN reingested_at TEXT');
    }
    if (!columns.includes('has_external_content')) {
        db.exec('ALTER TABLE memories ADD COLUMN has_external_content INTEGER NOT NULL DEFAULT 0 CHECK (has_external_content IN (0,1))');
    }

    // Substantiveness is computed at read time. Older databases retain this
    // inert NOT NULL column until their next open; fresh databases never get it.
    const rollupColumns = (db.pragma('table_info(session_rollups)') as Array<{ name: string }>).map((c) => c.name);
    if (rollupColumns.includes('substantive')) {
        db.exec('ALTER TABLE session_rollups DROP COLUMN substantive');
    }
}

/**
 * Sessions are unique by tool, native id, and segment index, with
 * surface/git_branch/kind/trailing_branch/trailing_files. SQLite has no
 * ALTER TABLE ... DROP/ADD CONSTRAINT, so a constraint change needs a full
 * table rebuild - the destructive-operations rule applies even though this
 * runs unconditionally at openDb() time, not behind a CLI --apply flag,
 * because it is purely additive to the row set (same ids, same row count)
 * and gated by foreign_key_check before commit.
 */
function migrateSessionsTable(db: Database.Database): void {
    const columns = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name);
    if (columns.includes('segment_index')) {
        if (!columns.includes('git_commit_count')) {
            db.exec('ALTER TABLE sessions ADD COLUMN git_commit_count INTEGER');
        }
        return; // already migrated (or a fresh DB that got the final SCHEMA directly)
    }

    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
        db.exec(`
      CREATE TABLE sessions_new (
        id               INTEGER PRIMARY KEY,
        tool             TEXT NOT NULL CHECK (tool IN ('claude-code','codex')),
        native_id        TEXT NOT NULL,
        segment_index    INTEGER NOT NULL DEFAULT 0,
        project_id       INTEGER NOT NULL REFERENCES projects(id),
        source_path      TEXT NOT NULL,
        cursor           TEXT,
        started_at       TEXT NOT NULL,
        last_ingested_at TEXT NOT NULL,
        surface          TEXT CHECK (surface IN ('cli','desktop')),
        git_branch       TEXT,
        kind             TEXT CHECK (kind IN ('main','subagent','fork','adjudicator')),
        last_turn_at     TEXT,
        trailing_branch  TEXT,
        trailing_files   TEXT NOT NULL DEFAULT '[]',
        UNIQUE (tool, native_id, segment_index)
      );
    `);
        db.exec(`
      INSERT INTO sessions_new (id, tool, native_id, segment_index, project_id, source_path, cursor, started_at, last_ingested_at, trailing_files)
      SELECT id, tool, native_id, 0, project_id, source_path, cursor, started_at, last_ingested_at, '[]'
      FROM sessions;
    `);
        db.exec('DROP TABLE sessions;');
        db.exec('ALTER TABLE sessions_new RENAME TO sessions;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);');
    });
    rebuild();

    const violations = db.pragma('foreign_key_check');
    if (Array.isArray(violations) && violations.length > 0) {
        throw new Error(`sessions table rebuild left ${violations.length} foreign-key violation(s): ${JSON.stringify(violations)}`);
    }
    db.pragma('foreign_keys = ON');
    // Preserve rebuilt rows and add the nullable historical baseline only
    // after the constraint migration is done.
    db.exec('ALTER TABLE sessions ADD COLUMN git_commit_count INTEGER');
}

export function openDb(dbPath: string = defaultDbPath()): Database.Database {
    if (dbPath !== ':memory:') {
        mkdirSync(path.dirname(dbPath), { recursive: true });
        hardenDir(path.dirname(dbPath));
    }
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    migrate(db);
    grandfatherConsentRoots(db);
    canonicalizeConsentRoots(db);
    if (dbPath !== ':memory:') {
        // WAL mode creates -wal/-shm sidecars as a side effect of the pragma
        // above; harden every file that actually exists on disk, not just
        // the main DB file - a leaked WAL still holds deleted content
        // (the purge path checkpoints WAL before deletion).
        hardenFile(dbPath);
        hardenFile(`${dbPath}-wal`);
        hardenFile(`${dbPath}-shm`);
    }
    return db;
}
