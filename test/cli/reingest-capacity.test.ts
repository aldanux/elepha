import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { registerReingest } from '../../src/cli/commands/reingest.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { createTestDb, seedMemory, seedProject, seedSession } from '../helpers/db.js';

// The command opens its own connection with the fixed policy, so this file
// lowers the fixed capacity instead of allocating gigabytes. Seeding stays
// far below it; the reingested summary alone crosses it.
const CAPACITY = 20_000;
const mocks = vi.hoisted(() => ({ summarize: vi.fn() }));

vi.mock('../../src/config/live-memory-retention.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/config/live-memory-retention.js')>()),
    LIVE_MEMORY_CAPACITY_BYTES: 20_000,
}));

vi.mock('../../src/summarizer/provider-config.js', () => ({
    createConfiguredSynthesisProviders: () => ({
        name: 'test',
        turnExtraction: { summarize: mocks.summarize },
        rollupMerge: {},
    }),
}));

describe('elepha reingest at live-memory capacity', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        process.exitCode = undefined;
    });

    it('stops with an error and keeps the previous memory when the replacement would reach capacity', async () => {
        const fixture = createTestDb('elepha-reingest-capacity-');
        const codexHome = path.join(fixture.directory, 'codex-home');
        const sourcePath = path.join(codexHome, 'sessions', 'rollout.jsonl');
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, '{}\n');
        const startedAt = new Date().toISOString();
        const projectPath = path.join(fixture.directory, 'project');
        const project = seedProject(fixture, { path: projectPath });
        const session = seedSession(fixture, { project, tool: 'codex', nativeId: 'native-1', sourcePath });
        seedMemory(fixture, { project, session, startedAt });
        fixture.store.consent.grant(projectPath);
        const before = fixture.db.prepare('SELECT decisions, reingested_at FROM memories').all();
        fixture.close();
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha-home'));
        vi.stubEnv('CODEX_HOME', codexHome);
        const turn: ParsedTurn = {
            tool: 'codex',
            sessionId: 'native-1',
            sourcePath,
            projectPath,
            turnIndex: 0,
            startedAt,
            endedAt: startedAt,
            userMessage: 'request',
            assistantText: 'response',
            toolCalls: [],
            cursor: '0',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        };
        vi.spyOn(CodexAdapter.prototype, 'parseTurns').mockImplementation(async function* () {
            yield turn;
        });
        mocks.summarize.mockResolvedValue({ decisions: [{ what: 'd'.repeat(CAPACITY), why: null }], pending_items: [], status: 'ok' });
        const stderr: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((message) => stderr.push(String(message)));
        vi.spyOn(console, 'log').mockImplementation(() => {});

        const program = new Command();
        registerReingest(program);
        await program.parseAsync(['node', 'elepha', 'reingest', '--since', '30d']);

        expect(process.exitCode).toBe(1);
        expect(stderr).toHaveLength(1);
        const after = new Database(fixture.dbPath, { readonly: true, fileMustExist: true });
        expect(after.prepare('SELECT decisions, reingested_at FROM memories').all()).toEqual(before);
        expect(after.prepare("SELECT native_id FROM live_memory_capture_deferrals WHERE tool = 'codex'").all()).toEqual([
            { native_id: 'native-1' },
        ]);
        after.close();
    });

    it('keeps the current Codex copy searchable and adds no replacement when reingest defers', async () => {
        const fixture = createTestDb('elepha-reingest-capacity-copy-');
        const codexHome = path.join(fixture.directory, 'codex-home');
        const sourcePath = path.join(codexHome, 'sessions', 'rollout.jsonl');
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, '{}\n');
        const startedAt = new Date().toISOString();
        const projectPath = path.join(fixture.directory, 'project');
        const project = seedProject(fixture, { path: projectPath });
        const session = seedSession(fixture, { project, tool: 'codex', nativeId: 'native-1', sourcePath });
        seedMemory(fixture, { project, session, startedAt, assistantText: 'currentcopyneedle', durableCapture: true });
        fixture.store.consent.grant(projectPath);
        const copies = () => fixture.db.prepare('SELECT memory_id, assistant_response, captured_at FROM filtered_turns').all();
        const before = copies();
        fixture.close();
        // No config file: the legacy durable-capture setting is absent.
        vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
        vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha-home'));
        vi.stubEnv('CODEX_HOME', codexHome);
        vi.spyOn(CodexAdapter.prototype, 'parseTurns').mockImplementation(async function* () {
            yield {
                tool: 'codex',
                sessionId: 'native-1',
                sourcePath,
                projectPath,
                turnIndex: 0,
                startedAt,
                endedAt: startedAt,
                userMessage: 'request',
                assistantText: 'replacementneedle',
                toolCalls: [],
                cursor: '0',
                hasExternalContent: false,
                resumeMarkerBefore: false,
            } satisfies ParsedTurn;
        });
        mocks.summarize.mockResolvedValue({ decisions: [{ what: 'd'.repeat(CAPACITY), why: null }], pending_items: [], status: 'ok' });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});

        const program = new Command();
        registerReingest(program);
        await program.parseAsync(['node', 'elepha', 'reingest', '--since', '30d']);

        expect(process.exitCode).toBe(1);
        const after = new Database(fixture.dbPath, { readonly: true, fileMustExist: true });
        const hits = (term: string) =>
            after.prepare('SELECT COUNT(*) AS count FROM filtered_turns_fts WHERE filtered_turns_fts MATCH ?').get(term);
        expect(after.prepare('SELECT memory_id, assistant_response, captured_at FROM filtered_turns').all()).toEqual(before);
        expect(hits('currentcopyneedle')).toEqual({ count: 1 });
        expect(hits('replacementneedle')).toEqual({ count: 0 });
        expect(after.prepare('SELECT COUNT(*) AS count FROM turn_search_index').get()).toEqual({ count: 1 });
        after.close();
    });
});
