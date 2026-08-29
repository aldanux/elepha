import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { registerReingest } from '../../src/cli/commands/reingest.js';
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

function seedCandidate(fixture: ReturnType<typeof createTestDb>, sourcePath: string): string {
    const startedAt = new Date().toISOString();
    const project = seedProject(fixture, { path: '/tmp/project' });
    const session = seedSession(fixture, { project, tool: 'codex', nativeId: 'native-1', sourcePath });
    seedMemory(fixture, { project, session, startedAt });
    fixture.close();
    return startedAt;
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
        const startedAt = seedCandidate(fixture, sourcePath);
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha-home'));
        vi.stubEnv('CODEX_HOME', codexHome);
        const turn = parsedTurn(sourcePath, startedAt);
        const parseTurns = vi.spyOn(CodexAdapter.prototype, 'parseTurns').mockImplementation(async function* () {
            yield turn;
        });

        const stdout = await runReingest();

        expect(parseTurns).toHaveBeenCalledWith(sourcePath, undefined, { closeTrailingOnIdle: true });
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
        const project = seedProject(fixture, { path: '/tmp/project' });
        const session = seedSession(fixture, { project, tool: 'codex', nativeId: 'native-1', sourcePath });
        seedMemory(fixture, { project, session, turnIndex: 2, startedAt, userMessage: 'original first prompt' });
        seedMemory(fixture, { project, session, turnIndex: 3, startedAt, userMessage: 'original later prompt' });
        fixture.db.prepare('UPDATE sessions SET first_prompt_search = ? WHERE id = ?').run('stale prompt', session.id);
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha-home'));
        vi.stubEnv('CODEX_HOME', codexHome);
        const refreshedFirstPrompt = `corrected $(whoami) \`danger\` ${'x'.repeat(10_000)}`;
        vi.spyOn(CodexAdapter.prototype, 'parseTurns').mockImplementation(async function* () {
            yield parsedTurn(sourcePath, startedAt, { turnIndex: 2, userMessage: refreshedFirstPrompt });
            yield parsedTurn(sourcePath, startedAt, { turnIndex: 3, userMessage: 'later prompt must not replace the first' });
        });

        await runReingest();

        expect(fixture.store.findSession('codex', 'native-1')?.first_prompt_search).toBe(firstPromptSearch(refreshedFirstPrompt));
    });
});
