import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';

const FIXTURE_PATH = path.resolve('test/fixtures/codex/rollout-2026-07-22T15-29-54-019f88f2-145b-7853-8390-75dac88737d6.jsonl');
const PROJECT_PATH = '/Users/test/demo-project';
const NATIVE_ID = '019f88f2-145b-7853-8390-75dac88737d6';

function publicSessionId(): string {
    return Buffer.from(JSON.stringify({ tool: 'codex', nativeId: NATIVE_ID, segmentIndex: 0 })).toString('base64url');
}

function firstTextBlock(response: unknown): { type: 'text'; text: string } | undefined {
    if (typeof response !== 'object' || response === null) {
        return undefined;
    }
    const content = (response as { content?: unknown }).content;
    if (!Array.isArray(content)) {
        return undefined;
    }
    const [block] = content;
    if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
    ) {
        return block;
    }
    return undefined;
}

function text(response: unknown): string {
    return firstTextBlock(response)?.text ?? '';
}

function claudeCodeModelVisibleText(response: unknown): string {
    if (typeof response === 'object' && response !== null && 'structuredContent' in response) {
        return JSON.stringify((response as { structuredContent: unknown }).structuredContent);
    }
    return text(response);
}

describe('elepha MCP stdio transport', () => {
    const databases: Array<ReturnType<typeof openDb>> = [];
    const clients: Client[] = [];

    beforeAll(() => {
        // This test starts the released bin entrypoint, which imports dist/.
        // Rebuild first so a source-only content-envelope regression cannot
        // pass against an old local artifact.
        execFileSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
            cwd: process.cwd(),
            stdio: 'pipe',
        });
    });

    afterEach(async () => {
        await Promise.all(clients.splice(0).map((client) => client.close()));
        databases.splice(0).forEach((db) => {
            db.close();
        });
    });

    it('serializes a rendered get_session episode as a text content block', async () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-mcp-stdio-home-'));
        const sourcePath = path.join(home, '.codex', 'sessions', 'fixture.jsonl');
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        copyFileSync(FIXTURE_PATH, sourcePath);
        const db = openDb(path.join(home, '.elepha', 'elepha.db'));
        databases.push(db);
        const projectId = Number(
            db
                .prepare(
                    `INSERT INTO projects (path, display_name, first_seen_at, last_seen_at)
                     VALUES (?, 'Fixture project', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
                )
                .run(PROJECT_PATH).lastInsertRowid,
        );
        const sessionId = Number(
            db
                .prepare(
                    `INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at, rendered_chars, rendered_turns)
                     VALUES ('codex', ?, 0, ?, ?, '2026-07-22T15:29:54.000Z', '2026-07-22T15:30:00.000Z', 1, 1)`,
                )
                .run(NATIVE_ID, projectId, sourcePath).lastInsertRowid,
        );
        db.prepare(
            `INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at, summarizer_status)
             VALUES (?, ?, 0, 'codex', '2026-07-22T15:29:54.000Z', '[]', '[]', '[]', '2026-07-22T15:30:00.000Z', 'not_configured')`,
        ).run(projectId, sessionId);
        db.prepare(
            `INSERT INTO consent_roots (ulid, path, state, decided_at, source)
             VALUES ('fixture-root', ?, 'approved', '2026-08-17T00:00:00.000Z', 'cli')`,
        ).run(PROJECT_PATH);
        db.close();
        databases.pop();

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [path.resolve('bin/elepha.js'), 'mcp', 'serve'],
            cwd: process.cwd(),
            env: { HOME: home, ELEPHA_ENV_FILE: path.join(home, 'missing.env') },
            stderr: 'pipe',
        });
        // Captured from Claude Code 2.1.233: protocol 2025-11-25 with
        // { roots: { listChanged: true }, elicitation: {} }. Claude Code gives
        // structuredContent precedence over content in the model-visible result,
        // so get_session must omit structuredContent to preserve rendered turns.
        const client = new Client(
            { name: 'claude-code', version: '2.1.233' },
            { capabilities: { roots: { listChanged: true }, elicitation: {} } },
        );
        clients.push(client);
        await client.connect(transport);

        const response = await client.callTool({ name: 'get_session', arguments: { id: publicSessionId() } });

        expect(firstTextBlock(response)).toMatchObject({ type: 'text' });
        expect(response).not.toHaveProperty('structuredContent');
        expect(text(response)).toContain('Check the locale files against English and fix any drift');
        expect(text(response)).toContain('Fixed drift in the ES and DE locale files to match the English source.');
        expect(text(response)).toContain('/Users/test/demo-project/extension/src/storage/system-prompts/en.js');
        expect(claudeCodeModelVisibleText(response)).toContain('Check the locale files against English and fix any drift');
    });
});
