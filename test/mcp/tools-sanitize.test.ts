import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpResponseShaper } from '../../src/mcp/server.js';
import { ElephaMcpService } from '../../src/mcp/tools.js';
import { detectShellSyntax, escapeShellSyntax } from '../../src/security/sanitize.js';
import { openDb } from '../../src/storage/db.js';
import type { ParsedTurn, SessionAdapter, ToolName } from '../../src/types/index.js';

class FixtureAdapter implements SessionAdapter {
    readonly tool: ToolName = 'codex';
    readonly watchGlobs = ['*.jsonl'];

    matches(): boolean {
        return true;
    }

    async classifySession(): Promise<{ kind: 'primary' }> {
        return { kind: 'primary' };
    }

    async classifyEmptySession() {
        return undefined;
    }

    nativeSessionId(filePath: string): string {
        return path.basename(filePath, '.jsonl');
    }

    async *parseTurns(): AsyncIterable<ParsedTurn> {
        yield {
            tool: 'codex',
            sessionId: 'dirty-session',
            sourcePath: '',
            projectPath: '',
            turnIndex: 0,
            startedAt: '2026-08-24T00:00:00.000Z',
            endedAt: '2026-08-24T00:01:00.000Z',
            userMessage: 'inspect the file',
            assistantText: 'done',
            toolCalls: [{ name: 'read_file', filePaths: ['src/example.ts'] }],
            cursor: '0|1',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        };
    }
}

function text(response: { content: [{ type: 'text'; text: string }] }): string {
    return response.content[0].text;
}

function leafStrings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(leafStrings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(leafStrings);
    return [];
}

describe('MCP response shell-syntax net', () => {
    const databases: ReturnType<typeof openDb>[] = [];
    let previousCodexHome: string | undefined;

    afterEach(() => {
        databases.splice(0).forEach((db) => {
            db.close();
        });
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
    });

    it('neutralizes unsafe project display fields in text and structured list_projects output', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-mcp-project-sanitize-'));
        const projectPath = path.join(root, '$(project)');
        mkdirSync(projectPath);
        const db = openDb(':memory:');
        databases.push(db);
        db.prepare(
            `INSERT INTO projects (path, display_name, first_seen_at, last_seen_at)
             VALUES (?, ?, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')`,
        ).run(projectPath, 'project`$(evil)\x1b[31m\x07');
        db.prepare(`INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES ('root', ?, 'approved', 'x', 'cli')`).run(
            realpathSync(projectPath),
        );

        const response = new ElephaMcpService(db, mcpResponseShaper).listProjects();
        expect(detectShellSyntax(text(response))).toBe(false);
        const projects = response.structuredContent?.projects as Array<{ name: string; paths: string[] }> | undefined;
        const project = projects?.[0];
        if (project === undefined) throw new Error('list_projects returned no project');
        expect(detectShellSyntax(project.name)).toBe(false);
        expect(project.paths.every((storedPath) => !detectShellSyntax(storedPath))).toBe(true);
    });

    it('recursively neutralizes every structured string while preserving normal and non-string values', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-mcp-structured-sanitize-'));
        const projectPath = path.join(root, 'project');
        mkdirSync(projectPath);
        const gitRemote = 'ssh://git@example.test/$(repo).git\x1b[31m';
        const gitBranch = 'feature/`whoami`';
        const startedAt = '2026-08-24T00:00:00.000Z\x1b[32m';
        const endedAt = '2026-08-24T00:01:00.000Z\x07';
        const db = openDb(':memory:');
        databases.push(db);
        const projectId = Number(
            db
                .prepare(
                    `INSERT INTO projects (path, display_name, git_remote, first_seen_at, last_seen_at)
                     VALUES (?, 'normal project', ?, '2026-08-24T00:00:00.000Z', '2026-08-24T00:01:00.000Z')`,
                )
                .run(projectPath, gitRemote).lastInsertRowid,
        );
        db.prepare(
            `INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at, surface, git_branch, rendered_chars, rendered_turns, title)
             VALUES ('codex', 'structured-session', 0, ?, ?, ?, ?, 'cli', ?, 400, 2, 'normal title')`,
        ).run(projectId, path.join(root, 'structured-session.jsonl'), startedAt, endedAt, gitBranch);
        db.prepare(`INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES ('root', ?, 'approved', 'x', 'cli')`).run(
            realpathSync(projectPath),
        );

        const response = new ElephaMcpService(db, mcpResponseShaper).listSessions({ project: projectPath, include_all: true });
        const structured = response.structuredContent;
        if (structured === undefined) throw new Error('list_sessions returned no structured content');

        expect(leafStrings(structured).every((value) => !detectShellSyntax(value))).toBe(true);
        expect(structured).toEqual({
            project: {
                name: 'normal project',
                key: escapeShellSyntax(gitRemote),
                paths: [projectPath],
                git_remote: escapeShellSyntax(gitRemote),
            },
            sessions: [
                {
                    id: expect.any(String),
                    title: 'normal title',
                    started_at: escapeShellSyntax(startedAt),
                    ended_at: escapeShellSyntax(endedAt),
                    tool: 'codex',
                    surface: 'Codex CLI',
                    git_branch: escapeShellSyntax(gitBranch),
                    turn_count: 0,
                    token_estimate: 100,
                    decision_count: null,
                    pending_count: null,
                    substantive: false,
                },
            ],
            has_more: false,
        });
    });

    it('repairs an imported-style stored title at each plain response boundary without inspecting rendered Markdown', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-mcp-title-sanitize-'));
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = root;
        const projectPath = path.join(root, 'project');
        const sourcePath = path.join(root, 'sessions', 'dirty-session.jsonl');
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        mkdirSync(projectPath);
        writeFileSync(sourcePath, '{}\n');
        const db = openDb(':memory:');
        databases.push(db);
        const projectId = Number(
            db
                .prepare(
                    `INSERT INTO projects (path, display_name, first_seen_at, last_seen_at)
                     VALUES (?, 'project', '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')`,
                )
                .run(projectPath).lastInsertRowid,
        );
        const sessionId = Number(
            db
                .prepare(
                    `INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at, title, rendered_chars, rendered_turns)
                     VALUES ('codex', 'dirty-session', 0, ?, ?, '2026-08-24T00:00:00.000Z', '2026-08-24T00:01:00.000Z', ?, 100, 1)`,
                )
                .run(projectId, sourcePath, 'resume `$(evil)\x1b[31m\x07').lastInsertRowid,
        );
        db.prepare(
            `INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at, summarizer_status)
             VALUES (?, ?, 0, 'codex', '2026-08-24T00:00:00.000Z', ?, '[]', ?, '2026-08-24T00:01:00.000Z', 'ok')`,
        ).run(projectId, sessionId, JSON.stringify([{ what: 'decision `$(evil)', why: null }]), JSON.stringify(['pending `$(evil)']));
        db.prepare(`INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES ('root', ?, 'approved', 'x', 'cli')`).run(
            realpathSync(projectPath),
        );
        const adapters: Record<ToolName, SessionAdapter> = {
            codex: new FixtureAdapter(),
            'claude-code': new FixtureAdapter(),
        };
        const service = new ElephaMcpService(db, mcpResponseShaper, adapters);
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const listed = service.listSessions({ project: projectPath, include_all: true });
            expect(detectShellSyntax(text(listed))).toBe(false);
            expect(log).toHaveBeenCalledWith(expect.stringContaining('mcp:list-sessions'));
            const sessions = listed.structuredContent?.sessions as Array<{ id: string; title: string }> | undefined;
            const listedSession = sessions?.[0];
            if (listedSession === undefined) throw new Error('list_sessions returned no public id');
            expect(detectShellSyntax(listedSession.title)).toBe(false);

            const served = await service.getSession({ id: listedSession.id });
            expect(text(served)).toContain('- `read_file`');
            expect(log).toHaveBeenCalledWith(expect.stringContaining('mcp:get-session-title'));

            const callsAfterRepair = log.mock.calls.length;
            db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('clean title', sessionId);
            const normal = await service.getSession({ id: listedSession.id });
            expect(text(normal)).toContain('- `read_file`');
            expect(log).toHaveBeenCalledTimes(callsAfterRepair);
        } finally {
            log.mockRestore();
        }
    });
});
