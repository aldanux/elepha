import { once } from 'node:events';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { defaultAdapters } from '../../src/adapters/index.js';
import { taskStateReportErrorText } from '../../src/adapters/task-state-report.js';
import { CODEX_TASK_SOURCE_KIND, CODEX_TASK_SOURCE_LOOKUP_CODE, CODEX_TASK_SOURCE_LOOKUP_MAX_ENTRIES } from '../../src/config/codex.js';
import {
    CURRENT_CHAT_EVIDENCE_MAX_CHARS,
    CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES,
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    DATABASE_LIFECYCLE_POLL_MS,
    FINGERPRINT_WINDOW_BYTES,
    HOOK_LOG_LINE_MAX_CHARS,
    HOOK_WATCHDOG_TIMEOUT_MS,
    SESSION_EVIDENCE_SOURCE_MAX_BYTES,
    SESSION_KIND_PREAMBLE_MAX_BYTES,
    TASK_STATE_MANIFEST_VERIFY_DEADLINE_MS,
    TASK_STATE_REPORT_ACK,
} from '../../src/config/constants.js';
import { setSetting } from '../../src/config/settings.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { TaskStateManifestPublisher } from '../../src/daemon/task-state-manifests.js';
import { appendHookLog, TASK_STATE_HOOK_STAGE } from '../../src/hooks/hook-log.js';
import { runSessionStart, type SessionStartDependencies } from '../../src/hooks/session-start.js';
import { runUserPromptSubmit, type UserPromptSubmitDependencies } from '../../src/hooks/user-prompt-submit.js';
import { openProviderTranscript } from '../../src/security/provider-transcript.js';
import * as subprocess from '../../src/security/subprocess-allowlist.js';
import {
    TASK_STATE_CHECKPOINT_INTRODUCTION,
    TASK_STATE_CURRENT_INTRODUCTION,
    TASK_STATE_REQUEST_INSTRUCTIONS,
} from '../../src/serving/instructions.js';
import { selectTaskStateCheckpoint } from '../../src/serving/task-state-manifest-selector.js';
import { verifyTaskStateManifest } from '../../src/serving/task-state-manifest-verifier.js';
import { databaseLifecyclePaths } from '../../src/storage/database-lifecycle.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { sourceTurnDigest, sourceTurnDigests } from '../../src/storage/source-turn-digest.js';
import { TaskStateManifestStore } from '../../src/storage/task-state-manifest-store.js';
import { TaskStateRequestStore } from '../../src/storage/task-state-request-store.js';
import type { ParsedTurn, SessionAdapter, SessionAdapterTool, TaskStateReportInput } from '../../src/types/index.js';
import { createTestDb } from '../helpers/db.js';

vi.mock('node:fs/promises', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs/promises')>();
    return { ...original, opendir: vi.fn(original.opendir) };
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function fixture(tool: SessionAdapterTool, subdirectory = false) {
    const f = createTestDb('active-task-continuity-');
    vi.stubEnv('ELEPHA_HOME', f.directory);
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(f.directory, '.claude'));
    vi.stubEnv('CODEX_HOME', path.join(f.directory, '.codex'));
    setSetting('memory-plus', 'false');
    const projectPath = path.join(f.directory, 'checkout');
    const cwd = subdirectory ? path.join(projectPath, 'packages', 'app') : projectPath;
    mkdirSync(cwd, { recursive: true });
    if (subdirectory) {
        f.store = new MemoryStore(f.db, {
            resolveGitRoot: () => projectPath,
            resolveGitRemote: () => null,
            resolveGitRootCommit: () => null,
        });
    }
    f.store.consent.grant(projectPath);
    const nativeId = tool === 'codex' ? '019fa000-0000-7000-8000-000000000321' : 'active-chat';
    const sourcePath =
        tool === 'codex'
            ? path.join(f.directory, '.codex', 'sessions', '2026', '10', '08', `rollout-2026-10-08T12-00-00-${nativeId}.jsonl`)
            : path.join(f.directory, '.claude', 'projects', 'fixture', `${nativeId}.jsonl`);
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    const lines = (records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    writeFileSync(
        sourcePath,
        tool === 'codex' ? lines([{ type: 'session_meta', payload: { id: nativeId, cwd, originator: 'codex-tui', source: 'cli' } }]) : '',
    );
    const logs: string[] = [];
    const adapters = defaultAdapters();
    const adapter = adapters[tool];
    const publisher = new TaskStateManifestPublisher({
        store: f.store,
        adapters,
        openTranscript: openProviderTranscript,
        log: (line) => logs.push(line),
        logError: (line) => logs.push(line),
        enqueue: () => {},
        stopped: () => false,
    });
    let sequence = 0;
    const startedAt = Date.now();
    const stamp = () => new Date(startedAt + sequence++ * 1000).toISOString();
    const cc = (role: string, content: unknown) => ({
        type: role,
        cwd,
        timestamp: stamp(),
        message: { role, content: role === 'assistant' && typeof content === 'string' ? [{ type: 'text', text: content }] : content },
    });
    const cx = (type: string, payload: unknown) => ({ type, payload, timestamp: stamp() });
    const reportRecords = (callId: string, input: unknown, received: boolean, rejected = false) => {
        const content = [{ type: 'text', text: rejected ? taskStateReportErrorText('malformed-input') : TASK_STATE_REPORT_ACK }];
        return tool === 'claude-code'
            ? [
                  cc('assistant', [{ type: 'tool_use', id: callId, name: 'mcp__elepha__report_task_state', input }]),
                  ...(received
                      ? [cc('user', [{ type: 'tool_result', tool_use_id: callId, content, ...(rejected ? { is_error: true } : {}) }])]
                      : []),
              ]
            : [
                  cx('response_item', {
                      type: 'function_call',
                      namespace: 'mcp__elepha',
                      name: 'report_task_state',
                      arguments: JSON.stringify(input),
                      call_id: callId,
                  }),
                  ...(received
                      ? [
                            cx('response_item', {
                                type: 'function_call_output',
                                call_id: callId,
                                output: rejected ? JSON.stringify({ content, isError: true }) : TASK_STATE_REPORT_ACK,
                            }),
                        ]
                      : []),
              ];
    };
    const appendTurn = (prompt: string, report?: unknown, result = true, earlier?: { input: unknown; rejected: boolean }, idle = false) => {
        const id = `report-${sequence}`;
        const turnId = `turn-${sequence}`;
        const reports = () => [
            ...(earlier ? reportRecords(`${id}-earlier`, earlier.input, true, earlier.rejected) : []),
            ...(report === undefined ? [] : reportRecords(id, report, result)),
        ];
        const records =
            tool === 'claude-code'
                ? [cc('user', prompt), ...reports(), cc('assistant', 'Acknowledged.')]
                : [
                      ...(idle ? [] : [cx('event_msg', { type: 'task_started', turn_id: turnId })]),
                      cx('event_msg', { type: 'user_message', message: prompt }),
                      ...reports(),
                      cx('response_item', {
                          type: 'message',
                          role: 'assistant',
                          content: [{ type: 'output_text', text: 'Acknowledged.' }],
                      }),
                      ...(idle ? [] : [cx('event_msg', { type: 'task_complete', turn_id: turnId })]),
                  ];
        appendFileSync(sourcePath, lines(records));
    };
    const appendReport = (report: unknown) => appendFileSync(sourcePath, lines(reportRecords(`report-${sequence}`, report, true)));
    const appendDesktopReport = (report: unknown, during: string) => {
        const started = Date.parse(stamp());
        const duringRecord = cx('response_item', {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: during }],
        });
        appendFileSync(
            sourcePath,
            lines([
                duringRecord,
                cx('event_msg', {
                    type: 'item_completed',
                    started_at_ms: started,
                    completed_at_ms: Date.parse(stamp()),
                    item: {
                        type: 'McpToolCall',
                        server: 'elepha',
                        tool: 'report_task_state',
                        id: 'desktop-report',
                        arguments: report,
                        status: 'completed',
                        result: { content: [{ type: 'text', text: TASK_STATE_REPORT_ACK }] },
                    },
                }),
            ]),
        );
    };
    const appendReportPrefix = (prompt: string, report: unknown) =>
        appendFileSync(
            sourcePath,
            lines([
                tool === 'claude-code' ? cc('user', prompt) : cx('event_msg', { type: 'user_message', message: prompt }),
                ...reportRecords(`report-${sequence}`, report, true),
            ]),
        );
    const appendAssistant = (text: string, completedTurnId?: string) =>
        appendFileSync(
            sourcePath,
            lines([
                tool === 'claude-code'
                    ? cc('assistant', text)
                    : cx('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }),
                ...(tool === 'codex' && completedTurnId ? [cx('event_msg', { type: 'task_complete', turn_id: completedTurnId })] : []),
            ]),
        );
    const liveCapture = () => {
        const daemon = new IngestionDaemon({
            store: f.store,
            watchRoots: [path.join(f.directory, '.claude', 'projects'), path.join(f.directory, '.codex', 'sessions')],
            log: (line) => logs.push(line),
            logError: (line) => logs.push(line),
        });
        onTestFinished(() => daemon.stop());
        return () =>
            (daemon as unknown as { scanFile(adapter: SessionAdapter, file: string, idle: boolean): Promise<unknown> }).scanFile(
                adapter,
                sourcePath,
                true,
            );
    };
    const retrievalBody = 'Excluded Elepha retrieval evidence.';
    const appendRetrieval = (prompt: string, pending = false) => {
        const callId = `retrieval-${sequence}`;
        const turnId = `turn-${sequence}`;
        appendFileSync(
            sourcePath,
            lines(
                tool === 'claude-code'
                    ? [
                          cc('user', prompt),
                          cc('assistant', [
                              {
                                  type: 'tool_use',
                                  id: callId,
                                  name: 'mcp__elepha__get_session',
                                  input: { id: 'historical-chat', view: 'capsule' },
                              },
                          ]),
                          cc('user', [{ type: 'tool_result', tool_use_id: callId, content: retrievalBody }]),
                          ...(pending ? [] : [cc('assistant', 'Acknowledged.')]),
                      ]
                    : [
                          cx('event_msg', { type: 'task_started', turn_id: turnId }),
                          cx('event_msg', { type: 'user_message', message: prompt }),
                          cx('response_item', {
                              type: 'function_call',
                              namespace: 'mcp__elepha',
                              name: 'get_session',
                              arguments: JSON.stringify({ id: 'historical-chat', view: 'capsule' }),
                              call_id: callId,
                          }),
                          cx('response_item', { type: 'function_call_output', call_id: callId, output: retrievalBody }),
                          ...(pending
                              ? []
                              : [
                                    cx('response_item', {
                                        type: 'message',
                                        role: 'assistant',
                                        content: [{ type: 'output_text', text: 'Acknowledged.' }],
                                    }),
                                    cx('event_msg', { type: 'task_complete', turn_id: turnId }),
                                ]),
                      ],
            ),
        );
    };
    const compact = () =>
        appendFileSync(
            sourcePath,
            tool === 'claude-code'
                ? lines([
                      { type: 'system', subtype: 'compact_boundary' },
                      {
                          type: 'user',
                          isCompactSummary: true,
                          cwd,
                          timestamp: stamp(),
                          message: { role: 'user', content: 'Native summary' },
                      },
                  ])
                : lines([cx('compacted', { encrypted_content: 'opaque-provider-state' })]),
        );
    const appendPendingPrompt = (prompt: string) => {
        const turnId = `pending-${sequence}`;
        appendFileSync(
            sourcePath,
            lines(
                tool === 'claude-code'
                    ? [cc('user', prompt)]
                    : [
                          cx('event_msg', { type: 'task_started', turn_id: turnId }),
                          cx('event_msg', { type: 'user_message', message: prompt }),
                      ],
            ),
        );
        return turnId;
    };
    const appendProjectInstructions = (text: string) =>
        appendFileSync(
            sourcePath,
            lines([
                cx('response_item', {
                    type: 'message',
                    role: 'user',
                    content: [
                        { type: 'input_text', text: `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\n${text}\n</INSTRUCTIONS>` },
                        { type: 'input_text', text: '<environment_context>\nfixture metadata\n</environment_context>' },
                    ],
                }),
                cx('turn_context', { cwd }),
            ]),
        );
    const capture = async (withheldReports = false) => {
        for await (const turn of adapter.parseTurns(sourcePath, undefined, { closeTrailingOnIdle: true, skipSessionTitle: true })) {
            if (turn.droppedReason !== undefined) continue;
            f.store.recordIngestedTurn(
                withheldReports ? { ...turn, taskStateReport: undefined, taskStateReportFailure: 'malformed-input' } : turn,
                { kind: 'main', surface: 'cli' },
                false,
                { decisions: [], pending_items: [], status: 'ok' },
                true,
            );
        }
    };
    const openDatabase = (async (file: string) => openUnmanagedDb(file)) as UserPromptSubmitDependencies['openDatabase'];
    const basePayload = {
        session_id: nativeId,
        cwd,
        transcript_path: tool === 'codex' ? null : sourcePath,
        model: 'test',
        permission_mode: 'default',
    };
    const request = (overrides: Record<string, unknown> = {}, dependencies: UserPromptSubmitDependencies = {}) =>
        runUserPromptSubmit(
            JSON.stringify({ ...basePayload, hook_event_name: 'UserPromptSubmit', prompt: 'Continue.', ...overrides }),
            tool,
            { dbPath: f.dbPath, openDatabase, log: (line) => logs.push(line), ...dependencies },
        );
    const continuation = (source = 'compact', overrides: Record<string, unknown> = {}, dependencies: SessionStartDependencies = {}) =>
        runSessionStart(JSON.stringify({ ...basePayload, hook_event_name: 'SessionStart', source, ...overrides }), tool, {
            dbPath: f.dbPath,
            openDatabase,
            log: (line) => logs.push(line),
            daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
            readUpdateAvailable: () => undefined,
            ...dependencies,
        });
    const requestId = () =>
        (f.db.prepare('SELECT request_id FROM task_state_requests WHERE consumed_at IS NULL').get() as { request_id: string }).request_id;
    const state = (objective: string | null, quote = objective ?? ''): Extract<TaskStateReportInput, { mode: 'precompact_manifest' }> => ({
        mode: 'precompact_manifest',
        request_id: requestId(),
        objective: objective === null ? null : { text: objective, sources: [{ role: 'user', quote }] },
        decisions: [],
        constraints: [],
        pending_items: [],
    });
    const latest = () => {
        const row = f.db.prepare('SELECT memory_id FROM task_state_manifests ORDER BY memory_id DESC LIMIT 1').get() as
            | { memory_id: number }
            | undefined;
        return row && new TaskStateManifestStore(f.db).get(row.memory_id);
    };
    return {
        ...f,
        tool,
        cwd,
        projectPath,
        nativeId,
        sourcePath,
        adapter,
        publisher,
        logs,
        appendTurn,
        appendReport,
        appendDesktopReport,
        appendReportPrefix,
        appendAssistant,
        liveCapture,
        appendRetrieval,
        retrievalBody,
        appendPendingPrompt,
        appendProjectInstructions,
        compact,
        capture,
        request,
        continuation,
        requestId,
        state,
        latest,
    };
}

function context(result: Awaited<ReturnType<typeof runSessionStart>>): string {
    if (!('output' in result)) return '';
    const hook = result.output.hookSpecificOutput as { additionalContext?: string };
    return hook.additionalContext ?? '';
}

it.each(['claude-code', 'codex'] as const)('requests and publishes task state from the first in-progress %s prompt', async (tool) => {
    const f = fixture(tool, true);
    vi.spyOn(subprocess, 'gitRevParseShowToplevelAsync').mockImplementation(async (cwd) => (cwd === f.cwd ? f.projectPath : null));
    vi.spyOn(subprocess, 'gitRemoteGetUrlOriginAsync').mockResolvedValue(null);
    vi.spyOn(subprocess, 'gitRootCommitAsync').mockResolvedValue(null);
    vi.spyOn(subprocess, 'gitRevListCountHeadAsync').mockResolvedValue(null);
    const objective = 'Implement the agreed event domain.';
    let nativeTurnId = tool === 'claude-code' ? f.appendPendingPrompt(objective) : undefined;
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 });
    const payload = { prompt: objective, transcript_path: tool === 'codex' ? null : f.sourcePath };
    if (tool === 'codex') {
        const initial = readFileSync(f.sourcePath);
        appendFileSync(f.sourcePath, `${JSON.stringify({ type: 'turn_context', payload: { cwd: f.projectPath } })}\n`);
        expect(await f.request(payload)).toEqual({ reason: 'not_command' });
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
        writeFileSync(f.sourcePath, initial);
        appendFileSync(f.sourcePath, `${JSON.stringify({ type: 'turn_context', payload: { cwd: f.cwd } })}\n`);
    }
    const request = await f.request(payload);
    expect(request).toHaveProperty('output');
    expect(await f.request({ ...payload, transcript_path: f.sourcePath })).toEqual(request);
    expect(await f.request({ ...payload, transcript_path: tool === 'codex' ? null : f.sourcePath })).toEqual(request);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_state_requests').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM injections').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 });
    if (tool === 'codex') nativeTurnId = f.appendPendingPrompt(objective);
    f.appendReport(f.state(objective));
    f.appendAssistant('Implemented the agreement.', nativeTurnId);
    f.compact();
    const capture = f.liveCapture();
    await capture();
    expect(f.latest(), f.logs.join('\n')).toMatchObject({ report: { objective: { text: objective } }, coverage: { state: 'verified' } });
    expect(f.db.prepare('SELECT consumed_at FROM task_state_requests').get()).toMatchObject({ consumed_at: expect.any(String) });
    await capture();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_state_requests').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_state_manifests').get()).toEqual({ n: 1 });
    expect(context(await f.continuation('resume'))).toContain(objective);
});

it('publishes Codex constraints from initial native instructions and assistant evidence preceding the report', async () => {
    const f = fixture('codex');
    const constraint = 'Keep every write inside the authorized checkout.';
    const pending = 'The dispatch verification remains pending.';
    f.appendProjectInstructions(constraint);
    const objective = 'Implement the dispatcher.';
    const nativeTurnId = f.appendPendingPrompt(objective);
    expect(await f.request()).toHaveProperty('output');
    f.appendAssistant(`${pending}\n${'.'.repeat(FINGERPRINT_WINDOW_BYTES)}`);
    const report = f.state(objective);
    report.constraints = [{ text: constraint, sources: [{ role: 'user', quote: constraint }] }];
    report.pending_items = [{ text: pending, sources: [{ role: 'assistant', quote: pending }] }];
    f.appendReport(report);
    f.appendAssistant('Report received.', nativeTurnId);
    const capture = f.liveCapture();
    await capture();
    expect(f.latest(), f.logs.join('\n')).toMatchObject({
        coverage: { state: 'verified' },
        report: { constraints: report.constraints, pending_items: report.pending_items },
    });
    expect(f.db.prepare('SELECT user_prompt FROM filtered_turns WHERE memory_id = ?').get(f.latest()?.memoryId)).toEqual({
        user_prompt: objective,
    });
    expect(f.latest()?.sourceLocators.find((source) => source.section === 'constraints')?.nativeSource?.kind).toBe(
        CODEX_TASK_SOURCE_KIND.projectInstructions,
    );
    expect(f.latest()?.sourceLocators.find((source) => source.section === 'pending_items')?.nativeSource?.kind).toBe(
        CODEX_TASK_SOURCE_KIND.assistantBeforeReport,
    );
    expect(f.db.prepare('SELECT consumed_at FROM task_state_requests').get()).toMatchObject({ consumed_at: expect.any(String) });
    await capture();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_state_manifests').get()).toEqual({ n: 1 });
    f.compact();
    const resumed = await f.continuation('resume');
    const delivered = context(resumed);
    expect(delivered, JSON.stringify(resumed)).toContain(constraint);
    expect(delivered).toContain(pending);
    expect(delivered).toContain(CODEX_TASK_SOURCE_KIND.projectInstructions);
    const original = readFileSync(f.sourcePath, 'utf8');
    writeFileSync(f.sourcePath, original.replace('fixture metadata', 'changed metadata'));
    expect(
        await selectTaskStateCheckpoint(f.db, { tool: 'codex', nativeSessionId: f.nativeId, cwd: f.cwd, transcriptPath: f.sourcePath }),
    ).toEqual({ state: 'unavailable', reason: 'source_quote_changed' });
});

it('publishes Codex Desktop pre-invocation assistant proof and consumes its request once', async () => {
    const f = fixture('codex');
    const objective = 'Implement the dispatcher.';
    const pending = 'Dispatcher verification remains pending.';
    const turnId = f.appendPendingPrompt(objective);
    expect(await f.request()).toHaveProperty('output');
    f.appendAssistant(pending);
    const report = f.state(objective);
    report.pending_items = [{ text: pending, sources: [{ role: 'assistant', quote: pending }] }];
    f.appendDesktopReport(report, 'This text was emitted during the report call.');
    f.appendAssistant('Report received.', turnId);
    const capture = f.liveCapture();
    await capture();
    expect(f.latest(), f.logs.join('\n')).toMatchObject({
        coverage: { state: 'verified' },
        report: { pending_items: report.pending_items },
    });
    expect(f.latest()?.sourceLocators.find((source) => source.section === 'pending_items')?.nativeSource?.kind).toBe(
        CODEX_TASK_SOURCE_KIND.assistantBeforeReport,
    );
    expect(f.db.prepare('SELECT consumed_at FROM task_state_requests').get()).toMatchObject({ consumed_at: expect.any(String) });
    await capture();
    await f.publisher.recover();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_state_manifests').get()).toEqual({ n: 1 });
    expect(context(await f.continuation('resume'))).toContain(pending);
});

it('withholds Codex Desktop assistant text during invocation and after completion, and mismatched calls', async () => {
    const f = fixture('codex');
    const objective = 'Implement the dispatcher.';
    const before = 'This agreement preceded invocation.';
    const during = 'This text arrived during the report call.';
    const after = 'This text arrived after completion.';
    const turnId = f.appendPendingPrompt(objective);
    expect(await f.request()).toHaveProperty('output');
    f.appendAssistant(before);
    const report = f.state(objective);
    report.pending_items = [before, during, after].map((text) => ({ text, sources: [{ role: 'assistant', quote: text }] }));
    f.appendDesktopReport(report, during);
    f.appendAssistant(after, turnId);
    await f.liveCapture()();
    const memory = f.db.prepare('SELECT id FROM memories ORDER BY id DESC LIMIT 1').get() as { id: number };
    const checked = await verifyTaskStateManifest(f.db, { reportingMemoryId: memory.id, report, cwd: f.cwd });
    expect(checked.state === 'prepared' && checked.manifest.coverage).toMatchObject({
        state: 'incomplete',
        resolvedSourceCount: 2,
        totalSourceCount: 4,
    });
    expect(f.latest()).toBeUndefined();
    expect(f.db.prepare('SELECT consumed_at FROM task_state_requests').get()).toEqual({ consumed_at: null });
    expect(
        await new CodexAdapter().readAssistantBeforeTaskReport(f.sourcePath, {
            start: 0,
            end: readFileSync(f.sourcePath).byteLength,
            reportCallId: 'different-call',
            report: { ...report, callId: 'different-call' },
            authorizeCwd: (cwd) => cwd === f.cwd,
        }),
    ).toBe(false);
});

it('recovers a completed Codex report beyond the hook byte budget with metadata-only cursor drift', async () => {
    const f = fixture('codex');
    const objective = 'Implement the dispatcher.';
    const constraint = 'Keep writes inside the authorized checkout.';
    const pending = 'The dispatch verification remains pending.';
    f.appendProjectInstructions(constraint);
    expect(await f.request()).toHaveProperty('output');
    const turnId = f.appendPendingPrompt(objective);
    f.appendAssistant(pending);
    appendFileSync(
        f.sourcePath,
        `${JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'function_call_output',
                call_id: 'work-result',
                output: '.'.repeat(SESSION_EVIDENCE_SOURCE_MAX_BYTES + SESSION_KIND_PREAMBLE_MAX_BYTES / 2),
            },
        })}\n`,
    );
    const report = f.state(objective);
    report.constraints = [{ text: constraint, sources: [{ role: 'user', quote: constraint }] }];
    report.pending_items = [{ text: pending, sources: [{ role: 'assistant', quote: pending }] }];
    f.appendReport(report);
    f.appendAssistant('Report received.', turnId);
    await f.capture();
    expect(await f.request()).toEqual({ reason: 'not_command' });
    expect(f.logs.at(-1)).toContain('error=TranscriptReadBudgetError');
    const retained = f.db.prepare('SELECT source_cursor AS cursor, source_digest AS digest FROM turn_search_index').get() as {
        cursor: string;
        digest: string;
    };
    appendFileSync(
        f.sourcePath,
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', settings: '.'.repeat(FINGERPRINT_WINDOW_BYTES) } })}\n`,
    );
    await f.publisher.recover();
    expect(f.latest(), f.logs.join('\n')).toMatchObject({
        coverage: { state: 'verified' },
        report: { constraints: report.constraints, pending_items: report.pending_items },
    });
    expect(f.latest()?.sourceLocators.filter((source) => source.nativeSource !== undefined)).toHaveLength(2);
    expect(f.db.prepare('SELECT source_cursor AS cursor, source_digest AS digest FROM turn_search_index').get()).toEqual(retained);
    expect(f.db.prepare('SELECT consumed_at FROM task_state_requests').get()).toMatchObject({ consumed_at: expect.any(String) });
    await f.publisher.recover();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_state_manifests').get()).toEqual({ n: 1 });
});

it('does not verify project instructions outside constraints, report arguments or assistant text after the report', async () => {
    const f = fixture('codex');
    const project = 'Use the authorized checkout only.';
    const argument = 'This text exists only inside report arguments.';
    const later = 'This assistant text appears after the call.';
    const result = 'This text exists only in a tool result.';
    const heading = 'A later instruction heading is not initial project provenance.';
    f.appendProjectInstructions(project);
    const objective = 'Implement the dispatcher.';
    const turnId = f.appendPendingPrompt(objective);
    expect(await f.request()).toHaveProperty('output');
    f.appendProjectInstructions(heading);
    appendFileSync(
        f.sourcePath,
        `${[
            { type: 'response_item', payload: { type: 'function_call', name: 'fixture_tool', call_id: 'work-result', arguments: '{}' } },
            { type: 'response_item', payload: { type: 'function_call_output', call_id: 'work-result', output: result } },
        ]
            .map((record) => JSON.stringify(record))
            .join('\n')}\n`,
    );
    const report = f.state(objective);
    report.decisions = [{ text: project, sources: [{ role: 'user', quote: project }] }];
    report.constraints = [{ text: heading, sources: [{ role: 'user', quote: heading }] }];
    report.pending_items = [
        { text: argument, sources: [{ role: 'assistant', quote: argument }] },
        { text: later, sources: [{ role: 'assistant', quote: later }] },
        { text: result, sources: [{ role: 'assistant', quote: result }] },
    ];
    f.appendReport(report);
    f.appendAssistant(later, turnId);
    await f.liveCapture()();
    const memory = f.db.prepare('SELECT id FROM memories ORDER BY id DESC LIMIT 1').get() as { id: number };
    const checked = await verifyTaskStateManifest(f.db, { reportingMemoryId: memory.id, report, cwd: f.cwd });
    expect(checked.state === 'prepared' && checked.manifest.coverage).toMatchObject({
        state: 'incomplete',
        resolvedSourceCount: 1,
        totalSourceCount: 6,
    });
    expect(f.latest()).toBeUndefined();
    expect(f.db.prepare('SELECT consumed_at FROM task_state_requests').get()).toEqual({ consumed_at: null });
});

it('refuses quoted-back Elepha output packaged as initial project instructions', async () => {
    const f = fixture('codex');
    expect(await f.request()).toHaveProperty('output');
    const injection = f.db.prepare('SELECT body FROM injections LIMIT 1').get() as { body: string };
    const body = injection.body.split('\n').slice(1, -1).join('\n');
    f.appendProjectInstructions(body);
    const objective = 'Implement the dispatcher.';
    const turnId = f.appendPendingPrompt(objective);
    const report = f.state(objective);
    report.constraints = [
        { text: 'Keep capture passive.', sources: [{ role: 'user', quote: TASK_STATE_REQUEST_INSTRUCTIONS.split(',')[0] }] },
    ];
    f.appendReport(report);
    f.appendAssistant('Report received.', turnId);
    await f.liveCapture()();
    const memory = f.db.prepare('SELECT id FROM memories LIMIT 1').get() as { id: number };
    const verified = await verifyTaskStateManifest(f.db, { reportingMemoryId: memory.id, report, cwd: f.cwd });
    expect(verified.state === 'prepared' && verified.manifest.coverage).toMatchObject({
        state: 'incomplete',
        resolvedSourceCount: 1,
        totalSourceCount: 2,
    });
    expect(f.latest()).toBeUndefined();
    expect(f.db.prepare('SELECT consumed_at FROM task_state_requests').get()).toEqual({ consumed_at: null });
});

it('withholds pathless Codex requests unless the exact native locator is unique, complete and unchanged', async () => {
    const f = fixture('codex');
    f.appendPendingPrompt('Implement the agreed event domain.');
    const source = readFileSync(f.sourcePath);
    const refused = async (stage: string, code?: string) => {
        expect(await f.request()).toEqual({ reason: 'not_command' });
        expect(f.logs.at(-1)).toContain(`stage=${stage}`);
        if (code) expect(f.logs.at(-1)).toContain(`code=${code}`);
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_state_requests').get()).toEqual({ n: 0 });
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM injections').get()).toEqual({ n: 0 });
    };
    const elsewhere = `${f.sourcePath}.unrelated`;
    renameSync(f.sourcePath, elsewhere);
    await refused(TASK_STATE_HOOK_STAGE.sourceLookup, CODEX_TASK_SOURCE_LOOKUP_CODE.missing);
    renameSync(elsewhere, f.sourcePath);

    const duplicate = path.join(path.dirname(path.dirname(f.sourcePath)), '09', path.basename(f.sourcePath));
    mkdirSync(path.dirname(duplicate));
    writeFileSync(duplicate, source);
    await refused(TASK_STATE_HOOK_STAGE.sourceLookup, CODEX_TASK_SOURCE_LOOKUP_CODE.ambiguous);
    rmSync(duplicate);

    const inaccessible = vi.spyOn(fsPromises, 'opendir').mockRejectedValueOnce(Object.assign(new Error(), { code: 'EACCES' }));
    await refused(TASK_STATE_HOOK_STAGE.sourceLookup, CODEX_TASK_SOURCE_LOOKUP_CODE.unreadable);
    inaccessible.mockRestore();

    writeFileSync(f.sourcePath, source.toString().replace(f.nativeId, '019fa000-0000-7000-8000-000000000999'));
    await refused(TASK_STATE_HOOK_STAGE.nativeKind);
    writeFileSync(f.sourcePath, source);

    const classify = vi.spyOn(CodexAdapter.prototype, 'classifySession').mockImplementationOnce(async () => {
        writeFileSync(duplicate, source);
        return { kind: 'primary' };
    });
    await refused(TASK_STATE_HOOK_STAGE.sourceLookup, CODEX_TASK_SOURCE_LOOKUP_CODE.changed);
    classify.mockRestore();
    rmSync(duplicate);

    mkdirSync(path.join(path.dirname(f.sourcePath), 'nested'));
    await refused(TASK_STATE_HOOK_STAGE.sourceLookup, CODEX_TASK_SOURCE_LOOKUP_CODE.incomplete);
});

it('bounds pathless Codex enumeration and closes a directory opened after the hook deadline', async () => {
    const f = fixture('codex');
    f.appendPendingPrompt('Implement the agreed event domain.');
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const root = path.join(f.directory, '.codex', 'sessions');
    const day = await original.opendir(path.dirname(f.sourcePath));
    const unrelated = await day.read();
    await day.close();
    if (!unrelated) throw new Error('Missing fixture entry');
    unrelated.name = 'unrelated.jsonl';
    const enumerating = await original.opendir(root);
    const reads = vi.spyOn(enumerating, 'read').mockImplementation(async () => unrelated);
    const enumerationClose = vi.spyOn(enumerating, 'close');
    vi.mocked(fsPromises.opendir).mockResolvedValueOnce(enumerating);
    expect(await f.request()).toEqual({ reason: 'not_command' });
    expect(f.logs.at(-1)).toContain(`code=${CODEX_TASK_SOURCE_LOOKUP_CODE.incomplete}`);
    expect(reads).toHaveBeenCalledTimes(CODEX_TASK_SOURCE_LOOKUP_MAX_ENTRIES + 1);
    expect(enumerationClose).toHaveBeenCalledOnce();

    const late = await original.opendir(root);
    const close = late.close.bind(late);
    let opened!: (directory: typeof late) => void;
    let closed!: () => void;
    const closure = new Promise<void>((resolve) => {
        closed = resolve;
    });
    vi.spyOn(late, 'close').mockImplementation(async () => {
        await close();
        closed();
    });
    onTestFinished(() => close().catch(() => undefined));
    vi.mocked(fsPromises.opendir).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                opened = resolve;
            }),
    );
    const started = performance.now();
    expect(await f.request()).toEqual({ reason: 'not_command' });
    expect(performance.now() - started).toBeLessThan(HOOK_WATCHDOG_TIMEOUT_MS);
    expect(f.logs.at(-1)).toContain(`stage=${TASK_STATE_HOOK_STAGE.deadline}`);
    opened(late);
    await closure;
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_state_requests').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM injections').get()).toEqual({ n: 0 });
});

async function holdWriter(dbPath: string, releaseAfter?: number) {
    const writer = new Worker(
        `const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(workerData, { fileMustExist: true });
db.exec('BEGIN IMMEDIATE');
parentPort.postMessage('held');
parentPort.once('message', (delay) => {
    const release = () => { db.exec('ROLLBACK'); db.close(); parentPort.close(); };
    if (delay === null) parentPort.once('message', release);
    else setTimeout(release, delay);
});`,
        { eval: true, workerData: dbPath },
    );
    onTestFinished(async () => {
        await writer.terminate();
    });
    await once(writer, 'message');
    const exited = once(writer, 'exit');
    writer.postMessage(releaseAfter ?? null);
    return async () => {
        if (releaseAfter === undefined) writer.postMessage('release');
        expect((await exited)[0]).toBe(0);
    };
}

it('recovers transient database opening contention and publishes only one authenticated request', async () => {
    const f = fixture('codex');
    f.appendTurn('Keep the agreement until the check is complete.');
    await f.capture();
    const release = await holdWriter(f.dbPath, 250);
    try {
        const started = performance.now();
        const result = await f.request({}, { openDatabase: undefined });
        expect(performance.now() - started).toBeLessThan(TASK_STATE_MANIFEST_VERIFY_DEADLINE_MS);
        expect(result).toHaveProperty('output');
        expect(await f.request({}, { openDatabase: undefined })).toEqual(result);
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_state_requests').get()).toEqual({ n: 1 });
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM injections').get()).toEqual({ n: 1 });
        expect(readdirSync(databaseLifecyclePaths(f.dbPath).leases)).toEqual([]);
    } finally {
        await release();
    }
});

it('ends persistent database opening contention within the hook budget without partial publication', async () => {
    const f = fixture('codex');
    f.appendTurn('Keep the agreement until the check is complete.');
    await f.capture();
    const release = await holdWriter(f.dbPath);
    try {
        const started = performance.now();
        const result = await f.request({}, { openDatabase: undefined });
        const elapsed = performance.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(TASK_STATE_MANIFEST_VERIFY_DEADLINE_MS - DATABASE_LIFECYCLE_POLL_MS);
        expect(elapsed).toBeLessThan(HOOK_WATCHDOG_TIMEOUT_MS);
        expect(result).toEqual({ reason: 'database_unavailable' });
        expect(f.logs.some((line) => line.includes('stage=database_open') && line.includes('code=SQLITE_BUSY'))).toBe(true);
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_state_requests').get()).toEqual({ n: 0 });
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM injections').get()).toEqual({ n: 0 });
        expect(readdirSync(databaseLifecyclePaths(f.dbPath).leases)).toEqual([]);
    } finally {
        await release();
    }
    expect(await f.request({}, { openDatabase: undefined })).toHaveProperty('output');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_state_requests').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM injections').get()).toEqual({ n: 1 });
});

it('diagnoses Codex task-state rejection stages without logging protected content or changing delivery', async () => {
    const f = fixture('codex');
    const logPath = path.join(f.directory, 'hook.log');
    vi.stubEnv('ELEPHA_HOOK_LOG_PATH', logPath);
    const protectedText = 'PRIVATE_PROMPT_REPORT_TRANSCRIPT_KEY_CREDENTIAL';
    const log = appendHookLog;
    const logged = () => readFileSync(logPath, 'utf8');
    const lastStage = () => logged().trim().split('\n').at(-1);
    const prompt = { prompt: protectedText };
    expect(await f.request({ ...prompt, session_id: protectedText }, { dbPath: path.join(f.directory, 'missing.db'), log })).toEqual({
        reason: 'database_unavailable',
    });
    expect(lastStage()).toContain(`stage=${TASK_STATE_HOOK_STAGE.databasePath}`);

    const unsafe = Object.assign(new Error(protectedText.repeat(1000)), {
        name: `${protectedText}\n\u001b[31m`,
        code: `SQLITE_${protectedText}`,
        syscall: protectedText,
        path: protectedText,
    });
    const denied = Object.assign(new Error(protectedText), { code: 'EACCES', syscall: 'open' });
    const failure = Object.assign(new AggregateError([unsafe, unsafe, denied], protectedText), { code: 'SQLITE_BUSY' });
    const databaseOpen = vi.fn();
    function openFailure(dbPath: ':memory:'): ReturnType<typeof openUnmanagedDb>;
    function openFailure(dbPath?: string): Promise<ReturnType<typeof openUnmanagedDb>>;
    function openFailure(_dbPath?: string): never {
        databaseOpen();
        throw failure;
    }
    expect(await f.request(prompt, { openDatabase: openFailure, log })).toEqual({ reason: 'database_unavailable' });
    expect(lastStage()).toContain(`stage=${TASK_STATE_HOOK_STAGE.databaseOpen}`);
    expect(lastStage()).toContain('code=SQLITE_BUSY');
    expect(lastStage()).toContain('code=EACCES');
    expect(lastStage()).toContain('causes_omitted=1');

    databaseOpen.mockClear();
    expect(await f.request({ ...prompt, agent_type: protectedText }, { log, openDatabase: openFailure })).toEqual({
        reason: 'not_command',
    });
    expect(lastStage()).toContain(`stage=${TASK_STATE_HOOK_STAGE.eligibility}`);
    expect(databaseOpen).not.toHaveBeenCalled();

    const initial = readFileSync(f.sourcePath);
    appendFileSync(f.sourcePath, 'invalid native record\n');
    expect(await f.request(prompt, { log })).toEqual({ reason: 'not_command' });
    // Metadata authenticates a pre-prompt chat, but malformed evidence cannot.
    expect(lastStage()).toContain(`stage=${TASK_STATE_HOOK_STAGE.sourceReplay}`);
    writeFileSync(f.sourcePath, initial);
    f.appendTurn(protectedText);
    await f.capture();
    f.store.consent.revoke(f.cwd);
    expect(await f.request(prompt, { log })).toEqual({ reason: 'not_command' });
    expect(lastStage()).toContain(`stage=${TASK_STATE_HOOK_STAGE.consent}`);
    f.store.consent.grant(f.cwd);

    const source = readFileSync(f.sourcePath, 'utf8');
    writeFileSync(f.sourcePath, source.replace(protectedText, protectedText.replace('PRIVATE', 'CHANGED')));
    expect(await f.request(prompt, { log })).toEqual({ reason: 'not_command' });
    expect(lastStage()).toContain(`stage=${TASK_STATE_HOOK_STAGE.sourceReplay}`);
    writeFileSync(f.sourcePath, source);

    vi.spyOn(CodexAdapter.prototype, 'nativeSessionId').mockImplementationOnce(() => {
        throw unsafe;
    });
    expect(await f.request(prompt, { log })).toEqual({ reason: 'hook_error' });
    expect(lastStage()).toContain(`stage=${TASK_STATE_HOOK_STAGE.authentication}`);

    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort());
    expect(await f.request(prompt, { log })).toEqual({ reason: 'not_command' });
    expect(lastStage()).toContain(`stage=${TASK_STATE_HOOK_STAGE.deadline}`);
    vi.spyOn(TaskStateRequestStore.prototype, 'prepareIssue').mockReturnValueOnce(undefined);
    expect(await f.request(prompt, { log })).toEqual({ reason: 'not_command' });
    expect(lastStage()).toContain(`stage=${TASK_STATE_HOOK_STAGE.requestPreparation}`);
    expect(await f.request(prompt, { log, writeInjection: () => false })).toEqual({ reason: 'not_command' });
    expect(lastStage()).toContain(`stage=${TASK_STATE_HOOK_STAGE.injectionWrite}`);
    vi.spyOn(TaskStateRequestStore.prototype, 'issuePrepared').mockReturnValueOnce(false);
    expect(await f.request(prompt, { log })).toEqual({ reason: 'not_command' });
    expect(lastStage()).toContain(`stage=${TASK_STATE_HOOK_STAGE.requestIssue}`);
    expect(f.db.prepare('SELECT COUNT(*) FROM task_state_requests').pluck().get()).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) FROM injections').pluck().get()).toBe(0);

    const diagnostics = logged();
    expect(diagnostics).toContain(`user-prompt-submit codex session_id=${f.nativeId}:`);
    expect(diagnostics).not.toContain(protectedText);
    expect(diagnostics).not.toContain('\r');
    expect(diagnostics).not.toContain('\u001b');
    for (const line of diagnostics.trim().split('\n')) {
        expect(line.slice(line.indexOf('user-prompt-submit')).length).toBeLessThanOrEqual(HOOK_LOG_LINE_MAX_CHARS);
    }
    const success = await f.request(prompt, { log });
    expect(success).toHaveProperty('output');
    expect(await f.request(prompt, { log })).toEqual(success);
    expect(logged()).toBe(diagnostics);
    expect(f.db.prepare('SELECT COUNT(*) FROM task_state_requests').pluck().get()).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) FROM injections').pluck().get()).toBe(1);
    expect(
        await f.request(prompt, {
            openDatabase: openFailure,
            log: () => {
                throw unsafe;
            },
        }),
    ).toEqual({ reason: 'database_unavailable' });
});

it('delivers the verified Claude cancellation after a compact boundary closes a user-only turn', async () => {
    const f = fixture('claude-code');
    f.appendTurn('Build the dispatcher.');
    await f.capture();
    await f.request();
    const initial = f.state('Build the dispatcher.');
    initial.pending_items = [{ text: 'Implement dispatch.', sources: [{ role: 'user', quote: 'Build the dispatcher.' }] }];
    f.appendTurn('Continue.', initial);
    await f.capture();
    await f.publisher.recover();
    await f.request();
    f.appendTurn('The dispatcher is cancelled.', f.state('The dispatcher is cancelled.'));
    await f.capture();
    await f.publisher.recover();
    const cancellation = f.latest();
    expect(cancellation?.coverage.state, f.logs.join('\n')).toBe('verified');
    expect(cancellation?.report.pending_items).toEqual([]);
    f.compact();
    expect(context(await f.continuation()), f.logs.join('\n')).toContain('The dispatcher is cancelled.');

    f.appendPendingPrompt('/compact');
    f.compact();
    await f.capture();
    const closed = f.db
        .prepare(`SELECT ft.user_prompt, ft.assistant_response FROM memories m
        JOIN filtered_turns ft ON ft.memory_id = m.id ORDER BY m.turn_index DESC LIMIT 1`)
        .get();
    expect(closed).toEqual({ user_prompt: '/compact', assistant_response: '' });
    expect(f.latest()).toEqual(cancellation);
    const completeSource = readFileSync(f.sourcePath);
    const cursor = f.db.prepare('SELECT source_cursor FROM turn_search_index ORDER BY memory_id DESC LIMIT 1').pluck().get() as string;
    writeFileSync(f.sourcePath, completeSource.subarray(0, f.adapter.cursorPosition?.(cursor).byteOffset));
    expect(context(await f.continuation())).toBe('');
    expect(f.logs.at(-1)).toContain('task_chat_unavailable');
    writeFileSync(f.sourcePath, completeSource);
    const repeated = context(await f.continuation());
    expect(repeated, f.logs.join('\n')).toContain('The dispatcher is cancelled.');
    expect(repeated).not.toContain('Implement dispatch.');
    expect(repeated).not.toContain('Native summary');
    expect(context(await f.continuation())).toBe('');

    writeFileSync(f.sourcePath, readFileSync(f.sourcePath, 'utf8').replace('/compact', '/changed'));
    f.compact();
    expect(context(await f.continuation())).toBe('');
    expect(f.logs.at(-1)).toContain('task_chat_unavailable');
});

describe.each(['claude-code', 'codex'] as const)('%s active task continuity', (tool) => {
    it('publishes an acknowledged idle report after its final assistant output extends retained coverage', async () => {
        const f = fixture(tool);
        f.appendTurn('Build the dispatcher.');
        await f.capture();
        await f.request();
        const requestId = f.requestId();
        f.appendReportPrefix('Continue.', f.state('Build the dispatcher.'));
        await f.capture();
        const prefix = f.db.prepare('SELECT source_cursor, source_digest FROM turn_search_index ORDER BY memory_id DESC LIMIT 1').get();
        expect(f.latest()).toBeUndefined();
        f.appendAssistant('The latest agreement remains active.');
        f.compact();
        await f.publisher.recover(requestId);
        const manifest = f.latest();
        expect(manifest?.coverage.state, f.logs.join('\n')).toBe('verified');
        expect(manifest?.report.objective?.text).toBe('Build the dispatcher.');
        expect(f.db.prepare('SELECT consumed_at FROM task_state_requests WHERE request_id = ?').pluck().get(requestId)).not.toBeNull();
        expect(
            f.db.prepare('SELECT source_cursor, source_digest FROM turn_search_index ORDER BY memory_id DESC LIMIT 1').get(),
        ).not.toEqual(prefix);
        await f.publisher.recover(requestId);
        expect(f.latest()).toEqual(manifest);
        expect(f.db.prepare('SELECT COUNT(*) FROM task_state_manifests').pluck().get()).toBe(1);
        const delivered = context(await f.continuation('resume'));
        expect(delivered, f.logs.join('\n')).toContain(TASK_STATE_CURRENT_INTRODUCTION);
        expect(delivered).toContain('Build the dispatcher.');
    });

    it('publishes a cancellation appended after the rejected prefix was captured on idle', async () => {
        const f = fixture(tool);
        const capture = f.liveCapture();
        f.appendTurn('Build the dispatcher.');
        await capture();
        await f.request();
        const requestId = f.requestId();
        const malformed = {
            ...f.state(null),
            constraints: [{ text: 'Keep capture passive.', sources: [{ role: 'user', quote: 'Keep capture passive.' }] }],
        };
        f.appendTurn('Cancel the dispatcher.', undefined, true, { input: malformed, rejected: true }, true);
        await capture();
        const coverage = () =>
            f.db.prepare('SELECT memory_id, source_cursor, source_digest FROM turn_search_index ORDER BY memory_id DESC LIMIT 1').get() as {
                memory_id: number;
                source_cursor: string;
                source_digest: string;
            };
        const prefix = coverage();
        expect(f.latest()).toBeUndefined();
        expect(f.db.prepare('SELECT consumed_at FROM task_state_requests WHERE request_id = ?').pluck().get(requestId)).toBeNull();

        f.appendReport(f.state(null));
        let complete: ParsedTurn | undefined;
        for await (const turn of f.adapter.parseTurns(f.sourcePath, undefined, { closeTrailingOnIdle: true })) complete = turn;
        if (complete === undefined) throw new Error('Completed native turn missing');
        expect(sourceTurnDigests(complete)).not.toContain(prefix.source_digest);
        await capture();
        expect(f.latest()?.report.objective, f.logs.join('\n')).toBeNull();
        expect(f.latest()?.report.pending_items).toEqual([]);
        expect(f.latest()?.coverage.state).toBe('verified');
        expect(coverage()).toEqual({
            memory_id: prefix.memory_id,
            source_cursor: complete.cursor,
            source_digest: sourceTurnDigest(complete),
        });
        expect(f.db.prepare('SELECT consumed_at FROM task_state_requests WHERE request_id = ?').pluck().get(requestId)).not.toBeNull();
        expect(f.db.prepare('SELECT COUNT(*) FROM memories').pluck().get()).toBe(2);
        const completed = coverage();
        const manifest = f.latest();
        await capture();
        expect(coverage()).toEqual(completed);
        expect(f.latest()).toEqual(manifest);
        expect(f.db.prepare('SELECT COUNT(*) FROM memories').pluck().get()).toBe(2);
    });

    it('withholds late corrections when the captured prefix changes or the appended reports are ambiguous', async () => {
        const f = fixture(tool);
        const capture = f.liveCapture();
        f.appendTurn('Build the dispatcher.');
        await capture();
        await f.request();
        const requestId = f.requestId();
        // Keep the changed user instruction outside the cursor fingerprint's
        // trailing window, so refusing it requires the retained turn digest.
        const malformed = {
            ...f.state(null),
            constraints: [{ text: `Keep capture passive. ${'.'.repeat(FINGERPRINT_WINDOW_BYTES)}`, sources: [] }],
        };
        f.appendTurn('Cancel the dispatcher.', undefined, true, { input: malformed, rejected: true }, true);
        await capture();
        const coverage = f.db.prepare('SELECT * FROM turn_search_index ORDER BY memory_id').all();
        const prefix = readFileSync(f.sourcePath, 'utf8');
        const refused = () => {
            expect(f.latest(), f.logs.join('\n')).toBeUndefined();
            expect(f.db.prepare('SELECT consumed_at FROM task_state_requests WHERE request_id = ?').pluck().get(requestId)).toBeNull();
            expect(f.db.prepare('SELECT * FROM turn_search_index ORDER BY memory_id').all()).toEqual(coverage);
            expect(f.db.prepare('SELECT COUNT(*) FROM memories').pluck().get()).toBe(2);
        };
        writeFileSync(f.sourcePath, prefix.replace('Cancel the dispatcher.', 'Change the dispatcher.'));
        f.appendReport(f.state(null));
        await capture();
        refused();

        writeFileSync(f.sourcePath, prefix);
        f.appendReport(f.state(null));
        f.appendReport(f.state(null));
        await capture();
        refused();
    });

    it('recovers one acknowledged correction after an explicitly rejected malformed report', async () => {
        const f = fixture(tool);
        f.appendTurn('Build the dispatcher.');
        await f.capture();
        await f.request();
        const initial = f.state('Build the dispatcher.');
        initial.pending_items = [{ text: 'Implement dispatch.', sources: [{ role: 'user', quote: 'Build the dispatcher.' }] }];
        f.appendTurn('Continue.', initial);
        await f.capture();
        await f.publisher.recover();
        const original = f.latest();
        expect(original?.report.pending_items).toHaveLength(1);
        await f.request();
        const requestId = f.requestId();
        const malformed = {
            ...f.state(null),
            constraints: [{ text: 'Keep capture passive.', sources: [{ role: 'user', quote: 'Keep capture passive.' }] }],
        };
        const completion = f.state('The dispatcher is complete.');
        f.appendTurn('The dispatcher is complete.', completion, true, { input: malformed, rejected: true });
        // Model the retained turn written before the adapter accepted retries.
        // Recovery must authenticate it without rewriting its captured evidence.
        await f.capture(true);
        await f.publisher.recover(requestId);
        const replacement = f.latest();
        expect(replacement?.memoryId, f.logs.join('\n')).not.toBe(original?.memoryId);
        expect(replacement?.report.objective?.text).toBe('The dispatcher is complete.');
        expect(replacement?.report.pending_items).toEqual([]);
        expect(f.db.prepare('SELECT consumed_at FROM task_state_requests WHERE request_id = ?').pluck().get(requestId)).not.toBeNull();
        f.compact();
        const delivered = context(await f.continuation());
        expect(delivered, f.logs.join('\n')).toContain(TASK_STATE_CURRENT_INTRODUCTION);
        expect(delivered).toContain('The dispatcher is complete.');
        expect(delivered).not.toContain('Implement dispatch.');
        // Pre-fix coverage did not include the report. Its native body must
        // still agree with the published manifest at every continuation.
        const changed = { ...completion, objective: { ...completion.objective, text: 'A different task.' } };
        const encoded = (input: unknown) => (tool === 'codex' ? JSON.stringify(JSON.stringify(input)) : JSON.stringify(input));
        writeFileSync(f.sourcePath, readFileSync(f.sourcePath, 'utf8').replace(encoded(completion), encoded(changed)));
        f.compact();
        expect(context(await f.continuation())).toBe('');
    });

    it('keeps the prior manifest and request pending when two reports are acknowledged', async () => {
        const f = fixture(tool);
        f.appendTurn('Build the dispatcher.');
        await f.capture();
        await f.request();
        const initial = f.state('Build the dispatcher.');
        initial.pending_items = [{ text: 'Implement dispatch.', sources: [{ role: 'user', quote: 'Build the dispatcher.' }] }];
        f.appendTurn('Continue.', initial);
        await f.capture();
        await f.publisher.recover();
        const original = f.latest();
        await f.request();
        const requestId = f.requestId();
        f.appendTurn('The dispatcher is complete.', f.state('The dispatcher is complete.'), true, {
            input: f.state('Build the dispatcher.'),
            rejected: false,
        });
        await f.capture();
        await f.publisher.recover(requestId);
        expect(f.latest()).toEqual(original);
        expect(f.db.prepare('SELECT consumed_at FROM task_state_requests WHERE request_id = ?').pluck().get(requestId)).toBeNull();
    });

    it('continues the exact native cwd beneath its grouped project owner', async () => {
        const f = fixture(tool, true);
        f.appendTurn('Build the dispatcher. Use 17.');
        await f.capture();
        expect(f.db.prepare('SELECT path FROM projects').pluck().get()).toBe(f.projectPath);
        const asked = await f.request();
        expect(context(asked), JSON.stringify({ asked, logs: f.logs, sessions: f.db.prepare('SELECT * FROM sessions').all() })).toContain(
            TASK_STATE_REQUEST_INSTRUCTIONS,
        );
        const first = f.state('Build the dispatcher.', 'Build the dispatcher.');
        first.decisions = [{ text: 'Use 17.', sources: [{ role: 'user', quote: 'Use 17.' }] }];
        f.appendTurn('Continue.', first);
        await f.capture();
        await f.publisher.recover();
        expect(f.latest()?.coverage.state, f.logs.join('\n')).toBe('verified');
        await f.request();
        const replacement = f.state('Build the dispatcher.', 'Build the dispatcher.');
        replacement.decisions = [{ text: 'Use 43.', sources: [{ role: 'user', quote: 'Use 43.' }] }];
        f.appendTurn('Use 43.', replacement);
        await f.capture();
        await f.publisher.recover();
        f.compact();

        const sibling = path.join(f.projectPath, 'packages', 'sibling');
        mkdirSync(sibling);
        expect(await f.request({ cwd: sibling })).toEqual({ reason: 'not_command' });
        expect(context(await f.continuation('resume', { cwd: sibling }))).toBe('');
        expect(await f.request({ cwd: f.projectPath })).toEqual({ reason: 'not_command' });
        const substitute = path.join(path.dirname(f.sourcePath), 'other', path.basename(f.sourcePath));
        mkdirSync(path.dirname(substitute));
        writeFileSync(substitute, readFileSync(f.sourcePath));
        expect(await f.request({ transcript_path: substitute })).toEqual({ reason: 'not_command' });
        expect(context(await f.continuation('resume', { transcript_path: substitute }))).toBe('');

        const compacted = context(await f.continuation());
        expect(compacted, f.logs.join('\n')).toContain(TASK_STATE_CURRENT_INTRODUCTION);
        expect(compacted).toContain('Use 43.');
        expect(compacted).not.toContain('Use 17.');
        expect(context(await f.continuation())).toBe('');
        const resumed = context(await f.continuation('resume'));
        expect(resumed, f.logs.join('\n')).toContain(TASK_STATE_CURRENT_INTRODUCTION);
        expect(resumed).toContain('Use 43.');
        f.compact();
        f.store.consent.revoke(f.cwd);
        expect(await f.request()).toEqual({ reason: 'not_command' });
        expect(context(await f.continuation())).toBe('');
    });

    it('does not label an older snapshot current after excluded closed or pending retrieval turns', async () => {
        const f = fixture(tool);
        f.appendTurn('Build the dispatcher. Use 17.');
        await f.capture();
        await f.request();
        const first = f.state('Build the dispatcher.', 'Build the dispatcher.');
        first.decisions = [{ text: 'Use 17.', sources: [{ role: 'user', quote: 'Use 17.' }] }];
        f.appendTurn('Continue.', first);
        await f.capture();
        await f.publisher.recover();
        const original = f.latest();
        expect(original?.coverage.state).toBe('verified');
        const memoryCount = f.db.prepare('SELECT COUNT(*) FROM memories').pluck().get();
        f.appendRetrieval('Use 43 instead of 17.');
        await f.capture();
        expect(f.latest()).toEqual(original);
        expect(f.db.prepare('SELECT COUNT(*) FROM memories').pluck().get()).toBe(memoryCount);
        const closed = context(await f.continuation('resume'));
        expect(closed, f.logs.join('\n')).toContain(TASK_STATE_CHECKPOINT_INTRODUCTION);
        expect(closed).not.toContain(TASK_STATE_CURRENT_INTRODUCTION);
        expect(closed).not.toContain('Use 43 instead of 17.');
        expect(closed).not.toContain(f.retrievalBody);
        expect(context(await f.continuation('resume'))).toBe('');

        await f.request();
        const replacement = f.state('Build the dispatcher.', 'Build the dispatcher.');
        replacement.decisions = [{ text: 'Use 43.', sources: [{ role: 'user', quote: 'Use 43.' }] }];
        f.appendTurn('Use 43.', replacement);
        await f.capture();
        await f.publisher.recover();
        const refreshed = f.latest();
        expect(refreshed?.memoryId).not.toBe(original?.memoryId);
        expect(context(await f.continuation('resume'))).toContain(TASK_STATE_CURRENT_INTRODUCTION);
        f.appendRetrieval('Use 99 instead of 43.', true);
        const pending = context(await f.continuation('resume'));
        expect(pending, f.logs.join('\n')).toContain(TASK_STATE_CHECKPOINT_INTRODUCTION);
        expect(pending).not.toContain(TASK_STATE_CURRENT_INTRODUCTION);
        expect(pending).not.toContain('Use 99 instead of 43.');
        expect(pending).not.toContain(f.retrievalBody);
        expect(f.latest()).toEqual(refreshed);
        expect(context(await f.continuation('resume'))).toBe('');
    });

    it('connects discovery, correlated replacement, continuation, boundary suppression and authenticated empty withdrawal without Memory-Plus', async () => {
        const f = fixture(tool);
        const initial = await f.request();
        if (tool === 'codex') expect(initial).toHaveProperty('output');
        else expect(initial).toEqual({ reason: 'not_command' });
        expect(f.latest()).toBeUndefined();
        f.appendTurn('Build the dispatcher. Use 17 initially.');
        await f.capture();
        const asked = await f.request();
        if (tool === 'codex') expect(asked).toEqual(initial);
        expect(context(asked), JSON.stringify({ asked, logs: f.logs, sessions: f.db.prepare('SELECT * FROM sessions').all() })).toContain(
            TASK_STATE_REQUEST_INSTRUCTIONS,
        );
        const firstId = f.requestId();
        expect(context(await f.request())).toContain(firstId);
        const first = f.state('Build the dispatcher.', 'Build the dispatcher.');
        first.decisions = [{ text: 'Use 17 initially.', sources: [{ role: 'user', quote: 'Use 17 initially.' }] }];
        first.pending_items = [{ text: 'Implement dispatch.', sources: [{ role: 'user', quote: 'Build the dispatcher.' }] }];
        f.appendTurn('Continue implementation.', first);
        await f.capture();
        expect(f.latest()).toBeUndefined();
        await f.publisher.recover();
        expect(f.latest()?.coverage.state, f.logs.join('\n')).toBe('verified');
        expect(context(await f.request())).not.toContain(firstId);
        const second = f.state('Build the dispatcher.', 'Build the dispatcher.');
        second.decisions = [
            {
                text: 'Use 43 because the upstream batch is 43.',
                sources: [{ role: 'user', quote: 'Use 43 because the upstream batch is 43.' }],
            },
        ];
        second.constraints = [{ text: 'Keep capture passive.', sources: [{ role: 'user', quote: 'Keep capture passive.' }] }];
        second.pending_items = [{ text: 'Verify dispatch.', sources: [{ role: 'user', quote: 'Verify dispatch.' }] }];
        f.appendTurn('Use 43 because the upstream batch is 43. Implementation is done. Verify dispatch. Keep capture passive.', second);
        await f.capture();
        await f.publisher.recover();
        f.compact();
        const delivered = context(await f.continuation());
        expect(delivered, f.logs.join('\n')).toContain(TASK_STATE_CURRENT_INTRODUCTION);
        expect(delivered).toContain('Use 43 because the upstream batch is 43.');
        expect(delivered).toContain('Verify dispatch.');
        expect(delivered).not.toContain('Use 17 initially.');
        expect(delivered).not.toContain('Implement dispatch.');
        expect(delivered).not.toContain('opaque-provider-state');
        expect(context(await f.continuation())).toBe('');
        f.compact();
        expect(context(await f.continuation())).toContain('Use 43');
        expect(context(await f.continuation())).toBe('');
        expect(context(await f.continuation('resume'))).toContain('Use 43');
        expect(context(await f.continuation('startup'))).toBe('');
        expect(context(await f.continuation('clear'))).toBe('');
        expect(context(await f.continuation('resume', { session_id: 'another-chat' }))).toBe('');
        await f.request();
        f.appendTurn('The task is finished.', f.state(null));
        await f.capture();
        await f.publisher.recover();
        expect(f.latest()?.report.objective).toBeNull();
        f.compact();
        expect(context(await f.continuation())).toBe('');
    });

    it('keeps earlier state on missing or malformed reports and labels newer source evidence during publication lag', async () => {
        const f = fixture(tool);
        f.appendTurn('Build the dispatcher.');
        await f.capture();
        await f.request();
        f.appendTurn('Continue.', f.state('Build the dispatcher.'));
        await f.capture();
        await f.publisher.recover();
        const original = f.latest();
        await f.request();
        f.appendTurn('Use 43 because the upstream batch is 43.', { ...f.state(null), decisions: 'malformed' });
        await f.capture();
        await f.publisher.recover();
        expect(f.latest()).toEqual(original);
        const pendingId = f.requestId();
        expect(context(await f.request())).toContain(pendingId);
        f.appendTurn('Verify dispatch.', f.state('Verify dispatch.'), false);
        await f.capture();
        await f.publisher.recover();
        expect(f.latest()).toEqual(original);
        f.compact();
        const earlier = context(await f.continuation());
        expect(earlier, f.logs.join('\n')).toContain(TASK_STATE_CHECKPOINT_INTRODUCTION);
        expect(earlier).not.toContain(TASK_STATE_CURRENT_INTRODUCTION);
        expect(earlier).toContain('Use 43');
        const replacement = f.state('Ship a different task.', 'Ship a different task.');
        f.appendTurn('Ship a different task.', replacement);
        await f.capture();
        expect(f.latest()).toEqual(original);
        expect(context(await f.continuation('resume'))).toContain(TASK_STATE_CHECKPOINT_INTRODUCTION);
        await f.publisher.recover();
        const updated = context(await f.continuation('resume'));
        expect(updated, f.logs.join('\n')).toContain(TASK_STATE_CURRENT_INTRODUCTION);
        expect(updated).toContain('Ship a different task.');
        expect(updated).not.toContain('Build the dispatcher.');
        expect(updated).not.toContain('Use 43');
        f.appendPendingPrompt('Change the new task: first review its constraints.');
        const pending = context(await f.continuation('resume'));
        expect(pending, f.logs.join('\n')).toContain(TASK_STATE_CHECKPOINT_INTRODUCTION);
        expect(pending).not.toContain(TASK_STATE_CURRENT_INTRODUCTION);
        expect(pending).toContain('Change the new task: first review its constraints.');
        expect(context(await f.continuation('resume'))).toBe('');
    });

    it('refuses substituted sources, non-main bindings and changed evidence or consent at delivery', async () => {
        const f = fixture(tool);
        f.appendTurn('Build the dispatcher.');
        await f.capture();
        await f.request();
        f.appendTurn('Continue.', f.state('Build the dispatcher.'));
        await f.capture();
        await f.publisher.recover();
        f.compact();
        const substitute = path.join(path.dirname(f.sourcePath), 'other', path.basename(f.sourcePath));
        mkdirSync(path.dirname(substitute));
        writeFileSync(substitute, readFileSync(f.sourcePath));
        expect(await f.request({ transcript_path: substitute })).toEqual({ reason: 'not_command' });
        expect(context(await f.continuation('resume', { transcript_path: substitute }))).toBe('');
        expect(await f.request({ agent_id: 'child' })).toEqual({ reason: 'subagent_context' });
        f.db.prepare("UPDATE sessions SET kind = 'subagent'").run();
        expect(await f.request()).toEqual({ reason: 'not_command' });
        expect(context(await f.continuation())).toBe('');
        f.db.prepare("UPDATE sessions SET kind = 'main'").run();
        const foreign = path.join(f.directory, 'sibling');
        mkdirSync(foreign);
        f.store.consent.grant(foreign);
        expect(await f.request({ cwd: foreign })).toEqual({ reason: 'not_command' });
        expect(context(await f.continuation('resume', { cwd: foreign }))).toBe('');
        const current = readFileSync(f.sourcePath, 'utf8');
        if (tool === 'codex') {
            const [headerLine, ...rest] = current.trimEnd().split('\n');
            const header = JSON.parse(headerLine ?? '');
            writeFileSync(
                f.sourcePath,
                `${[JSON.stringify({ ...header, payload: { ...header.payload, parent_thread_id: 'parent' } }), ...rest].join('\n')}\n`,
            );
            expect(await f.request()).toEqual({ reason: 'not_command' });
            expect(context(await f.continuation('resume'))).toBe('');
            writeFileSync(f.sourcePath, current);
        }
        writeFileSync(f.sourcePath, current.replace('Build the dispatcher.', 'Erase the dispatcher.'));
        expect(context(await f.continuation())).toBe('');
        writeFileSync(f.sourcePath, current);
        expect(context(await f.continuation('resume', {}, { beforeDelivery: () => f.store.consent.revoke(f.cwd) }))).toBe('');
        f.store.consent.grant(f.cwd);
        expect(
            context(
                await f.continuation(
                    'resume',
                    {},
                    { beforeDelivery: (db) => db.prepare('UPDATE turn_search_index SET source_digest = ?').run('a'.repeat(64)) },
                ),
            ),
        ).toBe('');
        expect(context(await f.continuation('resume'))).toBe('');
        f.store.consent.revoke(f.cwd);
        expect(await f.request()).toEqual({ reason: 'not_command' });
        expect(context(await f.continuation())).toBe('');
        const openDatabase = vi.fn();
        expect(await f.request({ session_id: 'x'.repeat(CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES + 1) }, { openDatabase })).toEqual({
            reason: 'not_command',
        });
        expect(await f.request({ cwd: 'x'.repeat(CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES + 1) }, { openDatabase })).toEqual({
            reason: 'not_command',
        });
        setSetting(`capture-${tool}`, 'false');
        expect(await f.request({}, { openDatabase })).toEqual({ reason: 'not_command' });
        expect(openDatabase).not.toHaveBeenCalled();
    });

    it('drops oldest task items explicitly when the delivered body reaches its existing bound', async () => {
        const f = fixture(tool);
        const quote = 'Evidence for the active constraint.';
        f.appendTurn(quote);
        await f.capture();
        await f.request();
        const report = f.state('Continue the bounded task.', quote);
        report.constraints = Array.from({ length: 8 }, (_, index) => ({
            text: `constraint-${index} ${'x'.repeat(300)}`,
            sources: [{ role: 'user' as const, quote }],
        }));
        f.appendTurn('Keep these constraints.', report);
        await f.capture();
        await f.publisher.recover();
        f.compact();
        const delivered = context(await f.continuation());
        expect(delivered, f.logs.join('\n')).toContain('constraint-7');
        expect(delivered).not.toContain('constraint-0');
        expect(delivered).toMatch(/"omitted_items":[1-9]/);
        expect(delivered.split('\n').slice(1, -1).join('\n').length).toBeLessThanOrEqual(CURRENT_CHAT_EVIDENCE_MAX_CHARS);
        for (let index = 0; index < 5; index++) f.appendTurn(`Newer evidence ${index}: retain this pending verification.`);
        const checkpoint = context(await f.continuation('resume'));
        expect(checkpoint).toContain(TASK_STATE_CHECKPOINT_INTRODUCTION);
        expect(checkpoint).toContain('Newer evidence 4');
        expect(checkpoint).not.toContain('Newer evidence 0');
        expect(checkpoint).toContain('older rendered turns in this episode omitted');
        expect(checkpoint.split('\n').slice(1, -1).join('\n').length).toBeLessThanOrEqual(CURRENT_CHAT_EVIDENCE_MAX_CHARS);
    });
});
