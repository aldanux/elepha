import path from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { liveMemoryUsageLine } from '../../src/cli/status.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { reconcileLiveMemoryUsage } from '../../src/storage/live-memory-usage.js';
import { expectLiveMemoryCurrent, independentLiveMemoryBytes, ledgerBytes } from '../helpers/live-memory.js';
import { withTempDir } from '../helpers/tmp.js';

const T = '2026-09-01T00:00:00.000Z';

function vector(dimensions: number, seed: number): Buffer {
    const values = new Float32Array(dimensions).map((_, index) => seed + index);
    return Buffer.from(values.buffer);
}

// Populates every counted table, with multibyte text, NULL fields, and BLOB
// vectors.
function seedEvidence(db: Database.Database): void {
    db.exec(`
      INSERT INTO projects (id, path, first_seen_at, last_seen_at) VALUES (1, '/work/app', '${T}', '${T}');
      INSERT INTO sessions (id, tool, native_id, project_id, source_path, started_at, last_ingested_at, title, custom_title, first_prompt_search)
      VALUES (1, 'codex', 'native-1', 1, '/src/one.jsonl', '${T}', '${T}', 'Título ☃', NULL, 'primer prompt 😀');
      INSERT INTO sessions (id, tool, native_id, project_id, source_path, started_at, last_ingested_at, title, custom_title, first_prompt_search)
      VALUES (2, 'claude-code', 'native-2', 1, '/src/two.jsonl', '${T}', '${T}', NULL, 'Custom — name', NULL);
      INSERT INTO memories (id, project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
      VALUES (1, 1, 1, 0, 'codex', '${T}', '[{"what":"usar ñ","why":"x"}]', '["src/a.ts"]', '[]', '${T}');
      INSERT INTO memories (id, project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
      VALUES (2, 1, 1, 1, 'codex', '${T}', '[]', '[]', '["follow up 🧪"]', '${T}');
      INSERT INTO task_state_manifests (memory_id, report, reporting_source, source_locators, coverage_state,
        resolved_source_count, total_source_count, coverage_reason, created_at)
      VALUES (1, '{"goal":"ship ✓"}', 'mcp', '[]', 'verified', 1, 1, NULL, '${T}');
      INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, tool_calls, filter_version, captured_at, assistant_structure)
      VALUES (1, 1, 'Pregunta ¿qué?', 'Respuesta 🚀', '[{"name":"read"}]', 1, '${T}', '{"finals":[[0,3]]}');
      INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, tool_calls, filter_version, captured_at, assistant_structure)
      VALUES (2, 1, 'second', 'answer', '[]', 1, '${T}', NULL);
      INSERT INTO session_rollups (session_id, project_id, tool, title, summary, decisions, instructions, pending_items, files_touched,
        turn_count, started_at, ended_at, kind, summarizer_status, rollup_state, rolled_up_through_turn_index, computed_at, rollup_version)
      VALUES (1, 1, 'codex', 'Rollup ☃', 'Resumen largo', '[]', '[{"what":"be brief"}]', '[]', '["src/a.ts"]',
        2, '${T}', '${T}', 'primary', 'ok', 'live', 1, '${T}', 1);
      INSERT INTO open_turns (tool, native_session_id, session_id, project_id, source_generation, turn_index, candidate_cursor,
        source_path, source_dev, source_ino, source_size, source_mtime_ms, source_revision, source_digest, failed_at, observed_at,
        receipt_coverage, decisions, pending_items, durable_included, durable_user_prompt, durable_assistant_response,
        durable_assistant_structure, durable_tool_calls)
      VALUES ('claude-code', 'native-2', 2, 1, 0, 0, 'c1', '/src/two.jsonl', '1', '2', 10, 1.0, 'r', 'd', '${T}', '${T}',
        'complete', '[{"what":"staged"}]', NULL, 1, 'open prompt ✎', 'open answer', NULL, '[]');
      INSERT INTO turn_search_index (memory_id, coverage, locator, source_cursor, source_digest, omitted_user_chars,
        omitted_assistant_chars, filter_version, indexed_at)
      VALUES (1, 'included', 'unavailable', NULL, 'digest-1', 0, 0, 1, '${T}');
    `);
    db.prepare(
        `INSERT INTO session_embeddings (session_id, rollup_session_id, project_id, source_hash, model, model_revision, dimensions, vector, computed_at)
         VALUES (2, NULL, 1, 'h', 'm', 'r', 4, ?, ?)`,
    ).run(vector(4, 1), T);
    db.prepare(
        `INSERT INTO turn_embeddings (memory_id, project_id, source_digest, text_hash, model, model_revision, dimensions, vector, computed_at)
         VALUES (1, 1, 'digest-1', 't', 'm', 'r', 3, ?, ?)`,
    ).run(vector(3, 7), T);
}

function ledgerTriggers(db: Database.Database): unknown[] {
    return db
        .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'live_memory_%' ORDER BY name")
        .all();
}

describe('live-memory usage ledger', () => {
    it('counts every approved field once, charges indexed filtered-turn text again, and ignores control metadata', () => {
        const db = openUnmanagedDb(':memory:');
        expect(ledgerBytes(db)).toBe(0);
        seedEvidence(db);
        expect(ledgerBytes(db)).toBeGreaterThan(0);
        expectLiveMemoryCurrent(db);

        const before = ledgerBytes(db);
        const prompt = 'naïve ☃';
        const response = 'ok';
        const toolCalls = '[]';
        const structure = '{"s":1}';
        db.prepare(
            `INSERT INTO memories (id, project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
             VALUES (3, 1, 1, 2, 'codex', ?, '', '', '', ?)`,
        ).run(T, T);
        db.prepare(
            `INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, tool_calls, filter_version, captured_at, assistant_structure)
             VALUES (3, 1, ?, ?, ?, 1, ?, ?)`,
        ).run(prompt, response, toolCalls, T, structure);
        const indexed = Buffer.byteLength(prompt) + Buffer.byteLength(response) + Buffer.byteLength(toolCalls);
        expect(ledgerBytes(db) - before).toBe(2 * indexed + Buffer.byteLength(structure));

        // Paths, cursors, timestamps, status, receipts, and injections are control data.
        const settled = ledgerBytes(db);
        db.exec(`
          UPDATE sessions SET cursor = 'a much longer cursor value', source_path = '/elsewhere/one.jsonl', last_ingested_at = '2027-01-01';
          UPDATE memories SET summarizer_status = 'ok', turn_started_at = '2027-01-01';
          UPDATE open_turns SET source_path = '/moved.jsonl', receipt_failure = 'failure text';
          UPDATE task_state_manifests SET source_locators = '[{"a":"long locator"}]';
          INSERT INTO injections (tool, native_session_id, injected_at, injection_id, body_hash, body)
          VALUES ('codex', 'native-1', '${T}', 'i', 'h', 'an injected body that is not memory');
        `);
        expect(ledgerBytes(db)).toBe(settled);
        expectLiveMemoryCurrent(db);
        db.close();
    });

    it('stays exact through replacement, nested structure reset, cascades, and deletion', () => {
        const db = openUnmanagedDb(':memory:');
        seedEvidence(db);

        // The structure trigger nulls a stale assistant_structure from inside the update.
        db.prepare("UPDATE filtered_turns SET assistant_response = 'Replaced answer that is longer' WHERE memory_id = 1").run();
        expect(db.prepare('SELECT assistant_structure FROM filtered_turns WHERE memory_id = 1').get()).toEqual({
            assistant_structure: null,
        });
        expectLiveMemoryCurrent(db);

        db.prepare("UPDATE filtered_turns SET user_prompt = 'p', tool_calls = '[1]', assistant_structure = '{}' WHERE memory_id = 2").run();
        expectLiveMemoryCurrent(db);

        db.prepare(
            `INSERT INTO session_rollups (session_id, project_id, tool, title, summary, decisions, instructions, pending_items, files_touched,
               turn_count, started_at, ended_at, kind, summarizer_status, rollup_state, rolled_up_through_turn_index, computed_at, rollup_version)
             VALUES (1, 1, 'codex', 'New', 'Shorter', '[]', '[]', '["x"]', '[]', 3, ?, ?, 'primary', 'ok', 'final', 2, ?, 1)
             ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, summary = excluded.summary, pending_items = excluded.pending_items`,
        ).run(T, T, T);
        expectLiveMemoryCurrent(db);

        db.prepare("UPDATE sessions SET title = NULL, custom_title = 'renamed ✓', first_prompt_search = 'again' WHERE id = 1").run();
        db.prepare('UPDATE memories SET decisions = \'[{"what":"changed"}]\' WHERE id = 2').run();
        db.prepare("UPDATE task_state_manifests SET report = '{}' WHERE memory_id = 1").run();
        db.prepare('UPDATE open_turns SET durable_user_prompt = NULL, pending_items = \'["p"]\'').run();
        db.prepare('UPDATE session_embeddings SET vector = ?, dimensions = 8').run(vector(8, 3));
        expectLiveMemoryCurrent(db);

        // Reindexing a turn discards its vector through a trigger.
        db.prepare("UPDATE turn_search_index SET indexed_at = '2027-01-01' WHERE memory_id = 1").run();
        expect(db.prepare('SELECT COUNT(*) AS n FROM turn_embeddings').get()).toEqual({ n: 0 });
        expectLiveMemoryCurrent(db);
        db.prepare(
            `INSERT INTO turn_embeddings (memory_id, project_id, source_digest, text_hash, model, model_revision, dimensions, vector, computed_at)
             VALUES (1, 1, 'digest-1', 't', 'm', 'r', 5, ?, ?)`,
        ).run(vector(5, 1), T);

        // Deleting a memory cascades to its manifest, copy, coverage, and vector.
        db.prepare('DELETE FROM memories WHERE id = 1').run();
        expect(db.prepare('SELECT COUNT(*) AS n FROM turn_embeddings').get()).toEqual({ n: 0 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM task_state_manifests').get()).toEqual({ n: 0 });
        expectLiveMemoryCurrent(db);

        // Deleting a session cascades to its staged turn and session vector.
        db.prepare('DELETE FROM sessions WHERE id = 2').run();
        expect(db.prepare('SELECT COUNT(*) AS n FROM open_turns').get()).toEqual({ n: 0 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM session_embeddings').get()).toEqual({ n: 0 });
        expectLiveMemoryCurrent(db);

        db.exec('DELETE FROM session_rollups; DELETE FROM memories; DELETE FROM sessions;');
        expect(ledgerBytes(db)).toBe(0);
        db.close();
    });

    it('rolls back the charge with the write that caused it', () => {
        const db = openUnmanagedDb(':memory:');
        seedEvidence(db);
        const before = ledgerBytes(db);

        expect(() =>
            db.transaction(() => {
                db.prepare("UPDATE filtered_turns SET assistant_response = 'much longer replacement text' WHERE memory_id = 2").run();
                db.prepare('DELETE FROM session_embeddings').run();
                throw new Error('abort');
            })(),
        ).toThrow('abort');

        expect(ledgerBytes(db)).toBe(before);
        expectLiveMemoryCurrent(db);
        db.close();
    });

    it('reinstalls a missing or altered ledger trigger on open and remeasures', () => {
        const dbPath = path.join(withTempDir('elepha-live-memory-drift-'), 'drift.db');
        const db = openUnmanagedDb(dbPath);
        seedEvidence(db);
        const canonical = ledgerTriggers(db);
        db.exec(`
          DROP TRIGGER live_memory_filtered_turns_ai;
          DROP TRIGGER live_memory_memories_au;
          CREATE TRIGGER live_memory_memories_au AFTER UPDATE ON memories BEGIN SELECT 1; END;
        `);
        db.prepare(
            `INSERT INTO memories (id, project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
             VALUES (4, 1, 1, 4, 'codex', ?, '[]', '[]', '[]', ?)`,
        ).run(T, T);
        db.prepare(
            `INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, tool_calls, filter_version, captured_at)
             VALUES (4, 1, 'untracked', 'write', '[]', 1, ?)`,
        ).run(T);
        db.prepare("UPDATE memories SET decisions = 'untracked decisions'").run();
        expect(ledgerBytes(db)).not.toBe(independentLiveMemoryBytes(db));
        db.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(ledgerTriggers(reopened)).toEqual(canonical);
        expectLiveMemoryCurrent(reopened);
        reopened.close();
    });

    it('reconcile replaces a stale total carried in with canonical triggers', () => {
        const db = openUnmanagedDb(':memory:');
        seedEvidence(db);
        const measured = ledgerBytes(db);
        db.prepare('UPDATE live_memory_usage SET total_bytes = 424242').run();

        expect(reconcileLiveMemoryUsage(db)).toBe(measured);
        expectLiveMemoryCurrent(db);
        db.close();
    });

    it('status reports the exact ledger total as logical live-memory usage', () => {
        const line = liveMemoryUsageLine(4_321_987_654);
        expect(line).toContain('live-memory usage');
        expect(line).toContain('4,321,987,654 bytes');
        expect(line).not.toMatch(/5 ?GB|limit|warning/i);
        expect(liveMemoryUsageLine(0)).toContain('0 bytes');
    });
});
