import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAdapters } from '../../src/adapters/index.js';
import { registerRepairMcp } from '../../src/cli/commands/repair-mcp.js';
import { renderedChars } from '../../src/rendering/raw-turn-renderer.js';
import { listManagedBackups } from '../../src/storage/backup.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { applyMcpRepair, planMcpRepair } from '../../src/storage/mcp-repair.js';
import { LOCKED_MEMORY_MESSAGE, registerParanoidDatabase } from '../../src/storage/paranoid-gate.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';

vi.mock('../../src/install/health-checks.js', () => ({ daemonHealth: () => ({ healthy: false, state: 'STOPPED' }) }));

async function candidate() {
    const fixture = createTestDb('elepha-mcp-repair-');
    const codexHome = path.join(fixture.directory, 'codex');
    const sourcePath = path.join(codexHome, 'sessions', 'repair-source.jsonl');
    vi.stubEnv('CODEX_HOME', codexHome);
    const project = seedProject(fixture);
    fixture.store.consent.grant(project.path);
    const session = seedSession(fixture, { project, nativeId: 'repair-source', sourcePath });
    const lines: unknown[] = [{ type: 'session_meta', payload: { id: session.native_id, cwd: project.path, originator: 'codex-desktop' } }];
    for (let index = 0; index < 4; index++) {
        const timestamp = `2026-09-17T00:00:0${index}.000Z`;
        lines.push({
            timestamp,
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Request ${index}` }] },
        });
        if (index !== 1) {
            lines.push({
                timestamp,
                type: 'event_msg',
                payload: {
                    type: 'item_completed',
                    item: {
                        type: 'McpToolCall',
                        id: `mcp-${index}`,
                        server: 'elepha',
                        tool: 'recall',
                        status: 'completed',
                        result: { content: [{ type: 'text', text: `Private MCP result ${index}` }] },
                    },
                },
            });
        }
        lines.push({
            timestamp,
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Response ${index}` }] },
        });
    }
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const turns = [];
    for await (const turn of defaultAdapters().codex.parseTurns(sourcePath, undefined, { closeTrailingOnIdle: true })) turns.push(turn);
    const stale = [0, 2].map((turnIndex) => seedMemory(fixture, { project, session, turnIndex, cursor: 'unchanged-cursor' }));
    const retained = seedMemory(fixture, { project, session, turnIndex: 1, cursor: 'unchanged-cursor' });
    const existingReceipt = turns[3];
    if (!existingReceipt) throw new Error('fixture did not produce receipt turn');
    expect(fixture.store.publishElephaMcpReceiptBatch([existingReceipt], session.id, 'codex', session.native_id, 0)).toBe(true);
    seedRollup(fixture, { project, session });
    fixture.db
        .prepare(`INSERT INTO session_embeddings (session_id, rollup_session_id, project_id, source_hash, model, model_revision, dimensions, vector, computed_at)
        VALUES (?, ?, ?, 'hash', 'model', 'revision', 1, ?, 'now')`)
        .run(session.id, session.id, project.id, Buffer.alloc(4));
    for (const memory of [...stale, retained]) {
        fixture.db
            .prepare(`INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, filter_version, captured_at)
            VALUES (?, 1, ?, 'durable response', 1, 'now')`)
            .run(memory.id, `durable${memory.id}`);
    }
    fixture.db.prepare("INSERT INTO durable_capture_status VALUES (?, 'complete', 1, 'now')").run(session.id);
    return { ...fixture, session, project, sourcePath, stale, retained, turns };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('source-backed MCP memory repair', () => {
    it('runs the CLI as a read-only preview, then backs up the original rows before applying the plan', async () => {
        const fixture = await candidate();
        fixture.close();
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha'));
        const output: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
        const run = async (apply: boolean) => {
            const program = new Command();
            registerRepairMcp(program);
            await program.parseAsync([
                'node',
                'elepha',
                'repair-mcp-self-ingestion',
                '--tool',
                'codex',
                '--session',
                fixture.session.native_id,
                ...(apply ? ['--apply'] : []),
            ]);
        };
        await run(false);
        expect(listManagedBackups(fixture.dbPath)).toEqual([]);
        for (const memory of fixture.stale) {
            expect(output).toContain(`Delete memory ${memory.id}: session ${fixture.session.id}, turn ${memory.turn_index}`);
        }
        await run(true);
        const backups = listManagedBackups(fixture.dbPath);
        expect(backups).toHaveLength(1);
        const backupPath = backups[0];
        if (!backupPath) throw new Error('missing backup');
        const backup = openUnmanagedDb(backupPath);
        const repaired = openUnmanagedDb(fixture.dbPath);
        try {
            expect(backup.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 3 });
            expect(backup.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').get()).toEqual({ n: 1 });
            expect(repaired.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 1 });
            expect(repaired.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').get()).toEqual({ n: 3 });
        } finally {
            backup.close();
            repaired.close();
        }
        output.length = 0;
        await run(false);
        expect(output).toContain('Nothing to repair.');
        expect(output.some((line) => line.startsWith('Insert MCP receipt:') || line.startsWith('Delete memory '))).toBe(false);
        await run(true);
        expect(listManagedBackups(fixture.dbPath)).toEqual(backups);
    });

    it('previews exact stale rows and repairs receipts and derived state while preserving the cursor and unrelated memory', async () => {
        const fixture = await candidate();
        const { store, db, session, sourcePath, turns } = fixture;
        const before = db.prepare('SELECT * FROM memories WHERE id = ?').get(fixture.retained.id);
        const plan = await planMcpRepair(store, defaultAdapters(), 'codex', session.native_id);
        try {
            expect(plan.memories.map((memory) => memory.turn_index)).toEqual([0, 2]);
            expect(plan.receipts.map((turn) => turn.turnIndex)).toEqual([0, 2, 3]);
            expect(plan.missingReceipts).toEqual([
                { turnIndex: 0, callId: 'mcp-0' },
                { turnIndex: 2, callId: 'mcp-2' },
            ]);
            expect(plan.sourcePath).toBe(sourcePath);
            expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 3 });
            expect(db.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').get()).toEqual({ n: 1 });
            applyMcpRepair(store, plan);
            expect(db.prepare('SELECT * FROM memories').all()).toEqual([before]);
            expect(db.prepare('SELECT source_turn_index FROM mcp_receipts ORDER BY source_turn_index').all()).toEqual([
                { source_turn_index: 0 },
                { source_turn_index: 2 },
                { source_turn_index: 3 },
            ]);
            expect(db.prepare('SELECT * FROM session_rollups').all()).toEqual([]);
            expect(db.prepare('SELECT * FROM session_embeddings').all()).toEqual([]);
            expect(db.prepare('SELECT * FROM durable_capture_status').all()).toEqual([]);
            expect(db.prepare('SELECT memory_id FROM filtered_turns').all()).toEqual([{ memory_id: fixture.retained.id }]);
            expect(db.prepare('SELECT total_bytes FROM durable_capture_usage').get()).toEqual(
                db
                    .prepare(
                        `SELECT SUM(length(CAST(user_prompt AS BLOB)) + length(CAST(assistant_response AS BLOB)) + length(CAST(tool_calls AS BLOB)) + COALESCE(length(CAST(assistant_structure AS BLOB)), 0)) AS total_bytes FROM filtered_turns`,
                    )
                    .get(),
            );
            expect(
                db.prepare('SELECT cursor, rendered_chars, rendered_turns, last_turn_at FROM sessions WHERE id = ?').get(session.id),
            ).toEqual({
                cursor: 'unchanged-cursor',
                rendered_chars: renderedChars(turns.filter((turn) => turn.turnIndex === 1)),
                rendered_turns: 1,
                last_turn_at: turns[1]?.endedAt,
            });
            const retry = await planMcpRepair(store, defaultAdapters(), 'codex', session.native_id);
            try {
                expect(retry.memories).toEqual([]);
                expect(retry.missingReceipts).toEqual([]);
                applyMcpRepair(store, retry);
                expect(db.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').get()).toEqual({ n: 3 });
            } finally {
                await retry.close();
            }
        } finally {
            await plan.close();
        }
    });

    it('refuses a locked plan before parsing the transcript', async () => {
        const fixture = await candidate();
        registerParanoidDatabase(fixture.db, fixture.dbPath, Buffer.alloc(32, 1));
        fixture.db.prepare("UPDATE paranoid_authority SET enrolled = 1, state = 'locked', generation = generation + 1").run();
        const adapters = defaultAdapters();
        const parse = vi.spyOn(adapters.codex, 'parseTurns');
        await expect(planMcpRepair(fixture.store, adapters, 'codex', fixture.session.native_id)).rejects.toThrow(LOCKED_MEMORY_MESSAGE);
        expect(parse).not.toHaveBeenCalled();
    });

    it('discards a plan when the authenticated read generation changes while parsing', async () => {
        const fixture = await candidate();
        registerParanoidDatabase(fixture.db, fixture.dbPath, Buffer.alloc(32, 1));
        const adapters = defaultAdapters();
        const parse = adapters.codex.parseTurns.bind(adapters.codex);
        vi.spyOn(adapters.codex, 'parseTurns').mockImplementation(async function* (...args) {
            yield* parse(...args);
            fixture.db.prepare("UPDATE paranoid_authority SET enrolled = 1, state = 'locked', generation = generation + 1").run();
        });
        await expect(planMcpRepair(fixture.store, adapters, 'codex', fixture.session.native_id)).rejects.toThrow(LOCKED_MEMORY_MESSAGE);
        expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 3 });
        expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').get()).toEqual({ n: 1 });
    });

    it('rejects a read-generation change after preview before publishing receipts or removing memories', async () => {
        const fixture = await candidate();
        registerParanoidDatabase(fixture.db, fixture.dbPath, Buffer.alloc(32, 1));
        const plan = await planMcpRepair(fixture.store, defaultAdapters(), 'codex', fixture.session.native_id);
        try {
            fixture.db.prepare('UPDATE paranoid_authority SET generation = generation + 1').run();
            expect(() => applyMcpRepair(fixture.store, plan)).toThrow(LOCKED_MEMORY_MESSAGE);
            expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 3 });
            expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').get()).toEqual({ n: 1 });
        } finally {
            await plan.close();
        }
    });

    it.each(['source', 'row', 'consent', 'generation'] as const)(
        'rejects a changed %s after preview without deleting rows or publishing receipts',
        async (change) => {
            const fixture = await candidate();
            const plan = await planMcpRepair(fixture.store, defaultAdapters(), 'codex', fixture.session.native_id);
            try {
                if (change === 'source') appendFileSync(fixture.sourcePath, '\n');
                if (change === 'row')
                    fixture.db.prepare('UPDATE memories SET pending_items = \'["changed"]\' WHERE id = ?').run(fixture.stale[0]?.id);
                if (change === 'consent') fixture.store.consent.revoke(fixture.project.path);
                if (change === 'generation') fixture.db.prepare('UPDATE source_generations SET generation = 1').run();
                expect(() => applyMcpRepair(fixture.store, plan)).toThrow(/changed/);
                expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 3 });
                expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').get()).toEqual({ n: 1 });
            } finally {
                await plan.close();
            }
        },
    );

    it('rolls receipt publication and all deletes back when a derived-state write fails', async () => {
        const fixture = await candidate();
        const plan = await planMcpRepair(fixture.store, defaultAdapters(), 'codex', fixture.session.native_id);
        try {
            fixture.db.exec("CREATE TRIGGER fail_repair BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'forced repair failure'); END");
            expect(() => applyMcpRepair(fixture.store, plan)).toThrow('forced repair failure');
            expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 3 });
            expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').get()).toEqual({ n: 1 });
            expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM filtered_turns').get()).toEqual({ n: 3 });
            expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM session_rollups').get()).toEqual({ n: 1 });
        } finally {
            await plan.close();
        }
    });
});
