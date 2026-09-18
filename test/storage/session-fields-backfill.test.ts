import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { INJECTION_QUOTE_BACK_MAX_ROWS } from '../../src/config/constants.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { InjectionQuoteBackIncompleteError } from '../../src/storage/injection-store.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { applySessionFieldsBackfill, planSessionFieldsBackfill } from '../../src/storage/session-fields-backfill.js';
import type { ParsedTurn, SessionAdapter, SessionAdapterMap } from '../../src/types/index.js';
import { withTempDir } from '../helpers/tmp.js';

const FIXTURE = `{"type":"attachment","uuid":"u0","timestamp":"2026-08-01T10:00:01.000Z","entrypoint":"cli","cwd":"/tmp/proj","sessionId":"sess-1","gitBranch":"main"}
{"type":"user","parentUuid":"u0","message":{"role":"user","content":"hello"},"uuid":"u1","timestamp":"2026-08-01T10:00:02.000Z","entrypoint":"cli","cwd":"/tmp/proj","sessionId":"sess-1","gitBranch":"main"}
{"type":"assistant","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"uuid":"a1","timestamp":"2026-08-01T10:00:03.000Z","sessionId":"sess-1","cwd":"/tmp/proj"}
`;

// Codex-shaped fixture - session_meta carries originator + git.branch (only
// on that one line and session-constant), a
// turn_context, a user response_item + matching user_message event_msg
// (the boundary), and an assistant response_item (the close). Modeled on
// the real minimal with-git fixture at
// test/fixtures/codex/rollout-2026-08-10-019fa000-0000-7000-8000-000000000001-with-git.jsonl
// rather than invented from scratch.
const CODEX_FIXTURE = `{"timestamp":"2026-08-10T09:00:00.000Z","type":"session_meta","payload":{"session_id":"codex-sess-1","id":"codex-sess-1","cwd":"/tmp/proj","originator":"codex-tui","cli_version":"0.147.0","source":"cli","git":{"commit_hash":"deadbeef0000000000000000000000000000000","branch":"feature/codex-coverage","repository_url":null}}}
{"timestamp":"2026-08-10T09:00:01.000Z","type":"turn_context","payload":{"turn_id":"turn-1","cwd":"/tmp/proj","workspace_roots":["/tmp/proj"]}}
{"timestamp":"2026-08-10T09:00:01.500Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello from codex"}],"internal_chat_message_metadata_passthrough":{"turn_id":"turn-1"}}}
{"timestamp":"2026-08-10T09:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"hello from codex","images":[],"local_images":[],"text_elements":[]}}
{"timestamp":"2026-08-10T09:00:02.500Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi from codex"}]}}
`;

describe('session-fields-backfill', () => {
    let dir: string;
    let claudeProjects: string;
    let codexSessions: string;
    let filePath: string;
    const adapters: SessionAdapterMap = { 'claude-code': new ClaudeCodeAdapter(), codex: new CodexAdapter() };

    beforeEach(() => {
        dir = withTempDir('elepha-backfill-');
        const claudeConfigDir = path.join(dir, 'claude-home');
        claudeProjects = path.join(claudeConfigDir, 'projects');
        const codexHome = path.join(dir, 'codex-home');
        codexSessions = path.join(codexHome, 'sessions');
        mkdirSync(claudeProjects, { recursive: true });
        mkdirSync(codexSessions, { recursive: true });
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        vi.stubEnv('CODEX_HOME', codexHome);
        filePath = path.join(claudeProjects, 'sess-1.jsonl');
        writeFileSync(filePath, FIXTURE);
    });

    afterEach(() => vi.unstubAllEnvs());

    function seedSession(db: ReturnType<typeof openUnmanagedDb>, sourcePath: string, nativeId = 'sess-1') {
        const store = new MemoryStore(db);
        const project = store.upsertProject('/tmp/proj');
        const session = store.upsertSession('claude-code', nativeId, project.id, sourcePath);
        db.prepare(
            `INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
       VALUES (?, ?, 0, 'claude-code', '2026-08-01T10:00:02.000Z', '[]', '[]', '[]', '2026-08-01T10:00:02.000Z')`,
        ).run(project.id, session.id);
        return session;
    }

    it('dry run (plan) writes nothing', async () => {
        const db = openUnmanagedDb(':memory:');
        const session = seedSession(db, filePath);
        const plan = await planSessionFieldsBackfill(db, adapters);
        expect(plan.changes.length).toBeGreaterThan(0);
        const row = db.prepare('SELECT surface FROM sessions WHERE id = ?').get(session.id) as { surface: string | null };
        expect(row.surface).toBeNull(); // plan must not have written anything
        db.close();
    });

    it('apply is transactional and populates surface/git_branch/kind', async () => {
        const db = openUnmanagedDb(':memory:');
        const session = seedSession(db, filePath);
        const plan = await applySessionFieldsBackfill(db, adapters);
        expect(plan.changes.length).toBeGreaterThan(0);
        const row = db.prepare('SELECT surface, git_branch, kind FROM sessions WHERE id = ?').get(session.id) as {
            surface: string;
            git_branch: string;
            kind: string;
        };
        expect(row.surface).toBe('cli');
        expect(row.git_branch).toBe('main');
        expect(row.kind).toBe('main');
        db.close();
    });

    it('writes session fields and planned memory flags atomically without reparsing after commit', async () => {
        const db = openUnmanagedDb(':memory:');
        const session = seedSession(db, filePath);
        const turn: ParsedTurn = {
            tool: 'claude-code',
            sessionId: session.native_id,
            sourcePath: filePath,
            projectPath: '/tmp/proj',
            turnIndex: 0,
            startedAt: '2026-08-01T10:00:02.000Z',
            endedAt: '2026-08-01T10:00:03.000Z',
            userMessage: 'hello',
            assistantText: 'external answer',
            toolCalls: [],
            cursor: '0',
            hasExternalContent: true,
            resumeMarkerBefore: false,
            surface: 'cli',
            gitBranch: 'main',
        };
        const parseTurns = vi.fn(async function* () {
            yield turn;
        });
        const adapter: SessionAdapter = {
            tool: 'claude-code',
            watchGlobs: [],
            matches: () => true,
            nativeSessionId: () => session.native_id,
            classifySession: async () => ({ kind: 'primary' }),
            classifyEmptySession: async () => undefined,
            parseTurns,
        };
        db.exec(`
            CREATE TRIGGER fail_memory_flag_update
            BEFORE UPDATE OF has_external_content ON memories
            BEGIN
                SELECT RAISE(ABORT, 'forced memory flag failure');
            END;
        `);

        await expect(applySessionFieldsBackfill(db, { ...adapters, 'claude-code': adapter })).rejects.toThrow('forced memory flag failure');

        expect(parseTurns).toHaveBeenCalledTimes(1);
        expect(db.prepare('SELECT surface, git_branch, kind FROM sessions WHERE id = ?').get(session.id)).toEqual({
            surface: null,
            git_branch: null,
            kind: null,
        });
        expect(db.prepare('SELECT has_external_content FROM memories WHERE session_id = ?').get(session.id)).toEqual({
            has_external_content: 0,
        });
        db.close();
    });

    it('unavailable transcripts leave fields NULL without aborting the rest of the batch', async () => {
        const db = openUnmanagedDb(':memory:');
        const missingPath = path.join(claudeProjects, 'does-not-exist.jsonl');
        expect(existsSync(missingPath)).toBe(false);
        const missingSession = seedSession(db, missingPath, 'sess-missing');
        // existsSync(dir) is true - a directory is not "missing". fs.open()
        // on a directory throws EISDIR on every platform, which is what
        // actually exercises the uncaught-throw path inside
        // JsonlTurnAdapter.parseTurns (base.ts's `open(filePath, 'r')` isn't
        // wrapped in try/catch there) - unlike a permission-denied fixture,
        // this is deterministic and doesn't depend on how CI/sandboxes run.
        const unreadableSession = seedSession(db, claudeProjects, 'sess-unreadable');
        const goodSession = seedSession(db, filePath, 'sess-1');

        const plan = await applySessionFieldsBackfill(db, adapters);

        for (const unavailableSession of [missingSession, unreadableSession]) {
            const change = plan.changes.find((candidate) => candidate.sessionId === unavailableSession.id);
            expect(change?.transcriptMissing).toBe(true);
            const row = db.prepare('SELECT surface FROM sessions WHERE id = ?').get(unavailableSession.id) as {
                surface: string | null;
            };
            expect(row.surface).toBeNull();
        }

        // The batch must not have aborted: the other session in the same run
        // still gets processed and written normally.
        const goodChange = plan.changes.find((c) => c.sessionId === goodSession.id);
        expect(goodChange?.transcriptMissing).toBe(false);
        const goodRow = db.prepare('SELECT surface FROM sessions WHERE id = ?').get(goodSession.id) as { surface: string | null };
        expect(goodRow.surface).toBe('cli');

        db.close();
    });

    it('re-running apply is idempotent (no duplicate memory updates, same end state)', async () => {
        const db = openUnmanagedDb(':memory:');
        seedSession(db, filePath);
        const first = await applySessionFieldsBackfill(db, adapters);
        const second = await applySessionFieldsBackfill(db, adapters);
        expect(second.changes.length).toBe(0); // nothing left to change - values already match
        expect(first.changes.length).toBeGreaterThan(0);
        db.close();
    });

    it('derives surface/kind/git_branch for a Codex session from session_meta (originator + git.branch), not per-line fields', async () => {
        const db = openUnmanagedDb(':memory:');
        const codexFilePath = path.join(codexSessions, 'codex-sess-1.jsonl');
        writeFileSync(codexFilePath, CODEX_FIXTURE);

        const store = new MemoryStore(db);
        const project = store.upsertProject('/tmp/proj');
        const session = store.upsertSession('codex', 'codex-sess-1', project.id, codexFilePath);
        db.prepare(
            `INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
       VALUES (?, ?, 0, 'codex', '2026-08-10T09:00:02.000Z', '[]', '[]', '[]', '2026-08-10T09:00:02.000Z')`,
        ).run(project.id, session.id);

        const plan = await applySessionFieldsBackfill(db, adapters);
        expect(plan.changes.length).toBeGreaterThan(0);

        const row = db.prepare('SELECT surface, git_branch, kind FROM sessions WHERE id = ?').get(session.id) as {
            surface: string;
            git_branch: string;
            kind: string;
        };
        expect(row.surface).toBe('cli');
        expect(row.kind).toBe('main');
        expect(row.git_branch).toBe('feature/codex-coverage');

        db.close();
    });

    it('fails explicitly without mutating metadata when quote-back coverage is incomplete', async () => {
        const db = openUnmanagedDb(':memory:');
        const session = seedSession(db, filePath);
        const insert = db.prepare(
            `INSERT INTO injections (tool, native_session_id, injected_at, injection_id, body_hash, body)
             VALUES ('claude-code', ?, '2026-08-01T09:00:00.000Z', ?, ?, ?)`,
        );
        for (let index = 0; index <= INJECTION_QUOTE_BACK_MAX_ROWS; index++) {
            insert.run(
                session.native_id,
                `bounded-${index}`,
                `legacy-hash-${index}`,
                `Distinct historical injection ${index} that cannot match this fixture.`,
            );
        }

        await expect(applySessionFieldsBackfill(db, adapters)).rejects.toBeInstanceOf(InjectionQuoteBackIncompleteError);
        expect(db.prepare('SELECT surface, git_branch, kind FROM sessions WHERE id = ?').get(session.id)).toEqual({
            surface: null,
            git_branch: null,
            kind: null,
        });
        db.close();
    });

    it('uses structural MCP receipts locally to suppress a later quote-back in the same planning pass', async () => {
        const db = openUnmanagedDb(':memory:');
        const receiptBody = 'This verified Elepha MCP result is long enough to be recognized when the next turn quotes it verbatim.';
        const replayPath = path.join(claudeProjects, 'same-pass-rule4.jsonl');
        writeFileSync(
            replayPath,
            `${[
                {
                    type: 'user',
                    cwd: '/tmp/proj',
                    timestamp: '2026-08-01T10:00:01.000Z',
                    entrypoint: 'cli',
                    gitBranch: 'must-not-be-derived',
                    message: { role: 'user', content: 'Ask Elepha' },
                },
                {
                    type: 'assistant',
                    cwd: '/tmp/proj',
                    timestamp: '2026-08-01T10:00:02.000Z',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'tool_use', id: 'call-1', name: 'mcp__elepha__recall', input: {} }],
                    },
                },
                {
                    type: 'user',
                    cwd: '/tmp/proj',
                    timestamp: '2026-08-01T10:00:03.000Z',
                    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: receiptBody }] },
                },
                {
                    type: 'assistant',
                    cwd: '/tmp/proj',
                    timestamp: '2026-08-01T10:00:04.000Z',
                    message: { role: 'assistant', content: [{ type: 'text', text: 'Immediate synthesis.' }] },
                },
                {
                    type: 'user',
                    cwd: '/tmp/proj',
                    timestamp: '2026-08-01T10:00:05.000Z',
                    entrypoint: 'cli',
                    gitBranch: 'also-must-not-be-derived',
                    message: { role: 'user', content: `As Elepha said: ${receiptBody}` },
                },
                {
                    type: 'assistant',
                    cwd: '/tmp/proj',
                    timestamp: '2026-08-01T10:00:06.000Z',
                    message: { role: 'assistant', content: [{ type: 'text', text: 'Quoted response.' }] },
                },
            ]
                .map((line) => JSON.stringify(line))
                .join('\n')}\n`,
        );
        const session = seedSession(db, replayPath, 'same-pass-rule4');

        const plan = await planSessionFieldsBackfill(db, adapters);
        const change = plan.changes.find((candidate) => candidate.sessionId === session.id);
        expect(change?.after).toMatchObject({ surface: null, git_branch: null, trailing_branch: null, trailing_files: '[]' });
        expect(db.prepare('SELECT * FROM injections').all()).toEqual([]);
        db.close();
    });
});
