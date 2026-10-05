import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlTurnAdapter } from '../../src/adapters/base.js';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { OPEN_TURN_SUMMARY_GRACE_MS } from '../../src/config/constants.js';
import { retainsFilteredCopy } from '../../src/config/filtered-capture-policy.js';
import { readMemoryConfig } from '../../src/config/memory-config.js';
import { elephaConfigPath } from '../../src/config/paths.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { mcpResponseShaper } from '../../src/mcp/server.js';
import { ElephaMcpService } from '../../src/mcp/tools.js';
import { buildInjectionId, wrap } from '../../src/security/sentinel.js';
import { publicSessionId } from '../../src/serving/session-id.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { SessionAdapter, ToolName } from '../../src/types/index.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

type FirstHost = 'claude-code' | 'codex';
type LegacySetting = 'absent' | 'false';

type ScanSeam = {
    scanFile(
        adapter: SessionAdapter,
        filePath: string,
        closeTrailingOnIdle: boolean,
    ): Promise<{ ingested: number; skipped?: { category: string } }>;
};

// Distinct needles: each proves which part of the source did or did not
// become stored, searchable evidence.
const ANSWER = 'Adopt the zanzibarquartz ledger format.';
const FORBIDDEN = ['thinkingsecretneedle', 'argumentsecretneedle', 'tooloutputsecretneedle', 'injectedsecretneedle'];

function claudeTranscript(nativeId: string, cwd: string): string {
    const base = { cwd, sessionId: nativeId, isSidechain: false, userType: 'external', version: '2.1.220' };
    const sentinel = wrap('brief', buildInjectionId(), 'Earlier context injectedsecretneedle');
    return [
        {
            ...base,
            type: 'user',
            parentUuid: null,
            uuid: 'u0',
            timestamp: '2026-09-20T10:00:00.000Z',
            message: { role: 'user', content: 'Which ledger format?' },
        },
        {
            ...base,
            type: 'assistant',
            parentUuid: 'u0',
            uuid: 'a0',
            timestamp: '2026-09-20T10:00:10.000Z',
            message: {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'Private thinkingsecretneedle', signature: 'sig' },
                    { type: 'tool_use', id: 't0', name: 'Bash', input: { command: 'echo argumentsecretneedle' } },
                ],
            },
        },
        {
            ...base,
            type: 'user',
            parentUuid: 'a0',
            uuid: 'r0',
            timestamp: '2026-09-20T10:00:20.000Z',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'tooloutputsecretneedle' }] },
        },
        {
            ...base,
            type: 'assistant',
            parentUuid: 'r0',
            uuid: 'a1',
            timestamp: '2026-09-20T10:00:30.000Z',
            message: { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
        },
        {
            ...base,
            type: 'user',
            parentUuid: 'a1',
            uuid: 'u1',
            timestamp: '2026-09-20T10:01:00.000Z',
            message: { role: 'user', content: sentinel },
        },
        {
            ...base,
            type: 'assistant',
            parentUuid: 'u1',
            uuid: 'a2',
            timestamp: '2026-09-20T10:01:10.000Z',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Acknowledged injectedsecretneedle.' }] },
        },
    ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join('');
}

function codexTranscript(nativeId: string, cwd: string): string {
    const sentinel = wrap('brief', buildInjectionId(), 'Earlier context injectedsecretneedle');
    return [
        { type: 'session_meta', payload: { id: nativeId, cwd, originator: 'codex-tui' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Which ledger format?' } },
        {
            type: 'response_item',
            payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Private thinkingsecretneedle' }] },
        },
        {
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'shell',
                call_id: 'c0',
                arguments: JSON.stringify({ command: ['echo', 'argumentsecretneedle'] }),
            },
        },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c0', output: 'tooloutputsecretneedle' } },
        {
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: ANSWER }] },
        },
        { type: 'event_msg', payload: { type: 'user_message', message: sentinel } },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'Acknowledged injectedsecretneedle.' }],
            },
        },
    ]
        .map((record) => `${JSON.stringify({ timestamp: '2026-09-20T10:00:00.000Z', ...record })}\n`)
        .join('');
}

interface Harness {
    root: string;
    dbPath: string;
    store: MemoryStore;
    claudeRoot: string;
    codexRoot: string;
}

// Provider stores, elepha home (config and Memory-Plus off), and the database
// all live in one repository-owned scratch directory.
function harness(legacy: LegacySetting | 'true', resolveGitIdentity?: Record<string, string>): Harness {
    const root = withTempDir('elepha-auto-capture-');
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, '.claude'));
    vi.stubEnv('CODEX_HOME', path.join(root, '.codex'));
    vi.stubEnv('ELEPHA_HOME', path.join(root, 'elepha-home'));
    mkdirSync(path.join(root, 'elepha-home'), { recursive: true });
    if (legacy !== 'absent') {
        writeFileSync(elephaConfigPath(), `${JSON.stringify({ 'durable-capture': legacy === 'true' })}\n`);
    }
    const dbPath = path.join(root, 'elepha.db');
    const identity = resolveGitIdentity ?? {};
    const store = new MemoryStore(openUnmanagedDb(dbPath), {
        resolveGitRoot: (cwd) => (identity[cwd] === undefined ? null : cwd),
        resolveGitRemote: (gitRoot) => identity[gitRoot] ?? null,
        resolveGitRootCommit: (gitRoot) => (identity[gitRoot] === undefined ? null : 'a'.repeat(40)),
    });
    return { root, dbPath, store, claudeRoot: path.join(root, '.claude', 'projects'), codexRoot: path.join(root, '.codex', 'sessions') };
}

function writeTranscript(h: Harness, tool: FirstHost, nativeId: string, cwd: string): string {
    const file =
        tool === 'codex'
            ? path.join(h.codexRoot, '2026', '09', '20', `rollout-2026-09-20T10-00-00-${nativeId}.jsonl`)
            : path.join(h.claudeRoot, 'project', `${nativeId}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, tool === 'codex' ? codexTranscript(nativeId, cwd) : claudeTranscript(nativeId, cwd));
    return file;
}

// No summarizer: capture must not depend on a synthesis provider.
function daemonFor(h: Harness, config: () => ReturnType<typeof readMemoryConfig> = () => readMemoryConfig()): IngestionDaemon {
    const daemon = new IngestionDaemon({ store: h.store, watchRoots: [h.claudeRoot, h.codexRoot], readConfig: config });
    daemons.push(daemon);
    return daemon;
}

function adapterFor(tool: FirstHost): SessionAdapter {
    return tool === 'codex' ? new CodexAdapter() : new ClaudeCodeAdapter();
}

function nativeIdFor(tool: FirstHost, suffix: string): string {
    return tool === 'codex' ? `019fa000-0000-7000-8000-0000000000${suffix}` : `aaaaaaaa-bbbb-cccc-dddd-0000000000${suffix}`;
}

function count(h: Harness, sql: string, ...params: unknown[]): number {
    return (h.store.database.prepare(sql).get(...params) as { count: number }).count;
}

function ftsHits(h: Harness, term: string): number {
    return count(h, 'SELECT COUNT(*) AS count FROM filtered_turns_fts WHERE filtered_turns_fts MATCH ?', term);
}

const daemons: IngestionDaemon[] = [];

afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('automatic filtered capture for Claude Code and Codex', () => {
    it.each([
        ['claude-code', 'absent'],
        ['claude-code', 'false'],
        ['codex', 'absent'],
        ['codex', 'false'],
    ] as const)('retains %s evidence with the legacy setting %s, Memory-Plus off and no synthesis provider', async (tool, legacy) => {
        const h = harness(legacy);
        const project = realpathSync(withGrantableTestDir('elepha-auto-capture-project-'));
        // A grant made before this policy existed is used unchanged.
        h.store.consent.grant(project);
        const consentBefore = h.store.database.prepare('SELECT * FROM consent_roots ORDER BY id').all();
        const configBefore = existsSync(elephaConfigPath()) ? readFileSync(elephaConfigPath(), 'utf8') : undefined;
        const nativeId = nativeIdFor(tool, '01');
        const transcript = writeTranscript(h, tool, nativeId, project);
        const daemon = daemonFor(h) as unknown as ScanSeam;

        await expect(daemon.scanFile(adapterFor(tool), transcript, true)).resolves.toMatchObject({ ingested: 1 });

        const session = h.store.findSession(tool, nativeId)!;
        expect(count(h, 'SELECT COUNT(*) AS count FROM memories WHERE session_id = ?', session.id)).toBe(1);
        expect(count(h, 'SELECT COUNT(*) AS count FROM filtered_turns')).toBe(1);
        expect(count(h, 'SELECT COUNT(*) AS count FROM turn_search_index')).toBe(1);
        expect(h.store.database.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(session.id)).toEqual({
            state: 'complete',
        });
        expect(ftsHits(h, 'zanzibarquartz')).toBe(1);
        // Reasoning, raw tool arguments, tool output and a sentinel-wrapped
        // turn never reach the retained copy or its search index.
        const stored = JSON.stringify(h.store.database.prepare('SELECT * FROM filtered_turns').all());
        for (const needle of FORBIDDEN) {
            expect(stored).not.toContain(needle);
            expect(ftsHits(h, needle)).toBe(0);
        }
        expect(h.store.database.prepare('SELECT * FROM consent_roots ORDER BY id').all()).toEqual(consentBefore);
        expect(existsSync(elephaConfigPath()) ? readFileSync(elephaConfigPath(), 'utf8') : undefined).toBe(configBefore);

        // A re-presented turn (reset cursor, overlapping scan) adds nothing.
        h.store.database.prepare('UPDATE sessions SET cursor = NULL WHERE id = ?').run(session.id);
        await daemon.scanFile(adapterFor(tool), transcript, true);
        expect(count(h, 'SELECT COUNT(*) AS count FROM memories')).toBe(1);
        expect(count(h, 'SELECT COUNT(*) AS count FROM filtered_turns')).toBe(1);
        expect(ftsHits(h, 'zanzibarquartz')).toBe(1);

        // The stored copy alone serves recall and session reads after the
        // provider deletes the transcript.
        const transcriptRead = vi.spyOn(JsonlTurnAdapter.prototype, 'parseTurns');
        unlinkSync(transcript);
        const service = new ElephaMcpService(h.store.database, mcpResponseShaper);
        expect(JSON.stringify(await service.recall({ query: 'zanzibarquartz' }))).toContain('zanzibarquartz');
        expect(JSON.stringify(await service.getSession({ id: publicSessionId(session), last_n: 1 }))).toContain('zanzibarquartz');
        expect(transcriptRead).not.toHaveBeenCalled();
    });

    it('adds no evidence for denied, unapproved, disabled-host, or unapproved sibling-checkout scopes', async () => {
        const approved = realpathSync(withGrantableTestDir('elepha-auto-capture-approved-'));
        const sibling = realpathSync(withGrantableTestDir('elepha-auto-capture-sibling-'));
        const denied = realpathSync(withGrantableTestDir('elepha-auto-capture-denied-'));
        const unapproved = realpathSync(withGrantableTestDir('elepha-auto-capture-unapproved-'));
        // The sibling checkout shares the approved checkout's repository identity.
        const remote = 'git@example.test:team/repo.git';
        const h = harness('false', { [approved]: remote, [sibling]: remote });
        h.store.upsertProject(approved);
        h.store.consent.grant(approved);
        h.store.consent.revoke(denied);
        const daemon = daemonFor(h) as unknown as ScanSeam;

        for (const [tool, cwd, suffix] of [
            ['claude-code', denied, '11'],
            ['codex', unapproved, '12'],
            ['claude-code', sibling, '13'],
        ] as const) {
            const transcript = writeTranscript(h, tool, nativeIdFor(tool, suffix), cwd);
            await expect(daemon.scanFile(adapterFor(tool), transcript, true)).resolves.toMatchObject({ ingested: 0 });
        }
        // The host switch is applied when the daemon selects an adapter for a
        // watched file, so the disabled host goes through the startup sweep.
        const disabledHost = writeTranscript(h, 'codex', nativeIdFor('codex', '14'), approved);
        const codexOff = daemonFor(h, () => {
            const result = readMemoryConfig();
            return 'error' in result ? result : { config: { ...result.config, captureCodex: false } };
        }) as unknown as { sweepStartupFiles(): Promise<void> };
        await codexOff.sweepStartupFiles();
        expect(h.store.findSession('codex', nativeIdFor('codex', '14'))).toBeUndefined();
        expect(existsSync(disabledHost)).toBe(true);

        expect(count(h, 'SELECT COUNT(*) AS count FROM memories')).toBe(0);
        expect(count(h, 'SELECT COUNT(*) AS count FROM filtered_turns')).toBe(0);
        expect(count(h, 'SELECT COUNT(*) AS count FROM turn_search_index')).toBe(0);
        expect(count(h, 'SELECT COUNT(*) AS count FROM open_turns')).toBe(0);
        expect(h.store.consent.consentState(sibling)).not.toBe('approved');
    });
});

describe('automatic filtered capture for failed-EOF staging', () => {
    function line(timestamp: string, type: string, payload: object): string {
        return `${JSON.stringify({ timestamp, type, payload })}\n`;
    }

    it('stages an incomplete Codex projection and replaces it with one complete copy, with the legacy setting false', async () => {
        const h = harness('false');
        const project = realpathSync(withGrantableTestDir('elepha-auto-capture-staging-'));
        h.store.consent.grant(project);
        const nativeId = nativeIdFor('codex', '21');
        const transcript = path.join(h.codexRoot, '2026', '09', '18', `rollout-2026-09-18T08-46-00-${nativeId}.jsonl`);
        mkdirSync(path.dirname(transcript), { recursive: true });
        writeFileSync(
            transcript,
            [
                line('2026-09-18T08:46:00.000Z', 'session_meta', { id: nativeId, cwd: project, originator: 'codex-desktop' }),
                line('2026-09-18T08:46:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'attempt-1' }),
                line('2026-09-18T08:46:02.000Z', 'response_item', {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'Investigate the stagedneedle issue.' }],
                }),
                line('2026-09-18T08:46:03.000Z', 'response_item', {
                    type: 'message',
                    role: 'assistant',
                    phase: 'commentary',
                    content: [{ type: 'output_text', text: 'Partial investigation.' }],
                }),
                line('2026-09-18T08:47:17.715Z', 'event_msg', {
                    type: 'task_complete',
                    turn_id: 'attempt-1',
                    last_agent_message: null,
                    error: { message: 'Selected model is at capacity.', codex_error_info: 'server_overloaded' },
                }),
            ].join(''),
        );
        const now = Date.parse('2026-09-18T08:47:17.715Z') + OPEN_TURN_SUMMARY_GRACE_MS + 1;
        const daemon = new IngestionDaemon({
            store: h.store,
            watchRoots: [h.codexRoot],
            now: () => now,
            readConfig: () => readMemoryConfig(),
        });
        daemons.push(daemon);
        const scan = daemon as unknown as ScanSeam;

        await scan.scanFile(new CodexAdapter(), transcript, true);

        const staged = h.store.findOpenTurn('codex', nativeId);
        expect(staged?.staged_at).not.toBeNull();
        expect(
            h.store.database
                .prepare('SELECT durable_included, durable_user_prompt FROM open_turns WHERE native_session_id = ?')
                .get(nativeId),
        ).toEqual({ durable_included: 1, durable_user_prompt: expect.stringContaining('stagedneedle') });
        // Staged evidence is not a completed memory or complete coverage.
        const session = h.store.findSession('codex', nativeId)!;
        expect(count(h, 'SELECT COUNT(*) AS count FROM memories')).toBe(0);
        expect(count(h, 'SELECT COUNT(*) AS count FROM filtered_turns')).toBe(0);
        expect(count(h, 'SELECT COUNT(*) AS count FROM durable_capture_status WHERE session_id = ?', session.id)).toBe(0);
        expect(h.store.getSessionCursor('codex', nativeId)).toBeUndefined();

        appendFileSync(
            transcript,
            [
                line('2026-09-18T09:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 'attempt-2' }),
                line('2026-09-18T09:00:01.000Z', 'response_item', {
                    type: 'message',
                    role: 'assistant',
                    phase: 'final_answer',
                    content: [{ type: 'output_text', text: 'Recovered recoveredneedle answer.' }],
                }),
                line('2026-09-18T09:00:02.000Z', 'event_msg', {
                    type: 'task_complete',
                    turn_id: 'attempt-2',
                    last_agent_message: 'Recovered recoveredneedle answer.',
                }),
            ].join(''),
        );
        await expect(scan.scanFile(new CodexAdapter(), transcript, true)).resolves.toMatchObject({ ingested: 1 });

        expect(h.store.findOpenTurn('codex', nativeId)).toBeUndefined();
        expect(count(h, 'SELECT COUNT(*) AS count FROM filtered_turns')).toBe(1);
        expect(ftsHits(h, 'recoveredneedle')).toBe(1);
        expect(h.store.database.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(session.id)).toEqual({
            state: 'complete',
        });
    });
});

describe('filtered capture policy', () => {
    // OpenCode keeps the legacy key as its opt-in for every configured state;
    // only the two first hosts retain copies automatically.
    it.each([
        ['absent', undefined],
        ['false', false],
        ['true', true],
    ] as const)('keeps OpenCode on the legacy setting when it is %s', (_label, setting) => {
        const root = withTempDir('elepha-auto-capture-policy-');
        const file = path.join(root, 'config.json');
        if (setting !== undefined) {
            writeFileSync(file, JSON.stringify({ 'durable-capture': setting }));
        }
        const config = readMemoryConfig(file);
        if ('error' in config) throw new Error(config.error);
        const legacy = config.config.durableCapture ?? false;
        const decisions = Object.fromEntries(
            (['claude-code', 'codex', 'opencode'] as ToolName[]).map((tool) => [tool, retainsFilteredCopy(tool, legacy)]),
        );

        expect(decisions).toEqual({ 'claude-code': true, codex: true, opencode: setting === true });
    });
});
