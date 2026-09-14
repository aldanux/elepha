-- Session rollup schema before the instructions category (0.8.1).
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
