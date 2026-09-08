import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { openUnmanagedDb, SQLITE_SOURCE_WATERMARK_SCHEMA } from '../../src/storage/db.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

describe('sessions table migration', () => {
    it('a fresh :memory: DB has the final schema with no migration needed', () => {
        const db = openUnmanagedDb(':memory:');
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
        const firstPromptSkipCols = (db.pragma('table_info(first_prompt_search_backfill_skips)') as Array<{ name: string }>).map(
            (c) => c.name,
        );
        expect(firstPromptSkipCols).toEqual(['session_id', 'skipped_at']);
        expect((db.pragma('table_info(paranoid_authority)') as Array<{ name: string }>).map((column) => column.name)).toEqual([
            'id',
            'enrolled',
            'state',
            'generation',
            'credential_tag',
        ]);
        expect(db.prepare('SELECT * FROM paranoid_authority WHERE id = 1').get()).toEqual({
            id: 1,
            enrolled: 0,
            state: 'unlocked',
            generation: 0,
            credential_tag: null,
        });
        expect((db.pragma('table_info(filtered_turns)') as Array<{ name: string }>).map((column) => column.name)).toEqual([
            'memory_id',
            'included',
            'user_prompt',
            'assistant_response',
            'tool_calls',
            'omitted_tool_call_count',
            'dropped_tool_ref_count',
            'omitted_before_chars',
            'filter_version',
            'captured_at',
        ]);
        expect((db.pragma('table_info(durable_capture_status)') as Array<{ name: string }>).map((column) => column.name)).toEqual([
            'session_id',
            'state',
            'filter_version',
            'updated_at',
        ]);
        expect((db.pragma('table_info(durable_capture_usage)') as Array<{ name: string }>).map((column) => column.name)).toEqual([
            'id',
            'total_bytes',
        ]);
        expect(
            (db.pragma(`table_info(${SQLITE_SOURCE_WATERMARK_SCHEMA.table})`) as Array<{ name: string }>).map((column) => column.name),
        ).toEqual([
            SQLITE_SOURCE_WATERMARK_SCHEMA.tool,
            SQLITE_SOURCE_WATERMARK_SCHEMA.sourcePath,
            SQLITE_SOURCE_WATERMARK_SCHEMA.watermark,
        ]);
        db.close();
    });

    it('adds the SQLite source watermark table to a legacy DB and leaves it unchanged on reopen', () => {
        const directory = withGrantableTestDir('elepha-sqlite-watermark-migration-');
        const dbPath = path.join(directory, 'test.db');
        const legacy = openUnmanagedDb(dbPath);
        legacy.exec(`DROP TABLE ${SQLITE_SOURCE_WATERMARK_SCHEMA.table}`);
        legacy.close();

        const migrated = openUnmanagedDb(dbPath);
        migrated
            .prepare(
                `INSERT INTO ${SQLITE_SOURCE_WATERMARK_SCHEMA.table}
                 (${SQLITE_SOURCE_WATERMARK_SCHEMA.tool}, ${SQLITE_SOURCE_WATERMARK_SCHEMA.sourcePath}, ${SQLITE_SOURCE_WATERMARK_SCHEMA.watermark})
                 VALUES (?, ?, ?)`,
            )
            .run('opencode', '/provider/opencode.db', 123);
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(reopened.prepare(`SELECT * FROM ${SQLITE_SOURCE_WATERMARK_SCHEMA.table}`).all()).toEqual([
            { tool: 'opencode', source_path: '/provider/opencode.db', watermark: 123 },
        ]);
        reopened.close();
    });

    it('rebuilds the pre-evicted durable capture status constraint and preserves existing coverage', () => {
        const directory = withGrantableTestDir('elepha-durable-status-migration-');
        const dbPath = path.join(directory, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec(`
          INSERT INTO projects (path, first_seen_at, last_seen_at)
          VALUES ('/legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
          VALUES ('codex', 'legacy', 1, '/legacy.jsonl', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          DROP TABLE durable_capture_status;
          CREATE TABLE durable_capture_status (
            session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            state TEXT NOT NULL CHECK (state IN ('complete','complete_truncated','disabled_gap','backfilling','source_unavailable','parse_error','revoked','incognito')),
            filter_version INTEGER NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO durable_capture_status VALUES (1, 'complete', 1, '2026-01-01T00:00:00.000Z');
        `);
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        expect(migrated.prepare('SELECT * FROM durable_capture_status').get()).toEqual({
            session_id: 1,
            state: 'complete',
            filter_version: 1,
            updated_at: '2026-01-01T00:00:00.000Z',
        });
        expect(() => migrated.prepare("UPDATE durable_capture_status SET state = 'evicted' WHERE session_id = 1").run()).not.toThrow();
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(reopened.prepare('SELECT state FROM durable_capture_status').get()).toEqual({ state: 'evicted' });
        reopened.close();
    });

    it('creates durable capture FTS objects, rebuilds pre-existing rows once, and remains idempotent on reopen', () => {
        const directory = withGrantableTestDir('elepha-durable-capture-migration-');
        const dbPath = path.join(directory, 'test.db');
        const existing = openUnmanagedDb(dbPath);
        existing.exec(`
          INSERT INTO projects (path, first_seen_at, last_seen_at)
          VALUES ('/legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
          VALUES ('codex', 'legacy', 1, '/legacy.jsonl', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          INSERT INTO memories
            (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
          VALUES
            (1, 1, 0, 'codex', '2026-01-01T00:00:00.000Z', '[]', '[]', '[]', '2026-01-01T00:00:00.000Z');
          INSERT INTO filtered_turns
            (memory_id, included, user_prompt, assistant_response, filter_version, captured_at)
          VALUES (1, 1, 'legacy durable needle', 'response', 1, '2026-01-01T00:00:00.000Z');
          DROP TRIGGER filtered_turns_ai;
          DROP TRIGGER filtered_turns_ad;
          DROP TRIGGER filtered_turns_au;
          DROP TABLE filtered_turns_fts;
          DROP TRIGGER filtered_turns_usage_ai;
          DROP TRIGGER filtered_turns_usage_ad;
          DROP TRIGGER filtered_turns_usage_au;
          DROP TABLE durable_capture_usage;
        `);
        existing.close();

        const migrated = openUnmanagedDb(dbPath);
        expect(
            migrated
                .prepare(
                    `SELECT type, name FROM sqlite_master
                     WHERE name IN ('filtered_turns_fts', 'filtered_turns_ai', 'filtered_turns_ad', 'filtered_turns_au')
                     ORDER BY name`,
                )
                .all(),
        ).toEqual([
            { type: 'trigger', name: 'filtered_turns_ad' },
            { type: 'trigger', name: 'filtered_turns_ai' },
            { type: 'trigger', name: 'filtered_turns_au' },
            { type: 'table', name: 'filtered_turns_fts' },
        ]);
        expect(migrated.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'needle'").all()).toEqual([
            { rowid: 1 },
        ]);
        expect(migrated.prepare('SELECT total_bytes FROM durable_capture_usage').get()).toEqual(
            migrated
                .prepare(
                    `SELECT SUM(
                       length(CAST(user_prompt AS BLOB)) +
                       length(CAST(assistant_response AS BLOB)) +
                       length(CAST(tool_calls AS BLOB))
                     ) AS total_bytes
                     FROM filtered_turns`,
                )
                .get(),
        );
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(reopened.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'needle'").all()).toEqual([
            { rowid: 1 },
        ]);
        reopened.close();
    });

    it('accepts (tool, native_id, 1) alongside (tool, native_id, 0)', () => {
        const db = openUnmanagedDb(':memory:');
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

describe('shown-session-list tool migration', () => {
    it('accepts opencode in a fresh database', () => {
        const db = openUnmanagedDb(':memory:');

        expect(() =>
            db
                .prepare('INSERT INTO shown_session_lists (tool, native_session_id, session_ids) VALUES (?, ?, ?)')
                .run('opencode', 'fresh-chat', '[1]'),
        ).not.toThrow();
        db.close();
    });

    it('widens a legacy constraint, preserves rows, and is unchanged on reopen', () => {
        const directory = withGrantableTestDir('elepha-shown-list-tool-migration-');
        const dbPath = path.join(directory, 'test.db');
        const legacy = openUnmanagedDb(dbPath);
        legacy.exec(`
            DROP TABLE shown_session_lists;
            CREATE TABLE shown_session_lists (
              tool              TEXT NOT NULL CHECK (tool IN ('claude-code','codex')),
              native_session_id TEXT NOT NULL,
              session_ids       TEXT NOT NULL,
              PRIMARY KEY (tool, native_session_id)
            );
            INSERT INTO shown_session_lists (tool, native_session_id, session_ids)
            VALUES ('claude-code', 'legacy-chat', '[7]');
        `);
        legacy.close();

        const migrated = openUnmanagedDb(dbPath);
        migrated
            .prepare('INSERT INTO shown_session_lists (tool, native_session_id, session_ids) VALUES (?, ?, ?)')
            .run('opencode', 'new-chat', '[9]');
        expect(migrated.prepare('SELECT * FROM shown_session_lists ORDER BY native_session_id').all()).toEqual([
            { tool: 'claude-code', native_session_id: 'legacy-chat', session_ids: '[7]' },
            { tool: 'opencode', native_session_id: 'new-chat', session_ids: '[9]' },
        ]);
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(reopened.prepare('SELECT * FROM shown_session_lists ORDER BY native_session_id').all()).toEqual([
            { tool: 'claude-code', native_session_id: 'legacy-chat', session_ids: '[7]' },
            { tool: 'opencode', native_session_id: 'new-chat', session_ids: '[9]' },
        ]);
        reopened.close();
    });
});

describe('migration idempotency and reversibility', () => {
    it('adds first_prompt_search to an existing sessions table and leaves historical rows NULL on reopen', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-first-prompt-search-column-'));
        const dbPath = path.join(dir, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec(`
          INSERT INTO projects (path, display_name, first_seen_at, last_seen_at)
          VALUES ('/legacy', 'legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
          VALUES ('codex', 'legacy', 1, '/legacy.jsonl', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          ALTER TABLE sessions DROP COLUMN first_prompt_search;
        `);
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        expect((migrated.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name)).toContain('first_prompt_search');
        expect(migrated.prepare('SELECT first_prompt_search FROM sessions WHERE native_id = ?').get('legacy')).toEqual({
            first_prompt_search: null,
        });
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect((reopened.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name)).toContain('first_prompt_search');
        reopened.close();
    });

    it('adds the first-prompt background skip table to an existing database and is a no-op when reopened', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-first-prompt-search-skips-'));
        const dbPath = path.join(dir, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec('DROP TABLE first_prompt_search_backfill_skips');
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        expect((migrated.pragma('table_info(first_prompt_search_backfill_skips)') as Array<{ name: string }>).map((c) => c.name)).toEqual([
            'session_id',
            'skipped_at',
        ]);
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect((reopened.pragma('table_info(first_prompt_search_backfill_skips)') as Array<{ name: string }>).map((c) => c.name)).toEqual([
            'session_id',
            'skipped_at',
        ]);
        reopened.close();
    });

    it('adds the shown-session-list table to an existing database and is a no-op when reopened', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-shown-session-list-table-'));
        const dbPath = path.join(dir, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec('DROP TABLE shown_session_lists');
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        expect((migrated.pragma('table_info(shown_session_lists)') as Array<{ name: string }>).map((c) => c.name)).toEqual([
            'tool',
            'native_session_id',
            'session_ids',
        ]);
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
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
        const prior = openUnmanagedDb(dbPath);
        prior.exec('DROP TABLE incognito_transcripts');
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        expect((migrated.pragma('table_info(incognito_transcripts)') as Array<{ name: string }>).map((c) => c.name)).toEqual([
            'tool',
            'native_id',
            'tombstoned_at',
        ]);
        migrated
            .prepare('INSERT INTO incognito_transcripts (tool, native_id, tombstoned_at) VALUES (?, ?, ?)')
            .run('codex', 'off-session', '2026-08-26T00:00:00.000Z');
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
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

        const migrated = openUnmanagedDb(dbPath);
        expect((migrated.pragma('table_info(projects)') as Array<{ name: string }>).map((c) => c.name)).toContain('git_root_commit');
        expect(migrated.prepare('SELECT git_root_commit FROM projects WHERE path = ?').get('/legacy')).toEqual({ git_root_commit: null });
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
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

        const migrated = openUnmanagedDb(dbPath);
        expect((migrated.pragma('table_info(consent_roots)') as Array<{ name: string }>).map((c) => c.name)).toContain('nudged_at');
        expect(migrated.prepare('SELECT nudged_at FROM consent_roots WHERE path = ?').get('/legacy')).toEqual({ nudged_at: null });
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect((reopened.pragma('table_info(consent_roots)') as Array<{ name: string }>).map((c) => c.name)).toContain('nudged_at');
        reopened.close();
    });

    it('drops the legacy session_rollups substantive column once and is a no-op when reopened', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-rollup-column-'));
        const dbPath = path.join(dir, 'test.db');

        const fresh = openUnmanagedDb(dbPath);
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

        const migrated = openUnmanagedDb(dbPath);
        expect((migrated.pragma('table_info(session_rollups)') as Array<{ name: string }>).map((c) => c.name)).not.toContain('substantive');
        expect(migrated.prepare('SELECT title FROM session_rollups').get()).toEqual({ title: 'Legacy rollup' });
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect((reopened.pragma('table_info(session_rollups)') as Array<{ name: string }>).map((c) => c.name)).not.toContain('substantive');
        reopened.close();
    });

    it('running openUnmanagedDb twice on the same file is a no-op the second time (idempotent)', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-migration-'));
        const dbPath = path.join(dir, 'test.db');

        const first = openUnmanagedDb(dbPath);
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

        const second = openUnmanagedDb(dbPath);
        const rows = second.prepare('SELECT * FROM sessions').all();
        expect(rows).toHaveLength(1); // the row survived, wasn't duplicated or dropped
        const cols = (second.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name);
        expect(cols).toContain('segment_index');
        second.close();
    });

    it('the old-shape sessions table (pre-migration) upgrades cleanly and preserves every row', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'elepha-migration-old-'));
        const dbPath = path.join(dir, 'test.db');

        // Build the OLD shape directly (bypassing openUnmanagedDb, which always writes
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

        const migrated = openUnmanagedDb(dbPath);
        const row = migrated.prepare('SELECT * FROM sessions WHERE native_id = ?').get('legacy-1') as Record<string, unknown>;
        expect(row.id).toBe(1); // id preserved across the rebuild
        expect(row.segment_index).toBe(0);
        expect(row.surface).toBeNull();
        expect(row.trailing_files).toBe('[]');
        expect(row.custom_title).toBeNull();
        expect(() =>
            migrated
                .prepare(
                    `INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
                     VALUES ('opencode', 'legacy-opencode', 1, '/provider/opencode.db', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
                )
                .run(),
        ).not.toThrow();

        const memRow = migrated.prepare('SELECT * FROM memories WHERE session_id = ?').get(1) as Record<string, unknown>;
        expect(memRow.has_external_content).toBe(0);

        const violations = migrated.pragma('foreign_key_check');
        expect(violations).toEqual([]);
        migrated.close();
    });
});
