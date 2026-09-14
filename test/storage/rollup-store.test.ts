import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { escapeShellSyntax } from '../../src/security/sanitize.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { mergeRollupContent, ROLLUP_VERSION, RollupStore, type RollupWrite } from '../../src/storage/rollup-store.js';
import { withTempDir } from '../helpers/tmp.js';

function baseWrite(overrides: Partial<RollupWrite> = {}): RollupWrite {
    return {
        sessionId: 1,
        projectId: 1,
        tool: 'claude-code',
        title: 'Fix the thing',
        summary: 'Fixed the thing.',
        decisions: [{ what: 'used SQLite', why: 'local single-user tool' }],
        instructions: [],
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

describe('RollupStore', () => {
    let store: MemoryStore;
    let rollups: RollupStore;

    beforeEach(() => {
        const db = openUnmanagedDb(':memory:');
        store = new MemoryStore(db);
        rollups = new RollupStore(db);
        const project = store.upsertProject('/repo');
        store.upsertSession('claude-code', 's1', project.id, '/tmp/s1.jsonl');
    });

    it('inserts and reads back a rollup with parsed JSON fields', () => {
        expect(rollups.write(baseWrite(), undefined)).toBe(true);
        const row = rollups.get(1)!;
        expect(row.title).toBe('Fix the thing');
        expect(row.decisions).toEqual([{ what: 'used SQLite', why: 'local single-user tool' }]);
        expect(row.rollup_state).toBe('live');
        expect(row.rolled_up_through_turn_index).toBe(2);
        expect(row.rollup_version).toBe(ROLLUP_VERSION);
    });

    // The core idempotency guard. A rollup is a mutable aggregate with no
    // UNIQUE constraint protecting it, and sessions reopen repeatedly, so a
    // duplicate apply must be rejected rather than double-counted.
    it('rejects a write whose expected watermark has already moved', () => {
        rollups.write(baseWrite(), undefined);
        expect(rollups.write(baseWrite({ throughTurnIndex: 5, title: 'first' }), 2)).toBe(true);

        // Second writer still believes the watermark is 2 - it is now 5.
        expect(rollups.write(baseWrite({ throughTurnIndex: 5, title: 'duplicate' }), 2)).toBe(false);
        expect(rollups.get(1)!.title).toBe('first');
    });

    it('stores optional reasons safely and preserves instructions through insert, update, and rebuild upsert', () => {
        const instructions = [{ what: 'Never use `$(unsafe)`', turnIndex: 1, at: 'first' }];
        rollups.write(baseWrite({ instructions }), undefined);
        const expected = [{ ...instructions[0], what: escapeShellSyntax(instructions[0].what) }];
        expect(rollups.get(1)!.instructions).toEqual(expected);
        expect(rollups.listByProject(1)[0].instructions).toEqual(expected);
        expect(rollups.write(baseWrite({ instructions, throughTurnIndex: 3 }), 2)).toBe(true);
        expect(rollups.get(1)!.instructions).toEqual(expected);
        expect(rollups.write(baseWrite({ instructions: [{ what: 'Use tabs', why: 'Avoid `$(noise)`' }] }), undefined)).toBe(true);
        expect(rollups.get(1)!.instructions).toEqual([{ what: 'Use tabs', why: escapeShellSyntax('Avoid `$(noise)`') }]);
    });

    it('orders and deduplicates instructions on the first write even when the model does not', () => {
        rollups.write(
            baseWrite({
                instructions: [
                    { what: 'New rule', turnIndex: 4 },
                    { what: 'Old rule', turnIndex: 1 },
                    { what: 'NEW RULE', turnIndex: 2 },
                ],
            }),
            undefined,
        );
        expect(rollups.get(1)!.instructions).toEqual([
            { what: 'Old rule', turnIndex: 1 },
            { what: 'New rule', turnIndex: 2 },
        ]);
    });

    it('markLive flips a final rollup back to live, and is a no-op on an already-live one', () => {
        rollups.write(baseWrite({ state: 'final' }), undefined);
        rollups.markLive(1);
        expect(rollups.get(1)!.rollup_state).toBe('live');
        rollups.markLive(1);
        expect(rollups.get(1)!.rollup_state).toBe('live');
    });

    it('re-inserting (version rebuild) replaces the row rather than throwing on the primary key', () => {
        // A caller can pin the stamped version to keep an intermediate rebuild
        // batch looking stale so it stays a rebuild candidate until the batch
        // that actually finishes the session. Omitting it keeps every existing
        // caller's behavior (current version) unchanged.
        rollups.write(baseWrite({ title: 'v1', rollupVersion: 0 }), undefined);
        expect(rollups.get(1)!.rollup_version).toBe(0);

        expect(rollups.write(baseWrite({ title: 'rebuilt' }), undefined)).toBe(true);
        expect(rollups.get(1)!.title).toBe('rebuilt');
        expect(rollups.get(1)!.rollup_version).toBe(ROLLUP_VERSION);
    });
});

describe('RollupStore.listSessions', () => {
    let store: MemoryStore;
    let rollups: RollupStore;
    let projectId: number;

    beforeEach(() => {
        const db = openUnmanagedDb(':memory:');
        store = new MemoryStore(db);
        rollups = new RollupStore(db);
        projectId = store.upsertProject('/repo').id;
        for (const nid of ['parent', 'child', 'thin']) store.upsertSession('claude-code', nid, projectId, `/tmp/${nid}.jsonl`);
    });

    const ids = () => ({
        parent: store.findSession('claude-code', 'parent')!.id,
        child: store.findSession('claude-code', 'child')!.id,
        thin: store.findSession('claude-code', 'thin')!.id,
    });

    it('attaches sub-agent rollups to their parent instead of listing them as peers', () => {
        const { parent, child } = ids();
        rollups.write(baseWrite({ sessionId: parent, projectId, title: 'Parent work' }), undefined);
        rollups.write(baseWrite({ sessionId: child, projectId, title: 'Sub work', kind: 'subagent', parentSessionId: parent }), undefined);

        const listed = rollups.listSessions(projectId);
        expect(listed).toHaveLength(1);
        expect(listed[0]!.rollup.title).toBe('Parent work');
        expect(listed[0]!.children.map((c) => c.title)).toEqual(['Sub work']);
    });

    it('lists rollups without a substantive filter', () => {
        const { parent, thin } = ids();
        rollups.write(baseWrite({ sessionId: parent, projectId, title: 'Real work' }), undefined);
        rollups.write(baseWrite({ sessionId: thin, projectId, title: 'Noise' }), undefined);

        expect(
            rollups
                .listSessions(projectId)
                .map((e) => e.rollup.title)
                .sort(),
        ).toEqual(['Noise', 'Real work']);
        expect(
            rollups
                .listSessions(projectId, { includeAll: true })
                .map((e) => e.rollup.title)
                .sort(),
        ).toEqual(['Noise', 'Real work']);
        expect(rollups.get(thin)).toBeDefined();
    });

    // A sub-agent whose parent has no rollup of its own (never rolled up, or
    // rolled up under a different project) has nothing to attach to. Hiding it
    // would lose it from every view, so it stands alone instead.
    it('lists a sub-agent standalone when its parent has no rollup to attach to', () => {
        const { parent, child } = ids();
        rollups.write(
            baseWrite({ sessionId: child, projectId, title: 'Orphan sub', kind: 'subagent', parentSessionId: parent }),
            undefined,
        );
        expect(rollups.get(parent)).toBeUndefined();
        expect(rollups.listSessions(projectId).map((e) => e.rollup.title)).toEqual(['Orphan sub']);
    });
});

describe('mergeRollupContent', () => {
    const prev = {
        decisions: [{ what: 'used SQLite', why: 'local tool' }],
        instructions: [],
        pendingItems: ['write tests', 'update docs'],
        filesTouched: ['/repo/a.ts'],
    };

    it('dedupes decisions by what, case-insensitively', () => {
        const merged = mergeRollupContent(prev, {
            decisions: [
                { what: 'Used SQLite', why: 'restated' },
                { what: 'added index', why: 'slow query' },
            ],
            instructions: [],
            pendingItems: [],
            filesTouched: [],
        });
        expect(merged.decisions).toHaveLength(2);
        expect(merged.decisions[0]!.why).toBe('local tool'); // first spelling wins
    });

    // pending_items REPLACE rather than union: the merge model is told to drop
    // items the new turns resolved, so unioning would make a resolved item
    // immortal.
    it('replaces pending_items so resolved ones can leave the list', () => {
        const merged = mergeRollupContent(prev, { decisions: [], instructions: [], pendingItems: ['update docs'], filesTouched: [] });
        expect(merged.pendingItems).toEqual(['update docs']);
    });

    it('unions files_touched with host-appropriate case dedupe', () => {
        const merged = mergeRollupContent(prev, {
            decisions: [],
            instructions: [],
            pendingItems: [],
            filesTouched: ['/repo/A.ts', '/repo/b.ts'],
        });
        if (process.platform === 'darwin') {
            expect(merged.filesTouched).toEqual(['/repo/a.ts', '/repo/b.ts']);
        } else {
            expect(merged.filesTouched).toEqual(['/repo/a.ts', '/repo/A.ts', '/repo/b.ts']);
        }
    });

    it('is idempotent - applying the same merge twice yields the same result', () => {
        const incoming = {
            decisions: [{ what: 'added index', why: 'slow query' }],
            instructions: [],
            pendingItems: ['ship it'],
            filesTouched: ['/repo/b.ts'],
        };
        const once = mergeRollupContent(prev, incoming);
        const twice = mergeRollupContent(once, incoming);
        expect(twice).toEqual(once);
    });
});

describe('instruction union', () => {
    const empty = { decisions: [], instructions: [], pendingItems: [], filesTouched: [] };

    it('unions instructions instead of replacing them when a model omits old rules', () => {
        const previous = { ...empty, instructions: [{ what: 'Always run tests' }], pendingItems: ['Run tests now'] };
        const incoming = { ...empty, instructions: [{ what: 'Use tabs', why: 'Project convention' }] };
        const merged = mergeRollupContent(previous, incoming);
        expect(merged.instructions).toEqual([...previous.instructions, ...incoming.instructions]);
        expect(merged.pendingItems).toEqual([]);
        expect(mergeRollupContent(merged, incoming)).toEqual(merged);
        expect(mergeRollupContent(merged, empty).instructions).toEqual(merged.instructions);
    });

    it('dedupes escaped, case-folded, trimmed what and retains earliest known provenance', () => {
        const what = 'Never use `$(unsafe)`';
        const previous = { ...empty, instructions: [{ what: escapeShellSyntax(what), turnIndex: 8, at: 'later' }, { what: 'Use tabs' }] };
        const incoming = {
            ...empty,
            instructions: [
                { what: `  ${what.toUpperCase()}  `, turnIndex: 2, at: 'first' },
                { what: 'USE TABS', turnIndex: 4, at: 'known' },
                { what: 'Use tabs', turnIndex: 9, at: 'repeated' },
            ],
        };
        const merged = mergeRollupContent(previous, incoming);
        expect(merged.instructions).toEqual([
            { what: escapeShellSyntax(what), turnIndex: 2, at: 'first' },
            { what: 'Use tabs', turnIndex: 4, at: 'known' },
        ]);
        expect(mergeRollupContent(merged, incoming)).toEqual(merged);
    });
});

describe('instructions schema migration', () => {
    it('creates a functional instructions column in a fresh database', () => {
        const db = openUnmanagedDb(':memory:');
        try {
            const store = new MemoryStore(db);
            store.upsertProject('/repo');
            store.upsertSession('claude-code', 's1', 1, '/repo/s1.jsonl');
            const rollups = new RollupStore(db);
            expect(db.pragma('table_info(session_rollups)')).toContainEqual(expect.objectContaining({ name: 'instructions', notnull: 1 }));
            rollups.write(baseWrite({ instructions: [{ what: 'Always run tests' }] }), undefined);
            expect(rollups.get(1)!.instructions).toEqual([{ what: 'Always run tests' }]);
        } finally {
            db.close();
        }
    });

    it('upgrades a populated prior schema and preserves all data on an idempotent reopen', () => {
        const dbPath = path.join(withTempDir('elepha-instructions-migration-'), 'legacy.db');
        const legacy = openUnmanagedDb(dbPath);
        const store = new MemoryStore(legacy);
        store.upsertProject('/repo');
        store.upsertSession('claude-code', 's1', 1, '/repo/s1.jsonl');
        legacy.exec('DROP TABLE session_rollups');
        legacy.exec(readFileSync(new URL('../fixtures/legacy-session-rollups.sql', import.meta.url), 'utf8'));
        legacy
            .prepare(`INSERT INTO session_rollups VALUES
            (1, 1, 'claude-code', 'Prior title', 'Prior summary', ?, ?, ?, 3,
             '2026-08-01', '2026-08-02', 'primary', NULL, 'ok', 'final', 2, '2026-08-02', 2)`)
            .run(JSON.stringify([{ what: 'SQLite', why: 'Local storage', turnIndex: 0 }]), '["Ship"]', '["a.ts"]');
        const before = legacy.prepare('SELECT * FROM session_rollups').get() as Record<string, unknown>;
        expect((legacy.pragma('table_info(session_rollups)') as Array<{ name: string }>).map((c) => c.name)).not.toContain('instructions');
        legacy.close();

        const upgraded = openUnmanagedDb(dbPath);
        expect(upgraded.prepare('SELECT * FROM session_rollups').get()).toEqual({ ...before, instructions: '[]' });
        expect(new RollupStore(upgraded).get(1)!.instructions).toEqual([]);
        upgraded.prepare('UPDATE session_rollups SET instructions = ? WHERE session_id = 1').run('[{"what":"Use tabs"}]');
        upgraded.close();

        const reopened = openUnmanagedDb(dbPath);
        try {
            expect(reopened.prepare('SELECT * FROM session_rollups').get()).toEqual({ ...before, instructions: '[{"what":"Use tabs"}]' });
            const columns = reopened.pragma('table_info(session_rollups)') as Array<{ name: string }>;
            expect(columns.filter((column) => column.name === 'instructions')).toHaveLength(1);
            expect(new RollupStore(reopened).get(1)!.instructions).toEqual([{ what: 'Use tabs' }]);
            expect(reopened.pragma('foreign_key_check')).toEqual([]);
        } finally {
            reopened.close();
        }
    });
});
