import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { codexSessionsRoot } from '../../src/config/paths.js';
import { openDb } from '../../src/storage/db.js';
import { firstPromptSearch } from '../../src/storage/first-prompt-search.js';
import {
    applyManualMerge,
    applyManualSplit,
    applyResegmentation,
    planManualMerge,
    planManualSplit,
    planResegmentation,
    verifyResegmentation,
} from '../../src/storage/resegmentation.js';
import { titleForSegment } from '../../src/storage/session-title.js';
import { planSessionTitleBackfill } from '../../src/storage/session-title-backfill.js';
import type { SessionAdapter, ToolName } from '../../src/types/index.js';

const adapters: Record<ToolName, SessionAdapter> = {
    'claude-code': new ClaudeCodeAdapter(),
    codex: new CodexAdapter(),
};

let previousCodexHome: string | undefined;

beforeAll(() => {
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = mkdtempSync(path.join(tmpdir(), 'elepha-resegment-codex-home-'));
    mkdirSync(codexSessionsRoot(), { recursive: true });
});

afterAll(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
});

function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

function codexFixture(options: { markerBeforeSecond?: boolean } = {}): string {
    const rows: unknown[] = [
        {
            timestamp: '2026-01-01T00:00:00.000Z',
            type: 'session_meta',
            payload: { id: 'native-1', cwd: '/tmp/project', originator: 'codex-tui', git: { branch: 'main' } },
        },
        { timestamp: '2026-01-01T00:00:00.500Z', type: 'turn_context', payload: { cwd: '/tmp/project' } },
        { timestamp: '2026-01-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'turn zero' } },
        {
            timestamp: '2026-01-01T00:01:00.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'zero done' }] },
        },
        { timestamp: '2026-01-01T06:00:00.000Z', type: 'turn_context', payload: { cwd: '/tmp/project' } },
    ];
    if (options.markerBeforeSecond) {
        rows.push({
            timestamp: '2026-01-01T06:00:30.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/tmp/project</cwd>\n</environment_context>' }],
            },
        });
    }
    rows.push(
        { timestamp: '2026-01-01T06:01:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'turn one' } },
        {
            timestamp: '2026-01-01T06:02:00.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one done' }] },
        },
        { timestamp: '2026-01-01T07:00:00.000Z', type: 'turn_context', payload: { cwd: '/tmp/project' } },
        { timestamp: '2026-01-01T07:01:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'turn two' } },
        {
            timestamp: '2026-01-01T07:02:00.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two done' }] },
        },
    );
    return rows.map(line).join('');
}

function seed(options: { markerBeforeSecond?: boolean; missingSource?: boolean; outsideStore?: boolean } = {}) {
    const db = openDb(':memory:');
    const dir = realpathSync(
        options.outsideStore
            ? mkdtempSync(path.join(tmpdir(), 'elepha-resegment-outside-'))
            : mkdtempSync(path.join(codexSessionsRoot(), 'elepha-resegment-')),
    );
    const sourcePath = path.join(dir, 'rollout-native-1.jsonl');
    if (!options.missingSource) {
        writeFileSync(sourcePath, codexFixture(options));
    }
    db.prepare(
        `INSERT INTO projects (id, path, display_name, git_root, git_remote, first_seen_at, last_seen_at)
         VALUES (1, '/tmp/project', 'project', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T07:02:00.000Z')`,
    ).run();
    db.prepare(
        `INSERT INTO sessions
         (id, tool, native_id, segment_index, project_id, source_path, cursor, started_at, last_ingested_at,
          surface, git_branch, kind, last_turn_at, trailing_branch, trailing_files)
         VALUES (1, 'codex', 'native-1', 0, 1, ?, 'cursor-final', '2026-08-15T00:00:00.000Z',
                 '2026-08-15T00:00:00.000Z', 'cli', 'main', 'main', NULL, NULL, '[]')`,
    ).run(sourcePath);
    const insertMemory = db.prepare(
        `INSERT INTO memories
         (id, project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items,
          created_at, summarizer_status, has_external_content)
         VALUES (?, 1, 1, ?, 'codex', ?, '[]', '[]', '[]', ?, 'ok', 0)`,
    );
    insertMemory.run(10, 0, '2026-01-01T00:00:01.000Z', '2026-08-15T00:00:01.000Z');
    insertMemory.run(11, 1, '2026-01-01T06:01:00.000Z', '2026-08-15T00:00:02.000Z');
    insertMemory.run(12, 2, '2026-01-01T07:01:00.000Z', '2026-08-15T00:00:03.000Z');
    insertRollup(db, 1);
    return { db, sourcePath };
}

function insertRollup(db: ReturnType<typeof openDb>, sessionId: number, parentSessionId: number | null = null): void {
    db.prepare(
        `INSERT INTO session_rollups
         (session_id, project_id, tool, title, summary, decisions, pending_items, files_touched, turn_count,
          started_at, ended_at, kind, parent_session_id, summarizer_status, rollup_state,
          rolled_up_through_turn_index, computed_at, rollup_version)
         VALUES (?, 1, 'codex', 'old', 'wrong after split', '[]', '[]', '[]', 3,
                 '2026-01-01T00:00:01.000Z', '2026-01-01T07:02:00.000Z', 'primary', ?, 'ok', 'final',
                 2, '2026-08-15T00:00:00.000Z', 2)`,
    ).run(sessionId, parentSessionId);
}

function resegmentationState(db: ReturnType<typeof openDb>): Record<string, unknown> {
    const correctionsTableExists =
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'segment_corrections'").get() !== undefined;
    return {
        sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all(),
        memories: db.prepare('SELECT * FROM memories ORDER BY id').all(),
        rollups: db.prepare('SELECT * FROM session_rollups ORDER BY session_id').all(),
        correctionsTableExists,
        corrections: correctionsTableExists ? db.prepare('SELECT * FROM segment_corrections ORDER BY id').all() : [],
    };
}

function failSessionUpdate(db: ReturnType<typeof openDb>, message: string): void {
    db.exec(`
      CREATE TEMP TRIGGER fail_resegmentation_session_update
      BEFORE UPDATE ON sessions
      BEGIN
        SELECT RAISE(ABORT, '${message}');
      END;
    `);
}

function failMemoryUpdate(db: ReturnType<typeof openDb>, message: string): void {
    db.exec(`
      CREATE TEMP TRIGGER fail_resegmentation_memory_update
      BEFORE UPDATE ON memories
      BEGIN
        SELECT RAISE(ABORT, '${message}');
      END;
    `);
}

describe('P2.2c re-segmentation', () => {
    it('previews without writes, replays resume markers, and lists the exact cut evidence', async () => {
        const { db } = seed({ markerBeforeSecond: true });

        const plan = await planResegmentation(db, adapters);

        expect(plan.affectedGroups).toBe(1);
        expect(plan.groups[0].resultingSegments).toHaveLength(2);
        expect(plan.groups[0].cuts).toEqual([expect.objectContaining({ atTurnIndex: 1, evidence: ['resume-marker'] })]);
        expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
        expect(db.prepare('SELECT COUNT(*) AS count FROM session_rollups').get()).toEqual({ count: 1 });
        db.close();
    });

    it('partitions retained turns exactly, backfills trailing state, invalidates rollups, and is idempotent', async () => {
        const { db } = seed({ markerBeforeSecond: true });
        db.prepare("UPDATE sessions SET title = 'old whole-session title', custom_title = 'Keep mine' WHERE id = 1").run();
        const beforeIds = (db.prepare('SELECT id FROM memories ORDER BY id').all() as Array<{ id: number }>).map((row) => row.id);
        const plan = await planResegmentation(db, adapters);

        applyResegmentation(db, plan);

        const sessions = db.prepare('SELECT id, segment_index, last_turn_at, cursor FROM sessions ORDER BY segment_index').all() as Array<{
            id: number;
            segment_index: number;
            last_turn_at: string;
            cursor: string | null;
        }>;
        expect(sessions.map((row) => row.segment_index)).toEqual([0, 1]);
        expect(sessions[0].last_turn_at).toBe('2026-01-01T00:01:00.000Z');
        expect(sessions[0].cursor).toBeNull();
        expect(sessions[1].last_turn_at).toBe('2026-01-01T07:02:00.000Z');
        expect(sessions[1].cursor).toBe('cursor-final');
        expect(
            db
                .prepare(
                    'SELECT segment_index, GROUP_CONCAT(turn_index) AS turns FROM sessions JOIN memories ON sessions.id = memories.session_id GROUP BY sessions.id ORDER BY segment_index',
                )
                .all() as Array<{ segment_index: number; turns: string }>,
        ).toEqual([
            { segment_index: 0, turns: '0' },
            { segment_index: 1, turns: '1,2' },
        ]);
        expect((db.prepare('SELECT id FROM memories ORDER BY id').all() as Array<{ id: number }>).map((row) => row.id)).toEqual(beforeIds);
        expect(db.prepare('SELECT segment_index, title FROM sessions ORDER BY segment_index').all()).toEqual([
            { segment_index: 0, title: titleForSegment([{ userMessage: 'turn zero' }], true) },
            { segment_index: 1, title: titleForSegment([{ userMessage: 'turn one' }, { userMessage: 'turn two' }], false) },
        ]);
        expect(db.prepare('SELECT segment_index, first_prompt_search FROM sessions ORDER BY segment_index').all()).toEqual([
            { segment_index: 0, first_prompt_search: firstPromptSearch('turn zero') },
            { segment_index: 1, first_prompt_search: firstPromptSearch('turn one') },
        ]);
        expect(db.prepare('SELECT custom_title FROM sessions WHERE id = 1').get()).toEqual({ custom_title: 'Keep mine' });
        expect((await planSessionTitleBackfill(db, adapters)).changes).toHaveLength(0);
        expect(db.prepare('SELECT COUNT(*) AS count FROM session_rollups').get()).toEqual({ count: 0 });
        expect(verifyResegmentation(db, plan)).toEqual({ ok: true, errors: [] });

        const second = await planResegmentation(db, adapters);
        expect(second.affectedGroups).toBe(0);
        applyResegmentation(db, second);
        expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 2 });

        db.prepare("UPDATE sessions SET title = 'stale left title' WHERE segment_index = 0").run();
        const titleOnly = await planResegmentation(db, adapters);
        expect(titleOnly.affectedGroups).toBe(1);
        applyResegmentation(db, titleOnly);
        expect(db.prepare('SELECT title FROM sessions WHERE segment_index = 0').get()).toEqual({ title: 'turn zero' });

        db.prepare("UPDATE sessions SET first_prompt_search = 'stale prompt' WHERE segment_index = 0").run();
        const firstPromptOnly = await planResegmentation(db, adapters);
        expect(firstPromptOnly.affectedGroups).toBe(1);
        applyResegmentation(db, firstPromptOnly);
        expect(db.prepare('SELECT first_prompt_search FROM sessions WHERE segment_index = 0').get()).toEqual({
            first_prompt_search: firstPromptSearch('turn zero'),
        });

        db.prepare("UPDATE sessions SET title = 'wrong title' WHERE segment_index = 1").run();
        expect(verifyResegmentation(db, titleOnly)).toEqual({
            ok: false,
            errors: ['codex:native-1:1 title differs'],
        });
        db.prepare("UPDATE sessions SET title = 'turn one', first_prompt_search = 'wrong prompt' WHERE segment_index = 1").run();
        expect(verifyResegmentation(db, firstPromptOnly)).toEqual({
            ok: false,
            errors: ['codex:native-1:1 first_prompt_search differs'],
        });
        db.close();
    });

    it('rolls back automatic resegmentation completely when a later mutation fails', async () => {
        const { db } = seed({ markerBeforeSecond: true });
        db.prepare(
            "UPDATE sessions SET title = 'original title', cursor = 'original cursor', last_turn_at = '2026-01-01T09:00:00.000Z', trailing_branch = 'original', trailing_files = '[\"original.ts\"]' WHERE id = 1",
        ).run();
        const plan = await planResegmentation(db, adapters);
        const before = resegmentationState(db);
        const failure = 'injected automatic resegmentation failure';
        failSessionUpdate(db, failure);

        expect(() => applyResegmentation(db, plan)).toThrow(failure);

        expect(resegmentationState(db)).toEqual(before);
        db.close();
    });

    it('deletes segment rows dropped by the plan without leaving rollup references', async () => {
        const { db } = seed();
        db.prepare(
            `INSERT INTO sessions
             (id, tool, native_id, segment_index, project_id, source_path, cursor, started_at, last_ingested_at,
              surface, git_branch, kind, last_turn_at, trailing_branch, trailing_files)
             SELECT 2, tool, native_id, 1, project_id, source_path, cursor, started_at, last_ingested_at,
                    surface, git_branch, kind, last_turn_at, trailing_branch, trailing_files
             FROM sessions WHERE id = 1`,
        ).run();
        db.prepare(
            `INSERT INTO sessions
             (id, tool, native_id, segment_index, project_id, source_path, cursor, started_at, last_ingested_at,
              surface, git_branch, kind, last_turn_at, trailing_branch, trailing_files)
             SELECT 3, tool, 'unrelated-native', 0, project_id, source_path, cursor, started_at, last_ingested_at,
                    surface, git_branch, kind, last_turn_at, trailing_branch, trailing_files
             FROM sessions WHERE id = 1`,
        ).run();
        insertRollup(db, 3, 2);
        const plan = await planResegmentation(db, adapters);
        const group = plan.groups.find((candidate) => candidate.nativeId === 'native-1');

        expect(group).toEqual(
            expect.objectContaining({
                status: 'ready',
                existingSessionIds: [1, 2],
                resultingSegments: [expect.objectContaining({ existingSessionId: 1 })],
            }),
        );

        applyResegmentation(db, plan);

        expect(db.prepare('SELECT id FROM sessions WHERE id = 2').get()).toBeUndefined();
        expect(db.prepare('SELECT session_id FROM session_rollups WHERE parent_session_id = 2').all()).toEqual([]);
        expect(verifyResegmentation(db, plan)).toEqual({ ok: true, errors: [] });
        db.close();
    });

    it('does not silently fall back when the source transcript is unavailable', async () => {
        const { db } = seed({ missingSource: true });

        const plan = await planResegmentation(db, adapters);

        expect(plan.skippedGroups).toBe(1);
        expect(plan.groups[0]).toEqual(expect.objectContaining({ status: 'skipped', issue: 'source transcript is missing' }));
        applyResegmentation(db, plan);
        expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
        db.close();
    });

    it('skips an out-of-store source transcript without classifying or parsing it', async () => {
        const { db } = seed({ outsideStore: true });
        const classifySession = vi.fn(adapters.codex.classifySession.bind(adapters.codex));
        const parseTurns = vi.fn(adapters.codex.parseTurns.bind(adapters.codex));
        const guardedAdapters = {
            ...adapters,
            codex: { ...adapters.codex, classifySession, parseTurns } as SessionAdapter,
        };

        const plan = await planResegmentation(db, guardedAdapters);

        expect(plan.skippedGroups).toBe(1);
        expect(plan.groups[0]).toEqual(
            expect.objectContaining({ status: 'skipped', issue: 'source transcript is outside the provider store' }),
        );
        expect(classifySession).not.toHaveBeenCalled();
        expect(parseTurns).not.toHaveBeenCalled();
        db.close();
    });

    it('keeps a 4h+ Codex gap together when marker, branch, and file evidence are unavailable', async () => {
        const { db } = seed();

        const plan = await planResegmentation(db, adapters);

        expect(plan.groups[0].cuts).toEqual([]);
        expect(plan.groups[0].resultingSegments).toHaveLength(1);
        applyResegmentation(db, plan);
        expect(db.prepare('SELECT last_turn_at FROM sessions').get()).toEqual({ last_turn_at: '2026-01-01T07:02:00.000Z' });
        db.close();
    });
});

describe('manual segment corrections', () => {
    it('rejects out-of-store manual split and merge without touching the parser or database', async () => {
        const operations = [
            {
                name: 'split',
                arrange: async () => {
                    const { db, sourcePath } = seed({ outsideStore: true });
                    return {
                        db,
                        sourcePath,
                        plan: (guardedAdapters: Record<ToolName, SessionAdapter>) => planManualSplit(db, guardedAdapters, 1, 1),
                    };
                },
            },
            {
                name: 'merge',
                arrange: async () => {
                    const { db } = seed();
                    const split = await planManualSplit(db, adapters, 1, 1);
                    const newId = applyManualSplit(db, split);
                    const outsideDirectory = realpathSync(mkdtempSync(path.join(tmpdir(), 'elepha-resegment-merge-outside-')));
                    const sourcePath = path.join(outsideDirectory, 'rollout-native-1.jsonl');
                    writeFileSync(sourcePath, codexFixture());
                    db.prepare("UPDATE sessions SET source_path = ? WHERE tool = 'codex' AND native_id = 'native-1'").run(sourcePath);
                    return {
                        db,
                        sourcePath,
                        plan: (guardedAdapters: Record<ToolName, SessionAdapter>) => planManualMerge(db, guardedAdapters, 1, newId),
                    };
                },
            },
        ];

        for (const operation of operations) {
            const { db, sourcePath, plan } = await operation.arrange();
            const classifySession = vi.fn(adapters.codex.classifySession.bind(adapters.codex));
            const parseTurns = vi.fn(adapters.codex.parseTurns.bind(adapters.codex));
            const guardedAdapters = {
                ...adapters,
                codex: { ...adapters.codex, classifySession, parseTurns } as SessionAdapter,
            };
            const before = resegmentationState(db);

            await expect(plan(guardedAdapters), operation.name).rejects.toThrow(
                `source transcript is outside the provider store: ${sourcePath}`,
            );
            expect(classifySession, operation.name).not.toHaveBeenCalled();
            expect(parseTurns, operation.name).not.toHaveBeenCalled();
            expect(resegmentationState(db), operation.name).toEqual(before);
            db.close();
        }
    });

    it('rolls back a manual split completely when a later mutation fails', async () => {
        const { db } = seed();
        db.prepare(
            "UPDATE sessions SET title = 'original title', cursor = 'original cursor', last_turn_at = '2026-01-01T09:00:00.000Z', trailing_branch = 'original', trailing_files = '[\"original.ts\"]' WHERE id = 1",
        ).run();
        const split = await planManualSplit(db, adapters, 1, 1);
        const before = resegmentationState(db);
        const failure = 'injected manual split failure';
        failSessionUpdate(db, failure);

        expect(() => applyManualSplit(db, split)).toThrow(failure);

        expect(resegmentationState(db)).toEqual(before);
        db.close();
    });

    it('rolls back a manual merge completely when a later mutation fails', async () => {
        const { db } = seed();
        const split = await planManualSplit(db, adapters, 1, 1);
        const secondId = applyManualSplit(db, split);
        insertRollup(db, 1);
        insertRollup(db, secondId);
        db.prepare(
            "UPDATE sessions SET title = 'left title', cursor = 'left cursor', last_turn_at = '2026-01-01T05:00:00.000Z', trailing_branch = 'left', trailing_files = '[\"left.ts\"]' WHERE id = 1",
        ).run();
        db.prepare(
            "UPDATE sessions SET title = 'right title', cursor = 'right cursor', last_turn_at = '2026-01-01T09:00:00.000Z', trailing_branch = 'right', trailing_files = '[\"right.ts\"]' WHERE id = ?",
        ).run(secondId);
        const merge = await planManualMerge(db, adapters, 1, secondId);
        const before = resegmentationState(db);
        const failure = 'injected manual merge failure';
        failMemoryUpdate(db, failure);

        expect(() => applyManualMerge(db, merge)).toThrow(failure);

        expect(resegmentationState(db)).toEqual(before);
        db.close();
    });

    it('splits and merges adjacent rows, invalidates rollups, and records correction direction', async () => {
        const { db } = seed();
        db.prepare("UPDATE sessions SET git_commit_count = 42, custom_title = 'Keep mine' WHERE id = 1").run();

        const split = await planManualSplit(db, adapters, 1, 1);
        const newId = applyManualSplit(db, split);
        expect(newId).not.toBe(1);
        expect(
            (db.prepare('SELECT segment_index FROM sessions ORDER BY segment_index').all() as Array<{ segment_index: number }>).map(
                (row) => row.segment_index,
            ),
        ).toEqual([0, 1]);
        expect(db.prepare('SELECT ulid, direction, turn_index FROM segment_corrections ORDER BY id').all()).toEqual([
            { ulid: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/), direction: 'split', turn_index: 1 },
        ]);
        expect(db.prepare('SELECT COUNT(*) AS count FROM session_rollups').get()).toEqual({ count: 0 });
        expect(db.prepare('SELECT rendered_chars FROM sessions ORDER BY segment_index').all()).toEqual([
            { rendered_chars: split.left.renderedChars },
            { rendered_chars: split.right.renderedChars },
        ]);
        expect(db.prepare('SELECT rendered_turns FROM sessions ORDER BY segment_index').all()).toEqual([
            { rendered_turns: split.left.renderedTurns },
            { rendered_turns: split.right.renderedTurns },
        ]);
        expect(db.prepare('SELECT git_commit_count FROM sessions ORDER BY segment_index').all()).toEqual([
            { git_commit_count: 42 },
            { git_commit_count: null },
        ]);
        expect(db.prepare('SELECT segment_index, title FROM sessions ORDER BY segment_index').all()).toEqual([
            { segment_index: 0, title: split.left.title },
            { segment_index: 1, title: split.right.title },
        ]);
        expect(db.prepare('SELECT segment_index, first_prompt_search FROM sessions ORDER BY segment_index').all()).toEqual([
            { segment_index: 0, first_prompt_search: split.left.firstPromptSearch },
            { segment_index: 1, first_prompt_search: split.right.firstPromptSearch },
        ]);
        expect(db.prepare('SELECT custom_title FROM sessions WHERE id = 1').get()).toEqual({ custom_title: 'Keep mine' });

        insertRollup(db, 1);
        insertRollup(db, newId);
        const merge = await planManualMerge(db, adapters, 1, newId);
        const keptId = applyManualMerge(db, merge);
        expect(keptId).toBe(1);
        expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
        expect(db.prepare('SELECT rendered_chars FROM sessions WHERE id = 1').get()).toEqual({
            rendered_chars: merge.merged.renderedChars,
        });
        expect(db.prepare('SELECT rendered_turns FROM sessions WHERE id = 1').get()).toEqual({
            rendered_turns: merge.merged.renderedTurns,
        });
        expect(db.prepare('SELECT title FROM sessions WHERE id = 1').get()).toEqual({ title: merge.merged.title });
        expect(db.prepare('SELECT first_prompt_search FROM sessions WHERE id = 1').get()).toEqual({
            first_prompt_search: merge.merged.firstPromptSearch,
        });
        expect(db.prepare('SELECT git_commit_count FROM sessions WHERE id = 1').get()).toEqual({ git_commit_count: 42 });
        expect(db.prepare('SELECT custom_title FROM sessions WHERE id = 1').get()).toEqual({ custom_title: 'Keep mine' });
        expect(db.prepare('SELECT GROUP_CONCAT(turn_index) AS turns FROM memories WHERE session_id = 1 ORDER BY turn_index').get()).toEqual(
            {
                turns: '0,1,2',
            },
        );
        expect(
            (db.prepare('SELECT direction FROM segment_corrections ORDER BY id').all() as Array<{ direction: string }>).map(
                (row) => row.direction,
            ),
        ).toEqual(['split', 'merge']);
        expect((db.pragma('foreign_key_check') as unknown[]).length).toBe(0);
        db.close();
    });
});
