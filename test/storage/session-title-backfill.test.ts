import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { applyCustomTitleBackfill, planCustomTitleBackfill } from '../../src/storage/custom-title-backfill.js';
import { openDb } from '../../src/storage/db.js';
import { UNTITLED_EPISODE } from '../../src/storage/session-title.js';
import { applySessionTitleBackfill, planSessionTitleBackfill } from '../../src/storage/session-title-backfill.js';
import type { ParsedTurn, ParseTurnsOptions, SessionAdapter, ToolName } from '../../src/types/index.js';

const SOURCE = path.join(__dirname, '..', 'fixtures', 'claude-code', 'sample-session.jsonl');
const CUSTOM_TITLE = path.join(__dirname, '..', 'fixtures', 'claude-code', 'claude-v2.1.229-custom-title.jsonl');
const FRAME_LINK = path.join(__dirname, '..', 'fixtures', 'claude-code', 'claude-v2.1.232-frame-link.jsonl');

class TitleFixtureAdapter implements SessionAdapter {
    readonly tool: ToolName = 'claude-code';
    readonly watchGlobs = ['*.jsonl'];

    matches(): boolean {
        return true;
    }

    async classifySession() {
        return { kind: 'primary' as const };
    }

    async classifyEmptySession() {
        return undefined;
    }

    nativeSessionId(): string {
        return 'title-backfill';
    }

    async *parseTurns(_filePath: string, _sinceCursor?: string, _options?: ParseTurnsOptions): AsyncIterable<ParsedTurn> {
        yield turn(0, 'Initial CSP request', 'Review CSP headers for iframe components');
        yield turn(
            1,
            '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
            'Review CSP headers for iframe components',
        );
        yield turn(2, 'This session is being continued from a previous conversation that ran out of context. Summary: prior work.');
        yield turn(3, 'Replace the iframe sandbox directive with the reviewed policy');
        yield turn(4, 'elepha:list', 'Elepha list');
        yield turn(5, '<command-name>/compact</command-name>\n<command-message>compact</command-message>', 'Compact conversation');
        yield turn(6, 'elepha:list');
        yield turn(7, 'Implement filtered recent sessions', 'Filtered recent sessions');
        yield turn(
            8,
            '**Executor:** Codex CLI · gpt-5.6-terra · effort high · **new chat**\n\n## Objective\nRepair title derivation for the first repeated routing header.',
        );
        yield turn(
            9,
            '**Executor:** Codex CLI · gpt-5.6-terra · effort high · **new chat**\n\n## Objective\nRepair title derivation for the second repeated routing header.',
        );
    }
}

class CodexFixtureAdapter extends TitleFixtureAdapter {
    override readonly tool: ToolName = 'codex';

    override nativeSessionId(): string {
        return 'codex-title-backfill';
    }

    override async *parseTurns(_filePath: string, _sinceCursor?: string, _options?: ParseTurnsOptions): AsyncIterable<ParsedTurn> {
        yield { ...turn(0, 'Inspect the remaining static-analysis errors'), tool: 'codex', sessionId: 'codex-title-backfill' };
    }
}

function turn(index: number, userMessage: string, aiTitle?: string): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: 'title-backfill',
        sourcePath: SOURCE,
        projectPath: '/repo',
        turnIndex: index,
        startedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
        endedAt: `2026-08-0${index + 1}T00:01:00.000Z`,
        userMessage,
        assistantText: 'Done.',
        toolCalls: [],
        cursor: `${index}|${index + 1}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
        aiTitle,
    };
}

describe('session-title backfill', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('writes titles only for segments with substantive prompts and uses Codex first messages', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-session-title-backfill-'));
        const claudeConfigDir = path.join(root, 'claude-home');
        const claudeProjects = path.join(claudeConfigDir, 'projects');
        const codexHome = path.join(root, 'codex-home');
        const codexSessions = path.join(codexHome, 'sessions');
        mkdirSync(claudeProjects, { recursive: true });
        mkdirSync(codexSessions, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        vi.stubEnv('CODEX_HOME', codexHome);
        const claudeSource = path.join(claudeProjects, 'sample-session.jsonl');
        const codexSource = path.join(codexSessions, 'sample-session.jsonl');
        const customTitleSource = path.join(claudeProjects, 'custom-title.jsonl');
        const frameLinkSource = path.join(claudeProjects, 'frame-link.jsonl');
        writeFileSync(claudeSource, '{}\n');
        writeFileSync(codexSource, '{}\n');
        copyFileSync(CUSTOM_TITLE, customTitleSource);
        copyFileSync(FRAME_LINK, frameLinkSource);

        const db = openDb(':memory:');
        db.prepare(
            `INSERT INTO projects (id, path, first_seen_at, last_seen_at)
             VALUES (1, '/repo', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
            `INSERT INTO sessions (id, tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at)
             VALUES (1, 'claude-code', 'title-backfill', 0, 1, ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z'),
                    (2, 'claude-code', 'title-backfill', 1, 1, ?, '2026-08-02T00:00:00.000Z', '2026-08-02T00:01:00.000Z'),
                    (3, 'codex', 'codex-title-backfill', 0, 1, ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z'),
                    (4, 'claude-code', 'title-backfill', 2, 1, ?, '2026-08-03T00:00:00.000Z', '2026-08-03T00:01:00.000Z'),
                    (5, 'claude-code', 'command-only-title-backfill', 0, 1, ?, '2026-08-04T00:00:00.000Z', '2026-08-04T00:01:00.000Z'),
                    (6, 'claude-code', 'command-then-work-title-backfill', 0, 1, ?, '2026-08-05T00:00:00.000Z', '2026-08-05T00:01:00.000Z'),
                    (7, 'claude-code', 'first-repeated-header', 0, 1, ?, '2026-08-06T00:00:00.000Z', '2026-08-06T00:01:00.000Z'),
                    (8, 'claude-code', 'second-repeated-header', 0, 1, ?, '2026-08-07T00:00:00.000Z', '2026-08-07T00:01:00.000Z')`,
        ).run(claudeSource, claudeSource, codexSource, claudeSource, claudeSource, claudeSource, claudeSource, claudeSource);
        const insertMemory = db.prepare(
            `INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
             VALUES (1, ?, ?, ?, '2026-08-01T00:00:00.000Z', '[]', '[]', '[]', '2026-08-01T00:00:00.000Z')`,
        );
        insertMemory.run(1, 0, 'claude-code');
        insertMemory.run(2, 1, 'claude-code');
        insertMemory.run(2, 2, 'claude-code');
        insertMemory.run(2, 3, 'claude-code');
        insertMemory.run(3, 0, 'codex');
        insertMemory.run(5, 4, 'claude-code');
        insertMemory.run(5, 5, 'claude-code');
        insertMemory.run(6, 6, 'claude-code');
        insertMemory.run(6, 7, 'claude-code');
        insertMemory.run(7, 8, 'claude-code');
        insertMemory.run(8, 9, 'claude-code');

        const adapters: Record<ToolName, SessionAdapter> = {
            'claude-code': new TitleFixtureAdapter(),
            codex: new CodexFixtureAdapter(),
        };

        const preview = await planSessionTitleBackfill(db, adapters);
        expect(preview.changes.map((change) => [change.sessionId, change.after])).toEqual([
            [1, 'Review CSP headers for iframe components'],
            [2, 'Replace the iframe sandbox directive with the reviewed policy'],
            [3, 'Inspect the remaining static-analysis errors'],
            [4, UNTITLED_EPISODE],
            [5, UNTITLED_EPISODE],
            [6, 'Filtered recent sessions'],
            [7, 'Repair title derivation for the first repeated routing header.'],
            [8, 'Repair title derivation for the second repeated routing header.'],
        ]);

        await applySessionTitleBackfill(db, adapters);
        expect(db.prepare('SELECT id, title FROM sessions ORDER BY id').all()).toEqual([
            { id: 1, title: 'Review CSP headers for iframe components' },
            { id: 2, title: 'Replace the iframe sandbox directive with the reviewed policy' },
            { id: 3, title: 'Inspect the remaining static-analysis errors' },
            { id: 4, title: UNTITLED_EPISODE },
            { id: 5, title: UNTITLED_EPISODE },
            { id: 6, title: 'Filtered recent sessions' },
            { id: 7, title: 'Repair title derivation for the first repeated routing header.' },
            { id: 8, title: 'Repair title derivation for the second repeated routing header.' },
        ]);
        expect((await planSessionTitleBackfill(db, adapters)).changes).toHaveLength(0);
        db.close();

        const customDb = openDb(':memory:');
        customDb
            .prepare(
                `INSERT INTO projects (id, path, first_seen_at, last_seen_at) VALUES (1, '/tmp/proj', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
            )
            .run();
        customDb
            .prepare(
                `INSERT INTO sessions (id, tool, native_id, project_id, source_path, started_at, last_ingested_at, rendered_chars)
                 VALUES (1, 'claude-code', 'custom-title-sample', 1, ?, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z', 123),
                        (2, 'claude-code', 'frame-link-sample', 1, ?, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z', 456)`,
            )
            .run(customTitleSource, frameLinkSource);
        const beforeRendered = customDb.prepare('SELECT id, rendered_chars FROM sessions ORDER BY id').all();
        const customTitleAdapters: Record<ToolName, SessionAdapter> = {
            'claude-code': new ClaudeCodeAdapter(),
            codex: new CodexAdapter(),
        };

        const customPreview = await planCustomTitleBackfill(customDb, customTitleAdapters);
        expect(customPreview.changes).toEqual([
            expect.objectContaining({ sessionId: 1, before: null, after: 'Latest project changelog', transcriptMissing: false }),
        ]);

        await applyCustomTitleBackfill(customDb, customTitleAdapters);
        expect(customDb.prepare('SELECT custom_title FROM sessions WHERE id = 1').get()).toEqual({
            custom_title: 'Latest project changelog',
        });
        expect(customDb.prepare('SELECT custom_title FROM sessions WHERE id = 2').get()).toEqual({ custom_title: null });
        expect(customDb.prepare('SELECT id, rendered_chars FROM sessions ORDER BY id').all()).toEqual(beforeRendered);
        expect((await planCustomTitleBackfill(customDb, customTitleAdapters)).changes).toHaveLength(0);
        customDb.close();
    });
});
