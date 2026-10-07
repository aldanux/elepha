import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES } from '../../src/config/constants.js';
import { setSetting } from '../../src/config/settings.js';
import * as providers from '../../src/embeddings/provider-config.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { TASK_STATE_REQUEST_INSTRUCTIONS } from '../../src/serving/instructions.js';
import { openDb, type openUnmanagedDb } from '../../src/storage/db.js';
import { TaskStateRequestStore } from '../../src/storage/task-state-request-store.js';
import { createTestDb, seedConsentRoot, seedProject, seedSession } from '../helpers/db.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function fixture() {
    const f = createTestDb('task-state-hook-');
    vi.stubEnv('ELEPHA_HOME', f.directory);
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(f.directory, '.claude'));
    const configPath = path.join(f.directory, 'config.json');
    setSetting('memory-plus', 'true', configPath);
    const project = seedProject(f);
    mkdirSync(project.path, { recursive: true });
    seedConsentRoot(f, { path: project.path });
    const sourcePath = path.join(f.directory, '.claude', 'projects', 'fixture', 'chat-1.jsonl');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, '');
    seedSession(f, { project, tool: 'claude-code', nativeId: 'chat-1', sourcePath, kind: 'main' });
    const provider = vi.spyOn(providers, 'createEmbeddingProvider').mockResolvedValue({
        configuration: { provider: 'local', model: 'fixture', revision: 'v1', dimensions: 2 },
        embed: async () => [1, 0],
        dispose: async () => {},
    });
    const databaseOpen = vi.fn();
    function openDatabase(dbPath: ':memory:'): ReturnType<typeof openUnmanagedDb>;
    function openDatabase(dbPath?: string): ReturnType<typeof openDb>;
    function openDatabase(dbPath?: string) {
        databaseOpen(dbPath);
        return dbPath === ':memory:' ? openDb(dbPath) : openDb(dbPath);
    }
    const run = (
        options: {
            prompt?: string;
            sourcePath?: string | null;
            agentId?: string;
            agentType?: string;
            enabled?: boolean;
            dbPath?: string;
            writeInjection?: () => boolean;
        } = {},
    ) => {
        if (options.enabled === false) setSetting('memory-plus', 'false', configPath);
        return runUserPromptSubmit(
            JSON.stringify({
                session_id: 'chat-1',
                cwd: project.path,
                hook_event_name: 'UserPromptSubmit',
                prompt: options.prompt ?? 'Continue the active task.',
                transcript_path: options.sourcePath === undefined ? sourcePath : options.sourcePath,
                ...(options.agentId ? { agent_id: options.agentId } : {}),
                ...(options.agentType ? { agent_type: options.agentType } : {}),
            }),
            'claude-code',
            {
                dbPath: options.dbPath ?? f.dbPath,
                configPath,
                openDatabase,
                log: () => {},
                ...(options.writeInjection ? { writeInjection: options.writeInjection } : {}),
            },
        );
    };
    const requestCount = () => (f.db.prepare('SELECT COUNT(*) AS count FROM task_state_requests').get() as { count: number }).count;
    const injectionCount = () => (f.db.prepare('SELECT COUNT(*) AS count FROM injections').get() as { count: number }).count;
    return { ...f, configPath, project, sourcePath, run, requestCount, injectionCount, provider, databaseOpen };
}

it.each([
    { enabled: false },
    { agentType: 'review' },
    { sourcePath: null },
    { sourcePath: '' },
    { sourcePath: 'x'.repeat(CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES + 1) },
    { sourcePath: 'other-chat.jsonl' },
    { prompt: ' ' },
])('does no database or receipt work for an ineligible Claude payload (case %#)', async (options) => {
    const f = fixture();
    expect(await f.run(options)).toEqual({ reason: 'not_command' });
    expect(f.databaseOpen).not.toHaveBeenCalled();
    expect(await f.run({ ...options, dbPath: path.join(f.directory, 'missing.db') })).toEqual({ reason: 'not_command' });
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.requestCount()).toBe(0);
    expect(f.injectionCount()).toBe(0);
});

it('asks one verified Claude main chat for a task-state report and preserves its pending request', async () => {
    const f = fixture();
    const first = await f.run();
    expect(first).toHaveProperty('output');
    const body = JSON.stringify(first);
    expect(body).toContain('elepha task-state request mode=precompact_manifest request_id=');
    expect(body).toContain(TASK_STATE_REQUEST_INSTRUCTIONS);
    expect(f.requestCount()).toBe(1);
    expect(f.injectionCount()).toBe(1);
    expect(f.provider).not.toHaveBeenCalled();
    const second = await f.run();
    expect(second).toHaveProperty('output');
    expect(JSON.stringify(second)).toBe(body);
    const marker = /elepha task-state request mode=precompact_manifest request_id=[0-9A-Z]+/;
    expect(JSON.stringify(second).match(marker)?.[0]).toBe(body.match(marker)?.[0]);
    expect(f.requestCount()).toBe(1);
    expect(f.injectionCount()).toBe(1);
});

it('does not ask from a command, child, disabled setting, or missing session', async () => {
    const f = fixture();
    expect(await f.run({ prompt: 'elepha:help' })).toHaveProperty('output');
    expect(await f.run({ agentId: 'child-1' })).toEqual({ reason: 'subagent_context' });
    expect(await f.run({ sourcePath: path.join(path.dirname(f.sourcePath), 'parent', 'subagents', 'agent-child.jsonl') })).toEqual({
        reason: 'not_command',
    });
    expect(f.requestCount()).toBe(0);
    f.db.prepare("DELETE FROM sessions WHERE tool = 'claude-code' AND native_id = 'chat-1'").run();
    expect(await f.run()).toEqual({ reason: 'not_command' });
    expect(await f.run({ enabled: false })).toEqual({ reason: 'not_command' });
    expect(f.requestCount()).toBe(0);
});

it('rolls back the task-state injection when request issuance fails after its write', async () => {
    const f = fixture();
    vi.spyOn(TaskStateRequestStore.prototype, 'issuePrepared').mockReturnValue(false);
    expect(await f.run()).toEqual({ reason: 'not_command' });
    expect(f.requestCount()).toBe(0);
    expect(f.injectionCount()).toBe(0);
});

it('rejects a substituted Claude source with the same native chat filename', async () => {
    const f = fixture();
    const substitute = path.join(path.dirname(path.dirname(f.sourcePath)), 'other', 'chat-1.jsonl');
    mkdirSync(path.dirname(substitute), { recursive: true });
    writeFileSync(substitute, '');
    expect(await f.run({ sourcePath: substitute })).toEqual({ reason: 'not_command' });
    expect(f.requestCount()).toBe(0);
    expect(f.injectionCount()).toBe(0);
});

it('does not issue a request when Memory-Plus is disabled during source verification', async () => {
    const f = fixture();
    let classifications = 0;
    vi.spyOn(ClaudeCodeAdapter.prototype, 'classifySession').mockImplementation(async () => {
        classifications += 1;
        if (classifications === 2) {
            setSetting('memory-plus', 'false', f.configPath);
        }
        return { kind: 'primary' };
    });
    expect(await f.run()).toEqual({ reason: 'not_command' });
    expect(classifications).toBe(2);
    expect(f.requestCount()).toBe(0);
    expect(f.injectionCount()).toBe(0);
});
