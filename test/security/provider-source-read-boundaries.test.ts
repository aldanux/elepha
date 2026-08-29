import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBackfills } from '../../src/cli/commands/backfills.js';
import { registerRollup } from '../../src/cli/commands/rollup.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { RollupService } from '../../src/daemon/rollup-service.js';
import { applyCustomTitleBackfill, planCustomTitleBackfill } from '../../src/storage/custom-title-backfill.js';
import { planExternalAgentImportPurge } from '../../src/storage/external-agent-import-purge.js';
import { applyFirstPromptSearchBackfill, planFirstPromptSearchBackfill } from '../../src/storage/first-prompt-search-backfill.js';
import { applyRenderedCharsBackfill, planRenderedCharsBackfill } from '../../src/storage/rendered-chars-backfill.js';
import { RollupStore } from '../../src/storage/rollup-store.js';
import { applySessionFieldsBackfill, planSessionFieldsBackfill } from '../../src/storage/session-fields-backfill.js';
import type {
    EmptySessionAnalysis,
    ParsedTurn,
    ParseTurnsOptions,
    SessionAdapter,
    SessionClassification,
    ToolName,
} from '../../src/types/index.js';
import { createTestDb, seedMemory, seedProject, seedSession, type TestDatabase } from '../helpers/db.js';

const OUTSIDE_PROMPT = 'Add a health check endpoint to the API';
const OUTSIDE_CUSTOM_TITLE = 'Outside custom title';
const STARTED_AT = '2026-08-01T10:00:00.000Z';
const CLAUDE_TRANSCRIPT =
    `{"type":"user","uuid":"u1","timestamp":"2026-08-01T10:00:02.000Z","entrypoint":"cli","cwd":"/tmp/proj","sessionId":"outside-session","message":{"role":"user","content":${JSON.stringify(OUTSIDE_PROMPT)}}}\n` +
    '{"type":"assistant","parentUuid":"u1","uuid":"a1","timestamp":"2026-08-01T10:00:03.000Z","cwd":"/tmp/proj","sessionId":"outside-session","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n' +
    `{"type":"custom-title","customTitle":${JSON.stringify(OUTSIDE_CUSTOM_TITLE)}}\n`;
const CODEX_TRANSCRIPT =
    '{"timestamp":"2026-08-01T10:00:00.000Z","type":"session_meta","payload":{"id":"outside-session","cwd":"/tmp/proj","originator":"codex-tui","source":"cli"}}\n' +
    '{"timestamp":"2026-08-01T10:00:01.000Z","type":"turn_context","payload":{"turn_id":"external-import-turn-1","cwd":"/tmp/proj"}}\n' +
    `{"timestamp":"2026-08-01T10:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":${JSON.stringify(OUTSIDE_PROMPT)}}}\n` +
    '{"timestamp":"2026-08-01T10:00:03.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}\n';

const mocks = vi.hoisted(() => ({
    provider: {
        rollup: vi.fn(),
        merge: vi.fn(),
    },
}));

vi.mock('../../src/summarizer/provider-config.js', () => ({
    createConfiguredSynthesisProviders: () => ({ rollupMerge: mocks.provider }),
}));

function successfulRollup() {
    return {
        status: 'ok' as const,
        output: {
            title: OUTSIDE_PROMPT,
            summary: OUTSIDE_PROMPT,
            decisions: [],
            pending_items: [],
            droppedDecisions: 0,
        },
    };
}

class DerivedDataAdapter implements SessionAdapter {
    readonly watchGlobs = ['*.jsonl'];
    readonly classifySession = vi.fn(async (): Promise<SessionClassification> => ({ kind: 'subagent' }));
    readonly readCustomTitle = vi.fn(async () => ({ customTitle: OUTSIDE_CUSTOM_TITLE, scannedTo: 1 }));
    readonly parseTurns = vi.fn(
        (_filePath: string, _sinceCursor?: string, _options?: ParseTurnsOptions): AsyncIterable<ParsedTurn> => this.turns(),
    );

    constructor(
        readonly tool: ToolName,
        private readonly sourcePath: string,
    ) {}

    matches(): boolean {
        return true;
    }

    nativeSessionId(): string {
        return 'outside-session';
    }

    async classifyEmptySession(): Promise<EmptySessionAnalysis | undefined> {
        return undefined;
    }

    private async *turns(): AsyncIterable<ParsedTurn> {
        yield {
            tool: this.tool,
            sessionId: 'outside-session',
            sourcePath: this.sourcePath,
            projectPath: '/tmp/proj',
            turnIndex: 0,
            startedAt: STARTED_AT,
            endedAt: '2026-08-01T10:00:03.000Z',
            userMessage: OUTSIDE_PROMPT,
            assistantText: 'done',
            toolCalls: [],
            cursor: '0|1',
            hasExternalContent: true,
            resumeMarkerBefore: false,
            surface: 'cli',
            gitBranch: 'outside-branch',
        };
    }
}

interface SeededOutsideSource {
    fixture: TestDatabase;
    sourcePath: string;
    adapter: DerivedDataAdapter;
    adapters: Record<ToolName, SessionAdapter>;
    sessionId: number;
}

function seedOutsideSource(tool: ToolName = 'claude-code'): SeededOutsideSource {
    const fixture = createTestDb('elepha-provider-source-boundary-');
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(fixture.directory, 'claude-home'));
    vi.stubEnv('CODEX_HOME', path.join(fixture.directory, 'codex-home'));
    vi.stubEnv('ELEPHA_HOME', path.join(fixture.directory, 'elepha-home'));
    vi.stubEnv('ELEPHA_DB_PATH', fixture.dbPath);
    const sourcePath = path.join(fixture.directory, 'outside.jsonl');
    writeFileSync(sourcePath, tool === 'codex' ? CODEX_TRANSCRIPT : CLAUDE_TRANSCRIPT);
    expect(existsSync(sourcePath)).toBe(true);
    for (const line of readFileSync(sourcePath, 'utf8').trim().split('\n')) {
        expect(() => JSON.parse(line)).not.toThrow();
    }

    const project = seedProject(fixture, { path: '/tmp/proj' });
    const session = seedSession(fixture, {
        project,
        tool,
        nativeId: 'outside-session',
        sourcePath,
        title: 'Existing title',
        startedAt: STARTED_AT,
        lastIngestedAt: STARTED_AT,
    });
    seedMemory(fixture, {
        project,
        session,
        startedAt: STARTED_AT,
        userMessage: 'Stored prompt',
        hasExternalContent: false,
        renderedChars: 0,
        renderedTurns: 0,
    });
    fixture.db.prepare('UPDATE sessions SET first_prompt_search = NULL WHERE id = ?').run(session.id);
    const adapter = new DerivedDataAdapter(tool, sourcePath);
    const otherTool: ToolName = tool === 'codex' ? 'claude-code' : 'codex';
    const otherAdapter = new DerivedDataAdapter(otherTool, sourcePath);
    const adapters: Record<ToolName, SessionAdapter> =
        tool === 'codex' ? { 'claude-code': otherAdapter, codex: adapter } : { 'claude-code': adapter, codex: otherAdapter };
    return { fixture, sourcePath, adapter, adapters, sessionId: session.id };
}

async function runCommand(register: (program: Command) => void, args: string[]): Promise<string> {
    const output: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...values) => output.push(values.map(String).join(' ')));
    const warn = vi.spyOn(console, 'warn').mockImplementation((...values) => output.push(values.map(String).join(' ')));
    const error = vi.spyOn(console, 'error').mockImplementation((...values) => output.push(values.map(String).join(' ')));
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
        const program = new Command();
        register(program);
        await program.parseAsync(['node', 'elepha', ...args]);
        return output.join('\n');
    } finally {
        process.exitCode = previousExitCode;
        log.mockRestore();
        warn.mockRestore();
        error.mockRestore();
    }
}

const ENTRY_POINTS: Array<{ name: string; run: () => Promise<void> }> = [
    {
        name: 'backfill-session-titles',
        async run() {
            const { fixture, sessionId } = seedOutsideSource();

            const preview = await runCommand(registerBackfills, ['backfill-session-titles']);
            const applied = await runCommand(registerBackfills, ['backfill-session-titles', '--apply']);

            expect(preview).not.toContain(OUTSIDE_PROMPT);
            expect(applied).not.toContain(OUTSIDE_PROMPT);
            expect(fixture.db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId)).toEqual({ title: 'Existing title' });
        },
    },
    {
        name: 'custom-title-backfill',
        async run() {
            const { fixture, adapter, adapters, sessionId } = seedOutsideSource();

            const plan = await planCustomTitleBackfill(fixture.db, adapters);
            await applyCustomTitleBackfill(fixture.db, adapters);

            expect(plan.changes).toEqual([expect.objectContaining({ transcriptMissing: true, after: null })]);
            expect(adapter.readCustomTitle).not.toHaveBeenCalled();
            expect(fixture.db.prepare('SELECT custom_title FROM sessions WHERE id = ?').get(sessionId)).toEqual({ custom_title: null });
        },
    },
    {
        name: 'rendered-chars-backfill',
        async run() {
            const { fixture, adapter, adapters, sessionId } = seedOutsideSource();

            const plan = await planRenderedCharsBackfill(fixture.db, adapters);
            await applyRenderedCharsBackfill(fixture.db, adapters);

            expect(plan.changes).toEqual([expect.objectContaining({ transcriptMissing: true, renderedChars: null })]);
            expect(adapter.parseTurns).not.toHaveBeenCalled();
            expect(fixture.db.prepare('SELECT rendered_chars, rendered_turns FROM sessions WHERE id = ?').get(sessionId)).toEqual({
                rendered_chars: null,
                rendered_turns: null,
            });
        },
    },
    {
        name: 'session-fields-backfill',
        async run() {
            const { fixture, adapter, adapters, sessionId } = seedOutsideSource();

            const plan = await planSessionFieldsBackfill(fixture.db, adapters);
            await applySessionFieldsBackfill(fixture.db, adapters);

            expect(plan.changes).toEqual([expect.objectContaining({ transcriptMissing: true })]);
            expect(adapter.classifySession).not.toHaveBeenCalled();
            expect(adapter.parseTurns).not.toHaveBeenCalled();
            expect(fixture.db.prepare('SELECT surface, git_branch, kind FROM sessions WHERE id = ?').get(sessionId)).toEqual({
                surface: null,
                git_branch: null,
                kind: null,
            });
            expect(fixture.db.prepare('SELECT has_external_content FROM memories WHERE session_id = ?').get(sessionId)).toEqual({
                has_external_content: 0,
            });
        },
    },
    {
        name: 'rollup command',
        async run() {
            const { fixture, sessionId } = seedOutsideSource('codex');

            await runCommand(registerRollup, ['rollup', '--all']);

            expect(mocks.provider.rollup).not.toHaveBeenCalled();
            expect(mocks.provider.merge).not.toHaveBeenCalled();
            expect(fixture.db.prepare('SELECT title FROM session_rollups WHERE session_id = ?').get(sessionId)).toBeUndefined();
        },
    },
    {
        name: 'external-agent-import-purge',
        async run() {
            const { fixture, adapter, sourcePath } = seedOutsideSource('codex');

            const plan = await planExternalAgentImportPurge(fixture.db, adapter);

            expect(adapter.classifySession).not.toHaveBeenCalled();
            expect(plan.importedSourcePaths).toEqual([]);
            expect(plan.sessions).toEqual([]);
            expect(plan.issues).toEqual([{ sourcePath, reason: 'source transcript is missing' }]);
        },
    },
    {
        name: 'daemon idle rollup sweep',
        async run() {
            const { fixture, adapter } = seedOutsideSource('codex');
            const rollupService = new RollupService({
                store: fixture.store,
                rollups: new RollupStore(fixture.db),
                provider: mocks.provider,
                idleCloseMs: 0,
            });
            const daemon = new IngestionDaemon({ store: fixture.store, adapters: [adapter], rollupService });

            const closed = await daemon.sweepIdleSessions(Date.now());

            expect(closed).toBe(0);
            expect(adapter.classifySession).not.toHaveBeenCalled();
            expect(mocks.provider.rollup).not.toHaveBeenCalled();
            expect(mocks.provider.merge).not.toHaveBeenCalled();
        },
    },
    {
        name: 'first-prompt-search-backfill',
        async run() {
            const { fixture, adapter, adapters, sessionId } = seedOutsideSource();

            const plan = await planFirstPromptSearchBackfill(fixture.db, adapters);
            await applyFirstPromptSearchBackfill(fixture.db, adapters);

            expect(plan.changes).toEqual([expect.objectContaining({ transcriptMissing: true, after: null })]);
            expect(adapter.parseTurns).not.toHaveBeenCalled();
            expect(fixture.db.prepare('SELECT first_prompt_search FROM sessions WHERE id = ?').get(sessionId)).toEqual({
                first_prompt_search: null,
            });
        },
    },
];

describe('database-supplied provider source read boundaries', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        mocks.provider.rollup.mockReset().mockResolvedValue(successfulRollup());
        mocks.provider.merge.mockReset().mockResolvedValue(successfulRollup());
    });

    it.each(ENTRY_POINTS)('$name rejects a readable transcript outside its provider store', async ({ run }) => {
        await run();
    });
});
