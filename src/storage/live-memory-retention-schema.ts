// Report tables of the fixed live-memory retention policy: removed native
// sessions, deferred captures, and the outcome of the last cleanup attempt.
// Kept apart from the policy so schema initialization does not load the
// backup and cleanup code.

import type { Database } from 'better-sqlite3-multiple-ciphers';

export const LIVE_MEMORY_RETENTION_REMOVALS_TABLE = 'live_memory_retention_removals';
export const LIVE_MEMORY_CAPTURE_DEFERRALS_TABLE = 'live_memory_capture_deferrals';
export const LIVE_MEMORY_RETENTION_STATE_TABLE = 'live_memory_retention_state';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${LIVE_MEMORY_RETENTION_REMOVALS_TABLE} (
  tool              TEXT NOT NULL,
  native_id         TEXT NOT NULL,
  source_started_at TEXT,
  segments          INTEGER NOT NULL CHECK (segments >= 0),
  removed_bytes     INTEGER NOT NULL CHECK (removed_bytes >= 0),
  removed_at        TEXT NOT NULL,
  backup_path       TEXT NOT NULL,
  PRIMARY KEY (tool, native_id)
);
CREATE TABLE IF NOT EXISTS ${LIVE_MEMORY_CAPTURE_DEFERRALS_TABLE} (
  tool              TEXT NOT NULL,
  native_id         TEXT NOT NULL,
  reason            TEXT NOT NULL,
  first_deferred_at TEXT NOT NULL,
  last_deferred_at  TEXT NOT NULL,
  attempts          INTEGER NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (tool, native_id)
);
CREATE TABLE IF NOT EXISTS ${LIVE_MEMORY_RETENTION_STATE_TABLE} (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  outcome        TEXT NOT NULL CHECK (outcome IN ('removed', 'failed', 'unconfirmed')),
  reason         TEXT,
  attempted_at   TEXT NOT NULL,
  retry_after_ms INTEGER NOT NULL,
  backup_path    TEXT
);
`;

export function migrateLiveMemoryRetention(db: Database): void {
    db.exec(SCHEMA);
}

// SQL predicate true when automatic retention removed the native session named
// by the two column expressions. Removal is not a purge: it only stops that
// native session from being captured or served again.
export function retentionRemovedSql(toolColumn: string, nativeIdColumn: string): string {
    return `EXISTS (SELECT 1 FROM ${LIVE_MEMORY_RETENTION_REMOVALS_TABLE} rr WHERE rr.tool = ${toolColumn} AND rr.native_id = ${nativeIdColumn})`;
}

export function isRetentionRemoved(db: Database, tool: string, nativeId: string): boolean {
    return (
        db.prepare(`SELECT 1 FROM ${LIVE_MEMORY_RETENTION_REMOVALS_TABLE} WHERE tool = ? AND native_id = ?`).get(tool, nativeId) !==
        undefined
    );
}
