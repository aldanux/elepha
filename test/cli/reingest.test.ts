import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { registerReingest } from '../../src/cli/commands/reingest.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { firstPromptSearch } from '../../src/storage/first-prompt-search.js';
import type { ParsedTurn, SummarizationOutput } from '../../src/types/index.js';
import { createTestDb, seedMemory, seedProject, seedSession } from '../helpers/db.js';

const mocks = vi.hoisted(() => ({ summarize: vi.fn() }));

vi.mock('../../src/summarizer/provider-config.js', () => ({
    createConfiguredSynthesisProviders: () => ({
        name: 'test',
        turnExtraction: { summarize: mocks.summarize },
        rollupMerge: {},
    }),
}));

const summary: SummarizationOutput = { decisions: [], pending_items: [], status: 'ok' };

function parsedTurn(sourcePath: string, startedAt: string, overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'native-1',
        sourcePath,
        projectPath: '/tmp/project',
        turnIndex: 0,
        startedAt,
        endedAt: startedAt,
        userMessage: 'request',
        assistantText: 'response',
        toolCalls: [],
        cursor: '0',
        hasExternalContent: false,
        resumeMarkerBefore: false,
        ...overrides,
    };
}

function seedCandidate(fixture: ReturnType<typeof createTestDb>, sourcePath: string): { projectPath: string; startedAt: string } {
    const startedAt = new Date().toISOString();
    const projectPath = path.join(fixture.directory, 'project');
    const project = seedProject(fixture, { path: projectPath });
    const session = seedSession(fixture, { project, tool: 'codex', nativeId: 'native-1', sourcePath });
    seedMemory(fixture, { project, session, startedAt });
    fixture.store.consent.grant(projectPath);
    fixture.close();
    return { projectPath, startedAt };
}

async function runReingest(): Promise<string[]> {
    const stdout: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message) => stdout.push(String(message)));
    const program = new Command();
    registerReingest(program);
    await program.parseAsync(['node', 'elepha', 'reingest', '--since', '30d']);
    return stdout;
}

describe('elepha reingest provider-store containment', () => {
    beforeEach(() => {
        mocks.summarize.mockReset();
        mocks.summarize.mockResolvedValue(summary);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('skips an out-of-store transcript without parsing or summarizing it', async () => {
        const fixture = createTestDb('elepha-reingest-paths-');
        const sourcePath = path.join(fixture.directory, 'outside.jsonl');
        writeFileSync(sourcePath, '{}\n');
        seedCandidate(fixture, sourcePath);
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha-home'));
        vi.stubEnv('CODEX_HOME', path.join(fixture.directory, 'codex-home'));
        const parseTurns = vi.spyOn(CodexAdapter.prototype, 'parseTurns');

        const stdout = await runReingest();

        expect(stdout.some((line) => line.includes('skipped native-1: source_path outside provider store'))).toBe(true);
        expect(parseTurns).not.toHaveBeenCalled();
        expect(mocks.summarize).not.toHaveBeenCalled();
    });

    it('reingests an in-store transcript exactly as before', async () => {
        const fixture = createTestDb('elepha-reingest-paths-');
        const codexHome = path.join(fixture.directory, 'codex-home');
        const sourcePath = path.join(codexHome, 'sessions', 'rollout.jsonl');
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, '{}\n');
        const { projectPath, startedAt } = seedCandidate(fixture, sourcePath);
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha-home'));
        vi.stubEnv('CODEX_HOME', codexHome);
        const turn = parsedTurn(sourcePath, startedAt, { projectPath });
        const parseTurns = vi.spyOn(CodexAdapter.prototype, 'parseTurns').mockImplementation(async function* () {
            yield turn;
        });

        const stdout = await runReingest();

        expect(parseTurns).toHaveBeenCalledWith(sourcePath, undefined, {
            closeTrailingOnIdle: true,
            handle: expect.anything(),
        });
        expect(mocks.summarize).toHaveBeenCalledWith({ userMessage: 'request', assistantText: 'response' });
        expect(stdout.some((line) => line.includes('Reingested 1 turn(s) across 1/1 session(s)'))).toBe(true);
    });

    it('refreshes first_prompt_search from the reingested minimum turn only', async () => {
        const fixture = createTestDb('elepha-reingest-first-prompt-');
        const codexHome = path.join(fixture.directory, 'codex-home');
        const sourcePath = path.join(codexHome, 'sessions', 'rollout.jsonl');
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, '{}\n');
        const startedAt = new Date().toISOString();
        const projectPath = path.join(fixture.directory, 'project');
        const project = seedProject(fixture, { path: projectPath });
        const session = seedSession(fixture, { project, tool: 'codex', nativeId: 'native-1', sourcePath });
        seedMemory(fixture, { project, session, turnIndex: 2, startedAt, userMessage: 'original first prompt' });
        seedMemory(fixture, { project, session, turnIndex: 3, startedAt, userMessage: 'original later prompt' });
        fixture.db.prepare('UPDATE sessions SET first_prompt_search = ? WHERE id = ?').run('stale prompt', session.id);
        fixture.store.consent.grant(projectPath);
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha-home'));
        vi.stubEnv('CODEX_HOME', codexHome);
        const refreshedFirstPrompt = `corrected $(whoami) \`danger\` ${'x'.repeat(10_000)}`;
        vi.spyOn(CodexAdapter.prototype, 'parseTurns').mockImplementation(async function* () {
            yield parsedTurn(sourcePath, startedAt, { projectPath, turnIndex: 2, userMessage: refreshedFirstPrompt });
            yield parsedTurn(sourcePath, startedAt, {
                projectPath,
                turnIndex: 3,
                userMessage: 'later prompt must not replace the first',
            });
        });

        await runReingest();

        expect(fixture.store.findSession('codex', 'native-1')?.first_prompt_search).toBe(firstPromptSearch(refreshedFirstPrompt));
    });

    it('learns historical MCP receipts before cutoff and suppresses later quote-back without provider calls', async () => {
        const fixture = createTestDb('elepha-reingest-mcp-receipt-');
        const codexHome = path.join(fixture.directory, 'codex-home');
        const sourcePath = path.join(codexHome, 'sessions', 'rollout.jsonl');
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, '{}\n');
        const { projectPath, startedAt } = seedCandidate(fixture, sourcePath);
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha-home'));
        vi.stubEnv('CODEX_HOME', codexHome);
        const receiptBody = 'The settled architecture keeps all memory local and uses read-only MCP serving.';
        vi.spyOn(CodexAdapter.prototype, 'parseTurns').mockImplementation(async function* () {
            yield parsedTurn(sourcePath, '2020-01-01T00:00:00.000Z', {
                projectPath,
                droppedReason: 'elepha-mcp',
                userMessage: '',
                assistantText: '',
                elephaMcpResultReceipts: [{ callId: 'call-old', body: receiptBody, observedAt: '2020-01-01T00:00:01.000Z' }],
            });
            yield parsedTurn(sourcePath, startedAt, {
                projectPath,
                turnIndex: 1,
                userMessage: `As noted earlier: ${receiptBody}`,
                assistantText: 'Repeated it.',
            });
            yield parsedTurn(sourcePath, startedAt, {
                projectPath,
                turnIndex: 2,
                userMessage: 'Unrelated clean maintenance',
                assistantText: 'Completed.',
            });
        });

        await runReingest();

        const verificationDb = openUnmanagedDb(fixture.dbPath);
        expect(
            verificationDb
                .prepare(
                    `SELECT body FROM mcp_receipts
                     WHERE tool = ? AND native_session_id = ? AND source_generation = 0`,
                )
                .all('codex', 'native-1'),
        ).toMatchObject([{ body: receiptBody }]);
        verificationDb.close();
        expect(mocks.summarize).toHaveBeenCalledTimes(1);
        expect(mocks.summarize).toHaveBeenCalledWith({ userMessage: 'Unrelated clean maintenance', assistantText: 'Completed.' });
    });

    it('rolls back the whole receipt batch when a current-generation call identity conflicts', async () => {
        const fixture = createTestDb('elepha-reingest-mcp-receipt-');
        const codexHome = path.join(fixture.directory, 'codex-home');
        const sourcePath = path.join(codexHome, 'sessions', 'rollout.jsonl');
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, '{}\n');
        const { projectPath } = seedCandidate(fixture, sourcePath);
        const seeded = openUnmanagedDb(fixture.dbPath);
        seeded.exec(`
            INSERT INTO source_generations (tool, native_id, generation) VALUES ('codex', 'native-1', 0);
            INSERT INTO mcp_receipts
                (tool, native_session_id, source_generation, source_turn_index, call_id, observed_at, body_hash, body)
            VALUES ('codex', 'native-1', 0, 1, 'bound-call', NULL, 'seed-hash', 'Original exact result body.');
        `);
        seeded.close();
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha-home'));
        vi.stubEnv('CODEX_HOME', codexHome);
        vi.spyOn(CodexAdapter.prototype, 'parseTurns').mockImplementation(async function* () {
            yield parsedTurn(sourcePath, '2020-01-01T00:00:00.000Z', {
                projectPath,
                droppedReason: 'elepha-mcp',
                userMessage: '',
                assistantText: '',
                elephaMcpResultReceipts: [{ callId: 'new-call', body: 'Must roll back.', observedAt: null }],
            });
            yield parsedTurn(sourcePath, '2020-01-01T00:00:01.000Z', {
                projectPath,
                turnIndex: 1,
                droppedReason: 'elepha-mcp',
                userMessage: '',
                assistantText: '',
                elephaMcpResultReceipts: [{ callId: 'bound-call', body: 'Conflicting result body.', observedAt: null }],
            });
        });

        await expect(runReingest()).rejects.toThrow('receipt protection incomplete');
        expect(mocks.summarize).not.toHaveBeenCalled();

        const verificationDb = openUnmanagedDb(fixture.dbPath);
        expect(verificationDb.prepare('SELECT call_id, body FROM mcp_receipts ORDER BY call_id').all()).toEqual([
            { call_id: 'bound-call', body: 'Original exact result body.' },
        ]);
        verificationDb.close();
    });

    it('requires reconciliation before summarizing when an active receipt disappeared from the source', async () => {
        const fixture = createTestDb('elepha-reingest-mcp-receipt-');
        const codexHome = path.join(fixture.directory, 'codex-home');
        const sourcePath = path.join(codexHome, 'sessions', 'rollout.jsonl');
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, '{}\n');
        const { projectPath, startedAt } = seedCandidate(fixture, sourcePath);
        const seeded = openUnmanagedDb(fixture.dbPath);
        seeded.exec(`
            INSERT INTO source_generations (tool, native_id, generation) VALUES ('codex', 'native-1', 0);
            INSERT INTO mcp_receipts
                (tool, native_session_id, source_generation, source_turn_index, call_id, observed_at, body_hash, body)
            VALUES ('codex', 'native-1', 0, 0, 'missing-call', NULL, 'seed-hash', 'Receipt missing from source.');
        `);
        seeded.close();
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha-home'));
        vi.stubEnv('CODEX_HOME', codexHome);
        vi.spyOn(CodexAdapter.prototype, 'parseTurns').mockImplementation(async function* () {
            yield parsedTurn(sourcePath, startedAt, { projectPath, userMessage: 'Would otherwise be summarized.' });
        });

        await expect(runReingest()).rejects.toThrow('reconciliation required');
        expect(mocks.summarize).not.toHaveBeenCalled();
    });
});
