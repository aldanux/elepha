// Security Rule 3 at the STORE level. The unit tests in sanitize.test.ts prove
// the transforms; these prove the choke points are actually wired, which is the
// difference between a stated rule and one enforced in code.

import path from 'node:path';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import { openDb, openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { enableParanoidMode, LOCKED_MEMORY_MESSAGE, lockMemory, unlockMemory } from '../../src/storage/paranoid-gate.js';
import { mergeRollupContent, RollupStore, type RollupWrite } from '../../src/storage/rollup-store.js';
import { applySanitize, planSanitize, verifySanitize } from '../../src/storage/sanitize-backfill.js';
import type { ParsedTurn, SummarizationOutput } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const C1_CONTROLS = '\u0080\u0085\u0090\u009b\u009f';

function hasC1(value: string): boolean {
    return [...value].some((char) => {
        const codePoint = char.codePointAt(0) ?? 0;
        return codePoint >= 0x80 && codePoint <= 0x9f;
    });
}

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
        db = openUnmanagedDb(':memory:');
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

    it('removes every representative C1 control from every live stored field', () => {
        const tainted = (label: string) => `${label}${C1_CONTROLS}`;
        rollups.write(
            baseWrite({
                title: tainted('title'),
                summary: tainted('summary'),
                decisions: [{ what: tainted('rollup what'), why: tainted('rollup why') }],
                pendingItems: [tainted('rollup pending')],
            }),
            undefined,
        );
        expect(
            store.recordTurn(
                {
                    ...turn(0),
                    userMessage: tainted('prompt'),
                    assistantText: tainted('response'),
                    toolCalls: [{ name: tainted('tool'), filePaths: [tainted('/repo/file')] }],
                },
                1,
                1,
                {
                    decisions: [{ what: tainted('memory what'), why: tainted('memory why') }],
                    pending_items: [tainted('memory pending')],
                    status: 'ok',
                },
                true,
            ),
        ).toBe(true);

        const rollup = rollups.get(1);
        const memory = store.listMemoriesForSession(1)[0];
        const filtered = db.prepare('SELECT user_prompt, assistant_response, tool_calls FROM filtered_turns').get() as {
            user_prompt: string;
            assistant_response: string;
            tool_calls: string;
        };
        const toolCalls = JSON.parse(filtered.tool_calls) as Array<{ name: string; filePaths: string[] }>;
        const storedLeaves = [
            rollup?.title,
            rollup?.summary,
            rollup?.decisions[0]?.what,
            rollup?.decisions[0]?.why,
            rollup?.pending_items[0],
            memory.decisions[0]?.what,
            memory.decisions[0]?.why,
            memory.pending_items[0],
            filtered.user_prompt,
            filtered.assistant_response,
            toolCalls[0]?.name,
            toolCalls[0]?.filePaths[0],
        ];
        expect(storedLeaves.every((value) => typeof value === 'string' && !hasC1(value) && !detectShellSyntax(value))).toBe(true);
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
        db = openUnmanagedDb(':memory:');
        const store = new MemoryStore(db);
        const project = store.upsertProject('/repo');
        store.upsertSession('claude-code', 's1', project.id, '/tmp/s1.jsonl');

        // Write dirty rows the way the pre-Rule-3 pipeline did: straight into
        // SQL, bypassing the choke points that now exist.
        const tainted = (value: string) => `${value}${C1_CONTROLS}`;
        db.prepare(
            `INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at, summarizer_status)
             VALUES (1, 1, 0, 'claude-code', '2026-08-01T00:00:00.000Z', ?, '[]', ?, '2026-08-01T00:00:00.000Z', 'ok')`,
        ).run(JSON.stringify([tainted('set `foo` to $(bar)')]), JSON.stringify([tainted('check ${BAZ}')]));
        db.prepare(
            `INSERT INTO filtered_turns
             (memory_id, included, user_prompt, assistant_response, tool_calls, filter_version, captured_at)
             VALUES (1, 1, ?, ?, ?, 1, '2026-08-01T00:00:00.000Z')`,
        ).run(
            tainted('|| promptneedle'),
            tainted('&& responseneedle'),
            JSON.stringify([
                {
                    name: tainted('\n|| toolnameneedle'),
                    filePaths: [tainted('  \\&& toolpathneedle')],
                    legacy: { nested: tainted('\\|| nestedneedle') },
                },
            ]),
        );
        db.prepare(
            `INSERT INTO session_rollups (session_id, project_id, tool, title, summary, decisions, pending_items, files_touched,
                turn_count, started_at, ended_at, kind, parent_session_id, summarizer_status, rollup_state,
                rolled_up_through_turn_index, computed_at, rollup_version)
             VALUES (1, 1, 'claude-code', ?, ?, ?, ?, '[]', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z',
                'primary', NULL, 'ok', 'final', 0, '2026-08-01T01:00:00.000Z', 1)`,
        ).run(
            tainted('Title with `backticks`'),
            tainted('Summary with $(cmd).'),
            JSON.stringify([{ what: tainted('kept `x`'), why: tainted('because ${y}') }]),
            JSON.stringify([tainted('pending <<HEREDOC')]),
        );
    });

    it('previews the affected fields without changing anything', () => {
        const plan = planSanitize(db);
        expect(plan.rollupRows).toBe(1);
        expect(plan.memoryRows).toBe(1);
        expect(plan.filteredTurnRows).toBe(1);
        expect(plan.changes.map((c) => `${c.table}.${c.field}`).sort()).toEqual([
            'filtered_turns.assistant_response',
            'filtered_turns.tool_calls',
            'filtered_turns.user_prompt',
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
        for (const table of ['session_rollups', 'memories', 'filtered_turns']) {
            expect(hasC1(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()))).toBe(false);
        }
    });

    it('is idempotent - a second run finds nothing to do', () => {
        applySanitize(db);
        expect(planSanitize(db).changes).toEqual([]);
        applySanitize(db);
        expect(verifySanitize(db)).toEqual([]);
    });

    it('repairs filtered turns while preserving JSON and exact FTS and usage maintenance', () => {
        db.exec('CREATE VIRTUAL TABLE temp.sanitize_terms USING fts5vocab(main, filtered_turns_fts, instance)');
        const termsBefore = db.prepare('SELECT term, doc, col, offset FROM temp.sanitize_terms ORDER BY term, doc, col, offset').all();
        const usageBefore = (db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number })
            .total_bytes;

        applySanitize(db);

        const row = db.prepare('SELECT user_prompt, assistant_response, tool_calls FROM filtered_turns').get() as {
            user_prompt: string;
            assistant_response: string;
            tool_calls: string;
        };
        expect(row.user_prompt).toBe('\\|\\| promptneedle');
        expect(row.assistant_response).toBe('\\&\\& responseneedle');
        expect(JSON.parse(row.tool_calls)).toEqual([
            {
                name: '\n\\|\\| toolnameneedle',
                filePaths: ['  \\&\\& toolpathneedle'],
                legacy: { nested: '\\|\\| nestedneedle' },
            },
        ]);
        expect(db.prepare('SELECT term, doc, col, offset FROM temp.sanitize_terms ORDER BY term, doc, col, offset').all()).toEqual(
            termsBefore,
        );
        const usage = (db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number })
            .total_bytes;
        const measured = (
            db
                .prepare(
                    `SELECT COALESCE(SUM(
                       length(CAST(user_prompt AS BLOB)) +
                       length(CAST(assistant_response AS BLOB)) +
                       length(CAST(tool_calls AS BLOB))
                     ), 0) AS total_bytes
                     FROM filtered_turns`,
                )
                .get() as { total_bytes: number }
        ).total_bytes;
        expect(usage).toBeLessThan(usageBefore);
        expect(usage).toBe(measured);

        const storedAfterFirstApply = JSON.stringify(row);
        expect(applySanitize(db).changes).toEqual([]);
        expect(JSON.stringify(db.prepare('SELECT user_prompt, assistant_response, tool_calls FROM filtered_turns').get())).toBe(
            storedAfterFirstApply,
        );
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

const SANITIZE_SECRET = 'sanitize-secret-value $(exposed)';
const PARANOID_PASSPHRASE = 'correct horse battery staple';

interface ManagedSanitizeFixture {
    db: Database;
    dbPath: string;
    directory: string;
    memoryId: number;
}

async function createManagedSanitizeFixture(): Promise<ManagedSanitizeFixture> {
    const directory = withGrantableTestDir('elepha-sanitize-paranoid-');
    const dbPath = path.join(directory, 'elepha.db');
    vi.stubEnv('ELEPHA_DB_PATH', dbPath);
    vi.stubEnv('ELEPHA_ENV_FILE', path.join(directory, 'missing.env'));
    vi.stubEnv('ELEPHA_HOME', path.join(directory, 'isolated-elepha-home'));
    const db = await openDb(dbPath, {
        encryption: {
            platform: 'linux',
            env: { CI: '1' },
            keyFilePath: () => path.join(directory, 'elepha.keydata'),
        },
    });
    const store = new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null });
    const project = store.upsertProject(path.join(directory, 'project'));
    const session = store.upsertSession('claude-code', 'sanitize-session', project.id, path.join(directory, 'session.jsonl'));
    store.recordTurn(
        {
            tool: 'claude-code',
            sessionId: 'sanitize-session',
            sourcePath: path.join(directory, 'session.jsonl'),
            projectPath: project.path,
            turnIndex: 0,
            startedAt: '2026-08-01T00:00:00.000Z',
            endedAt: '2026-08-01T00:00:01.000Z',
            userMessage: 'safe prompt',
            assistantText: 'safe response',
            toolCalls: [],
            cursor: 'c0',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        },
        session.id,
        project.id,
        { decisions: [], pending_items: [], status: 'ok' },
        true,
    );
    const memory = store.listMemoriesForSession(session.id)[0];
    db.prepare('UPDATE filtered_turns SET user_prompt = ? WHERE memory_id = ?').run(SANITIZE_SECRET, memory.id);
    return { db, dbPath, directory, memoryId: memory.id };
}

function storedSanitizeSecret(fixture: ManagedSanitizeFixture): string {
    return (
        fixture.db.prepare('SELECT user_prompt FROM filtered_turns WHERE memory_id = ?').get(fixture.memoryId) as {
            user_prompt: string;
        }
    ).user_prompt;
}

async function runRegisteredSanitize(db: Database, ...args: string[]): Promise<{ errors: string[]; logs: string[]; warnings: string[] }> {
    vi.doMock('../../src/storage/db.js', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../src/storage/db.js')>()),
        openDb: vi.fn().mockResolvedValue(db),
    }));
    const logs: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message) => logs.push(String(message)));
    vi.spyOn(console, 'error').mockImplementation((message) => errors.push(String(message)));
    vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(String(message)));
    const { registerSanitize } = await import('../../src/cli/commands/sanitize.js');
    const program = new Command();
    registerSanitize(program);
    await program.parseAsync(['node', 'elepha', 'sanitize', ...args]);
    return { errors, logs, warnings };
}

describe('sanitize paranoid read gate', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        vi.doUnmock('../../src/storage/db.js');
        vi.doUnmock('../../src/storage/sanitize-backfill.js');
        vi.unstubAllEnvs();
    });

    it('prints only the standard locked response during a locked dry run', async () => {
        const fixture = await createManagedSanitizeFixture();
        enableParanoidMode(fixture.db, PARANOID_PASSPHRASE);

        const output = await runRegisteredSanitize(fixture.db);

        expect(output).toEqual({ errors: [], logs: [LOCKED_MEMORY_MESSAGE], warnings: [] });
        expect(output.logs.join('\n')).not.toContain(SANITIZE_SECRET);
        expect(storedSanitizeSecret(fixture)).toBe(SANITIZE_SECRET);
        fixture.db.close();
    });

    it('prints only the standard locked response and changes nothing during locked apply', async () => {
        const fixture = await createManagedSanitizeFixture();
        enableParanoidMode(fixture.db, PARANOID_PASSPHRASE);

        const output = await runRegisteredSanitize(fixture.db, '--apply');

        expect(output).toEqual({ errors: [], logs: [LOCKED_MEMORY_MESSAGE], warnings: [] });
        expect(output.logs.join('\n')).not.toContain(SANITIZE_SECRET);
        expect(storedSanitizeSecret(fixture)).toBe(SANITIZE_SECRET);
        fixture.db.close();
    });

    it('suppresses a plan when lock completes after its rows are read but before rendering', async () => {
        const fixture = await createManagedSanitizeFixture();
        enableParanoidMode(fixture.db, PARANOID_PASSPHRASE);
        expect(unlockMemory(fixture.db, PARANOID_PASSPHRASE)).toBe('unlocked');
        let planRead = false;
        vi.doMock('../../src/storage/sanitize-backfill.js', async (importOriginal) => {
            const actual = await importOriginal<typeof import('../../src/storage/sanitize-backfill.js')>();
            return {
                ...actual,
                planSanitize: (db: Database) => {
                    const plan = actual.planSanitize(db);
                    planRead = true;
                    expect(lockMemory(db)).toBe('locked');
                    return plan;
                },
            };
        });

        const output = await runRegisteredSanitize(fixture.db);

        expect(planRead).toBe(true);
        expect(output).toEqual({ errors: [], logs: [LOCKED_MEMORY_MESSAGE], warnings: [] });
        expect(output.logs.join('\n')).not.toContain(SANITIZE_SECRET);
        expect(storedSanitizeSecret(fixture)).toBe(SANITIZE_SECRET);
        fixture.db.close();
    });

    it('does not update after a competing lock completes before the first sanitize update', async () => {
        const fixture = await createManagedSanitizeFixture();
        enableParanoidMode(fixture.db, PARANOID_PASSPHRASE);
        expect(unlockMemory(fixture.db, PARANOID_PASSPHRASE)).toBe('unlocked');
        const contender = await openDb(fixture.dbPath, {
            encryption: {
                platform: 'linux',
                env: { CI: '1' },
                keyFilePath: () => path.join(fixture.directory, 'elepha.keydata'),
            },
        });
        const prepare = fixture.db.prepare.bind(fixture.db);
        let lockAttempted = false;
        let lockCompletedBeforeUpdate = false;
        let lockError: unknown;
        vi.spyOn(fixture.db, 'prepare').mockImplementation(((source: string) => {
            if (!lockAttempted && /^UPDATE filtered_turns SET user_prompt = \?/.test(source)) {
                lockAttempted = true;
                try {
                    lockCompletedBeforeUpdate = lockMemory(contender) === 'locked';
                } catch (error) {
                    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'SQLITE_BUSY') {
                        throw error;
                    }
                    lockError = error;
                }
            }
            return prepare(source);
        }) as typeof fixture.db.prepare);

        const output = await runRegisteredSanitize(fixture.db, '--apply');
        const stored = storedSanitizeSecret(fixture);

        expect({ lockAttempted, output }).toMatchObject({ lockAttempted: true });
        if (lockCompletedBeforeUpdate) {
            expect(lockError).toBeUndefined();
            expect(output).toEqual({ errors: [], logs: [LOCKED_MEMORY_MESSAGE], warnings: [] });
            expect(stored).toBe(SANITIZE_SECRET);
        } else {
            expect(lockError).toMatchObject({ code: 'SQLITE_BUSY' });
            expect(stored).not.toBe(SANITIZE_SECRET);
            expect(output.errors).toEqual([]);
            expect(output.warnings).toEqual([]);
            expect(output.logs.join('\n')).toContain(SANITIZE_SECRET);
            expect(output.logs).toContain('Rewrote 1 field(s).');
            expect(output.logs).toContain('Verified: no stored field carries shell-active syntax.');
            expect(lockMemory(contender)).toBe('locked');
        }
        contender.close();
        fixture.db.close();
    }, 15000);
});
