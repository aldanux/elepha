import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';

describe('sessions table migration', () => {
    it('a fresh :memory: DB has the final schema with no migration needed', () => {
        const db = openDb(':memory:');
        const projectCols = (db.pragma('table_info(projects)') as Array<{ name: string }>).map((c) => c.name);
        expect(projectCols).toContain('git_root_commit');
        const sessionColumns = db.pragma('table_info(sessions)') as Array<{ name: string; notnull: number }>;
        const cols = sessionColumns.map((c) => c.name);
        expect(cols).toEqual(
            expect.arrayContaining([
                'id',
                'tool',
                'native_id',
                'segment_index',
                'project_id',
                'source_path',
                'cursor',
                'started_at',
                'last_ingested_at',
                'surface',
                'git_branch',
                'kind',
                'last_turn_at',
                'trailing_branch',
                'trailing_files',
                'rendered_chars',
                'rendered_turns',
                'title',
                'custom_title',
                'first_prompt_search',
                'git_commit_count',
            ]),
        );
        expect(sessionColumns.find((column) => column.name === 'git_commit_count')).toMatchObject({ notnull: 0 });
        const memCols = (db.pragma('table_info(memories)') as Array<{ name: string }>).map((c) => c.name);
        expect(memCols).toContain('has_external_content');
        const consentCols = (db.pragma('table_info(consent_roots)') as Array<{ name: string }>).map((c) => c.name);
        expect(consentCols).toContain('nudged_at');
        const rollupCols = (db.pragma('table_info(session_rollups)') as Array<{ name: string }>).map((c) => c.name);
        expect(rollupCols).not.toContain('substantive');
        const shownListCols = (db.pragma('table_info(shown_session_lists)') as Array<{ name: string }>).map((c) => c.name);
        expect(shownListCols).toEqual(['tool', 'native_session_id', 'session_ids']);
        const incognitoCols = (db.pragma('table_info(incognito_transcripts)') as Array<{ name: string }>).map((c) => c.name);
        expect(incognitoCols).toEqual(['tool', 'native_id', 'tombstoned_at']);
        db.close();
    });

    it('accepts (tool, native_id, 1) alongside (tool, native_id, 0)', () => {
        const db = openDb(':memory:');
        db.prepare(
            `INSERT INTO projects (path, display_name, git_root, git_remote, first_seen_at, last_seen_at)
       VALUES ('/p', 'p', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        ).run();
        const insert = db.prepare(
            `INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at)
       VALUES (@tool, @native_id, @segment_index, 1, '/tmp/x.jsonl', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        );
        insert.run({ tool: 'codex', native_id: 'abc', segment_index: 0 });
        expect(() => insert.run({ tool: 'codex', native_id: 'abc', segment_index: 1 })).not.toThrow();
        expect(() => insert.run({ tool: 'codex', native_id: 'abc', segment_index: 0 })).toThrow(/UNIQUE/);
        db.close();
    });
});

describe('migration idempotency and reversibility', () => {
    it('adds first_prompt_search to an existing sessions table and leaves historical rows NULL on reopen', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-first-prompt-search-column-'));
        const dbPath = path.join(dir, 'test.db');
        const prior = openDb(dbPath);
        prior.exec(`
          INSERT INTO projects (path, display_name, first_seen_at, last_seen_at)
          VALUES ('/legacy', 'legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
          VALUES ('codex', 'legacy', 1, '/legacy.jsonl', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          ALTER TABLE sessions DROP COLUMN first_prompt_search;
        `);
        prior.close();

        const migrated = openDb(dbPath);
        expect((migrated.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name)).toContain('first_prompt_search');
        expect(migrated.prepare('SELECT first_prompt_search FROM sessions WHERE native_id = ?').get('legacy')).toEqual({
            first_prompt_search: null,
        });
        migrated.close();

        const reopened = openDb(dbPath);
        expect((reopened.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name)).toContain('first_prompt_search');
        reopened.close();
    });

    it('adds the shown-session-list table to an existing database and is a no-op when reopened', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-shown-session-list-table-'));
        const dbPath = path.join(dir, 'test.db');
        const prior = openDb(dbPath);
        prior.exec('DROP TABLE shown_session_lists');
        prior.close();

        const migrated = openDb(dbPath);
        expect((migrated.pragma('table_info(shown_session_lists)') as Array<{ name: string }>).map((c) => c.name)).toEqual([
            'tool',
            'native_session_id',
            'session_ids',
        ]);
        migrated.close();

        const reopened = openDb(dbPath);
        expect((reopened.pragma('table_info(shown_session_lists)') as Array<{ name: string }>).map((c) => c.name)).toEqual([
            'tool',
            'native_session_id',
            'session_ids',
        ]);
        reopened.close();
    });

    it('adds the incognito tombstone table to an existing database and preserves it on reopen', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-incognito-table-'));
        const dbPath = path.join(dir, 'test.db');
        const prior = openDb(dbPath);
        prior.exec('DROP TABLE incognito_transcripts');
        prior.close();

        const migrated = openDb(dbPath);
        expect((migrated.pragma('table_info(incognito_transcripts)') as Array<{ name: string }>).map((c) => c.name)).toEqual([
            'tool',
            'native_id',
            'tombstoned_at',
        ]);
        migrated
            .prepare('INSERT INTO incognito_transcripts (tool, native_id, tombstoned_at) VALUES (?, ?, ?)')
            .run('codex', 'off-session', '2026-08-26T00:00:00.000Z');
        migrated.close();

        const reopened = openDb(dbPath);
        expect(reopened.prepare('SELECT tool, native_id FROM incognito_transcripts').all()).toEqual([
            { tool: 'codex', native_id: 'off-session' },
        ]);
        reopened.close();
    });

    it('adds git_root_commit to a legacy projects table and is a no-op when reopened', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-project-root-commit-column-'));
        const dbPath = path.join(dir, 'test.db');
        const legacy = new Database(dbPath);
        legacy.exec(`
          CREATE TABLE projects (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            display_name TEXT,
            git_root TEXT,
            git_remote TEXT,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
          );
        `);
        legacy
            .prepare(
                "INSERT INTO projects (path, display_name, git_root, git_remote, first_seen_at, last_seen_at) VALUES ('/legacy', 'legacy', '/legacy', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            )
            .run();
        legacy.close();

        const migrated = openDb(dbPath);
        expect((migrated.pragma('table_info(projects)') as Array<{ name: string }>).map((c) => c.name)).toContain('git_root_commit');
        expect(migrated.prepare('SELECT git_root_commit FROM projects WHERE path = ?').get('/legacy')).toEqual({ git_root_commit: null });
        migrated.close();

        const reopened = openDb(dbPath);
        expect((reopened.pragma('table_info(projects)') as Array<{ name: string }>).map((c) => c.name)).toContain('git_root_commit');
        reopened.close();
    });

    it('adds nudged_at to a legacy consent_roots table and is a no-op when reopened', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-consent-nudge-column-'));
        const dbPath = path.join(dir, 'test.db');
        const legacy = new Database(dbPath);
        legacy.exec(`
          CREATE TABLE consent_roots (
            id INTEGER PRIMARY KEY,
            ulid TEXT NOT NULL UNIQUE,
            path TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK (state IN ('approved', 'denied', 'pending')),
            decided_at TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('discovery', 'cli', 'grandfathered'))
          );
        `);
        legacy
            .prepare(
                "INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES ('01J00000000000000000000000', '/legacy', 'pending', '2026-01-01T00:00:00.000Z', 'discovery')",
            )
            .run();
        legacy.close();

        const migrated = openDb(dbPath);
        expect((migrated.pragma('table_info(consent_roots)') as Array<{ name: string }>).map((c) => c.name)).toContain('nudged_at');
        expect(migrated.prepare('SELECT nudged_at FROM consent_roots WHERE path = ?').get('/legacy')).toEqual({ nudged_at: null });
        migrated.close();

        const reopened = openDb(dbPath);
        expect((reopened.pragma('table_info(consent_roots)') as Array<{ name: string }>).map((c) => c.name)).toContain('nudged_at');
        reopened.close();
    });

    it('drops the legacy session_rollups substantive column once and is a no-op when reopened', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-rollup-column-'));
        const dbPath = path.join(dir, 'test.db');

        const fresh = openDb(dbPath);
        fresh.close();

        // Simulate an older database shape on an existing database file.
        const legacy = new Database(dbPath);
        legacy.exec('ALTER TABLE session_rollups ADD COLUMN substantive INTEGER NOT NULL DEFAULT 0');
        legacy.exec(`
          INSERT INTO projects (path, display_name, first_seen_at, last_seen_at)
            VALUES ('/legacy', 'legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
            VALUES ('codex', 'legacy', 1, '/legacy.jsonl', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          INSERT INTO session_rollups
            (session_id, project_id, tool, title, summary, decisions, pending_items, files_touched, turn_count,
             started_at, ended_at, kind, parent_session_id, substantive, summarizer_status, rollup_state,
             rolled_up_through_turn_index, computed_at, rollup_version)
            VALUES (1, 1, 'codex', 'Legacy rollup', '', '[]', '[]', '[]', 0,
                    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'primary', NULL, 0, 'ok', 'final',
                    -1, '2026-01-01T00:00:00.000Z', 1);
        `);
        expect((legacy.pragma('table_info(session_rollups)') as Array<{ name: string }>).map((c) => c.name)).toContain('substantive');
        legacy.close();

        const migrated = openDb(dbPath);
        expect((migrated.pragma('table_info(session_rollups)') as Array<{ name: string }>).map((c) => c.name)).not.toContain('substantive');
        expect(migrated.prepare('SELECT title FROM session_rollups').get()).toEqual({ title: 'Legacy rollup' });
        migrated.close();

        const reopened = openDb(dbPath);
        expect((reopened.pragma('table_info(session_rollups)') as Array<{ name: string }>).map((c) => c.name)).not.toContain('substantive');
        reopened.close();
    });

    it('running openDb twice on the same file is a no-op the second time (idempotent)', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-migration-'));
        const dbPath = path.join(dir, 'test.db');

        const first = openDb(dbPath);
        first
            .prepare(
                `INSERT INTO projects (path, display_name, git_root, git_remote, first_seen_at, last_seen_at)
       VALUES ('/p', 'p', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
            )
            .run();
        first
            .prepare(
                `INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
       VALUES ('codex', 'abc', 1, '/tmp/x.jsonl', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
            )
            .run();
        first.close();

        const second = openDb(dbPath);
        const rows = second.prepare('SELECT * FROM sessions').all();
        expect(rows).toHaveLength(1); // the row survived, wasn't duplicated or dropped
        const cols = (second.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name);
        expect(cols).toContain('segment_index');
        second.close();
    });

    it('the old-shape sessions table (pre-migration) upgrades cleanly and preserves every row', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-migration-old-'));
        const dbPath = path.join(dir, 'test.db');

        // Build the OLD shape directly (bypassing openDb, which always writes
        // the NEW SCHEMA) to simulate a real legacy database file.
        const raw = new Database(dbPath);
        raw.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, display_name TEXT,
        git_root TEXT, git_remote TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY, tool TEXT NOT NULL, native_id TEXT NOT NULL,
        project_id INTEGER NOT NULL REFERENCES projects(id), source_path TEXT NOT NULL,
        cursor TEXT, started_at TEXT NOT NULL, last_ingested_at TEXT NOT NULL,
        UNIQUE (tool, native_id)
      );
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
        session_id INTEGER NOT NULL REFERENCES sessions(id), turn_index INTEGER NOT NULL,
        tool TEXT NOT NULL, turn_started_at TEXT NOT NULL, decisions TEXT NOT NULL,
        files_touched TEXT NOT NULL, pending_items TEXT NOT NULL, superseded_at TEXT,
        created_at TEXT NOT NULL, summarizer_status TEXT NOT NULL DEFAULT 'unknown', reingested_at TEXT,
        UNIQUE (session_id, turn_index)
      );
    `);
        raw.prepare(
            `INSERT INTO projects (path, display_name, git_root, git_remote, first_seen_at, last_seen_at)
       VALUES ('/p', 'p', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        ).run();
        raw.prepare(
            `INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
       VALUES ('codex', 'legacy-1', 1, '/tmp/x.jsonl', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        ).run();
        raw.prepare(
            `INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
       VALUES (1, 1, 0, 'codex', '2026-01-01T00:00:00.000Z', '[]', '[]', '[]', '2026-01-01T00:00:00.000Z')`,
        ).run();
        raw.close();

        const migrated = openDb(dbPath);
        const row = migrated.prepare('SELECT * FROM sessions WHERE native_id = ?').get('legacy-1') as Record<string, unknown>;
        expect(row.id).toBe(1); // id preserved across the rebuild
        expect(row.segment_index).toBe(0);
        expect(row.surface).toBeNull();
        expect(row.trailing_files).toBe('[]');
        expect(row.custom_title).toBeNull();

        const memRow = migrated.prepare('SELECT * FROM memories WHERE session_id = ?').get(1) as Record<string, unknown>;
        expect(memRow.has_external_content).toBe(0);

        const violations = migrated.pragma('foreign_key_check');
        expect(violations).toEqual([]);
        migrated.close();
    });
});
