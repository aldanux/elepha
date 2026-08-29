import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRollup } from '../../src/cli/commands/rollup.js';
import { ROLLUP_VERSION } from '../../src/storage/rollup-store.js';
import type { RollupResult } from '../../src/summarizer/rollup-provider.js';
import { createTestDb, seedMemory, seedProject, seedSession } from '../helpers/db.js';

const mocks = vi.hoisted(() => ({
    daemonHealth: vi.fn(() => ({ state: 'NOT RUNNING (no heartbeat file)', healthy: false })),
    provider: {
        rollup: vi.fn(),
        merge: vi.fn(),
    },
}));

vi.mock('../../src/install/health-checks.js', () => ({ daemonHealth: mocks.daemonHealth }));
//noinspection JSUnusedGlobalSymbols
vi.mock('../../src/summarizer/provider-config.js', () => ({
    createConfiguredSynthesisProviders: () => ({ rollupMerge: mocks.provider }),
}));

const rollupResult: RollupResult = {
    status: 'ok',
    output: { title: 'T', summary: 'S', decisions: [{ what: 'w', why: 'y' }], pending_items: [], droppedDecisions: 0 },
};

function seedRollupCandidate(renderedChars: number | null = 400) {
    const fixture = createTestDb('elepha-rollup-cli-');
    const project = seedProject(fixture);
    const claudeConfigDir = path.join(fixture.directory, 'claude-home');
    const providerRoot = path.join(claudeConfigDir, 'projects');
    mkdirSync(providerRoot, { recursive: true });
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
    const sourcePath = path.join(providerRoot, 'session.jsonl');
    writeFileSync(sourcePath, '');
    const closedAt = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(sourcePath, closedAt, closedAt);
    const session = seedSession(fixture, { project, tool: 'claude-code', nativeId: 'session-1', sourcePath });
    seedMemory(fixture, { project, session, renderedChars });
    fixture.db.prepare('UPDATE sessions SET rendered_chars = ? WHERE id = ?').run(renderedChars, session.id);
    fixture.close();
    return fixture;
}

async function runRollup(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((message) => stdout.push(String(message)));
    const error = vi.spyOn(console, 'error').mockImplementation((message) => stderr.push(String(message)));
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const program = new Command();
    registerRollup(program);
    try {
        await program.parseAsync(['node', 'elepha', 'rollup', ...args]);
        return { stdout: `${stdout.join('\n')}\n`, stderr: `${stderr.join('\n')}\n`, exitCode: process.exitCode };
    } finally {
        process.exitCode = previousExitCode;
        log.mockRestore();
        error.mockRestore();
    }
}

describe('elepha rollup --rebuild', () => {
    let previousDbPath: string | undefined;

    beforeEach(() => {
        previousDbPath = process.env.ELEPHA_DB_PATH;
        mocks.provider.rollup.mockReset();
        mocks.provider.merge.mockReset();
        mocks.provider.rollup.mockResolvedValue(rollupResult);
        mocks.provider.merge.mockResolvedValue(rollupResult);
        mocks.daemonHealth.mockReturnValue({ state: 'NOT RUNNING (no heartbeat file)', healthy: false });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        if (previousDbPath === undefined) {
            delete process.env.ELEPHA_DB_PATH;
        } else {
            process.env.ELEPHA_DB_PATH = previousDbPath;
        }
    });

    it('previews the rebuild count and estimated cost without calling the provider', async () => {
        const fixture = seedRollupCandidate();
        process.env.ELEPHA_DB_PATH = fixture.dbPath;

        const result = await runRollup(['--rebuild']);

        expect(result.exitCode).toBeUndefined();
        expect(result.stdout).toContain(`Preview: 1 session(s) would be rebuilt whose rollup predates v${ROLLUP_VERSION}.`);
        expect(result.stdout).toContain('ESTIMATED cost: $0.0027 (100 input / 512 output tokens).');
        expect(result.stdout).toContain('Re-run with --rebuild --apply to make API calls.');
        expect(mocks.provider.rollup).not.toHaveBeenCalled();
        expect(mocks.provider.merge).not.toHaveBeenCalled();
    });

    it('falls back to the stored turn count when rendered_chars is unavailable', async () => {
        const fixture = seedRollupCandidate(null);
        process.env.ELEPHA_DB_PATH = fixture.dbPath;

        const result = await runRollup(['--rebuild']);

        expect(result.stdout).toContain('ESTIMATED cost: $0.0026 (1 input / 512 output tokens).');
    });

    it('runs a rebuild only with --apply and reports its actual cost', async () => {
        const fixture = seedRollupCandidate();
        process.env.ELEPHA_DB_PATH = fixture.dbPath;

        const result = await runRollup(['--rebuild', '--apply', '--all']);

        expect(result.exitCode).toBeUndefined();
        expect(mocks.provider.rollup).toHaveBeenCalledTimes(1);
        expect(result.stdout).toContain('API calls: 0 — tokens 0 in / 0 out — est. cost $0.0000');
    });

    it('directs a live rebuild through the capture pause and resume commands', async () => {
        const fixture = seedRollupCandidate();
        process.env.ELEPHA_DB_PATH = fixture.dbPath;
        mocks.daemonHealth.mockReturnValue({ state: 'RUNNING', healthy: true });

        const result = await runRollup(['--rebuild', '--apply']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('`elepha pause`');
        expect(result.stderr).toContain('`elepha rollup --rebuild --apply`');
        expect(result.stderr).toContain('`elepha resume`');
        expect(result.stderr).not.toContain('elepha stop');
    });

    it.each([{ args: [] }, { args: ['--all'] }])('keeps normal rollup immediate without --apply ($args)', async ({ args }) => {
        const fixture = seedRollupCandidate();
        process.env.ELEPHA_DB_PATH = fixture.dbPath;

        const result = await runRollup(args);

        expect(result.exitCode).toBeUndefined();
        expect(mocks.provider.rollup).toHaveBeenCalledTimes(1);
    });
});
