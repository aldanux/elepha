import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';

describe('P2.8 git_commit_count schema migration', () => {
    it('adds a NULL baseline to a pre-git_commit_count P2.1 database and preserves its rows', () => {
        const file = path.join(mkdtempSync(path.join(tmpdir(), 'elepha-legacy-count-')), 'legacy.db');
        const db = new Database(file);
        db.exec(`
            CREATE TABLE projects (
              id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, display_name TEXT,
              git_root TEXT, git_remote TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
            );
            CREATE TABLE sessions (
              id INTEGER PRIMARY KEY, tool TEXT NOT NULL, native_id TEXT NOT NULL, segment_index INTEGER NOT NULL DEFAULT 0,
              project_id INTEGER NOT NULL, source_path TEXT NOT NULL, cursor TEXT, started_at TEXT NOT NULL,
              last_ingested_at TEXT NOT NULL, surface TEXT, git_branch TEXT, kind TEXT, last_turn_at TEXT,
              trailing_branch TEXT, trailing_files TEXT NOT NULL DEFAULT '[]', rendered_chars INTEGER,
              rendered_turns INTEGER, custom_title TEXT, UNIQUE (tool, native_id, segment_index)
            );
            INSERT INTO projects (id, path, first_seen_at, last_seen_at)
              VALUES (1, '/legacy', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
            INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
              VALUES ('codex', 'legacy', 1, '/legacy.jsonl', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        `);
        // `openDb` owns the production migration; this instance is deliberately
        // a legacy on-disk shape only long enough to prove the additive result.
        db.close();
        const migrated = openDb(file);
        expect(migrated.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
        expect(migrated.prepare('SELECT git_commit_count FROM sessions WHERE native_id = ?').get('legacy')).toEqual({
            git_commit_count: null,
        });
        migrated.close();
    });
});
