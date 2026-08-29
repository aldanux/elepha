import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { openDb } from '../../src/storage/db.js';
import { applyRenderedCharsBackfill, planRenderedCharsBackfill } from '../../src/storage/rendered-chars-backfill.js';
import type { SessionAdapter, ToolName } from '../../src/types/index.js';

const FIXTURE =
    '{"type":"user","uuid":"u1","timestamp":"2026-08-01T10:00:02.000Z","entrypoint":"cli","cwd":"/tmp/proj","sessionId":"sess-1","message":{"role":"user","content":"hello"}}\n' +
    '{"type":"assistant","parentUuid":"u1","uuid":"a1","timestamp":"2026-08-01T10:00:03.000Z","cwd":"/tmp/proj","sessionId":"sess-1","message":{"role":"assistant","content":[{"type":"text","text":"hi `there`"}]}}\n';

describe('rendered-chars backfill', () => {
    let dir: string;
    let sourcePath: string;
    const adapters: Record<ToolName, SessionAdapter> = { 'claude-code': new ClaudeCodeAdapter(), codex: new CodexAdapter() };

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'elepha-rendered-chars-'));
        const claudeConfigDir = path.join(dir, 'claude-home');
        const providerRoot = path.join(claudeConfigDir, 'projects');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        sourcePath = path.join(providerRoot, 'session.jsonl');
        writeFileSync(sourcePath, FIXTURE);
    });

    afterEach(() => vi.unstubAllEnvs());

    function seed(db: ReturnType<typeof openDb>, pathToTranscript = sourcePath): number {
        db.prepare(
            `INSERT INTO projects (id, path, first_seen_at, last_seen_at) VALUES (1, '/tmp/proj', '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z')`,
        ).run();
        const session = db
            .prepare(
                `INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
                 VALUES ('claude-code', 'sess-1', 1, ?, '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z')`,
            )
            .run(pathToTranscript);
        db.prepare(
            `INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
             VALUES (1, ?, 0, 'claude-code', '2026-08-01T10:00:02.000Z', '[]', '[]', '[]', '2026-08-01T10:00:00.000Z')`,
        ).run(Number(session.lastInsertRowid));
        return Number(session.lastInsertRowid);
    }

    it('plans without writing and applies renderer-derived or unavailable-source values', async () => {
        const cases = [
            { name: 'available', transcriptPath: sourcePath, missing: false },
            { name: 'missing', transcriptPath: path.join(dir, 'gone.jsonl'), missing: true },
        ];

        for (const scenario of cases) {
            const db = openDb(':memory:');
            const sessionId = seed(db, scenario.transcriptPath);

            const preview = await planRenderedCharsBackfill(db, adapters);
            const previewChange = preview.changes.find((change) => change.sessionId === sessionId);
            expect(db.prepare('SELECT rendered_chars, rendered_turns FROM sessions WHERE id = ?').get(sessionId)).toEqual({
                rendered_chars: 0,
                rendered_turns: 0,
            });

            const applied = await applyRenderedCharsBackfill(db, adapters);
            const row = db.prepare('SELECT rendered_chars, rendered_turns FROM sessions WHERE id = ?').get(sessionId);
            if (scenario.missing) {
                expect(applied.sessionsMissingTranscript, scenario.name).toBe(1);
                expect(previewChange).toEqual(expect.objectContaining({ sessionId, transcriptMissing: true, renderedChars: null }));
                expect(row).toEqual({ rendered_chars: null, rendered_turns: null });
            } else {
                expect(previewChange?.renderedChars, scenario.name).toBeGreaterThan(0);
                expect(row).toEqual({
                    rendered_chars: previewChange?.renderedChars,
                    rendered_turns: previewChange?.renderedTurns,
                });
            }
            db.close();
        }
    });
});
