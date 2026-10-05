import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { openUnmanagedDb, SQLITE_SOURCE_WATERMARK_SCHEMA } from '../../src/storage/db.js';
import { dropLiveMemoryLedger } from '../helpers/live-memory.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

describe('sessions table migration', () => {
    it('adds compact assistant structure to a populated prior durable schema and keeps mixed writers and reopen idempotent', () => {
        const directory = withGrantableTestDir('elepha-assistant-structure-migration-');
        const dbPath = path.join(directory, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        dropLiveMemoryLedger(prior);
        prior.exec(`
          INSERT INTO projects (path, first_seen_at, last_seen_at) VALUES ('/legacy', '2026-01-01', '2026-01-01');
          INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
          VALUES ('codex', 'legacy', 1, '/legacy.jsonl', '2026-01-01', '2026-01-01');
          INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
          VALUES (1, 1, 0, 'codex', '2026-01-01', '[]', '[]', '[]', '2026-01-01');
          INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, filter_version, captured_at)
          VALUES (1, 1, 'Legacy question', 'Original response', 1, '2026-01-01');
          DROP TRIGGER filtered_turns_structure_au;
          DROP TRIGGER filtered_turns_usage_ai;
          DROP TRIGGER filtered_turns_usage_ad;
          DROP TRIGGER filtered_turns_usage_au;
          ALTER TABLE filtered_turns DROP COLUMN assistant_structure;
          CREATE TRIGGER filtered_turns_usage_ai AFTER INSERT ON filtered_turns BEGIN
            UPDATE durable_capture_usage SET total_bytes = total_bytes + length(CAST(new.user_prompt AS BLOB)) + length(CAST(new.assistant_response AS BLOB)) + length(CAST(new.tool_calls AS BLOB)) WHERE id = 1;
          END;
          CREATE TRIGGER filtered_turns_usage_ad AFTER DELETE ON filtered_turns BEGIN
            UPDATE durable_capture_usage SET total_bytes = total_bytes - length(CAST(old.user_prompt AS BLOB)) - length(CAST(old.assistant_response AS BLOB)) - length(CAST(old.tool_calls AS BLOB)) WHERE id = 1;
          END;
          CREATE TRIGGER filtered_turns_usage_au AFTER UPDATE OF user_prompt, assistant_response, tool_calls ON filtered_turns BEGIN
            UPDATE durable_capture_usage SET total_bytes = total_bytes - length(CAST(old.user_prompt AS BLOB)) - length(CAST(old.assistant_response AS BLOB)) - length(CAST(old.tool_calls AS BLOB)) + length(CAST(new.user_prompt AS BLOB)) + length(CAST(new.assistant_response AS BLOB)) + length(CAST(new.tool_calls AS BLOB)) WHERE id = 1;
          END;
          DROP TRIGGER filtered_turns_au;
          CREATE TRIGGER filtered_turns_au AFTER UPDATE ON filtered_turns BEGIN
            INSERT INTO filtered_turns_fts(filtered_turns_fts, rowid, user_prompt, assistant_response, tool_calls)
            VALUES ('delete', old.memory_id, old.user_prompt, old.assistant_response, old.tool_calls);
            INSERT INTO filtered_turns_fts(rowid, user_prompt, assistant_response, tool_calls)
            VALUES (new.memory_id, new.user_prompt, new.assistant_response, new.tool_calls);
          END;
        `);
        const before = prior.prepare('SELECT * FROM filtered_turns').get();
        const initialUsage = prior.prepare('SELECT total_bytes FROM durable_capture_usage').get();
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        expect(migrated.prepare('SELECT * FROM filtered_turns').get()).toEqual({ ...(before as object), assistant_structure: null });
        expect(migrated.prepare('SELECT total_bytes FROM durable_capture_usage').get()).toEqual(initialUsage);
        const metadata = JSON.stringify({ unclassified: false, finals: [[0, 17]], omitted: 0 });
        migrated.prepare('UPDATE filtered_turns SET assistant_structure = ?').run(metadata);
        const afterStructure = migrated.prepare('SELECT total_bytes FROM durable_capture_usage').get();
        expect(afterStructure).toEqual({
            total_bytes: (initialUsage as { total_bytes: number }).total_bytes + Buffer.byteLength(metadata),
        });
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(reopened.prepare('SELECT total_bytes FROM durable_capture_usage').get()).toEqual(afterStructure);
        expect(reopened.prepare('SELECT assistant_structure FROM filtered_turns').get()).toEqual({ assistant_structure: metadata });
        // A writer from before the new column still updates ordinary content.
        reopened.prepare('UPDATE filtered_turns SET assistant_response = ?').run('Replacement response');
        expect(reopened.prepare('SELECT assistant_structure FROM filtered_turns').get()).toEqual({ assistant_structure: null });
        expect(reopened.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'Replacement'").all()).toEqual([
            { rowid: 1 },
        ]);
        expect(reopened.prepare('SELECT total_bytes FROM durable_capture_usage').get()).toEqual({
            total_bytes: Buffer.byteLength('Legacy questionReplacement response[]'),
        });
        expect(reopened.pragma('foreign_key_check')).toEqual([]);
        reopened.close();
    });

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
                'source_format',
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
        const standingRuleCols = (db.pragma('table_info(standing_rules)') as Array<{ name: string; notnull: number }>).map((c) => c.name);
        expect(standingRuleCols).toEqual(['id', 'ulid', 'project_id', 'text', 'created_at']);
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
            'assistant_structure',
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
        expect((db.pragma('table_info(open_turns)') as Array<{ name: string }>).map((column) => column.name)).toEqual(
            expect.arrayContaining([
                'tool',
                'native_session_id',
                'session_id',
                'project_id',
                'source_generation',
                'turn_index',
                'anchor_cursor',
                'candidate_cursor',
                'source_revision',
                'source_digest',
                'failed_at',
                'staged_at',
                'validation_epoch',
                'validated_epoch',
                'receipt_coverage',
                'decisions',
                'durable_user_prompt',
                'durable_filter_version',
            ]),
        );
        expect(
            (db.pragma(`table_info(${SQLITE_SOURCE_WATERMARK_SCHEMA.table})`) as Array<{ name: string }>).map((column) => column.name),
        ).toEqual([
            SQLITE_SOURCE_WATERMARK_SCHEMA.tool,
            SQLITE_SOURCE_WATERMARK_SCHEMA.sourcePath,
            SQLITE_SOURCE_WATERMARK_SCHEMA.watermark,
            SQLITE_SOURCE_WATERMARK_SCHEMA.cursorId,
        ]);
        db.close();
    });

    it('labels existing V2 cursors without changing historical OpenCode rows and reopens idempotently', () => {
        const directory = withGrantableTestDir('elepha-opencode-format-migration-');
        const dbPath = path.join(directory, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec(`
          INSERT INTO projects (path, first_seen_at, last_seen_at) VALUES ('/legacy', '2026-01-01', '2026-01-01');
          INSERT INTO sessions (tool, native_id, project_id, source_path, cursor, started_at, last_ingested_at)
          VALUES ('opencode', 'legacy-v1', 1, '/provider/opencode.db', '2100|msg_4', '2026-01-01', '2026-01-01'),
                 ('opencode', 'captured-v2', 1, '/provider/opencode.db', 'v2:3|msg_captured_3', '2026-01-01', '2026-01-01');
          ALTER TABLE sessions DROP COLUMN source_format;
        `);
        prior.close();

        for (let reopen = 0; reopen < 2; reopen++) {
            const migrated = openUnmanagedDb(dbPath);
            expect(migrated.prepare('SELECT native_id, source_format, cursor FROM sessions ORDER BY native_id').all()).toEqual([
                { native_id: 'captured-v2', source_format: 'opencode-v2', cursor: 'v2:3|msg_captured_3' },
                { native_id: 'legacy-v1', source_format: 'native', cursor: '2100|msg_4' },
            ]);
            expect(migrated.pragma('foreign_key_check')).toEqual([]);
            migrated.close();
        }
    });

    it('adds task-state manifests to a populated prior database and preserves rows across two reopens', () => {
        const directory = withGrantableTestDir('elepha-task-state-manifest-migration-');
        const dbPath = path.join(directory, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec(`
          INSERT INTO projects (path, first_seen_at, last_seen_at) VALUES ('/legacy', '2026-01-01', '2026-01-01');
          INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
          VALUES ('codex', 'legacy', 1, '/legacy.jsonl', '2026-01-01', '2026-01-01');
          INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
          VALUES (1, 1, 0, 'codex', '2026-01-01', '[]', '[]', '[]', '2026-01-01');
          DROP TABLE task_state_manifests;
        `);
        const original = {
            projects: prior.prepare('SELECT * FROM projects').all(),
            sessions: prior.prepare('SELECT * FROM sessions').all(),
            memories: prior.prepare('SELECT * FROM memories').all(),
        };
        prior.close();

        for (let reopen = 0; reopen < 2; reopen++) {
            const migrated = openUnmanagedDb(dbPath);
            expect((migrated.pragma('table_info(task_state_manifests)') as Array<{ name: string }>).map((column) => column.name)).toEqual([
                'memory_id',
                'report',
                'reporting_source',
                'source_locators',
                'coverage_state',
                'resolved_source_count',
                'total_source_count',
                'coverage_reason',
                'created_at',
            ]);
            expect(migrated.pragma('foreign_key_list(task_state_manifests)')).toEqual(
                expect.arrayContaining([expect.objectContaining({ table: 'memories', from: 'memory_id', on_delete: 'CASCADE' })]),
            );
            expect(migrated.prepare('SELECT * FROM projects').all()).toEqual(original.projects);
            expect(migrated.prepare('SELECT * FROM sessions').all()).toEqual(original.sessions);
            expect(migrated.prepare('SELECT * FROM memories').all()).toEqual(original.memories);
            expect(migrated.prepare('SELECT memory_id FROM task_state_manifests').all()).toEqual(reopen === 0 ? [] : [{ memory_id: 1 }]);
            const insert = migrated.prepare(`INSERT INTO task_state_manifests
                (memory_id, report, reporting_source, source_locators, coverage_state,
                 resolved_source_count, total_source_count, coverage_reason, created_at)
                VALUES (?, '{}', '{}', '[]', 'incomplete', 0, 0, 'no_source_backed_items', '2026-01-01')`);
            if (reopen === 0) {
                insert.run(1);
            }
            expect(() => insert.run(999)).toThrow();
            expect(migrated.pragma('foreign_key_check')).toEqual([]);
            migrated.close();
        }
    });

    it('adds one-use task-state requests to a populated prior database and reopens idempotently', () => {
        const directory = withGrantableTestDir('elepha-task-state-request-migration-');
        const dbPath = path.join(directory, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec(`
            INSERT INTO projects (id, path, first_seen_at, last_seen_at) VALUES (1, '/legacy', '2026-01-01', '2026-01-01');
            INSERT INTO sessions (id, tool, native_id, project_id, source_path, started_at, last_ingested_at, kind)
            VALUES (1, 'codex', 'legacy', 1, '/legacy.jsonl', '2026-01-01', '2026-01-01', 'main');
            INSERT INTO injections (id, tool, native_session_id, injected_at, injection_id, body_hash, body)
            VALUES (1, 'codex', 'legacy', '2026-01-01', 'injected', 'hash', 'request');
            DROP TABLE task_state_requests;
        `);
        prior.close();

        for (let reopen = 0; reopen < 2; reopen++) {
            const migrated = openUnmanagedDb(dbPath);
            expect(migrated.pragma('foreign_key_list(task_state_requests)')).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ table: 'injections', from: 'injection_row_id', on_delete: 'CASCADE' }),
                    expect.objectContaining({ table: 'sessions', from: 'session_id', on_delete: 'CASCADE' }),
                ]),
            );
            expect(migrated.prepare('SELECT request_id FROM task_state_requests').all()).toEqual(
                reopen === 0 ? [] : [{ request_id: '01J00000000000000000000000' }],
            );
            if (reopen === 0) {
                const insert = migrated.prepare(`INSERT INTO task_state_requests
                    (request_id, injection_row_id, session_id, tool, native_session_id, mode,
                     physical_checkout, checkout_dev, checkout_ino, consent_ulid, consent_decided_at, source_path,
                     source_generation, after_turn_index, issued_at)
                    VALUES (?, ?, 1, 'codex', 'legacy', 'precompact_manifest',
                            '/legacy', '1', '1', 'grant', '2026-01-01', '/legacy.jsonl', 0, -1, '2026-01-01')`);
                insert.run('01J00000000000000000000000', 1);
                expect(() => insert.run('01J00000000000000000000001', 999)).toThrow();
            }
            expect(migrated.pragma('foreign_key_check')).toEqual([]);
            migrated.close();
        }
    });

    it('adds MCP receipts to an existing database and leaves the migration idempotent on reopen', () => {
        const directory = withGrantableTestDir('elepha-mcp-receipts-migration-');
        const dbPath = path.join(directory, 'test.db');
        const legacy = openUnmanagedDb(dbPath);
        legacy.exec('DROP TABLE mcp_receipts');
        legacy.close();

        const migrated = openUnmanagedDb(dbPath);
        expect((migrated.pragma('table_info(mcp_receipts)') as Array<{ name: string }>).map((column) => column.name)).toEqual([
            'id',
            'tool',
            'native_session_id',
            'source_generation',
            'source_turn_index',
            'call_id',
            'observed_at',
            'body_hash',
            'body',
        ]);
        expect(
            migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mcp_receipts_source_order'").get(),
        ).toEqual({
            name: 'idx_mcp_receipts_source_order',
        });
        migrated
            .prepare(
                `INSERT INTO mcp_receipts
                 (tool, native_session_id, source_generation, source_turn_index, call_id, observed_at, body_hash, body)
                 VALUES ('codex', 'legacy-session', 0, 4, 'call-1', NULL, 'hash', 'body')`,
            )
            .run();
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(reopened.prepare('SELECT source_generation, source_turn_index, call_id, observed_at, body FROM mcp_receipts').all()).toEqual(
            [{ source_generation: 0, source_turn_index: 4, call_id: 'call-1', observed_at: null, body: 'body' }],
        );
        reopened.close();
    });

    it('adds open-turn staging to a real prior database and leaves the migration idempotent on reopen', () => {
        const directory = withGrantableTestDir('elepha-open-turns-migration-');
        const dbPath = path.join(directory, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec(`
          DROP TRIGGER open_turns_usage_ai;
          DROP TRIGGER open_turns_usage_ad;
          DROP TRIGGER open_turns_usage_au;
          DROP TABLE open_turns;
          CREATE TABLE open_turns (
            tool TEXT NOT NULL,
            native_session_id TEXT NOT NULL,
            session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            source_generation INTEGER NOT NULL,
            turn_index INTEGER NOT NULL,
            anchor_cursor TEXT,
            candidate_cursor TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_dev TEXT NOT NULL,
            source_ino TEXT NOT NULL,
            source_size INTEGER NOT NULL,
            source_mtime_ms REAL NOT NULL,
            source_revision TEXT NOT NULL,
            source_digest TEXT NOT NULL,
            failed_at TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            staged_at TEXT,
            receipt_coverage TEXT NOT NULL CHECK (receipt_coverage IN ('complete','incomplete')),
            receipt_failure TEXT,
            decisions TEXT,
            pending_items TEXT,
            summarizer_status TEXT,
            durable_included INTEGER CHECK (durable_included IN (0,1)),
            durable_user_prompt TEXT,
            durable_assistant_response TEXT,
            durable_assistant_structure TEXT,
            durable_tool_calls TEXT,
            durable_omitted_tool_call_count INTEGER,
            durable_dropped_tool_ref_count INTEGER,
            durable_omitted_before_chars INTEGER,
            durable_filter_version INTEGER,
            PRIMARY KEY (tool, native_session_id)
          );
        `);
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        const columns = migrated.pragma('table_info(open_turns)') as Array<{ name: string; dflt_value: string | null }>;
        expect(columns.map((column) => column.name)).toEqual(
            expect.arrayContaining(['source_revision', 'validation_epoch', 'validated_epoch']),
        );
        expect(columns.find((column) => column.name === 'validation_epoch')?.dflt_value).toBe('0');
        expect(columns.find((column) => column.name === 'validated_epoch')?.dflt_value).toBe('0');
        expect(
            migrated
                .prepare(
                    `SELECT name FROM sqlite_master
                     WHERE type = 'trigger' AND name LIKE 'open_turns_usage_%'
                     ORDER BY name`,
                )
                .all(),
        ).toEqual([{ name: 'open_turns_usage_ad' }, { name: 'open_turns_usage_ai' }, { name: 'open_turns_usage_au' }]);
        expect(migrated.pragma('foreign_key_check')).toEqual([]);
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect((reopened.pragma('table_info(open_turns)') as Array<{ name: string }>).map((column) => column.name)).toEqual(
            expect.arrayContaining(['validation_epoch', 'validated_epoch']),
        );
        expect(reopened.pragma('foreign_key_check')).toEqual([]);
        reopened.close();
    });

    it('adds the hook quote-back ordering index to an existing database idempotently', () => {
        const directory = withGrantableTestDir('elepha-hook-order-index-migration-');
        const dbPath = path.join(directory, 'test.db');
        const legacy = openUnmanagedDb(dbPath);
        legacy.exec('DROP INDEX idx_injections_session_order');
        legacy.close();

        const migrated = openUnmanagedDb(dbPath);
        expect(
            migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_injections_session_order'").get(),
        ).toEqual({ name: 'idx_injections_session_order' });
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(
            reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_injections_session_order'").get(),
        ).toEqual({ name: 'idx_injections_session_order' });
        reopened.close();
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
            { tool: 'opencode', source_path: '/provider/opencode.db', watermark: 123, cursor_id: null },
        ]);
        reopened.close();
    });

    it('adds a cursor ID to an existing V2 watermark row and preserves the timestamp on reopen', () => {
        const directory = withGrantableTestDir('elepha-sqlite-cursor-migration-');
        const dbPath = path.join(directory, 'test.db');
        const legacy = openUnmanagedDb(dbPath);
        legacy.exec(`DROP TABLE ${SQLITE_SOURCE_WATERMARK_SCHEMA.table};
            CREATE TABLE ${SQLITE_SOURCE_WATERMARK_SCHEMA.table} (
                tool TEXT NOT NULL, source_path TEXT NOT NULL, watermark INTEGER NOT NULL,
                PRIMARY KEY (tool, source_path)
            );
            INSERT INTO ${SQLITE_SOURCE_WATERMARK_SCHEMA.table} VALUES ('opencode', '/provider/opencode.db#session_v2', 123);`);
        legacy.close();

        const migrated = openUnmanagedDb(dbPath);
        expect(migrated.prepare(`SELECT * FROM ${SQLITE_SOURCE_WATERMARK_SCHEMA.table}`).all()).toEqual([
            { tool: 'opencode', source_path: '/provider/opencode.db#session_v2', watermark: 123, cursor_id: null },
        ]);
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(reopened.prepare(`SELECT * FROM ${SQLITE_SOURCE_WATERMARK_SCHEMA.table}`).all()).toEqual([
            { tool: 'opencode', source_path: '/provider/opencode.db#session_v2', watermark: 123, cursor_id: null },
        ]);
        reopened.close();
    });

    it('adds a metadata-only V2 pending queue to a prior database and reopens idempotently', () => {
        const directory = withGrantableTestDir('elepha-opencode-v2-pending-migration-');
        const dbPath = path.join(directory, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec('DROP TABLE opencode_v2_pending');
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        const columns = (migrated.pragma('table_info(opencode_v2_pending)') as Array<{ name: string }>).map((column) => column.name);
        expect(columns).toEqual([
            'source_path',
            'native_id',
            'observed_seq',
            'observed_updated',
            'retry_rank',
            'needs_continuation',
            'resume_cursor',
        ]);
        migrated
            .prepare(`INSERT INTO opencode_v2_pending
                (source_path, native_id, observed_seq, observed_updated, needs_continuation)
                VALUES ('/provider/opencode.db', 'ses_pending', 3, 400, 0)`)
            .run();
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(reopened.prepare('SELECT * FROM opencode_v2_pending').all()).toEqual([
            {
                source_path: '/provider/opencode.db',
                native_id: 'ses_pending',
                observed_seq: 3,
                observed_updated: 400,
                retry_rank: 0,
                needs_continuation: 0,
                resume_cursor: null,
            },
        ]);
        reopened.close();
    });

    it('adds the metadata-only V2 handoff table to a prior database and reopens idempotently', () => {
        const directory = withGrantableTestDir('elepha-opencode-v2-handoff-migration-');
        const dbPath = path.join(directory, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec('DROP TABLE opencode_v2_handoffs');
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        const columns = (migrated.pragma('table_info(opencode_v2_handoffs)') as Array<{ name: string }>).map((column) => column.name);
        expect(columns).toEqual([
            'native_id',
            'source_path',
            'status',
            'v1_cursor',
            'turn_index_offset',
            'observed_seq',
            'observed_updated',
            'observed_v1_updated',
            'needs_continuation',
            'reason',
        ]);
        migrated
            .prepare(`INSERT INTO opencode_v2_handoffs
                (native_id, source_path, status, v1_cursor, turn_index_offset, observed_seq, observed_updated, observed_v1_updated)
                VALUES ('ses_handoff', '/provider/opencode.db', 'active', '2100|msg_4', 2, 8, 300, 200)`)
            .run();
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(reopened.prepare('SELECT * FROM opencode_v2_handoffs').all()).toEqual([
            {
                native_id: 'ses_handoff',
                source_path: '/provider/opencode.db',
                status: 'active',
                v1_cursor: '2100|msg_4',
                turn_index_offset: 2,
                observed_seq: 8,
                observed_updated: 300,
                observed_v1_updated: 200,
                needs_continuation: 0,
                reason: null,
            },
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
            state TEXT NOT NULL CHECK (state IN ('complete','complete_truncated','disabled_gap','parse_error','revoked','incognito')),
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
    it('adds resume contexts beside stored cursors in a populated prior database and reopens idempotently', () => {
        const dir = withTempDir('elepha-resume-context-columns-');
        const dbPath = path.join(dir, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec(`
          INSERT INTO projects (path, first_seen_at, last_seen_at) VALUES ('/legacy', '2026-01-01', '2026-01-01');
          INSERT INTO sessions (tool, native_id, project_id, source_path, cursor, started_at, last_ingested_at)
          VALUES ('codex', 'legacy', 1, '/legacy.jsonl', '120|1|0123456789abcdef', '2026-01-01', '2026-01-01');
          INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
          VALUES (1, 1, 0, 'codex', '2026-01-01', '[]', '[]', '[]', '2026-01-01');
          INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, filter_version, captured_at)
          VALUES (1, 1, 'Legacy question', 'Legacy answer', 1, '2026-01-01');
          INSERT INTO turn_search_index
            (memory_id, coverage, locator, source_cursor, source_digest, omitted_user_chars, omitted_assistant_chars, filter_version, indexed_at)
          VALUES (1, 'included', 'available', '120|1|0123456789abcdef', 'digest', 0, 0, 1, '2026-01-01');
          ALTER TABLE sessions DROP COLUMN cursor_context;
          ALTER TABLE turn_search_index DROP COLUMN source_context;
        `);
        prior.close();

        const state = (db: Database.Database) => ({
            sessionColumns: (db.pragma('table_info(sessions)') as Array<{ name: string }>).filter((c) => c.name === 'cursor_context')
                .length,
            coverageColumns: (db.pragma('table_info(turn_search_index)') as Array<{ name: string }>).filter(
                (c) => c.name === 'source_context',
            ).length,
            session: db.prepare('SELECT cursor, cursor_context FROM sessions').get(),
            coverage: db.prepare('SELECT source_cursor, source_context, source_digest FROM turn_search_index').get(),
        });
        const expected = {
            sessionColumns: 1,
            coverageColumns: 1,
            session: { cursor: '120|1|0123456789abcdef', cursor_context: null },
            coverage: { source_cursor: '120|1|0123456789abcdef', source_context: null, source_digest: 'digest' },
        };
        const migrated = openUnmanagedDb(dbPath);
        expect(state(migrated)).toEqual(expected);
        migrated.close();
        const reopened = openUnmanagedDb(dbPath);
        expect(state(reopened)).toEqual(expected);
        reopened.close();
    });

    it('creates resume-context columns in a fresh database', () => {
        const db = openUnmanagedDb(':memory:');
        expect((db.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name)).toContain('cursor_context');
        expect((db.pragma('table_info(turn_search_index)') as Array<{ name: string }>).map((c) => c.name)).toContain('source_context');
        db.close();
    });

    it('adds first_prompt_search to an existing sessions table and leaves historical rows NULL on reopen', () => {
        const dir = withTempDir('elepha-first-prompt-search-column-');
        const dbPath = path.join(dir, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        dropLiveMemoryLedger(prior);
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
        const dir = withTempDir('elepha-first-prompt-search-skips-');
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
        const dir = withTempDir('elepha-shown-session-list-table-');
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
        const dir = withTempDir('elepha-incognito-table-');
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

    it('adds standing rules to a legacy database, preserves stored rules, and is a no-op when reopened', () => {
        const dir = withTempDir('elepha-standing-rules-table-');
        const dbPath = path.join(dir, 'test.db');
        const prior = openUnmanagedDb(dbPath);
        prior.exec(`
          INSERT INTO projects (path, display_name, first_seen_at, last_seen_at)
          VALUES ('/legacy', 'legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          DROP INDEX idx_standing_rules_project;
          DROP TABLE standing_rules;
        `);
        prior.close();

        const migrated = openUnmanagedDb(dbPath);
        expect((migrated.pragma('table_info(standing_rules)') as Array<{ name: string }>).map((column) => column.name)).toEqual([
            'id',
            'ulid',
            'project_id',
            'text',
            'created_at',
        ]);
        expect(
            migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_standing_rules_project'").get(),
        ).toEqual({ name: 'idx_standing_rules_project' });
        migrated
            .prepare('INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)')
            .run('01J00000000000000000000000', 1, 'Legacy standing rule.', '2026-01-01T00:00:00.000Z');
        // The project row that owns a rule cannot be removed by a cascade.
        expect(() => migrated.prepare('DELETE FROM projects WHERE id = 1').run()).toThrow(/FOREIGN KEY/);
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(reopened.prepare('SELECT ulid, project_id, text FROM standing_rules').all()).toEqual([
            { ulid: '01J00000000000000000000000', project_id: 1, text: 'Legacy standing rule.' },
        ]);
        expect(reopened.pragma('foreign_key_check')).toEqual([]);
        reopened.close();
    });

    it('adds git_root_commit to a legacy projects table and is a no-op when reopened', () => {
        const dir = withTempDir('elepha-project-root-commit-column-');
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
        const dir = withTempDir('elepha-consent-nudge-column-');
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
        const dir = withTempDir('elepha-rollup-column-');
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
        const dir = withTempDir('elepha-migration-');
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
        const dir = withTempDir('elepha-migration-old-');
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

    it('creates session-dependent tables against the rebuilt sessions table and keeps them on reopen', () => {
        const dir = withTempDir('elepha-migration-session-dependents-');
        const dbPath = path.join(dir, 'test.db');
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
      INSERT INTO projects (path, first_seen_at, last_seen_at) VALUES ('/p', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
      VALUES ('opencode', 'legacy-1', 1, '/provider/opencode.db', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
        raw.close();
        const sessionParents = (db: Database.Database) =>
            ['task_state_requests', 'opencode_compaction_receipts', 'opencode_task_state_receipts'].map((table) => [
                table,
                (db.pragma(`foreign_key_list(${table})`) as Array<{ table: string; from: string }>)
                    .filter((key) => key.from === 'session_id')
                    .map((key) => key.table),
            ]);
        const expectedParents = [
            ['task_state_requests', ['sessions']],
            ['opencode_compaction_receipts', ['sessions']],
            ['opencode_task_state_receipts', ['sessions']],
        ];

        const migrated = openUnmanagedDb(dbPath);
        expect(sessionParents(migrated)).toEqual(expectedParents);
        migrated
            .prepare(
                `INSERT INTO opencode_compaction_receipts (session_id, summary, reason, observed_at, coverage)
                 VALUES (1, 'summary', 'auto', '2026-01-01T00:00:00.000Z', 'volatile_unverified')`,
            )
            .run();
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        try {
            expect(sessionParents(reopened)).toEqual(expectedParents);
            expect(reopened.prepare('SELECT COUNT(*) FROM opencode_compaction_receipts').pluck().get()).toBe(1);
            // The session foreign key must cascade from the live sessions table.
            reopened.prepare('DELETE FROM sessions WHERE id = 1').run();
            expect(reopened.prepare('SELECT COUNT(*) FROM opencode_compaction_receipts').pluck().get()).toBe(0);
            expect(reopened.pragma('foreign_key_check')).toEqual([]);
        } finally {
            reopened.close();
        }
    });
});
