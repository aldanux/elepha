import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAdapters } from '../../src/adapters/index.js';
import { registerRepairClaudeCompact } from '../../src/cli/commands/repair-claude-compact.js';
import { renderedChars } from '../../src/rendering/raw-turn-renderer.js';
import { listManagedBackups } from '../../src/storage/backup.js';
import {
    applyCompactSummaryRepair,
    type CompactSummaryRepairPlan,
    planCompactSummaryRepair,
} from '../../src/storage/claude-compact-repair.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { LOCKED_MEMORY_MESSAGE, registerParanoidDatabase } from '../../src/storage/paranoid-gate.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';

vi.mock('../../src/install/health-checks.js', () => ({ daemonHealth: () => ({ healthy: false, state: 'STOPPED' }) }));

const SUMMARY = 'This session is being continued from a previous conversation that ran out of context.';
const NATIVE_ID = 'compact-repair';

// Turn 1 is a manual compact (summary, then a real prompt); turn 3 is an
// automatic compact the assistant continues with no new prompt.
function transcript(cwd: string, flagged: boolean): string {
    const at = (second: number) => `2026-08-01T00:00:${String(second).padStart(2, '0')}.000Z`;
    const line = (second: number, value: Record<string, unknown>) =>
        JSON.stringify({ cwd, sessionId: NATIVE_ID, timestamp: at(second), ...value });
    const user = (second: number, content: unknown) => line(second, { type: 'user', message: { role: 'user', content } });
    const assistant = (second: number, content: unknown[]) => line(second, { type: 'assistant', message: { role: 'assistant', content } });
    const summary = (second: number) =>
        line(second, {
            type: 'user',
            ...(flagged ? { isCompactSummary: true, isVisibleInTranscriptOnly: true } : {}),
            message: { role: 'user', content: SUMMARY },
        });
    const boundary = (second: number) => line(second, { type: 'system', subtype: 'compact_boundary' });
    return `${[
        user(0, 'First prompt'),
        assistant(1, [{ type: 'text', text: 'Before compact.' }]),
        boundary(2),
        summary(3),
        user(4, 'Next step'),
        assistant(5, [{ type: 'text', text: 'Done.' }]),
        boundary(6),
        summary(7),
        assistant(8, [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: path.join(cwd, 'a.ts') } }]),
        user(9, [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok' }]),
        assistant(10, [{ type: 'text', text: 'After compact.' }]),
        user(11, 'Final prompt'),
        assistant(12, [{ type: 'text', text: 'Bye.' }]),
    ].join('\n')}\n`;
}

async function parse(sourcePath: string): Promise<ParsedTurn[]> {
    const turns: ParsedTurn[] = [];
    for await (const turn of defaultAdapters()['claude-code'].parseTurns(sourcePath, undefined, { closeTrailingOnIdle: true })) {
        turns.push(turn);
    }
    return turns;
}

// Seeds the rows the pre-fix adapter persisted: the summary-only turn 1 and
// the summary-prefixed continuation turn 3 at their historical indexes.
async function candidate(flagged = true) {
    const fixture = createTestDb('elepha-compact-repair-');
    const claudeHome = path.join(fixture.directory, 'claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome);
    const project = seedProject(fixture);
    fixture.store.consent.grant(project.path);
    const sourcePath = path.join(claudeHome, 'projects', 'demo', `${NATIVE_ID}.jsonl`);
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, transcript(project.path, flagged));
    const session = seedSession(fixture, { project, tool: 'claude-code', nativeId: NATIVE_ID, sourcePath });
    const turns = await parse(sourcePath);
    const stored = [0, 1, 2, 3, 4].map((turnIndex) => {
        const turn = turns.find((t) => t.turnIndex === turnIndex);
        if (!turn) throw new Error(`fixture did not produce turn ${turnIndex}`);
        return seedMemory(fixture, {
            project,
            session,
            turnIndex,
            startedAt: turn.startedAt,
            endedAt: turn.endedAt,
            userMessage: turnIndex === 1 || turnIndex === 3 ? SUMMARY : turn.userMessage,
            assistantText: turn.assistantText,
            cursor: 'unchanged-cursor',
        });
    });
    // A summary-only turn had no assistant side, so its durable copy holds
    // the summary prompt and the empty values capture writes for that shape.
    for (const memory of stored) {
        fixture.db
            .prepare(`INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, filter_version, captured_at)
            VALUES (?, 1, ?, ?, 1, 'now')`)
            .run(memory.id, memory.turn_index === 1 ? SUMMARY : `durable${memory.id}`, memory.turn_index === 1 ? '' : 'durable response');
    }
    seedRollup(fixture, { project, session });
    fixture.db
        .prepare(`INSERT INTO session_embeddings (session_id, rollup_session_id, project_id, source_hash, model, model_revision, dimensions, vector, computed_at)
        VALUES (?, ?, ?, 'hash', 'model', 'revision', 1, ?, 'now')`)
        .run(session.id, session.id, project.id, Buffer.alloc(4));
    fixture.db.prepare("INSERT INTO durable_capture_status VALUES (?, 'complete', 1, 'now')").run(session.id);
    const [first, summaryOnly, next, continuation, last] = stored;
    if (!first || !summaryOnly || !next || !continuation || !last) throw new Error('fixture did not seed memories');
    return { ...fixture, project, session, sourcePath, turns, summaryOnly, continuation, survivors: [first, next, continuation, last] };
}

// Every table a repair may read or write, so a refusal can prove it left
// the database byte-identical rather than spot-checking row counts.
function snapshot(db: ReturnType<typeof createTestDb>['db']) {
    return Object.fromEntries(
        [
            'sessions',
            'memories',
            'filtered_turns',
            'session_rollups',
            'session_embeddings',
            'durable_capture_status',
            'source_generations',
            'durable_capture_usage',
        ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
}

async function withPlan(fixture: Awaited<ReturnType<typeof candidate>>, run: (plan: CompactSummaryRepairPlan) => void | Promise<void>) {
    const plan = await planCompactSummaryRepair(fixture.store, defaultAdapters(), NATIVE_ID);
    try {
        await run(plan);
    } finally {
        await plan.close();
    }
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('source-backed Claude Code compact summary repair', () => {
    it('parses the fixture into a dropped summary-only turn and a kept continuation at their historical indexes', async () => {
        const fixture = await candidate();
        expect(fixture.turns.map((t) => [t.turnIndex, t.userMessage, t.droppedReason, t.formerlyStoredBoundary])).toEqual([
            [0, 'First prompt', undefined, undefined],
            [1, '', 'empty', true],
            [2, 'Next step', undefined, undefined],
            [3, '', undefined, true],
            [4, 'Final prompt', undefined, undefined],
        ]);
    });

    it('previews without writing, then deletes only the summary-only row and rebuilds derived state', async () => {
        const fixture = await candidate();
        const { db, session } = fixture;
        const survivorIds = fixture.survivors.map((m) => m.id).join(', ');
        const memoriesBefore = db.prepare(`SELECT * FROM memories WHERE id IN (${survivorIds}) ORDER BY id`).all();
        const durableBefore = db.prepare(`SELECT * FROM filtered_turns WHERE memory_id IN (${survivorIds}) ORDER BY memory_id`).all();
        // The FTS index and usage ledger follow filtered_turns only through
        // triggers, so the cascade must fire them for the deleted durable copy.
        const indexed = (term: string) =>
            db.prepare('SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH ? ORDER BY rowid').all(term);
        const usage = () =>
            (db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number }).total_bytes;
        const durableBytes = (where: string) =>
            (
                db
                    .prepare(`SELECT COALESCE(SUM(length(CAST(user_prompt AS BLOB)) + length(CAST(assistant_response AS BLOB)) +
                        COALESCE(length(CAST(assistant_structure AS BLOB)), 0) + length(CAST(tool_calls AS BLOB))), 0) AS n
                        FROM filtered_turns WHERE ${where}`)
                    .get() as { n: number }
            ).n;
        const continuationTerm = `durable${fixture.continuation.id}`;
        expect(indexed('continued')).toEqual([{ rowid: fixture.summaryOnly.id }]);
        expect(indexed(continuationTerm)).toEqual([{ rowid: fixture.continuation.id }]);
        const usageBefore = usage();
        const summaryOnlyBytes = durableBytes(`memory_id = ${fixture.summaryOnly.id}`);
        expect(summaryOnlyBytes).toBeGreaterThan(0);
        const before = snapshot(db);
        await withPlan(fixture, (plan) => {
            expect(plan.memories).toEqual([{ id: fixture.summaryOnly.id, session_id: session.id, turn_index: 1 }]);
            expect(plan.unresolved).toEqual([{ id: fixture.continuation.id, session_id: session.id, turn_index: 3 }]);
            expect(snapshot(db)).toEqual(before);

            applyCompactSummaryRepair(fixture.store, plan);
        });
        expect(db.prepare('SELECT * FROM memories ORDER BY id').all()).toEqual(memoriesBefore);
        expect(db.prepare('SELECT * FROM filtered_turns ORDER BY memory_id').all()).toEqual(durableBefore);
        expect(indexed('continued')).toEqual([]);
        expect(indexed(continuationTerm)).toEqual([{ rowid: fixture.continuation.id }]);
        expect(usage()).toBe(usageBefore - summaryOnlyBytes);
        expect(usage()).toBe(durableBytes('1'));
        expect(db.prepare('SELECT * FROM session_rollups').all()).toEqual([]);
        expect(db.prepare('SELECT * FROM session_embeddings').all()).toEqual([]);
        expect(db.prepare('SELECT * FROM durable_capture_status').all()).toEqual([]);
        expect(db.pragma('foreign_key_check')).toEqual([]);
        const surviving = fixture.turns.filter((t) => t.turnIndex !== 1);
        expect(
            db
                .prepare('SELECT cursor, rendered_chars, rendered_turns, last_turn_at, segment_index FROM sessions WHERE id = ?')
                .get(session.id),
        ).toEqual({
            cursor: 'unchanged-cursor',
            rendered_chars: renderedChars(surviving),
            rendered_turns: surviving.length,
            last_turn_at: surviving.at(-1)?.endedAt,
            segment_index: 0,
        });

        await withPlan(fixture, (retry) => {
            expect(retry.memories).toEqual([]);
            expect(retry.unresolved).toEqual([{ id: fixture.continuation.id, session_id: session.id, turn_index: 3 }]);
        });
    });

    it('runs the CLI as a read-only preview, then backs up the original rows before applying the plan', async () => {
        const fixture = await candidate();
        const { session, summaryOnly, continuation } = fixture;
        fixture.close();
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha'));
        const output: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
        const run = async (apply: boolean) => {
            const program = new Command();
            registerRepairClaudeCompact(program);
            await program.parseAsync([
                'node',
                'elepha',
                'repair-claude-compact-summaries',
                '--session',
                NATIVE_ID,
                ...(apply ? ['--apply'] : []),
            ]);
        };
        await run(false);
        expect(listManagedBackups(fixture.dbPath)).toEqual([]);
        expect(output).toContain(`Delete summary-only memory ${summaryOnly.id}: session ${session.id}, turn 1`);
        expect(output).toContain(
            `Unresolved compact continuation memory ${continuation.id}: session ${session.id}, turn 3 (kept unchanged)`,
        );
        expect(output).toContain(
            'Continuation rows may still carry compact summary text from earlier parses. --apply removes only summary-only rows, not all historical contamination.',
        );
        expect(output).toContain('Dry run only - nothing was written. Re-run with --apply to delete these exact summary-only rows.');
        const unchanged = openUnmanagedDb(fixture.dbPath);
        try {
            expect(unchanged.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 5 });
        } finally {
            unchanged.close();
        }

        await run(true);
        const backups = listManagedBackups(fixture.dbPath);
        expect(backups).toHaveLength(1);
        const backupPath = backups[0];
        if (!backupPath) throw new Error('missing backup');
        const backup = openUnmanagedDb(backupPath);
        const repaired = openUnmanagedDb(fixture.dbPath);
        try {
            expect(backup.prepare('SELECT turn_index FROM memories ORDER BY turn_index').all()).toEqual(
                [0, 1, 2, 3, 4].map((turn_index) => ({ turn_index })),
            );
            expect(repaired.prepare('SELECT turn_index FROM memories ORDER BY turn_index').all()).toEqual(
                [0, 2, 3, 4].map((turn_index) => ({ turn_index })),
            );
        } finally {
            backup.close();
            repaired.close();
        }

        output.length = 0;
        await run(true);
        expect(output).toContain('No summary-only compact memories to repair.');
        expect(output).toContain(
            `Unresolved compact continuation memory ${continuation.id}: session ${session.id}, turn 3 (kept unchanged)`,
        );
        expect(output.some((line) => line.startsWith('Delete summary-only memory '))).toBe(false);
        expect(listManagedBackups(fixture.dbPath)).toEqual(backups);
    });

    it('selects nothing when summary-like wording lacks the structural compact marker', async () => {
        const fixture = await candidate(false);
        await withPlan(fixture, (plan) => {
            expect(plan.memories).toEqual([]);
            expect(plan.unresolved).toEqual([]);
        });
    });

    it('refuses a row at the summary index whose start time is not the summary line', async () => {
        const fixture = await candidate();
        fixture.db.prepare("UPDATE memories SET turn_started_at = '2026-08-01T00:00:04.000Z' WHERE id = ?").run(fixture.summaryOnly.id);
        const before = snapshot(fixture.db);
        await expect(planCompactSummaryRepair(fixture.store, defaultAdapters(), NATIVE_ID)).rejects.toThrow(
            'Compact summary repair cannot bind stored turn 1 to its compact summary',
        );
        expect(snapshot(fixture.db)).toEqual(before);
    });

    it('selects a summary-only row that has no durable copy', async () => {
        const fixture = await candidate();
        fixture.db.prepare('DELETE FROM filtered_turns WHERE memory_id = ?').run(fixture.summaryOnly.id);
        await withPlan(fixture, (plan) => {
            expect(plan.memories).toEqual([{ id: fixture.summaryOnly.id, session_id: fixture.session.id, turn_index: 1 }]);
        });
    });

    it.each([
        ['assistant response', "assistant_response = 'real work'"],
        ['tool call', `tool_calls = '[{"name":"Read","filePaths":[]}]'`],
        ['omitted tool call', 'omitted_tool_call_count = 1'],
        ['dropped tool reference', 'dropped_tool_ref_count = 1'],
        ['omitted final answer', `assistant_structure = '{"unclassified":false,"finals":[],"omitted":1}'`],
        ['undecodable structure', "assistant_structure = 'not json'"],
        ['evicted prompt with omitted text', "user_prompt = '', omitted_before_chars = 10"],
    ])('refuses a summary-only row whose durable copy holds a %s', async (_label, change) => {
        const fixture = await candidate();
        fixture.db.prepare(`UPDATE filtered_turns SET ${change} WHERE memory_id = ?`).run(fixture.summaryOnly.id);
        const before = snapshot(fixture.db);
        await expect(planCompactSummaryRepair(fixture.store, defaultAdapters(), NATIVE_ID)).rejects.toThrow(
            'Compact summary repair refuses stored turn 1: its durable copy may hold assistant work the summary-only source turn cannot account for',
        );
        expect(snapshot(fixture.db)).toEqual(before);
    });

    it.each(['missing', 'consent'] as const)('refuses to plan when the source is %s', async (change) => {
        const fixture = await candidate();
        if (change === 'missing') renameSync(fixture.sourcePath, `${fixture.sourcePath}.moved`);
        if (change === 'consent') fixture.store.consent.revoke(fixture.project.path);
        const before = snapshot(fixture.db);
        await expect(planCompactSummaryRepair(fixture.store, defaultAdapters(), NATIVE_ID)).rejects.toThrow(
            change === 'missing' ? /source unavailable/ : /changed/,
        );
        expect(snapshot(fixture.db)).toEqual(before);
    });

    it.each(['source', 'row', 'consent', 'generation'] as const)(
        'rejects a changed %s after preview without changing rows',
        async (change) => {
            const fixture = await candidate();
            await withPlan(fixture, (plan) => {
                if (change === 'source') appendFileSync(fixture.sourcePath, '\n');
                if (change === 'row')
                    fixture.db.prepare('UPDATE memories SET pending_items = \'["changed"]\' WHERE id = ?').run(fixture.continuation.id);
                if (change === 'consent') fixture.store.consent.revoke(fixture.project.path);
                if (change === 'generation')
                    fixture.db
                        .prepare("INSERT OR REPLACE INTO source_generations (tool, native_id, generation) VALUES ('claude-code', ?, 1)")
                        .run(NATIVE_ID);
                const before = snapshot(fixture.db);
                expect(() => applyCompactSummaryRepair(fixture.store, plan)).toThrow(/changed/);
                expect(snapshot(fixture.db)).toEqual(before);
            });
        },
    );

    it('rejects a read-generation change after preview without changing rows', async () => {
        const fixture = await candidate();
        registerParanoidDatabase(fixture.db, fixture.dbPath, Buffer.alloc(32, 1));
        await withPlan(fixture, (plan) => {
            fixture.db.prepare('UPDATE paranoid_authority SET generation = generation + 1').run();
            const before = snapshot(fixture.db);
            expect(() => applyCompactSummaryRepair(fixture.store, plan)).toThrow(LOCKED_MEMORY_MESSAGE);
            expect(snapshot(fixture.db)).toEqual(before);
        });
    });

    it('rolls every write back when postcondition verification fails', async () => {
        const fixture = await candidate();
        await withPlan(fixture, (plan) => {
            const before = snapshot(fixture.db);
            fixture.db.exec(`CREATE TRIGGER alter_survivor AFTER DELETE ON memories BEGIN
                UPDATE memories SET pending_items = '["collateral"]' WHERE id = ${fixture.continuation.id}; END`);
            expect(() => applyCompactSummaryRepair(fixture.store, plan)).toThrow(
                'Compact summary repair verification failed: surviving memories changed',
            );
            expect(snapshot(fixture.db)).toEqual(before);
        });
    });
});
