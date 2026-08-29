import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { createTestDb, seedMemory, seedProject, seedSession } from '../helpers/db.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const elephaCli = path.join(repositoryRoot, 'src', 'cli', 'index.ts');

const TRANSCRIPT =
    '{"type":"user","uuid":"u1","timestamp":"2026-08-01T10:00:02.000Z","entrypoint":"cli","cwd":"/tmp/proj","sessionId":"sess-1","message":{"role":"user","content":"hello"}}\n' +
    '{"type":"assistant","parentUuid":"u1","uuid":"a1","timestamp":"2026-08-01T10:00:03.000Z","cwd":"/tmp/proj","sessionId":"sess-1","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n';

function runBackfillCli(dbPath: string, ...args: string[]) {
    return spawnSync(process.execPath, [tsxCli, elephaCli, 'backfill-rendered-chars', ...args], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            ELEPHA_DB_PATH: dbPath,
            ELEPHA_ENV_FILE: path.join(path.dirname(dbPath), 'missing.env'),
            ELEPHA_HOME: path.join(path.dirname(dbPath), 'isolated-elepha-home'),
            CLAUDE_CONFIG_DIR: path.join(path.dirname(dbPath), 'claude-home'),
        },
    });
}

function seed(fixture: ReturnType<typeof createTestDb>, sourcePath: string): void {
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
    seedMemory(fixture, { project, session, startedAt: now, renderedChars: 0, renderedTurns: 0 });
    fixture.close();
}

describe('elepha backfill-rendered-chars', () => {
    it('backs up the DB before applying and creates no backup during a dry run', () => {
        const fixture = createTestDb('elepha-rendered-chars-cli-');
        const { directory, dbPath } = fixture;
        const sourcePath = path.join(directory, 'claude-home', 'projects', 'session.jsonl');
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, TRANSCRIPT);
        seed(fixture, sourcePath);
        fixture.close();

        const applied = runBackfillCli(dbPath, '--apply');

        expect(applied.status).toBe(0);
        expect(applied.stdout).toContain(`Backed up ${dbPath} to `);
        const backupName = readdirSync(directory).find((name) => name.startsWith('elepha.db.bak-'));
        expect(backupName).toBeDefined();

        const backup = openDb(path.join(directory, backupName!));
        expect(backup.prepare('SELECT rendered_chars, rendered_turns FROM sessions').get()).toEqual({
            rendered_chars: 0,
            rendered_turns: 0,
        });
        backup.close();

        const appliedDb = openDb(dbPath);
        const current = appliedDb.prepare('SELECT rendered_chars, rendered_turns FROM sessions').get() as {
            rendered_chars: number;
            rendered_turns: number;
        };
        expect(current.rendered_chars).toBeGreaterThan(0);
        expect(current.rendered_turns).toBe(1);
        appliedDb.close();

        const dryRunFixture = createTestDb('elepha-rendered-chars-cli-');
        const dryRunDirectory = dryRunFixture.directory;
        const dryRunDbPath = dryRunFixture.dbPath;
        const dryRunSourcePath = path.join(dryRunDirectory, 'claude-home', 'projects', 'session.jsonl');
        mkdirSync(path.dirname(dryRunSourcePath), { recursive: true });
        writeFileSync(dryRunSourcePath, TRANSCRIPT);
        seed(dryRunFixture, dryRunSourcePath);
        dryRunFixture.close();
        const dryRun = runBackfillCli(dryRunDbPath);

        expect(dryRun.status).toBe(0);
        expect(readdirSync(dryRunDirectory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);
    }, 15000);
});
