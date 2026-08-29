import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { firstPromptSearch } from '../../src/storage/first-prompt-search.js';
import { planFirstPromptSearchBackfill } from '../../src/storage/first-prompt-search-backfill.js';
import type { SessionAdapter, ToolName } from '../../src/types/index.js';
import { createTestDb, seedMemory, seedProject, seedSession } from '../helpers/db.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const elephaCli = path.join(repositoryRoot, 'src', 'cli', 'index.ts');
const PROMPT = 'index $(danger) `this` first prompt';
const TRANSCRIPT =
    `{"type":"user","uuid":"u1","timestamp":"2026-08-01T10:00:02.000Z","entrypoint":"cli","cwd":"/tmp/proj","sessionId":"sess-1","message":{"role":"user","content":${JSON.stringify(PROMPT)}}}\n` +
    '{"type":"assistant","parentUuid":"u1","uuid":"a1","timestamp":"2026-08-01T10:00:03.000Z","cwd":"/tmp/proj","sessionId":"sess-1","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n';

function runBackfillCli(dbPath: string, ...args: string[]) {
    const claudeConfigDir = path.join(path.dirname(dbPath), 'claude-home');
    return spawnSync(process.execPath, [tsxCli, elephaCli, 'backfill-first-prompt-search', ...args], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            ELEPHA_DB_PATH: dbPath,
            ELEPHA_ENV_FILE: path.join(path.dirname(dbPath), 'missing.env'),
            ELEPHA_HOME: path.join(path.dirname(dbPath), 'isolated-elepha-home'),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
        },
    });
}

function seedLegacyRow(fixture: ReturnType<typeof createTestDb>, sourcePath: string, value: string | null): void {
    const now = '2026-08-01T10:00:00.000Z';
    const project = seedProject(fixture, { path: '/tmp/proj' });
    const session = seedSession(fixture, {
        project,
        tool: 'claude-code',
        nativeId: 'sess-1',
        sourcePath,
        startedAt: now,
        lastIngestedAt: now,
    });
    seedMemory(fixture, { project, session, startedAt: now, userMessage: PROMPT });
    fixture.db.prepare('UPDATE sessions SET first_prompt_search = ? WHERE id = ?').run(value, session.id);
    fixture.close();
}

describe('elepha backfill-first-prompt-search', () => {
    it('previews NULL rows without writing and --apply populates changed rows from transcripts', () => {
        const dryRunFixture = createTestDb('elepha-first-prompt-search-cli-');
        const dryRunSource = path.join(dryRunFixture.directory, 'claude-home', 'projects', 'session.jsonl');
        mkdirSync(path.dirname(dryRunSource), { recursive: true });
        writeFileSync(dryRunSource, TRANSCRIPT);
        seedLegacyRow(dryRunFixture, dryRunSource, null);

        const dryRun = runBackfillCli(dryRunFixture.dbPath);
        const help = runBackfillCli(dryRunFixture.dbPath, '--help');

        expect(dryRun.status).toBe(0);
        expect(dryRun.stdout).toContain(`first_prompt_search: NULL -> ${firstPromptSearch(PROMPT)}`);
        expect(help.stdout).toContain('Rows stay body-unsearchable by');
        expect(help.stdout).toContain('elepha:query until this backfill succeeds');
        expect(readdirSync(dryRunFixture.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
        const dryRunDb = openDb(dryRunFixture.dbPath);
        expect(dryRunDb.prepare('SELECT first_prompt_search FROM sessions').get()).toEqual({ first_prompt_search: null });
        dryRunDb.close();

        const appliedFixture = createTestDb('elepha-first-prompt-search-cli-');
        const appliedSource = path.join(appliedFixture.directory, 'claude-home', 'projects', 'session.jsonl');
        mkdirSync(path.dirname(appliedSource), { recursive: true });
        writeFileSync(appliedSource, TRANSCRIPT);
        seedLegacyRow(appliedFixture, appliedSource, 'stale value');

        const applied = runBackfillCli(appliedFixture.dbPath, '--apply');

        expect(applied.status).toBe(0);
        expect(applied.stdout).toContain(`first_prompt_search: stale value -> ${firstPromptSearch(PROMPT)}`);
        expect(applied.stdout).toContain('Wrote first_prompt_search for 1 session(s).');
        expect(readdirSync(appliedFixture.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(true);
        const appliedDb = openDb(appliedFixture.dbPath);
        expect(appliedDb.prepare('SELECT first_prompt_search FROM sessions').get()).toEqual({
            first_prompt_search: firstPromptSearch(PROMPT),
        });
        appliedDb.close();
    });

    it('treats an out-of-store transcript as unavailable without parsing it', async () => {
        const fixture = createTestDb('elepha-first-prompt-search-guard-');
        const sourcePath = path.join(fixture.directory, 'outside.jsonl');
        writeFileSync(sourcePath, TRANSCRIPT);
        const now = '2026-08-01T10:00:00.000Z';
        const project = seedProject(fixture, { path: '/tmp/proj' });
        const session = seedSession(fixture, {
            project,
            tool: 'claude-code',
            nativeId: 'sess-1',
            sourcePath,
            startedAt: now,
            lastIngestedAt: now,
        });
        seedMemory(fixture, { project, session, startedAt: now, userMessage: PROMPT });
        fixture.db.prepare('UPDATE sessions SET first_prompt_search = NULL WHERE id = ?').run(session.id);
        const parseTurns = vi.fn(async function* () {});
        const adapter = { parseTurns } as unknown as SessionAdapter;
        const adapters: Record<ToolName, SessionAdapter> = { 'claude-code': adapter, codex: adapter };
        const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = path.join(fixture.directory, 'claude-home');

        try {
            const plan = await planFirstPromptSearchBackfill(fixture.db, adapters);

            expect(plan.sessionsMissingTranscript).toBe(1);
            expect(plan.changes).toEqual([expect.objectContaining({ transcriptMissing: true, after: null })]);
            expect(parseTurns).not.toHaveBeenCalled();
        } finally {
            if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
        }
    });
});
