import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlTurnAdapter } from '../../src/adapters/base.js';
import { defaultAdapters } from '../../src/adapters/index.js';
import { claudeProjectsRoot, codexSessionsRoot } from '../../src/config/paths.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { mcpResponseShaper } from '../../src/mcp/server.js';
import { ElephaMcpService } from '../../src/mcp/tools.js';
import * as providerTranscript from '../../src/security/provider-transcript.js';
import { currentChatEvidence } from '../../src/serving/current-chat-evidence.js';
import { publicSessionId } from '../../src/serving/session-id.js';
import { SessionReader, STORED_EVIDENCE_REASONS } from '../../src/serving/session-reader.js';
import { TurnSearchIndex } from '../../src/storage/turn-search-index.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { createTestDb, seedConsentRoot, seedProject, seedRollup, seedSession } from '../helpers/db.js';

type StoredTool = 'claude-code' | 'codex';

const SUMMARY = { decisions: [], pending_items: [], status: 'not_configured' as const };
const NOW = Date.parse('2026-09-29T00:00:00.000Z');
const PROMPTS = ['Choose the refund receipt format', 'Should receipts be signed?', 'Where do signed receipts live?'];
const COMMENTARY = 'Checking the receipt module before answering.';
const ANSWERS = [
    'Use JSON receipts with a stable schema.',
    'Yes, sign every receipt with the service key.',
    'Store signed receipts in the ledger bucket.',
];

// A trailing prompt closes the last answered turn in both transcript formats.
function claudeTranscript(nativeId: string, cwd: string): string {
    return [...PROMPTS, 'Close the open turn']
        .flatMap((prompt, index) => [
            {
                type: 'user',
                parentUuid: index === 0 ? null : `a${index - 1}`,
                isSidechain: false,
                message: { role: 'user', content: prompt },
                uuid: `u${index}`,
                timestamp: `2026-09-20T10:0${index}:00.000Z`,
                userType: 'external',
                entrypoint: 'cli',
                cwd,
                sessionId: nativeId,
                version: '2.1.220',
            },
            {
                type: 'assistant',
                parentUuid: `u${index}`,
                message: { role: 'assistant', content: [{ type: 'text', text: ANSWERS[index] ?? 'Closing.' }] },
                uuid: `a${index}`,
                timestamp: `2026-09-20T10:0${index}:30.000Z`,
                sessionId: nativeId,
                cwd,
            },
        ])
        .map((record) => `${JSON.stringify(record)}\n`)
        .join('');
}

// Every Codex turn carries provider phases, so a reader that reopened the
// rollout could still recover structure the stored copy does not have.
function codexTranscript(nativeId: string, cwd: string): string {
    return [
        { type: 'session_meta', payload: { id: nativeId, cwd } },
        ...PROMPTS.flatMap((prompt, index) => [
            { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
            {
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: COMMENTARY }] },
            },
            {
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    phase: 'final_answer',
                    content: [{ type: 'output_text', text: ANSWERS[index] }],
                },
            },
        ]),
        { type: 'event_msg', payload: { type: 'user_message', message: 'Close the open turn' } },
    ]
        .map((record) => `${JSON.stringify({ timestamp: '2026-09-20T10:00:00.000Z', ...record })}\n`)
        .join('');
}

async function storedSession(tool: StoredTool) {
    const f = createTestDb('stored-evidence-serving-');
    const checkout = path.join(f.directory, 'checkout');
    mkdirSync(checkout, { recursive: true });
    const project = seedProject(f, { path: checkout });
    seedConsentRoot(f, { path: checkout });
    vi.stubEnv('CODEX_HOME', path.join(f.directory, 'codex'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(f.directory, 'claude'));
    const nativeId = tool === 'codex' ? '019fa000-0000-7000-8000-0000000000aa' : 'aaaaaaaa-bbbb-cccc-dddd-0000000000aa';
    const storeRoot = tool === 'codex' ? codexSessionsRoot() : claudeProjectsRoot();
    const sourcePath = path.join(storeRoot, tool === 'codex' ? `rollout-${nativeId}.jsonl` : `${nativeId}.jsonl`);
    mkdirSync(storeRoot, { recursive: true });
    writeFileSync(sourcePath, tool === 'codex' ? codexTranscript(nativeId, checkout) : claudeTranscript(nativeId, checkout));
    const session = seedSession(f, { project, tool, nativeId, sourcePath, title: 'Refund receipts' });
    const turns: ParsedTurn[] = [];
    for await (const turn of defaultAdapters()[tool].parseTurns(sourcePath)) turns.push(turn);
    expect(turns.map((turn) => turn.userMessage)).toEqual(expect.arrayContaining(PROMPTS));
    for (const turn of turns.filter((candidate) => PROMPTS.includes(candidate.userMessage))) {
        expect(
            f.store.recordTurn({ ...turn, sessionId: nativeId, sourcePath, projectPath: checkout }, session.id, project.id, SUMMARY, true),
        ).toBe(true);
    }
    expect(f.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(session.id)).toEqual({ state: 'complete' });
    const id = publicSessionId(session);
    const service = new ElephaMcpService(f.db, mcpResponseShaper);
    const payload = (prompt: string) =>
        JSON.stringify({
            session_id: 'current-chat',
            cwd: checkout,
            hook_event_name: 'UserPromptSubmit',
            prompt,
            turn_id: 'turn-1',
            model: 'gpt-5.6',
            permission_mode: 'default',
            transcript_path: null,
        });
    return {
        ...f,
        checkout,
        project,
        session,
        nativeId,
        sourcePath,
        id,
        service,
        payload,
        turns: turns.filter((turn) => PROMPTS.includes(turn.userMessage)),
    };
}

// Each read gets a fresh data nonce and brief marker; the served content is
// what must stay identical.
function withoutNonces(value: unknown): string {
    return JSON.stringify(value)
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<nonce>')
        .replace(/\[\[elepha:brief:[0-9A-Z]{26}]]/g, '<brief>');
}

function captureState(f: Awaited<ReturnType<typeof storedSession>>) {
    return Object.fromEntries(
        [
            'sessions',
            'memories',
            'filtered_turns',
            'durable_capture_status',
            'durable_capture_usage',
            'turn_search_index',
            'source_generations',
            'open_turns',
            'consent_roots',
        ].map((table) => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
}

async function commandResults(f: Awaited<ReturnType<typeof storedSession>>, tool: StoredTool) {
    const hook = { dbPath: f.dbPath, now: () => NOW, log: () => undefined };
    return {
        full: withoutNonces(await f.service.getSession({ id: f.id })),
        tail: withoutNonces(await f.service.getSession({ id: f.id, last_n: 2 })),
        query: withoutNonces(await f.service.getSession({ id: f.id, query: 'receipt format' })),
        last: withoutNonces(await runUserPromptSubmit(f.payload('elepha:last'), tool, hook)),
        resume: withoutNonces(await runUserPromptSubmit(f.payload('elepha:resume:1'), tool, hook)),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('complete stored evidence serving', () => {
    it.each([
        ['claude-code', false],
        ['codex', false],
        ['codex', true],
    ] as const)(
        'serves %s from the stored copy alone, identically after the transcript disappears; structure removed=%s',
        async (tool, withoutStructure) => {
            const f = await storedSession(tool);
            if (withoutStructure) {
                f.db.prepare('UPDATE filtered_turns SET assistant_structure = NULL').run();
            }
            const transcriptRead = vi.spyOn(JsonlTurnAdapter.prototype, 'parseTurns');
            const sourceOpen = vi.spyOn(providerTranscript, 'openProviderTranscript');
            const before = captureState(f);

            const present = await commandResults(f, tool);
            expect(transcriptRead).not.toHaveBeenCalled();
            writeFileSync(
                f.sourcePath,
                (tool === 'codex' ? codexTranscript(f.nativeId, f.checkout) : claudeTranscript(f.nativeId, f.checkout)).replaceAll(
                    ANSWERS[0]!,
                    'Changed provider answer that must not be served.',
                ),
            );
            const changed = await commandResults(f, tool);
            expect(changed).toEqual(present);
            unlinkSync(f.sourcePath);
            const removed = await commandResults(f, tool);

            expect(removed).toEqual(present);
            expect(captureState(f)).toEqual(before);
            expect(sourceOpen).not.toHaveBeenCalled();
            expect(transcriptRead).not.toHaveBeenCalled();
            for (const answer of ANSWERS) expect(present.full).toContain(answer);
            expect(present.tail).not.toContain(ANSWERS[0]);
            expect(present.tail).toContain(ANSWERS[2]);
            expect(present.query).toContain(ANSWERS[0]);
            for (const answer of ANSWERS) {
                expect(present.resume).toContain(answer);
                expect(present.last).toContain(answer);
            }
            // Stored content only: without stored phases the commentary stays
            // in the served response instead of being reclassified from source.
            if (tool === 'codex') {
                expect(present.query.includes(COMMENTARY)).toBe(withoutStructure);
            }
        },
    );

    it('keeps a Codex copy without stored structure unclassified at the reader, with no transcript read', async () => {
        const f = await storedSession('codex');
        f.db.prepare('UPDATE filtered_turns SET assistant_structure = NULL').run();
        const transcriptRead = vi.spyOn(JsonlTurnAdapter.prototype, 'parseTurns');
        const reader = new SessionReader(f.db);
        const served = reader.sessionById(f.session.id);
        if (!served) throw new Error('stored session was not served');

        const first = await reader.firstInteraction(served);
        const window = await reader.evidenceWindow(served, 2);

        expect(first).toMatchObject({ source: 'durable stored interaction', turnIndex: 0 });
        expect(first.projection?.assistantStructure).toBeUndefined();
        expect(first.projection?.assistantResponse).toContain(COMMENTARY);
        expect(window).toMatchObject({ returned: 2, omitted: 1, total: 3 });
        expect(window.projections?.map((projection) => projection.assistantStructure)).toEqual([undefined, undefined]);
        expect(transcriptRead).not.toHaveBeenCalled();
    });

    it('serves current-chat evidence from a complete Codex copy without structure and keeps checkout isolation', async () => {
        const f = await storedSession('codex');
        f.db.prepare('UPDATE filtered_turns SET assistant_structure = NULL').run();
        const transcriptRead = vi.spyOn(JsonlTurnAdapter.prototype, 'parseTurns');
        const request = { tool: 'codex' as const, nativeSessionId: f.nativeId, cwd: f.checkout, mode: 'continuation' as const };

        const present = await currentChatEvidence(f.db, request);
        unlinkSync(f.sourcePath);
        const removed = await currentChatEvidence(f.db, request);

        expect(present.state).toBe('available');
        expect(removed).toEqual(present);
        expect(transcriptRead).not.toHaveBeenCalled();

        const otherCheckout = path.join(f.directory, 'other-checkout');
        mkdirSync(otherCheckout, { recursive: true });
        const elsewhere = await currentChatEvidence(f.db, { ...request, cwd: otherCheckout });
        expect(elsewhere.state).toBe('unavailable');
        f.store.consent.revoke(f.checkout);
        const revoked = await currentChatEvidence(f.db, request);
        expect(revoked.state).toBe('unavailable');
        expect(JSON.stringify(revoked)).not.toContain(ANSWERS[2]);
    });

    it.each(['claude-code', 'codex'] as const)('blocks a complete stored %s copy once consent is revoked', async (tool) => {
        const f = await storedSession(tool);
        unlinkSync(f.sourcePath);
        f.store.consent.revoke(f.checkout);

        const results = await commandResults(f, tool);

        for (const result of Object.values(results)) {
            for (const answer of ANSWERS) expect(result).not.toContain(answer);
        }
        expect(results.full).toContain('"reason":"unknown_session"');
    });

    it.each(['claude-code', 'codex'] as const)('never serves a stale %s copy as complete after reingest', async (tool) => {
        const f = await storedSession(tool);
        f.db.prepare('UPDATE filtered_turns SET captured_at = ?').run('2000-01-01T00:00:00.000Z');
        const first = f.db.prepare('SELECT turn_started_at FROM memories WHERE session_id = ? AND turn_index = 0').get(f.session.id) as {
            turn_started_at: string;
        };
        expect(
            f.store.reingestTurn(
                {
                    tool,
                    sessionId: f.nativeId,
                    sourcePath: f.sourcePath,
                    projectPath: f.checkout,
                    turnIndex: 0,
                    startedAt: first.turn_started_at,
                    endedAt: first.turn_started_at,
                    userMessage: PROMPTS[0]!,
                    assistantText: 'Use CBOR receipts instead.',
                    toolCalls: [],
                    cursor: '0',
                    hasExternalContent: false,
                    resumeMarkerBefore: false,
                },
                f.session.id,
                f.project.id,
                SUMMARY,
            ),
        ).toBe(true);
        const sourceOpen = vi.spyOn(providerTranscript, 'openProviderTranscript');
        const parsed = vi.spyOn(JsonlTurnAdapter.prototype, 'parseTurns');
        const before = captureState(f);
        const results = await commandResults(f, tool);
        for (const result of Object.values(results)) {
            expect(result).not.toContain(ANSWERS[0]);
            expect(result).toContain(STORED_EVIDENCE_REASONS.stale);
        }
        expect(sourceOpen).not.toHaveBeenCalled();
        expect(parsed).not.toHaveBeenCalled();
        expect(captureState(f)).toEqual(before);
    });

    it.each(['claude-code', 'codex'] as const)('reports an incomplete %s copy as unavailable once its transcript is gone', async (tool) => {
        const f = await storedSession(tool);
        f.db.prepare("UPDATE durable_capture_status SET state = 'disabled_gap' WHERE session_id = ?").run(f.session.id);
        unlinkSync(f.sourcePath);

        const results = await commandResults(f, tool);

        for (const answer of ANSWERS) {
            expect(results.full).not.toContain(answer);
            expect(results.tail).not.toContain(answer);
            expect(results.resume).not.toContain(answer);
        }
        expect(results.full).toContain('"empty":true');
    });
    it.each(['claude-code', 'codex'] as const)(
        'does not let a readable %s source rescue retained gaps or decoding failure',
        async (tool) => {
            const f = await storedSession(tool);
            // Exercise a whole-session query rather than its independently valid
            // first interaction; that distinct scope is checked below.
            f.db.prepare('UPDATE sessions SET first_prompt_search = NULL WHERE id = ?').run(f.session.id);
            const sourceOpen = vi.spyOn(providerTranscript, 'openProviderTranscript');
            const parsed = vi.spyOn(JsonlTurnAdapter.prototype, 'parseTurns');
            const originalRows = f.db.prepare('SELECT * FROM filtered_turns').all();
            const originalStatus = f.db.prepare('SELECT * FROM durable_capture_status').all();
            const variants = [
                ['DELETE FROM filtered_turns; DELETE FROM durable_capture_status', STORED_EVIDENCE_REASONS.missing],
                ['DELETE FROM filtered_turns WHERE memory_id = (SELECT MAX(id) FROM memories)', STORED_EVIDENCE_REASONS.incomplete],
                ['UPDATE filtered_turns SET filter_version = 0', STORED_EVIDENCE_REASONS.filterVersionMismatch],
                ["UPDATE durable_capture_status SET state = 'evicted'", STORED_EVIDENCE_REASONS.evicted],
                ["UPDATE filtered_turns SET tool_calls = '{invalid'", STORED_EVIDENCE_REASONS.unreadable],
            ] as const;
            for (const [invalidate, reason] of variants) {
                f.db.exec(invalidate);
                const before = captureState(f);
                const results = await commandResults(f, tool);
                for (const result of Object.values(results)) {
                    expect(result).toContain(reason);
                    for (const answer of ANSWERS) expect(result).not.toContain(answer);
                }
                expect(captureState(f)).toEqual(before);
                f.db.exec('DELETE FROM filtered_turns; DELETE FROM durable_capture_status');
                for (const [table, rows] of [
                    ['filtered_turns', originalRows],
                    ['durable_capture_status', originalStatus],
                ] as const) {
                    for (const row of rows as Record<string, unknown>[]) {
                        const columns = Object.keys(row);
                        f.db
                            .prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
                            .run(...Object.values(row));
                    }
                }
                // Deleting a copy deliberately removes its coverage row as well.
                for (const turn of f.turns) {
                    const memory = f.db
                        .prepare('SELECT id FROM memories WHERE session_id = ? AND turn_index = ?')
                        .get(f.session.id, turn.turnIndex) as { id: number };
                    new TurnSearchIndex(f.db).record(memory.id, turn, new Date().toISOString());
                }
            }
            expect(sourceOpen).not.toHaveBeenCalled();
            expect(parsed).not.toHaveBeenCalled();
        },
    );

    it.each(['claude-code', 'codex'] as const)(
        'keeps individually current %s evidence and summaries scoped while refusing an incomplete session',
        async (tool) => {
            const f = await storedSession(tool);
            f.db.prepare('DELETE FROM filtered_turns WHERE memory_id = (SELECT MAX(id) FROM memories)').run();
            const reader = new SessionReader(f.db);
            const session = reader.sessionById(f.session.id)!;
            const sourceOpen = vi.spyOn(providerTranscript, 'openProviderTranscript');
            const parsed = vi.spyOn(JsonlTurnAdapter.prototype, 'parseTurns');
            expect(await reader.render(session, 1)).toEqual({ reason: STORED_EVIDENCE_REASONS.incomplete });
            expect((await reader.indexedTurnEvidence({ ...session, expectedProjectPath: f.checkout }, 0)).state).toBe('available');
            const selected = withoutNonces(await f.service.getSession({ id: f.id, query: 'receipt format' }));
            expect(selected).toContain(ANSWERS[0]);
            expect(selected).toContain('durable stored interaction, stored turn index 0');
            expect(selected).toContain('not a complete episode');
            seedRollup(f, {
                session: f.session,
                project: f.project,
                decisions: [{ what: 'Summary decision: retain the receipt schema.' }],
            });
            const summary = withoutNonces(await f.service.getSession({ id: f.id, query: 'receipt' }));
            expect(summary).toContain('stored rollup');
            expect(summary).toContain('Summary decision');
            expect(summary).toContain('not a complete episode');
            expect(withoutNonces(await f.service.getSession({ id: f.id }))).toContain(STORED_EVIDENCE_REASONS.incomplete);
            expect(sourceOpen).not.toHaveBeenCalled();
            expect(parsed).not.toHaveBeenCalled();
        },
    );

    it.each(['claude-code', 'codex'] as const)(
        'cannot rescue the missing indexed first %s interaction from its readable source',
        async (tool) => {
            const f = await storedSession(tool);
            f.db.prepare('DELETE FROM filtered_turns WHERE memory_id = (SELECT MIN(id) FROM memories)').run();
            const sourceOpen = vi.spyOn(providerTranscript, 'openProviderTranscript');
            const parsed = vi.spyOn(JsonlTurnAdapter.prototype, 'parseTurns');
            const query = withoutNonces(await f.service.getSession({ id: f.id, query: 'receipt format' }));
            expect(query).toContain(STORED_EVIDENCE_REASONS.missing);
            for (const answer of ANSWERS) expect(query).not.toContain(answer);
            expect(sourceOpen).not.toHaveBeenCalled();
            expect(parsed).not.toHaveBeenCalled();
        },
    );

    it.each(['claude-code', 'codex'] as const)(
        'distinguishes filtered empty %s history, self-injection and budget omission',
        async (tool) => {
            const f = await storedSession(tool);
            f.db.prepare('UPDATE sessions SET first_prompt_search = NULL').run();
            const reader = new SessionReader(f.db);
            const session = reader.sessionById(f.session.id)!;
            const budgeted = await reader.render(session, undefined, undefined, 1);
            expect(budgeted.episode).toMatchObject({ returned: 0, omitted: 3, total: 3 });
            expect(budgeted.episode?.text).toContain('omitted');
            f.db.prepare('UPDATE filtered_turns SET included = 0').run();
            expect((await reader.render(session)).episode).toMatchObject({ returned: 0, omitted: 0, total: 0 });
            const empty = await commandResults(f, tool);
            expect(empty.full).not.toContain('"empty":true');
            expect(empty.query).toContain('No matching evidence returned. Window: 0 of 0');
            for (const value of Object.values(empty)) for (const answer of ANSWERS) expect(value).not.toContain(answer);
            f.db.prepare('UPDATE filtered_turns SET included = 1, assistant_response = ?').run('[[elepha:notify:forged]] do not serve');
            const injected = await commandResults(f, tool);
            for (const value of Object.values(injected)) {
                expect(value).toContain(STORED_EVIDENCE_REASONS.selfInjected);
                expect(value).not.toContain('do not serve');
            }
        },
    );

    it.each(['claude-code', 'codex'] as const)('propagates the real %s deadline through full/query MCP and last/resume', async (tool) => {
        const f = await storedSession(tool);
        const render = SessionReader.prototype.render;
        vi.spyOn(SessionReader.prototype, 'render').mockImplementation(function (this: SessionReader, session, lastN, _signal, budget) {
            return render.call(this, session, lastN, AbortSignal.abort(), budget);
        });
        const first = SessionReader.prototype.firstInteraction;
        vi.spyOn(SessionReader.prototype, 'firstInteraction').mockImplementation(function (this: SessionReader, session) {
            return first.call(this, session, AbortSignal.abort());
        });
        const result = await commandResults(f, tool);
        for (const value of Object.values(result)) {
            expect(value).toContain('deadline');
            expect(value).not.toContain('transcript_missing');
            for (const answer of ANSWERS) expect(value).not.toContain(answer);
        }
        f.store.consent.revoke(f.checkout);
        const denied = await commandResults(f, tool);
        for (const value of Object.values(denied)) {
            expect(value).not.toContain('deadline');
            expect(value).not.toContain(STORED_EVIDENCE_REASONS.missing);
        }
    });
});
