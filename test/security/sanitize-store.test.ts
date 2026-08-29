// Security Rule 3 at the STORE level. The unit tests in sanitize.test.ts prove
// the transforms; these prove the choke points are actually wired, which is the
// difference between a stated rule and one enforced in code.

import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { mergeRollupContent, RollupStore, type RollupWrite } from '../../src/storage/rollup-store.js';
import { applySanitize, planSanitize, verifySanitize } from '../../src/storage/sanitize-backfill.js';
import type { ParsedTurn, SummarizationOutput } from '../../src/types/index.js';

function baseWrite(overrides: Partial<RollupWrite> = {}): RollupWrite {
    return {
        sessionId: 1,
        projectId: 1,
        tool: 'claude-code',
        title: 'Fix the thing',
        summary: 'Fixed the thing.',
        decisions: [{ what: 'used SQLite', why: 'local single-user tool' }],
        pendingItems: ['write tests'],
        filesTouched: ['/repo/a.ts'],
        turnCount: 3,
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-01T01:00:00.000Z',
        kind: 'primary',
        parentSessionId: null,
        summarizerStatus: 'ok',
        state: 'live',
        throughTurnIndex: 2,
        ...overrides,
    };
}

function turn(turnIndex: number): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: 's1',
        sourcePath: '/tmp/s1.jsonl',
        projectPath: '/repo',
        turnIndex,
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-01T00:00:30.000Z',
        userMessage: 'do a thing',
        assistantText: 'done',
        toolCalls: [],
        cursor: `c${turnIndex}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

describe('Rule 3 choke points', () => {
    let db: Database;
    let store: MemoryStore;
    let rollups: RollupStore;

    beforeEach(() => {
        db = openDb(':memory:');
        store = new MemoryStore(db);
        rollups = new RollupStore(db);
        const project = store.upsertProject('/repo');
        store.upsertSession('claude-code', 's1', project.id, '/tmp/s1.jsonl');
    });

    it('escapes decisions and strips display strings written through RollupStore.write', () => {
        rollups.write(
            baseWrite({
                title: 'Fix `date` handling',
                summary: 'Removed $(date) from the template.',
                decisions: [{ what: 'rejected `$(date)`', why: 'it re-evaluates on ${EVERY} render' }],
                pendingItems: ['audit <<EOF blocks'],
            }),
            undefined,
        );

        const row = rollups.get(1);
        expect(row).toBeDefined();
        // Display strings: metacharacter gone, words kept.
        expect(row?.title).toBe('Fix date handling');
        expect(row?.summary).toBe('Removed date from the template.');
        expect(row?.pending_items).toEqual(['audit EOF blocks']);
        // Decisions: escaped, so the reference to the rejected syntax survives.
        expect(row?.decisions[0].what).toBe('rejected \\`$\\(date)\\`');
        expect(row?.decisions[0].why).toBe('it re-evaluates on $\\{EVERY} render');

        for (const text of [row?.title, row?.summary, ...(row?.pending_items ?? []), row?.decisions[0].what, row?.decisions[0].why]) {
            expect(detectShellSyntax(text as string)).toBe(false);
        }
    });

    it('escapes decisions and strips pending items written through MemoryStore.recordTurn', () => {
        const summary: SummarizationOutput = {
            decisions: [{ what: 'pinned `zod` to 4.x', why: 'the 5.x codemod is unreleased' }],
            pending_items: ['run $(npm audit)'],
            status: 'ok',
        };
        expect(store.recordTurn(turn(0), 1, 1, summary)).toBe(true);

        const rows = store.listMemoriesForSession(1);
        expect(rows[0].decisions).toEqual([{ what: 'pinned \\`zod\\` to 4.x', why: 'the 5.x codemod is unreleased' }]);
        expect(rows[0].pending_items).toEqual(['run npm audit']);
        expect(verifySanitize(db)).toEqual([]);
    });

    it('escapes on the reingest path too - a maintenance rewrite is still a write', () => {
        store.recordTurn(turn(0), 1, 1, { decisions: [{ what: 'a', why: null }], pending_items: [], status: 'ok' });
        store.reingestTurn(turn(0), 1, 1, { decisions: [{ what: 're-derived `x`', why: null }], pending_items: [], status: 'ok' });
        expect(store.listMemoriesForSession(1)[0].decisions).toEqual([{ what: 're-derived \\`x\\`', why: null }]);
    });

    it('keeps the merge dedupe working across the sanitize boundary', () => {
        // `previous` comes back from the store already escaped; `incoming` is
        // raw summarizer output. Keying on the raw text would treat these as
        // two different decisions and duplicate them on every merge.
        const merged = mergeRollupContent(
            { decisions: [{ what: 'rejected $\\(date)', why: 'stale' }], pendingItems: [], filesTouched: [] },
            { decisions: [{ what: 'rejected $(date)', why: 'stale' }], pendingItems: [], filesTouched: [] },
        );
        expect(merged.decisions).toHaveLength(1);
    });

    it('leaves files_touched alone - those are tool-call paths, not summarizer output', () => {
        store.recordTurn({ ...turn(0), toolCalls: [{ name: 'Edit', filePaths: ['/repo/weird`name.ts'] }] }, 1, 1, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });
        expect(store.listMemoriesForSession(1)[0].files_touched).toEqual(['/repo/weird`name.ts']);
    });
});

describe('Rule 3 backfill', () => {
    let db: Database;

    beforeEach(() => {
        db = openDb(':memory:');
        const store = new MemoryStore(db);
        const project = store.upsertProject('/repo');
        store.upsertSession('claude-code', 's1', project.id, '/tmp/s1.jsonl');

        // Write dirty rows the way the pre-Rule-3 pipeline did: straight into
        // SQL, bypassing the choke points that now exist.
        db.prepare(
            `INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at, summarizer_status)
             VALUES (1, 1, 0, 'claude-code', '2026-08-01T00:00:00.000Z', ?, '[]', ?, '2026-08-01T00:00:00.000Z', 'ok')`,
        ).run(JSON.stringify(['set `foo` to $(bar)']), JSON.stringify(['check ${BAZ}']));
        db.prepare(
            `INSERT INTO session_rollups (session_id, project_id, tool, title, summary, decisions, pending_items, files_touched,
                turn_count, started_at, ended_at, kind, parent_session_id, summarizer_status, rollup_state,
                rolled_up_through_turn_index, computed_at, rollup_version)
             VALUES (1, 1, 'claude-code', ?, ?, ?, ?, '[]', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z',
                'primary', NULL, 'ok', 'final', 0, '2026-08-01T01:00:00.000Z', 1)`,
        ).run(
            'Title with `backticks`',
            'Summary with $(cmd).',
            JSON.stringify([{ what: 'kept `x`', why: 'because ${y}' }]),
            JSON.stringify(['pending <<HEREDOC']),
        );
    });

    it('previews the affected fields without changing anything', () => {
        const plan = planSanitize(db);
        expect(plan.rollupRows).toBe(1);
        expect(plan.memoryRows).toBe(1);
        expect(plan.changes.map((c) => `${c.table}.${c.field}`).sort()).toEqual([
            'memories.decisions',
            'memories.pending_items',
            'session_rollups.decisions',
            'session_rollups.pending_items',
            'session_rollups.summary',
            'session_rollups.title',
        ]);
        // Preview means preview: the store is untouched.
        expect(verifySanitize(db).length).toBeGreaterThan(0);
    });

    it('leaves the store with nothing the detector flags', () => {
        applySanitize(db);
        expect(verifySanitize(db)).toEqual([]);
    });

    it('is idempotent - a second run finds nothing to do', () => {
        applySanitize(db);
        expect(planSanitize(db).changes).toEqual([]);
        applySanitize(db);
        expect(verifySanitize(db)).toEqual([]);
    });

    it('preserves the words while neutralizing the syntax', () => {
        applySanitize(db);
        const row = new RollupStore(db).get(1);
        expect(row?.title).toBe('Title with backticks');
        expect(row?.decisions[0].what).toContain('x');
        expect(row?.decisions[0].why).toContain('y');
    });

    it('does not report a false positive on JSON backslash encoding', () => {
        // A correctly escaped backtick is stored as `\\`` inside the JSON
        // column. Running the detector on the raw column text would read that
        // as an unescaped backtick and the verification would never reach zero.
        applySanitize(db);
        const raw = db.prepare('SELECT decisions FROM memories WHERE id = 1').get() as { decisions: string };
        expect(raw.decisions).toContain('\\\\`');
        expect(verifySanitize(db)).toEqual([]);
    });
});
