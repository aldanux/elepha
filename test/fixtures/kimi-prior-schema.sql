-- Phase-2 schema, before Kimi capture. Kept literal to exercise the real CHECK migration.
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
  tool             TEXT NOT NULL CHECK (tool IN ('claude-code','codex','opencode')),
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
