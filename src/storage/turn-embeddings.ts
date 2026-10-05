// Private, derived per-turn Memory-Plus vector cache.
//
// Rows are keyed by memories.id through the turn search coverage row, never
// directly by memories: a vector exists only for a turn that the search index
// covers, and withdrawing that coverage withdraws the vector. Deleting a
// memory fires the turn search cleanup trigger, and incognito deletes the
// coverage rows explicitly; both reach this table through the ON DELETE
// CASCADE foreign key, which requires foreign_keys = ON on the connection.
//
// The table stores no turn prose. source_digest pins the source turn the
// vector was computed from, text_hash pins the exact embedded text, and the
// model name, revision and dimensions pin the model, so a stale or foreign
// vector is detectable without re-reading the text. The vector is a
// little-endian float32 array, so its byte length is fixed by dimensions.
//
// Like session_embeddings, this cache is rebuildable: consent revocation and
// restore delete it, and disabling Memory-Plus retains it without serving it.

import type { Database } from 'better-sqlite3-multiple-ciphers';
import { TURN_SEARCH_INDEX_TABLE } from './turn-search-index.js';

export const TURN_EMBEDDINGS_TABLE = 'turn_embeddings';
export const TURN_EMBEDDINGS_REINDEX_TRIGGER = 'turn_search_index_embeddings_au';
export const TURN_EMBEDDING_REFRESH_STATE_TABLE = 'turn_embedding_refresh_state';

// Reingest updates the search coverage row in place. Its foreign key does not
// cascade on UPDATE, so discard the vector before it can describe old text.
const TURN_EMBEDDINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${TURN_EMBEDDINGS_TABLE} (
  memory_id      INTEGER PRIMARY KEY REFERENCES ${TURN_SEARCH_INDEX_TABLE}(memory_id) ON DELETE CASCADE,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_digest  TEXT NOT NULL,
  text_hash      TEXT NOT NULL,
  model          TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  dimensions     INTEGER NOT NULL CHECK (dimensions > 0),
  vector         BLOB NOT NULL CHECK (typeof(vector) = 'blob' AND length(vector) = dimensions * 4),
  computed_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turn_embeddings_project ON ${TURN_EMBEDDINGS_TABLE}(project_id);

CREATE TRIGGER IF NOT EXISTS ${TURN_EMBEDDINGS_REINDEX_TRIGGER} AFTER UPDATE ON ${TURN_SEARCH_INDEX_TABLE} BEGIN
  DELETE FROM ${TURN_EMBEDDINGS_TABLE} WHERE memory_id = new.memory_id;
END;

CREATE TABLE IF NOT EXISTS ${TURN_EMBEDDING_REFRESH_STATE_TABLE} (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  before_memory_id INTEGER CHECK (before_memory_id IS NULL OR before_memory_id > 0),
  model           TEXT NOT NULL,
  model_revision  TEXT NOT NULL,
  dimensions      INTEGER NOT NULL CHECK (dimensions > 0),
  authority_hash  TEXT NOT NULL,
  authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
  sweep_issue_hash TEXT NOT NULL DEFAULT '',
  sweep_unavailable INTEGER NOT NULL DEFAULT 0 CHECK (sweep_unavailable >= 0),
  sweep_changed INTEGER NOT NULL DEFAULT 0 CHECK (sweep_changed >= 0),
  sweep_failed INTEGER NOT NULL DEFAULT 0 CHECK (sweep_failed >= 0),
  last_reported_issue_hash TEXT NOT NULL DEFAULT ''
);

CREATE TRIGGER IF NOT EXISTS turn_embedding_refresh_consent_ai AFTER INSERT ON consent_roots BEGIN
  UPDATE ${TURN_EMBEDDING_REFRESH_STATE_TABLE} SET authority_epoch = authority_epoch + 1,
    before_memory_id = NULL, sweep_issue_hash = '', sweep_unavailable = 0,
    sweep_changed = 0, sweep_failed = 0, last_reported_issue_hash = '';
END;
CREATE TRIGGER IF NOT EXISTS turn_embedding_refresh_consent_au AFTER UPDATE ON consent_roots BEGIN
  UPDATE ${TURN_EMBEDDING_REFRESH_STATE_TABLE} SET authority_epoch = authority_epoch + 1,
    before_memory_id = NULL, sweep_issue_hash = '', sweep_unavailable = 0,
    sweep_changed = 0, sweep_failed = 0, last_reported_issue_hash = '';
END;
CREATE TRIGGER IF NOT EXISTS turn_embedding_refresh_consent_ad AFTER DELETE ON consent_roots BEGIN
  UPDATE ${TURN_EMBEDDING_REFRESH_STATE_TABLE} SET authority_epoch = authority_epoch + 1,
    before_memory_id = NULL, sweep_issue_hash = '', sweep_unavailable = 0,
    sweep_changed = 0, sweep_failed = 0, last_reported_issue_hash = '';
END;
CREATE TRIGGER IF NOT EXISTS turn_embedding_refresh_project_ai AFTER INSERT ON projects BEGIN
  UPDATE ${TURN_EMBEDDING_REFRESH_STATE_TABLE} SET authority_epoch = authority_epoch + 1,
    before_memory_id = NULL, sweep_issue_hash = '', sweep_unavailable = 0,
    sweep_changed = 0, sweep_failed = 0, last_reported_issue_hash = '';
END;
CREATE TRIGGER IF NOT EXISTS turn_embedding_refresh_project_au
AFTER UPDATE OF path, git_root, git_remote, git_root_commit ON projects
WHEN old.path IS NOT new.path OR old.git_root IS NOT new.git_root
  OR old.git_remote IS NOT new.git_remote OR old.git_root_commit IS NOT new.git_root_commit BEGIN
  UPDATE ${TURN_EMBEDDING_REFRESH_STATE_TABLE} SET authority_epoch = authority_epoch + 1,
    before_memory_id = NULL, sweep_issue_hash = '', sweep_unavailable = 0,
    sweep_changed = 0, sweep_failed = 0, last_reported_issue_hash = '';
END;
CREATE TRIGGER IF NOT EXISTS turn_embedding_refresh_project_ad AFTER DELETE ON projects BEGIN
  UPDATE ${TURN_EMBEDDING_REFRESH_STATE_TABLE} SET authority_epoch = authority_epoch + 1,
    before_memory_id = NULL, sweep_issue_hash = '', sweep_unavailable = 0,
    sweep_changed = 0, sweep_failed = 0, last_reported_issue_hash = '';
END;
`;

// Idempotent on every open. Must run after the turn search index exists,
// because the foreign key names it.
export function migrateTurnEmbeddings(db: Database): void {
    db.transaction(() => db.exec(TURN_EMBEDDINGS_SCHEMA))();
}
